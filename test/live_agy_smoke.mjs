import { spawnSync } from "node:child_process";
import { AcpClient } from "../src/acp/client.mjs";
import { AGENT_PRESETS } from "../src/config.mjs";

async function main() {
  // 1. Inspect real `agy -p "/quota" --output-format json` payload
  const quotaRun = spawnSync("agy", ["-p", "/quota", "--output-format", "json"], {
    encoding: "utf8",
    timeout: 10000,
  });
  console.log("=== QUOTA CLI ===");
  console.log("exit:", quotaRun.status, "stdout:", (quotaRun.stdout || "").trim().slice(0, 600));

  // 2. Drive real `agy acp --stdio` through our AcpClient
  const client = new AcpClient(AGENT_PRESETS.agy);
  const seenKinds = new Set();
  const sampleByKind = new Map();

  client.on("sessionUpdate", ({ update }) => {
    const kind = update?.sessionUpdate || "unknown";
    seenKinds.add(kind);
    if (!sampleByKind.has(kind)) {
      sampleByKind.set(kind, update);
    }
  });

  const init = await client.start();
  console.log("=== INIT ===");
  console.log("agent:", init.agentInfo, "supportsList:", client.supportsSessionList(), "supportsLoad:", client.supportsSessionLoad());

  const sessions = await client.listSessions(process.cwd());
  console.log("=== SESSION/LIST ===");
  console.log("count:", sessions.length, "latest:", sessions[0]?.title || sessions[0]?.sessionId);

  const created = await client.createSession("/tmp");
  const sid = created.sessionId;
  console.log("=== SESSION/NEW ===");
  console.log("sessionId:", sid, "mode:", created.modes?.currentModeId, "configOptions:", (created.configOptions || []).map((c) => `${c.id}=${c.currentValue}`));

  // Test mode switch & thinking level switch
  const modeRes = await client.setMode(sid, "auto");
  console.log("=== SET_MODE (auto) ===");
  console.log("ok:", JSON.stringify(modeRes).slice(0, 200));

  const effortRes = await client.setConfigOption(sid, "thought_level", "low");
  console.log("=== SET_EFFORT (low) ===");
  console.log("ok:", JSON.stringify(effortRes).slice(0, 200));

  // Run one tiny prompt to verify real streaming updates
  console.log("=== SESSION/PROMPT ===");
  const promptRes = await client.sendPrompt(sid, [{ type: "text", text: "Reply with exactly one word: PONG" }]);
  console.log("stopReason:", promptRes?.stopReason);
  console.log("seen sessionUpdate kinds:", [...seenKinds]);
  for (const [k, sample] of sampleByKind) {
    console.log(`sample[${k}]:`, JSON.stringify(sample).slice(0, 300));
  }

  await client.stop(sid);
  console.log("=== DONE ===");
}

main().catch((err) => {
  console.error("LIVE SMOKE FAILED:", err);
  process.exit(1);
});
