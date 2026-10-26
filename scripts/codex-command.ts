import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";

const environmentValue = (env: NodeJS.ProcessEnv, name: string) =>
  Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve a native executable; a desktop-launched terminal may have a richer PATH. */
export function resolveCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const override = environmentValue(env, "FLOWCANVAS_CODEX_PATH");
  if (override) {
    if (!isAbsolute(override) || !isFile(override)) {
      throw new Error(
        "FLOWCANVAS_CODEX_PATH must point to an existing Codex executable using its full path.",
      );
    }
    return override;
  }

  const executable = platform === "win32" ? "codex.exe" : "codex";
  const path = environmentValue(env, "PATH") ?? "";
  for (const entry of path.split(platform === "win32" ? ";" : ":")) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, executable);
    if (isFile(candidate)) return candidate;
  }

  if (platform === "win32") {
    const localAppData =
      environmentValue(env, "LOCALAPPDATA") ?? join(homedir(), "AppData", "Local");
    const bin = join(localAppData, "OpenAI", "Codex", "bin");
    const direct = join(bin, executable);
    if (isFile(direct)) return direct;
    if (existsSync(bin)) {
      const candidates = readdirSync(bin, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(bin, entry.name, executable))
        .filter(isFile)
        .map((file) => ({ file, modified: statSync(file).mtimeMs }))
        .sort((a, b) => b.modified - a.modified);
      if (candidates[0]) return candidates[0].file;
    }
  }

  throw new Error(
    "Could not find the Codex executable on PATH or in the Codex desktop installation. Set FLOWCANVAS_CODEX_PATH to the full path of the native Codex executable, then run npm run codex:check again.",
  );
}

export function assertProcessSucceeded(
  result: SpawnSyncReturns<Buffer>,
  action: string,
) {
  if (result.error) throw new Error(`${action}: ${result.error.message}`);
  if (result.status !== 0) {
    const reason =
      result.stderr?.toString().trim() ||
      (result.signal
        ? `The process ended with signal ${result.signal}.`
        : `The process exited with code ${result.status ?? "unknown"}.`);
    throw new Error(`${action}: ${reason}`);
  }
}
