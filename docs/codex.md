# Codex integration

[Back to README](../README.md)

FlowCanvas exposes a local Streamable HTTP MCP endpoint at `http://127.0.0.1:4317/mcp`. The connection provides live tools; the companion skill provides guidance. Both use the same backend as the browser canvas.

## Install the companion skill

From the repository root:

```powershell
npm run skill:install
```

This copies `skills/flowcanvas` to `~/.codex/skills/flowcanvas`, or `$CODEX_HOME/skills/flowcanvas` when set. Restart Codex to discover it. Invoke `$flowcanvas` explicitly, or refer to FlowCanvas during a discussion for automatic skill selection.

The maintained source is [skills/flowcanvas/SKILL.md](../skills/flowcanvas/SKILL.md), with tool and connection references alongside it. Rerun the installer after updating that source. The skill alone cannot access live diagrams; MCP tools must also be connected.

## Configure the connection

```powershell
npm run up
```

The launcher starts FlowCanvas, registers `flowcanvas` in your Codex user configuration, and verifies the connection. A local HTTP header helper reads the service's credential file using absolute paths. Setup does not print the credential or depend on `FLOWCANVAS_MCP_TOKEN` in the terminal environment.

Restart Codex after initial setup or connection changes. Ordinary launches reuse the configuration. Keep the service's terminal open and stop it with Ctrl+C.

The helpers locate Codex on `PATH` or in its Windows desktop installation. For a custom installation, set `FLOWCANVAS_CODEX_PATH` to the full path of the native executable. No marketplace plugin or browser extension is required.

## Connection checks

With the service running, these commands can be run independently:

```powershell
npm run mcp:setup
npm run mcp:check
npm run codex:check
```

- `mcp:setup` registers or updates the endpoint and credential helper.
- `mcp:check` verifies an HTTP MCP handshake and a JSON-text tool call.
- `codex:check` starts a Codex app-server process and checks discovery using the installed configuration, without creating a chat or running a model.

The launcher runs all three automatically. Passing checks confirms access in the check process; an existing chat may still need Codex to restart and reload its tools.

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

A selected Concept can have no diagrams yet. Codex can create its first draft with `create_draft` and `sourceVersionId: null`. Draft edits require a fresh revision and commit as an atomic batch. Codex cannot apply drafts or change shared-tab ownership.

## Inspect rendered diagrams

`inspect_diagram` accepts `kind: "draft"` or `"main"`. It reports the revision/version, clipped headings, scrolling notes, overlapping blocks or labels, and older sub-agent calls entering side ports. By default it also returns a PNG bounded to 1600 × 1200 pixels. Use `includeImage: false` for measurements only.

`view: "shared_canvas"` means the displayed canvas was inspected. `view: "saved_preview"` means a hidden or explicitly addressed saved diagram was rendered with the same Canvas component in the shared tab. Inspection does not switch tabs, pan, zoom, change selection, apply drafts, or read a secondary tab's state.

A connected browser is required. Edits flush first, and ownership, selection, or draft revision changes reject stale results. Rendering failures are explicit. Measurements supplement visual review; they cannot establish architectural quality or overall readability. Images omit editing controls and empty placeholders.

See the [agent tool reference](../skills/flowcanvas/references/tools.md) for schemas and editing examples.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Codex cannot find tools | Keep FlowCanvas running, run `npm run codex:check`, and restart Codex if the connection was missing or failed when the chat started. |
| Service unreachable | Start `npm run up` and keep its terminal open. Confirm the endpoint and port. |
| Existing service reported | Stop it with Ctrl+C in its owning terminal before launching again. |
| Credential authentication fails | Stop the service and run `npm run up` again. Check the credential directory and restart Codex after connection changes. Keep `mcp-token` private. |
| No active workspace | Open FlowCanvas and share the intended tab. Sharing selects context; it does not install tools. |
| New tools missing after an update | Rebuild and restart FlowCanvas, reload its browser page, and restart Codex. |

See [configuration](operations.md#configuration) for custom ports and directories.
