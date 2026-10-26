import { startService } from "./service.js";
const service = startService();
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log("\nStopping FlowCanvas…");
  await service.close();
  console.log("FlowCanvas stopped. Database closed.");
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => void shutdown());
if (process.platform === "win32") process.on("SIGBREAK", () => void shutdown());
try {
  await service.ready;
  const port = (service.server.address() as import("node:net").AddressInfo)
    .port;
  console.log(
    `FlowCanvas: http://127.0.0.1:${port}\nLocal data: ${service.directory}\nKeep this terminal open. Press Ctrl+C to stop.`,
  );
} catch (error) {
  console.error(`FlowCanvas could not start: ${(error as Error).message}`);
  process.exitCode = 1;
}
