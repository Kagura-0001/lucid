import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient, parseQuotaPayload } from "../src/acp/client.mjs";

const MOCK_SERVER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

let nextServerId = 100;
const pendingPermission = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.id && !msg.method) {
    const resolver = pendingPermission.get(msg.id);
    if (resolver) {
      pendingPermission.delete(msg.id);
      resolver(msg.result);
    }
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Mock ACP Agent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true },
          sessionCapabilities: { list: {}, load: {}, resume: {}, close: {} },
        },
      },
    });
    return;
  }

  if (msg.method === "session/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessions: [{ sessionId: "sess-old", cwd: msg.params.cwd, title: "Old chat", updatedAt: "2026-11-19T10:00:00Z" }],
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "sess-1",
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }] },
        configOptions: [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: "mock-pro", options: [{ value: "mock-pro", name: "Mock Pro" }] },
          { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
        ],
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact history" }] },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "sess-1", update: { sessionUpdate: "usage_update", used: 1024, size: 200000 } },
    });
    return;
  }

  if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    return;
  }

  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning edit..." } } },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit app.js", kind: "edit", status: "pending" } },
    });

    const permId = nextServerId++;
    pendingPermission.set(permId, (permResult) => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "completed",
            content: [{ type: "diff", path: "/tmp/app.js", oldText: "a = 1\\n", newText: "a = 2\\n" }],
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Done! Decision: " + permResult.outcome.optionId },
          },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    });

    send({
      jsonrpc: "2.0",
      id: permId,
      method: "session/request_permission",
      params: {
        sessionId: sid,
        title: "Allow editing /tmp/app.js?",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    return;
  }

  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`;

test("AcpClient handles full lifecycle including streaming updates and permission approval", async () => {
  const client = new AcpClient({
    name: "Mock ACP",
    command: process.execPath,
    args: ["-e", MOCK_SERVER_SCRIPT],
  });

  const updates = [];
  client.on("sessionUpdate", (p) => updates.push(p.update));

  let permTitle = "";
  client.on("permissionRequest", ({ params, selectOption }) => {
    permTitle = params.title;
    selectOption("allow-once");
  });

  const init = await client.start();
  assert.equal(init.agentInfo.name, "Mock ACP Agent");
  assert.equal(client.supportsSessionList(), true);

  const sessions = await client.listSessions("/tmp");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, "sess-old");

  const created = await client.createSession("/tmp");
  assert.equal(created.sessionId, "sess-1");

  const promptRes = await client.sendPrompt("sess-1", [{ type: "text", text: "edit file" }]);
  assert.equal(promptRes.stopReason, "end_turn");
  assert.equal(permTitle, "Allow editing /tmp/app.js?");

  const kinds = updates.map((u) => u.sessionUpdate);
  assert.ok(kinds.includes("available_commands_update"));
  assert.ok(kinds.includes("usage_update"));
  assert.ok(kinds.includes("agent_thought_chunk"));
  assert.ok(kinds.includes("tool_call"));
  assert.ok(kinds.includes("tool_call_update"));
  assert.ok(kinds.includes("agent_message_chunk"));

  const msgUpdate = updates.find((u) => u.sessionUpdate === "agent_message_chunk");
  assert.equal(msgUpdate.content.text, "Done! Decision: allow-once");

  await client.stop("sess-1");
});

test("parseQuotaPayload formats official agy /quota JSON response cleanly", () => {
  const parsed = parseQuotaPayload({
    status: "SUCCESS",
    response:
      "Gemini Models\tWeekly Limit Remaining\t97%\t2026-11-26T09:00:14Z\n" +
      "Gemini Models\tFive Hour Limit Remaining\t88%\t2026-11-19T14:00:14Z\n" +
      "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-26T12:13:11Z\n",
  });
  assert.equal(parsed.badge, "5h 88% · wk 97%");
  assert.equal(parsed.lines.length, 3);
});
