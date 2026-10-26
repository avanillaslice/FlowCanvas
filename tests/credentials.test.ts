import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { readToken } from "../src/server/config.js";
import { acceptsCredential } from "../scripts/connection.js";
import { startService } from "../src/server/service.js";

describe("shared file-based MCP credentials", () => {
  it("shares a workspace credential with Codex independently of the database location", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flowcanvas-data-"));
    const credentials = mkdtempSync(join(tmpdir(), "flowcanvas-workspace-"));
    const stale = readToken(directory);
    const service = startService({
      directory,
      credentialDirectory: credentials,
      port: 0,
    });
    await service.ready;
    try {
      const response = execFileSync(
        process.execPath,
        [resolve("scripts/mcp-headers.mjs"), join(credentials, "mcp-token")],
        {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, FLOWCANVAS_MCP_TOKEN: stale },
        },
      );
      const token = JSON.parse(response).Authorization.slice("Bearer ".length);
      const url = `http://127.0.0.1:${(service.server.address() as any).port}/mcp`;
      expect(await acceptsCredential(url, token)).toBe(true);
      expect(await acceptsCredential(url, stale)).toBe(false);
      const health = await (await fetch(new URL("/api/health", url))).json();
      expect(health.dataDirectory).toBe(directory);
      expect(health.credentialDirectory).toBe(credentials);
    } finally {
      await service.close();
    }
  });
  it("keeps an existing credential rather than replacing it on later startups", () => {
    const directory = mkdtempSync(join(tmpdir(), "flowcanvas-credential-"));
    const first = readToken(directory);
    expect(readToken(directory)).toBe(first);
    expect(readFileSync(join(directory, "mcp-token"), "utf8")).toBe(first);
  });
  it("the Codex credential helper ignores a stale PowerShell environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "flowcanvas-helper-"));
    const token = readToken(directory);
    const response = execFileSync(
      process.execPath,
      [resolve("scripts/mcp-headers.mjs"), join(directory, "mcp-token")],
      {
        env: { ...process.env, FLOWCANVAS_MCP_TOKEN: "stale-shell-credential" },
        encoding: "utf8",
        windowsHide: true,
      },
    );
    expect(JSON.parse(response).Authorization).toBe(`Bearer ${token}`);
  });
  it("detects mismatches and uses the current file after a credential change", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flowcanvas-auth-"));
    const first = readToken(directory);
    const store = new Store(":memory:");
    const { app } = createApp(store, {
      token: () => readToken(directory),
      dataDirectory: directory,
    });
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    try {
      const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
      expect(await acceptsCredential(url, first)).toBe(true);
      expect(await acceptsCredential(url, "stale")).toBe(false);
      const changed = "b".repeat(64);
      writeFileSync(join(directory, "mcp-token"), changed);
      expect(await acceptsCredential(url, first)).toBe(false);
      expect(await acceptsCredential(url, changed)).toBe(true);
      const health = await (await fetch(new URL("/api/health", url))).json();
      expect(health.dataDirectory).toBe(directory);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});
