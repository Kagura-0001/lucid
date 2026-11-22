import { EventEmitter } from "node:events";
import readline from "node:readline";

export class JsonRpcError extends Error {
  constructor(code, message, data = undefined) {
    super(message || `JSON-RPC error ${code}`);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export class StdioJsonRpc extends EventEmitter {
  constructor(stdin, stdout) {
    super();
    this.stdin = stdin;
    this.stdout = stdout;
    this.nextId = 1;
    this.pending = new Map();
    this.requestHandler = null;
    this.closed = false;

    this.rl = readline.createInterface({
      input: stdout,
      crlfDelay: Infinity,
    });

    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.handleLine(trimmed);
    });

    this.rl.on("close", () => {
      this.handleClose(new Error("ACP stdio stream closed"));
    });

    if (stdin && typeof stdin.on === "function") {
      stdin.on("error", (err) => {
        this.handleClose(err);
      });
    }
  }

  onRequest(handler) {
    this.requestHandler = handler;
  }

  writeMessage(payload) {
    if (this.closed || !this.stdin || !this.stdin.writable) {
      throw new Error("ACP stdin is not writable");
    }
    this.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params = undefined, timeoutMs = 0) {
    if (this.closed) {
      return Promise.reject(new Error(`Cannot call ${method}: ACP connection is closed`));
    }
    const id = this.nextId;
    this.nextId += 1;

    const payload = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pending.set(id, {
        method,
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.writeMessage(payload);
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = undefined) {
    if (this.closed) return;
    const payload = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      payload.params = params;
    }
    try {
      this.writeMessage(payload);
    } catch {
      // Ignore write failures during teardown
    }
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("protocolWarning", `Non-JSON line on ACP stdout: ${line.slice(0, 120)}`);
      return;
    }

    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== null && msg.id !== undefined;
    const hasMethod = typeof msg.method === "string";

    // Outbound request response
    if (hasId && !hasMethod) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Server-initiated RPC request (e.g. session/request_permission)
    if (hasId && hasMethod) {
      this.dispatchInboundRequest(msg.id, msg.method, msg.params);
      return;
    }

    // Server notification (e.g. session/update)
    if (hasMethod) {
      this.emit("notification", msg.method, msg.params);
    }
  }

  async dispatchInboundRequest(id, method, params) {
    if (!this.requestHandler) {
      this.sendErrorResponse(id, -32601, `Method not implemented: ${method}`);
      return;
    }
    try {
      const result = await this.requestHandler(method, params);
      if (!this.closed) {
        this.writeMessage({ jsonrpc: "2.0", id, result: result ?? {} });
      }
    } catch (err) {
      const code = typeof err?.code === "number" ? err.code : -32000;
      const message = err?.message || String(err);
      this.sendErrorResponse(id, code, message);
    }
  }

  sendErrorResponse(id, code, message) {
    if (this.closed) return;
    try {
      this.writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code, message },
      });
    } catch {
      // Ignore write failures during teardown
    }
  }

  handleClose(err) {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      entry.reject(err);
    }
    this.pending.clear();
    this.emit("close", err);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.rl.close();
    } catch {
      // Ignore
    }
    for (const [, entry] of this.pending) {
      entry.reject(new Error("ACP client closed"));
    }
    this.pending.clear();
  }
}
