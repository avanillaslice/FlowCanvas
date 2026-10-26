# FlowCanvas

A local visual workspace for sketching and discussing software and agent architecture with Codex.

Create diagrams by hand, ask Codex to explore an alternative, and compare editable drafts with saved main versions. FlowCanvas supports the discussion around a design; it does not execute the agents or processes in a diagram.

## Features

- **Projects and Concepts:** organise related architecture diagrams in named workspaces.
- **Versioned main diagrams:** apply a draft to save an immutable version, then keep editing. Explore alternatives from any saved version.
- **Shared editing with Codex:** read and edit drafts through a local Model Context Protocol (MCP) service. Applying a draft remains a manual browser action.
- **Purposeful connections:** distinguish normal flow, data requests, and sub-agent calls across six block types.
- **Canvas controls:** resize blocks, arrange diagrams, adjust connection routes, duplicate selections, and undo or redo edits.
- **Local persistence:** save Projects, Concepts, drafts, and history in SQLite, with a backup command for recovery.

## Requirements

- Node.js **22.12+ on the 22.x line, or 24+**, and npm. Windows is the primary development platform; other operating systems have not been verified.
- Git to clone the repository.
- Codex installed locally for the agent integration. The launcher must find its executable on `PATH` or in the Windows desktop installation.

The browser application can also run on its own, without Codex. FlowCanvas does not require an OpenAI API key.

## Quick start

```powershell
git clone https://github.com/avanillaslice/FlowCanvas.git
cd FlowCanvas
npm ci
npm run build
npm run skill:install
npm run up
```

Open [FlowCanvas at http://127.0.0.1:4317](http://127.0.0.1:4317).

`npm run up` starts the service in the foreground, registers the `flowcanvas` MCP connection in your Codex user configuration, and checks HTTP access and Codex tool discovery. Keep the terminal open; press **Ctrl+C** there to stop the service and close its database.

The skill installer copies the companion guidance into your Codex user skills directory. **Restart Codex after the first setup** to load the skill and MCP connection. Subsequent launches normally need only `npm run up`. Rebuild after updating the source and rerun `npm run skill:install` when the bundled skill changes.

To use the browser application without setting up Codex, run `npm start` after building instead. It starts the HTTP service without registering or checking an MCP connection.

## First diagram

1. Create a **Project**, then a **Concept** inside it.
2. Create a draft and add blocks from the palette. Give each a short heading and connect related steps.
3. Choose **Arrange**, then adjust blocks or connections as needed.
4. Ask Codex: “Use FlowCanvas to read my current draft and help me sketch an alternative.” You can also invoke the companion skill explicitly with `$flowcanvas`.
5. Click **Apply draft** to save main v1. The draft stays open; applying it again saves v2 and preserves v1.

The first browser tab supplies shared context. Use **Share this tab with Codex** to explicitly share another tab. The indicator identifies the context supplied to tools; it does not mean an agent is continuously watching the canvas.

## Documentation

| Guide | Contents |
| --- | --- |
| [Canvas guide](docs/canvas.md) | Drafts, versions, connections, layout, shortcuts, and saving |
| [Codex integration](docs/codex.md) | Skill installation, MCP setup, shared context, inspection, and troubleshooting |
| [Local operation and recovery](docs/operations.md) | Startup, configuration, storage, backups, and restoration |
| [Development](docs/development.md) | Development server, checks, architecture, and repository layout |
| [Agent tool reference](skills/flowcanvas/references/tools.md) | MCP operations and graph editing examples |

## Common commands

Run these from the repository root.

| Command | Purpose |
| --- | --- |
| `npm run up` | Start FlowCanvas and configure and verify its Codex connection |
| `npm start` | Start the built HTTP service only |
| `npm run dev` | Start the development UI and service |
| `npm run build` | Type-check and build the UI and server |
| `npm test` | Run service, storage, routing, layout, and MCP tests |
| `npm run test:e2e` | Run browser tests against a built application |
| `npm run backup` | Create a timestamped SQLite backup |
| `npm run skill:install` | Install or update the companion Codex skill |

See the [development guide](docs/development.md#checks) for browser-test prerequisites and the [Codex guide](docs/codex.md#connection-checks) for connection diagnostics.

## Scope

FlowCanvas supports local planning, plain multiline block notes, saved alternatives, and a local agent connection. Workflow execution, Markdown rendering, nested subflows, cloud collaboration, visual version diffs, and an export/import interface are not currently implemented.
