import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertProcessSucceeded,
  resolveCodexExecutable,
} from "../scripts/codex-command.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "flowcanvas-codex-"));
  return { root, env: { LOCALAPPDATA: root, Path: "" } };
}

describe("Codex launcher in an ordinary PowerShell environment", () => {
  it("finds the desktop executable when Codex is absent from PATH", () => {
    const { root, env } = setup();
    const version = join(root, "OpenAI", "Codex", "bin", "release-hash");
    mkdirSync(version, { recursive: true });
    const executable = join(version, "codex.exe");
    writeFileSync(executable, "test fixture");
    mkdirSync(join(root, "OpenAI", "Codex", "bin", "incomplete-release"));
    expect(resolveCodexExecutable(env, "win32")).toBe(executable);
  });

  it("prefers an executable on PATH over desktop fallback discovery", () => {
    const { root, env } = setup();
    writeFileSync(join(root, "codex.exe"), "test fixture");
    expect(resolveCodexExecutable({ ...env, Path: `"${root}"` }, "win32")).toBe(
      join(root, "codex.exe"),
    );
  });

  it("honors an explicit executable path and reports invalid overrides", () => {
    const { root, env } = setup();
    const executable = join(root, "custom-codex.exe");
    writeFileSync(executable, "test fixture");
    expect(
      resolveCodexExecutable({ ...env, FLOWCANVAS_CODEX_PATH: executable }, "win32"),
    ).toBe(executable);
    expect(() =>
      resolveCodexExecutable(
        { ...env, FLOWCANVAS_CODEX_PATH: join(root, "missing.exe") },
        "win32",
      ),
    ).toThrow("existing Codex executable");
  });

  it("gives an actionable error when no installation can be found", () => {
    const { env } = setup();
    expect(() => resolveCodexExecutable(env, "win32")).toThrow(
      "FLOWCANVAS_CODEX_PATH",
    );
  });

  it("reports a process-launch failure even when stderr is unavailable", () => {
    const result = spawnSync(join(tmpdir(), "flowcanvas-nonexistent-executable"), []);
    expect(() => assertProcessSucceeded(result, "Could not register FlowCanvas"))
      .toThrow(/Could not register FlowCanvas:.*ENOENT/);
  });
});
