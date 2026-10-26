import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startService } from "../src/server/service.js";
import {
  acceptsCredential,
  connection,
  processFile,
  projectRoot,
  readInstance,
} from "./connection.js";
import { stopCodexSetupProcesses } from "./codex-rpc.js";

const current = connection();
const url = new URL(current.url);
let service: ReturnType<typeof startService> | undefined;
let stopping = false;
const runtime = {
  pid: process.pid,
  script: join(projectRoot, "dist", "server", "server", "index.js"),
  ownerScript: fileURLToPath(import.meta.url),
  dataDir: current.dataDir,
  credentialDir: current.credentialDir,
  url: current.url,
  mode: "foreground" as const,
};
const shutdown = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  if (service) console.log("\nStopping FlowCanvas…");
  stopCodexSetupProcesses();
  try {
    await service?.close();
    if (readInstance()?.pid === process.pid)
      writeFileSync(
        processFile,
        JSON.stringify({ ...runtime, pid: 0, mode: "stopped" }),
      );
    if (service)
      console.log("FlowCanvas stopped. HTTP connections and database closed.");
  } catch (error) {
    console.error("Shutdown failed: " + (error as Error).message);
    code = 1;
  }
  process.exit(code);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => void shutdown());
if (process.platform === "win32") process.on("SIGBREAK", () => void shutdown());

try {
  if (!existsSync(join(projectRoot, "dist", "web", "index.html")))
    throw new Error("Build FlowCanvas first with npm run build.");
  let alreadyRunning = false;
  try {
    const response = await fetch(new URL("/api/health", url), {
      signal: AbortSignal.timeout(1000),
    });
    alreadyRunning = response.ok;
  } catch {
    /* No existing listener. */
  }
  if (alreadyRunning)
    throw new Error(
      "FlowCanvas is already running in another terminal. Stop it there with Ctrl+C before starting it in this terminal.",
    );
  service = startService({
    directory: current.dataDir,
    credentialDirectory: current.credentialDir,
    port: Number(url.port || 4317),
    webPath: join(projectRoot, "dist", "web"),
  });
  await service.ready;
  mkdirSync(join(projectRoot, ".local"), { recursive: true });
  writeFileSync(processFile, JSON.stringify(runtime));
  console.log(
    `FlowCanvas: ${url.origin}\nLocal data: ${current.dataDir}\nKeep this terminal open. Press Ctrl+C to stop.`,
  );
  if (!(await acceptsCredential(current.url, current.token)))
    throw new Error("The service credential did not match its local file.");
  if (!process.argv.includes("--service-only")) {
    await import("./setup-mcp.js");
    await import("./probe-mcp.js");
    await import("./probe-codex.js");
  }
  console.log(
    `\nFlowCanvas is ready: ${url.origin}\nPress Ctrl+C in this terminal to shut it down.`,
  );
} catch (error) {
  if (!stopping) {
    console.error((error as Error).message);
    await shutdown(1);
  }
}
