import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const { pid, script, mode } = JSON.parse(
  readFileSync(".local/server-process.json", "utf8"),
) as { pid: number; script: string; mode?: string };
if (mode === "stopped" || pid === 0) {
  console.log("FlowCanvas is already stopped.");
  process.exit(0);
}
if (mode === "foreground") {
  console.log(
    "FlowCanvas runs in its owning terminal. Press Ctrl+C in that terminal to stop it cleanly.",
  );
  process.exit(0);
}
if (!Number.isInteger(pid) || pid < 1)
  throw new Error("Invalid saved FlowCanvas process.");
if (process.platform === "win32") {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:FLOWCANVAS_SERVER_PID); if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine.Contains($env:FLOWCANVAS_SERVER_SCRIPT)) { Stop-Process -Id $p.ProcessId; Write-Output 'FlowCanvas stopped.' } else { Write-Output 'The saved FlowCanvas process is no longer running.' }",
    ],
    {
      env: {
        ...process.env,
        FLOWCANVAS_SERVER_PID: String(pid),
        FLOWCANVAS_SERVER_SCRIPT: script,
      },
      windowsHide: true,
      stdio: "pipe",
    },
  );
  if (result.status !== 0) throw new Error(result.stderr.toString());
  console.log(result.stdout.toString().trim());
} else {
  throw new Error(
    "The background stop helper currently supports Windows. Run npm start in a terminal on other platforms and stop with Ctrl+C.",
  );
}
