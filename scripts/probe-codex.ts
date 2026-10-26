import { CodexRpc } from "./codex-rpc.js";
// Read the installed configuration as-is; never inject a working token into this probe.
const codex = new CodexRpc();
try {
  await codex.initialize();
  const inventory = await codex.request("mcpServerStatus/list", {
    serverName: "flowcanvas",
    detail: "toolsAndAuthOnly",
  });
  const server = inventory.data?.find(
    (item: any) => item.name === "flowcanvas",
  );
  const tools = Object.keys(server?.tools ?? {});
  if (
    !tools.includes("read_workspace") ||
    !tools.includes("edit_draft") ||
    !tools.includes("inspect_diagram") ||
    server?.toolsError
  )
    throw new Error(
      server?.toolsError ??
        "FlowCanvas tools were not discovered using the installed connection.",
    );
  console.log(
    "Codex discovered " +
      tools.length +
      " FlowCanvas tools using the installed credential helper.",
  );
  console.log(
    "Real Codex MCP discovery passed without creating a chat or running an agent.",
  );
} finally {
  codex.close();
}
