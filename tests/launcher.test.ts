import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

describe("client-independent launcher", () => {
  it("starts without Codex, keeps client settings intact, and exposes authenticated MCP tools", async () => {
    // A separate checkout keeps the launcher's instance record and data away
    // from the user's running service. It needs no installed agent client.
    const root = mkdtempSync(join(tmpdir(), "flowcanvas-launcher-"));
    for (const entry of ["src", "scripts", "package.json"])
      cpSync(resolve(entry), join(root, entry), { recursive: true });
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction");
    mkdirSync(join(root, "dist", "web"), { recursive: true });
    writeFileSync(join(root, "dist", "web", "index.html"), "<title>Launcher test</title>");
    const clientHome = join(root, "client-home");
    mkdirSync(clientHome);
    const config = "# Existing client settings must remain unchanged\n";
    writeFileSync(join(clientHome, "config.toml"), config);

    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()));
    const url = `http://127.0.0.1:${port}`;
    const data = join(root, "data");
    const credentials = join(root, "credentials");
    mkdirSync(credentials);
    const token = "c".repeat(64);
    writeFileSync(join(credentials, "mcp-token"), token);

    const child = spawn(process.execPath, ["--import", "tsx", "scripts/run.ts"], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_HOME: clientHome,
        FLOWCANVAS_CODEX_PATH: join(root, "codex-is-not-installed"),
        FLOWCANVAS_DATA_DIR: data,
        FLOWCANVAS_CREDENTIAL_DIR: credentials,
        FLOWCANVAS_PORT: String(port),
        FLOWCANVAS_MCP_URL: `${url}/mcp`,
      },
    });
    let output = "";
    const exited = once(child, "exit");
    const client = new Client({ name: "independent-client", version: "1" });
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`Launcher timed out: ${output}`)), 15000);
        const collect = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("FlowCanvas is ready:")) { clearTimeout(timer); done(); }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`Launcher exited (${code}): ${output}`)); });
      });
      expect(child.exitCode).toBeNull();
      expect((await fetch(url)).status).toBe(200);
      expect((await fetch(`${url}/mcp`)).status).toBe(401);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["read_workspace", "edit_draft", "inspect_diagram"]));
      const result = await client.callTool({ name: "list_concepts", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(readFileSync(join(clientHome, "config.toml"), "utf8")).toBe(config);
      expect(readdirSync(clientHome)).toEqual(["config.toml"]);
      expect(readFileSync(join(credentials, "mcp-token"), "utf8")).toBe(token);
      expect(output).not.toContain(token);
      expect(existsSync(join(root, ".local", "server-process.json"))).toBe(true);
    } finally {
      await client.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      // Remove the junction itself first; never recurse into shared dependencies.
      rmSync(join(root, "node_modules"), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);
});
