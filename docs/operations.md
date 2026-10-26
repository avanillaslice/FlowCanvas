# Local operation and recovery

[Back to README](../README.md)

## Start and stop

After installing dependencies and building, run `npm run up` from the repository root. It starts the service and runs a generic MCP connection check. Configure your agent separately using the [manual setup guide](agents.md). Keep the terminal open and use **Ctrl+C** there to close HTTP connections and the database. A second launcher rejects an existing service instead of attaching to it.

`npm run launch` is an alias for the same launcher. `npm start` serves the built browser application and MCP endpoint without the launcher's connection check. `npm run stop` removes older background instances; stop current foreground instances in their owning terminal.

The service binds to `127.0.0.1`, with a default URL of [http://127.0.0.1:4317](http://127.0.0.1:4317). Use one browser origin consistently to preserve tab identity.

## Storage

| Item | Default location |
| --- | --- |
| SQLite database on Windows | `%LOCALAPPDATA%\FlowCanvas\flowcanvas.db` |
| Database when `LOCALAPPDATA` is unset | `~/.local/share/FlowCanvas/flowcanvas.db` |
| MCP credential | `.local/mcp-token` inside the checkout |
| Launcher instance record | `.local/server-process.json` inside the checkout |
| Optional companion skill | Manually copied to a skills location supported by your agent client |

Projects, Concepts, drafts, and history persist outside the checkout by default. The credential and instance record are ignored by Git. Keep the credential private; it grants local MCP access. The application validates request hosts and origins and uses browser session credentials for UI actions.

The launcher records its directories so connection helpers in other shells use the same files, and clears live process ownership when it exits. Session selection is persisted, but previous browser ownership is not restored as an active shared connection after service shutdown.

## Configuration

Set environment variables before starting the service or running helpers.

| Variable | Purpose |
| --- | --- |
| `FLOWCANVAS_PORT` | HTTP port; default `4317` |
| `FLOWCANVAS_DATA_DIR` | Directory containing `flowcanvas.db`; also the default credential directory when explicitly set |
| `FLOWCANVAS_CREDENTIAL_DIR` | Explicit credential-directory override, taking precedence over the data directory |
| `FLOWCANVAS_MCP_URL` | MCP URL for the launcher and helpers; otherwise derived from `FLOWCANVAS_PORT` |
| `FLOWCANVAS_CODEX_PATH` | Full path to the native Codex executable, used only by the optional `codex:check` command |
| `CODEX_HOME` | Codex home override for the optional discovery check; not required by FlowCanvas |

For example, in PowerShell:

```powershell
$env:FLOWCANVAS_PORT = "4320"
npm run up
```

The launcher derives `http://127.0.0.1:4320/mcp`. Update the URL in your agent client manually. If `FLOWCANVAS_MCP_URL` is already set, update or clear it to match. Starting the service does not modify client configuration.

For an isolated data directory:

```powershell
$env:FLOWCANVAS_DATA_DIR = "C:\FlowCanvasData"
npm run up
```

Unless `FLOWCANVAS_CREDENTIAL_DIR` is also set, credentials go beside that database. Changing overrides does not move existing data. Use absolute directory paths and the same data override when backing up that instance.

## Back up

```powershell
npm run backup
```

The command uses SQLite's backup API and works while FlowCanvas is active. It writes `flowcanvas-backup-<timestamp>.db` beside the database and prints the destination. It reads `FLOWCANVAS_DATA_DIR` directly, so set that variable in the backup terminal for a custom location.

Do not copy only the live database file while writes are active; use the backup command for a consistent snapshot.

## Restore

1. Stop FlowCanvas in its owning terminal.
2. Preserve a copy of the current data directory.
3. Move the existing `flowcanvas.db`, `flowcanvas.db-wal`, and `flowcanvas.db-shm` files aside if present.
4. Copy the chosen backup into the data directory and name it `flowcanvas.db`.
5. Restart with the same configuration and check your Concepts and versions.

Browser session storage separately journals unacknowledged edits. Failed saves can recover in the affected tab and offer retry; a database backup covers committed data.

## Database migrations

The current schema is version 2. Opening a version 1 database creates `flowcanvas.db.backup-v1-<id>.db` beside it before migration. Newer schemas are rejected rather than downgraded.

Deleted drafts are excluded from normal reads, with source records retained to preserve immutable main-version history links. Saved main history persists across service restarts; the session's undo history does not.
