import { spawn } from "node:child_process";
const processes = [
  spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
  }),
];
for (const event of ["SIGINT", "SIGTERM"] as const)
  process.on(event, () => {
    processes.forEach((p) => p.kill());
    process.exit();
  });
processes.forEach((p) =>
  p.on("exit", (code) => {
    if (code) {
      processes.forEach((child) => child.kill());
      process.exit(code);
    }
  }),
);
