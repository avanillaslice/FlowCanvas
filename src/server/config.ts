import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Resolve identically from src/server and the compiled dist/server/server files,
// including when PowerShell starts the application from another directory.
let projectDirectory = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(projectDirectory, "package.json"))) {
  const parent = dirname(projectDirectory);
  if (parent === projectDirectory)
    throw new Error("Could not locate the FlowCanvas installation directory.");
  projectDirectory = parent;
}
export const dataDir =
  process.env.FLOWCANVAS_DATA_DIR ??
  join(
    process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"),
    "FlowCanvas",
  );
export const credentialDir =
  process.env.FLOWCANVAS_CREDENTIAL_DIR ??
  process.env.FLOWCANVAS_DATA_DIR ??
  join(projectDirectory, ".local");

export function readToken(directory = credentialDir) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "mcp-token");
  try {
    writeFileSync(file, randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const token = readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/i.test(token))
    throw new Error(`Invalid FlowCanvas credential file: ${file}`);
  return token;
}
