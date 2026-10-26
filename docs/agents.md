# Agent integration

[Back to README](../README.md)

FlowCanvas exposes a local MCP service for compatible agent clients. The optional companion skill supplies diagramming guidance. Setup is manual: the application does not install skills, register itself with clients, or modify their configuration.

## Compatibility

Your client must support **Streamable HTTP MCP**, reach the service on the same machine, and send a configured bearer-token header. FlowCanvas does not provide a stdio transport, legacy HTTP+SSE endpoint, or OAuth login. Clients that only support those connection modes cannot connect directly.

The default endpoint is `http://127.0.0.1:4317/mcp`. A cloud service cannot reach your computer through its own `localhost`; it needs a local client or a separately managed connection bridge. FlowCanvas binds to loopback and is intended for local use.

Tools return JSON text. Visual inspection additionally returns an MCP image block; clients and models without image support can use `includeImage: false` for measurements. Skill support is optional for calling tools. The skill uses the [Agent Skills format](https://agentskills.io/specification); transport details follow [Streamable HTTP MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

The automated suites exercise a generic MCP SDK client, including browser-backed edits and image inspection. Codex is the locally verified agent integration. Other agent products have not yet been individually verified.

## Configure a client manually

1. Build FlowCanvas and start it with `npm run up`. Keep the terminal open. Startup reports the MCP URL and credential file path without printing the token.
2. In your client's MCP settings, add a server named `flowcanvas` using **Streamable HTTP** and the displayed URL.
3. Configure authentication using the raw token in the local credential file. The default file is `.local/mcp-token` in the checkout. For an HTTP header field, use `Authorization: Bearer <token>`; if the client offers a bearer-token field, enter just the token. Read it locally, trim whitespace, and use the client's private settings or secret store rather than chat or a checked-in file.
4. Reload the client's MCP connection and check that tools such as `read_workspace`, `edit_draft`, and `inspect_diagram` appear.
5. Open FlowCanvas in a browser, select a Concept, and share the intended tab.

Configuration field names differ between clients; there is no universal client configuration JSON. If a client supports a command that returns authentication headers, it can invoke `scripts/mcp-headers.mjs` with the credential file path instead of storing a copy of the token. See the [Codex example](codex.md) for that approach. The helper prints credentials for the client to consume and should not be run as a diagnostic log.

The token persists across service restarts. Update your client if you change the port, checkout path used by a helper, or credential directory. See [configuration](operations.md#configuration) for overrides.

## Add the skill manually

Copy the entire [skills/flowcanvas](../skills/flowcanvas/SKILL.md) folder into a skill directory supported by your client. Keep `SKILL.md` and `references/` together. The optional `agents/openai.yaml` supplies Codex UI metadata; other clients can ignore it.

Reload skills according to your client's instructions. Invocation syntax and discovery locations are client-specific. The skill is guidance for using an already configured MCP connection; it does not establish authentication or install tools. When the bundled skill changes, manually update your copied folder.

## Connection checks

With FlowCanvas running, use `npm run mcp:check` from the checkout. This checks a real MCP handshake, tool discovery, and a JSON-text catalog read through a generic SDK client. The launcher runs it automatically; it does not start an agent or consume a model turn.

For Codex only, `npm run codex:check` checks the existing client configuration. Passing either check does not prove an already-open chat has refreshed its tool catalog.

## Shared context

Open the intended Concept in the shared tab, then ask:

> Use FlowCanvas to read my current draft and help me sketch an alternative.

No ID or browser URL is needed for the current selection.

| Request | Tool call |
| --- | --- |
| Read the selected draft | `read_diagram` with `kind: "draft"` and no IDs |
| Read the selected main | `read_diagram` with `kind: "main"` and no IDs |
| Read Concept metadata and diagram references | `read_concept` with no ID |
| Compare selected main and draft | `read_workspace` |

Selection-based reads ask the shared browser to flush pending edits. If it cannot confirm its contents, the service reports a busy, changed, or disconnected workspace. Explicit diagram IDs address saved diagrams without flushing pending browser edits.

Only the shared tab supplies selections. Other tabs do not automatically become shared, and their selections are not exposed. Saved diagrams remain queryable by ID; the header's Concept ID can be copied for a specific lookup. Workspace awareness refreshes through tool calls. UI changes do not automatically send content into a conversation.

A selected Concept can have no diagrams yet. An agent can create its first draft with `create_draft` and `sourceVersionId: null`. Draft edits require a fresh revision and commit as an atomic batch. Agents cannot apply drafts or change shared-tab ownership.

## Inspect rendered diagrams

`inspect_diagram` accepts `kind: "draft"` or `"main"`. It reports the revision/version, clipped headings, scrolling notes, overlapping blocks or labels, and older sub-agent calls entering side ports. By default it also returns a PNG bounded to 1600 × 1200 pixels. Use `includeImage: false` for measurements only.

`view: "shared_canvas"` means the displayed canvas was inspected. `view: "saved_preview"` means a hidden or explicitly addressed saved diagram was rendered with the same Canvas component in the shared tab. Inspection does not switch tabs, pan, zoom, change selection, apply drafts, or read a secondary tab's state.

A connected browser is required. Edits flush first, and ownership, selection, or draft revision changes reject stale results. Rendering failures are explicit. Measurements supplement visual review; they cannot establish architectural quality or overall readability. Images omit editing controls and empty placeholders.

See the [agent tool reference](../skills/flowcanvas/references/tools.md) for schemas and editing examples.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Service unreachable | Start FlowCanvas and check the port. The MCP client must be able to reach this machine's loopback address. |
| Authentication fails | Check the configured token or header helper against the credential path reported at startup. FlowCanvas expects a bearer header, not an OAuth login. |
| MCP check passes but the agent has no tools | Reload that client's MCP connection or restart the client. Confirm that this chat has tool access. |
| No active workspace | Open the browser and share the intended tab. Sharing selects context; it does not install tools. |
| Inspection images unavailable | Check client/model image support. Measurements can be requested with `includeImage: false`; they do not confirm visual readability. |
| Tools missing after an update | Rebuild, restart FlowCanvas, reload its browser page, and reload the client's MCP connection. |
| Existing service reported | Stop it with Ctrl+C in its owning terminal before launching again. |

See [configuration](operations.md#configuration) for custom ports and directories.
