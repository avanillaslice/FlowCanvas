import { join, resolve } from "node:path";
import { Store } from "./store.js";
import { createApp } from "./app.js";
import { credentialDir, dataDir, readToken } from "./config.js";

export function startService(
  options: {
    directory?: string;
    credentialDirectory?: string;
    port?: number;
    webPath?: string;
  } = {},
) {
  const directory = resolve(options.directory ?? dataDir);
  const credentialDirectory = resolve(
    options.credentialDirectory ??
      (options.directory ? directory : credentialDir),
  );
  // The header helper must be able to read the credential before the first MCP request.
  readToken(credentialDirectory);
  const port = options.port ?? Number(process.env.FLOWCANVAS_PORT ?? 4317);
  const store = new Store(join(directory, "flowcanvas.db"));
  const { app, workspace } = createApp(store, {
    token: () => readToken(credentialDirectory),
    dataDirectory: directory,
    credentialDirectory,
    webPath: options.webPath ?? resolve("dist/web"),
  });
  const server = app.listen(port, "127.0.0.1");
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", (error) => {
      if (store.db.open) store.close();
      reject(error);
    });
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      const finish = () => {
        try {
          if (store.db.open) store.close();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      if (!server.listening) {
        finish();
        return;
      }
      // Stop accepting requests, end SSE/HTTP connections, then close SQLite.
      // Database commands are synchronous: no transaction is left half-applied.
      server.close((error) => {
        if (error) reject(error);
        else finish();
      });
      server.closeAllConnections();
    }));
  return { server, store, workspace, ready, close, directory };
}
