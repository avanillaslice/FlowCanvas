import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialDir, dataDir, readToken } from "../src/server/config.js";

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const processFile = join(projectRoot, ".local", "server-process.json");
export interface RuntimeInstance {
  pid: number;
  script: string;
  dataDir?: string;
  credentialDir?: string;
  url?: string;
  mode?: "foreground" | "background" | "stopped";
  ownerScript?: string;
}
export function readInstance(): RuntimeInstance | null {
  try {
    return JSON.parse(readFileSync(processFile, "utf8"));
  } catch {
    return null;
  }
}
export function connection() {
  const instance = readInstance();
  const url =
    process.env.FLOWCANVAS_MCP_URL ??
    `http://127.0.0.1:${process.env.FLOWCANVAS_PORT ?? "4317"}/mcp`;
  const sameInstance =
    instance?.script ===
      join(projectRoot, "dist", "server", "server", "index.js") &&
    instance.url === url;
  const directory = resolve(
    process.env.FLOWCANVAS_DATA_DIR ??
      (sameInstance ? instance?.dataDir : undefined) ??
      dataDir,
  );
  const credentials = resolve(
    process.env.FLOWCANVAS_CREDENTIAL_DIR ??
      (process.env.FLOWCANVAS_DATA_DIR ? directory : undefined) ??
      (sameInstance ? instance?.credentialDir : undefined) ??
      credentialDir,
  );
  return {
    url,
    dataDir: directory,
    credentialDir: credentials,
    tokenFile: join(credentials, "mcp-token"),
    token: readToken(credentials),
  };
}
export function credentialHelperCommand(tokenFile: string) {
  const paths = [
    process.execPath,
    join(projectRoot, "scripts", "mcp-headers.mjs"),
    tokenFile,
  ];
  return paths
    .map((path) => {
      if (/["\r\n]/.test(path))
        throw new Error(
          "The credential helper path contains an unsupported quote or line break.",
        );
      return `"${path.replaceAll("\\", "/")}"`;
    })
    .join(" ");
}
export async function acceptsCredential(url: string, token: string) {
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (response.status === 401 || response.status === 403) return false;
  if (response.status !== 405)
    throw new Error(
      `Unexpected response from FlowCanvas MCP endpoint (${response.status}).`,
    );
  return true;
}
