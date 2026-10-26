# Local connection

FlowCanvas is a local Streamable HTTP MCP service. The default endpoint is `http://127.0.0.1:4317/mcp`, usually named `flowcanvas` in the client. The browser uses `http://127.0.0.1:4317`. Port and directory overrides can change these defaults.

The user starts `npm run up` from the checkout and keeps that terminal open. Ctrl+C closes the service and database. Do not start a detached copy or stop the user's service as a diagnostic action. Startup checks MCP access but does not install skills or configure an agent.

## Client requirements

The client must reach this machine's loopback address, support Streamable HTTP, and send `Authorization: Bearer <token>`. Stdio-only clients and cloud clients without local connectivity cannot connect directly. FlowCanvas does not provide OAuth login.

The default credential file is the checkout's ignored `.local/mcp-token`. Startup prints its path, never its contents. `FLOWCANVAS_DATA_DIR` defaults credentials to that directory; `FLOWCANVAS_CREDENTIAL_DIR` overrides credentials explicitly. Keep token contents out of chat and diagnostic output. The skill does not establish authentication or install tools.

Connection and skill setup are manual and client-specific. Existing Codex connections may use `scripts/mcp-headers.mjs` as `http_headers_helper`; retain a working configuration. Do not assume every client supports this helper or Codex's configuration format.

## Diagnose missing tools

Check available tool names first. From the checkout, `npm run mcp:check` verifies the HTTP handshake and a JSON-text tool call through a generic SDK client. It does not run a model. For Codex only, `npm run codex:check` can additionally verify discovery through its installed configuration. Neither result proves that the current chat has refreshed its tool catalog.

- If the service is unreachable, ask the user to start FlowCanvas in their terminal. Check the endpoint and whether the client can access local services.
- If authentication fails, compare the client's token source with the credential path reported by startup or the local `/api/health` response. Do not reveal the token.
- If checks pass but the chat has no tools, reload the client's MCP connection or restart it. Do not substitute plugin searches, browser inventories, or a requested tab URL.
- If tools are present but there is no active workspace, open FlowCanvas and share the intended tab. **Shared with agents** identifies context, not a continuously connected agent.
- If the client cannot consume image results, use `inspect_diagram` with `includeImage: false`; report that visual verification remains incomplete.

The database defaults to `%LOCALAPPDATA%\FlowCanvas\flowcanvas.db` on Windows, or `~/.local/share/FlowCanvas/flowcanvas.db` when LOCALAPPDATA is unset. Changing only the credential location does not move saved Concepts.
