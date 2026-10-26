import { cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../skills/flowcanvas", import.meta.url));
const skills = join(
  process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  "skills",
);
mkdirSync(skills, { recursive: true });
const destination = join(skills, "flowcanvas");
cpSync(source, destination, { recursive: true });
console.log(`FlowCanvas skill installed: ${destination}`);
console.log("Restart Codex to discover the skill. Invoke it with $flowcanvas.");
