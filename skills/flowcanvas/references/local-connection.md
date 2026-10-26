# Local connection

Run commands from the FlowCanvas repository root, the directory containing `package.json`. The default browser URL is `http://127.0.0.1:4317`, and the Streamable HTTP MCP endpoint is `http://127.0.0.1:4317/mcp`. The configured server name is `flowcanvas`. Directory and port overrides can change these defaults. This is a direct local MCP service, not a marketplace plugin.

The user runs `npm run up` from the repository root and keeps that terminal open. Ctrl+C closes the service and database. Do not start a detached copy or stop the user's service as a diagnostic action. A second launcher cannot take over a service already running in another terminal.

Codex's connection is configured in `%USERPROFILE%\.codex\config.toml` (or `$CODEX_HOME\config.toml` when set). The `[mcp_servers.flowcanvas]` entry points at the local endpoint and uses `http_headers_helper` to invoke the installation's `scripts/mcp-headers.mjs`. This helper reads the ignored `.local/mcp-token` file in the installation. Do not print, paste, or request the credential. The skill does not establish authentication or install the MCP tools by itself.

When tools are unavailable, inspect their current availability first. If needed, run these diagnostics from the installation directory:

```powershell
npm run mcp:check
npm run codex:check
```

The first checks the HTTP MCP handshake and a structured call. The second uses a fresh installed Codex process to verify tool discovery against its actual configuration; it does not create a chat or run a model. Neither result proves that the existing conversation has refreshed its tool catalog.

- If the service is unreachable, ask the user to run `npm run up` from the repository root in their own terminal.
- If authentication fails, check the configured helper's credential path against the running service's `/api/health` `credentialDirectory`. Never reveal credential contents. By default, the service and helper use the checkout's `.local/mcp-token` file.
- After connection changes or a failed startup in Codex, keep FlowCanvas running and ask the user to restart Codex so it can load the connection. Routine FlowCanvas restarts preserve its credential and should not require repeatedly reconfiguring Codex.
- If both probes pass but this chat still lacks the tools, report that the current chat's connection needs reloading. Do not search unrelated plugins or browser inventories, and do not ask for a tab URL as a substitute.
- Once tools are available, `read_workspace` determines the shared context. “Shared with Codex” in the UI means that this tab supplies that context; it does not certify a connected agent.

Setup can be rerun with `npm run mcp:setup`, normally handled by `npm run up`. The database defaults to `%LOCALAPPDATA%\FlowCanvas\flowcanvas.db` on Windows, or `~/.local/share/FlowCanvas/flowcanvas.db` when `LOCALAPPDATA` is unset. `FLOWCANVAS_DATA_DIR` overrides data storage and defaults credentials to that directory; `FLOWCANVAS_CREDENTIAL_DIR` overrides credentials explicitly. Changing only the credential location does not relocate saved Concepts.
