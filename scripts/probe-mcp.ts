import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { connection } from "./connection.js";
const current = connection();
const client = new Client({
  name: "flowcanvas-verification",
  version: "0.1.0",
});
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(current.url), {
      requestInit: { headers: { Authorization: `Bearer ${current.token}` } },
    }),
  );
  const { tools } = await client.listTools();
  if (!tools.some((tool) => tool.name === "inspect_diagram"))
    throw new Error("The running FlowCanvas service is outdated. Rebuild, restart it in its owning terminal, and reload the browser page.");
  console.log(
    `MCP handshake passed. Tools: ${tools.map((t) => t.name).join(", ")}`,
  );
  const result = await client.callTool({
    name: "list_concepts",
    arguments: {},
  });
  if (result.isError) throw new Error("MCP list_concepts failed.");
  if (result.structuredContent !== undefined) throw new Error("Expected text-only MCP result.");
  const content = result.content as { type: string; text: string }[];
  if (content.length !== 1 || content[0].type !== "text") throw new Error("Expected one JSON text block.");
  const payload = JSON.parse(content[0].text);
  if (!Array.isArray(payload.projects) || !Array.isArray(payload.concepts)) throw new Error("Invalid catalog response.");
  console.log("JSON-text tool call passed. No apply tool is exposed.");
} catch (error) {
  if ((error as { code?: number }).code === 401)
    throw new Error(
      `FlowCanvas rejected the credential from ${current.tokenFile}. Stop its owning terminal with Ctrl+C, then run npm run up from the repository root to reload the service and connection.`,
    );
  throw error;
} finally {
  await client.close();
}
