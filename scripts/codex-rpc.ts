import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveCodexExecutable } from "./codex-command.js";
const ownedProcesses = new Set<ReturnType<typeof spawn>>();
export function stopCodexSetupProcesses() {
  for (const child of ownedProcesses) child.kill();
  ownedProcesses.clear();
}
process.once("exit", stopCodexSetupProcesses);

/** Configuration and MCP protocol operations only; never starts an agent turn. */
export class CodexRpc {
  private child = spawn(
    resolveCodexExecutable(),
    ["app-server", "--listen", "stdio://"],
    { env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  private lines = createInterface({ input: this.child.stdout });
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private stopped = false;
  constructor() {
    ownedProcesses.add(this.child);
    this.child.once("exit", () => ownedProcesses.delete(this.child));
    const fail = (error: Error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    this.lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new Error(
            message.error.message ?? "Codex configuration request failed.",
          ),
        );
      else pending.resolve(message.result);
    });
    this.child.on("error", fail);
    this.child.stdin.on("error", fail);
    this.child.on("exit", () => {
      if (!this.stopped)
        fail(new Error("The Codex configuration process closed unexpectedly."));
    });
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "flowcanvas-local",
        title: "FlowCanvas connection setup",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }
  request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex timed out handling ${method}.`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  close() {
    this.stopped = true;
    this.lines.close();
    this.child.stdin.end();
    this.child.kill();
    ownedProcesses.delete(this.child);
  }
}
