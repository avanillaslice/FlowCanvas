import { CodexRpc } from "./codex-rpc.js";
import {
  acceptsCredential,
  connection,
  credentialHelperCommand,
} from "./connection.js";
const current = connection();
if (!(await acceptsCredential(current.url, current.token)))
  throw new Error(
    "The running FlowCanvas service is using a different credential. Stop its owning terminal with Ctrl+C, then run npm run up from the repository root before configuring Codex.",
  );
const helper = credentialHelperCommand(current.tokenFile);
const codex = new CodexRpc();
try {
  await codex.initialize();
  const read = await codex.request("config/read", { includeLayers: false });
  const previous = read.config?.mcp_servers?.flowcanvas;
  const configured =
    previous?.url === current.url &&
    previous?.http_headers_helper === helper &&
    previous?.enabled !== false &&
    !previous?.bearer_token_env_var &&
    !Object.keys(previous?.http_headers ?? {}).some(
      (key) => key.toLowerCase() === "authorization",
    ) &&
    !Object.keys(previous?.env_http_headers ?? {}).some(
      (key) => key.toLowerCase() === "authorization",
    );
  if (configured) {
    console.log(
      "FlowCanvas MCP is already configured to read the local credential file.",
    );
  } else {
    const result = await codex.request("config/value/write", {
      keyPath: "mcp_servers.flowcanvas",
      value: { url: current.url, http_headers_helper: helper },
      mergeStrategy: "replace",
    });
    if (result.status !== "ok" && result.status !== "okOverridden")
      throw new Error(
        "Codex did not confirm saving the FlowCanvas connection.",
      );
    console.log(
      "FlowCanvas MCP configured using its local credential file. Restart Codex once after this connection change; ordinary launches do not need new environment variables.",
    );
  }
} finally {
  codex.close();
}
