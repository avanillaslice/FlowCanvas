# Codex example

[Back to README](../README.md) · [General agent setup](agents.md)

Codex connects to the same local MCP service as other clients. If FlowCanvas already works in Codex, keep your existing MCP entry, credential helper, and installed skill. Starting with `npm run up` or a personal launcher continues to serve the same endpoint and token; startup no longer registers or rewrites client configuration.

## Manual MCP configuration

Start FlowCanvas, then edit your user `~/.codex/config.toml` (or the configuration under `CODEX_HOME` when set). Add or update one `flowcanvas` entry. This Windows example uses placeholder paths; replace all three paths with your Node executable, checkout, and credential file:

```toml
[mcp_servers.flowcanvas]
url = "http://127.0.0.1:4317/mcp"
http_headers_helper = '''"C:/Program Files/nodejs/node.exe" "C:/path/to/FlowCanvas/scripts/mcp-headers.mjs" "C:/path/to/FlowCanvas/.local/mcp-token"'''
```

Use absolute paths. The helper reads the credential file and returns an Authorization header privately to Codex. It does not depend on `FLOWCANVAS_MCP_TOKEN`. Replace conflicting authorization settings if migrating an old entry, since configured bearer tokens can take precedence over the helper. Restart Codex after changing its configuration. See [official Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

The helper's path and credential format are unchanged for existing installations. Directory or port overrides require matching edits to the configuration. FlowCanvas does not implement OAuth login.

## Manual skill placement

Copy the entire `skills/flowcanvas` folder into a skill location your Codex installation discovers. Current documentation lists `~/.agents/skills/flowcanvas` for a user-wide skill and `.agents/skills/flowcanvas` within a repository. See [official skill locations](https://learn.chatgpt.com/docs/build-skills).

Existing FlowCanvas installations may already have a working copy under `~/.codex/skills/flowcanvas` or `CODEX_HOME/skills/flowcanvas`. Update that discovered copy in place rather than creating a duplicate. The repository includes optional `agents/openai.yaml` metadata for Codex. If the updated skill does not appear, restart Codex.

Invoke `$flowcanvas` or ask Codex to use FlowCanvas during a discussion. Skill placement and MCP configuration are separate manual steps.

## Connection checks

With FlowCanvas running:

```powershell
npm run mcp:check
npm run codex:check
```

The first checks the service through a generic MCP client. The second starts a Codex app-server process and verifies the installed configuration without creating a chat, running a model, or changing settings. It locates the native Codex executable on PATH or in the Windows desktop installation; use `FLOWCANVAS_CODEX_PATH` for a custom executable path.

If the checks pass but your chat lacks tools, reload Codex's connection. The **Shared with agents** indicator identifies the browser context supplied to Codex and any other connected clients; it does not indicate an agent is continuously watching.

For shared context, inspection, and troubleshooting, see the [agent guide](agents.md#shared-context).
