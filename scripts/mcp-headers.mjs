import { readFileSync } from "node:fs";
// Called privately by Codex; stdout is a credential response, never a user-facing log.
const token = readFileSync(process.argv[2], "utf8").trim();
if (!/^[a-f0-9]{64}$/i.test(token))
  throw new Error("The FlowCanvas credential file is invalid.");
process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }));
