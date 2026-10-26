import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Graph } from "../../src/shared/model.js";
const legacyMainFlow: Graph = JSON.parse(readFileSync(resolve("tests/fixtures/legacy-main-flow.json"), "utf8"));
const mixedPortFlow: Graph = JSON.parse(readFileSync(resolve("tests/fixtures/mixed-port-flow.json"), "utf8"));

async function client() {
  const value = new Client({ name: "browser-integration", version: "1" });
  await value.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4318/mcp"), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${readFileSync(resolve(".local/e2e-data/mcp-token"), "utf8").trim()}`,
        },
      },
    }),
  );
  return value;
}
const call = async (mcp: Client, name: string, args = {}) => {
  const result = await mcp.callTool({ name, arguments: args });
  expect(result).not.toHaveProperty("structuredContent");
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
};
async function selectConnection(page: Page, edge: Locator) {
  const path = edge.locator(".react-flow__edge-path");
  // A perfectly horizontal SVG path has a zero-height bounding box despite
  // its visible stroke. Wait for its geometry rather than box visibility.
  await expect.poll(() => path.evaluate((element) => (element as SVGPathElement).getTotalLength())).toBeGreaterThan(0);
  const position = await path.evaluate((element) => {
    const path = element as SVGPathElement;
    // Click near the source, on the actual line and before the label.
    const point = path.getPointAtLength(Math.min(18, path.getTotalLength() * 0.1)).matrixTransform(path.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(position.x, position.y);
  await expect(edge).toHaveClass(/selected/);
}
// Presentation assertions use the browser API; MCP omits layout and ports.
async function readWorkspaceLayout(mcp: Client, page: Page) {
  const workspace = await call(mcp, "read_workspace");
  const resumeId = await page.evaluate(() => sessionStorage.getItem("flowcanvas:session"));
  const session = await (await page.request.post("/api/session", { data: { resumeId } })).json();
  const headers = { "x-session-id": session.id, "x-session-token": session.token };
  for (const [key, route] of [["selectedDraft", "drafts"], ["selectedMain", "versions"]]) {
    if (workspace[key]) workspace[key] = await (await page.request.get(
      "/api/" + route + "/" + workspace[key].id, { headers },
    )).json();
  }
  return workspace;
}
async function fitArrangedDraft(
  page: Page,
  draft: { graph: { nodes: { id: string; x: number; y: number }[] } },
) {
  const pane = page.locator(".draft-pane");
  // The arrange response arrives before the editor refresh and its automatic fit.
  // Wait for the actual arranged positions, then fit that same graph before drawing.
  for (const node of draft.graph.nodes) {
    await expect(
      pane.locator(`.react-flow__node[data-id="${node.id}"]`),
    ).toHaveCSS("transform", `matrix(1, 0, 0, 1, ${node.x}, ${node.y})`);
  }
  await pane.getByRole("button", { name: "Fit to view", exact: true }).click();
}
async function initialize(
  page: Page,
  name = `Flow ${Date.now()}`,
  createInitialDraft = true,
) {
  await page.goto("/");
  await expect(
    page.getByRole("button", {
      name: /Shared with agents|Share this tab with agents/,
    }),
  ).toBeVisible();
  const share = page.getByRole("button", {
    name: "Share this tab with agents",
    exact: true,
  });
  if (await share.count()) await share.click();
  await page
    .getByRole("button", { name: "New project", exact: true })
    .first()
    .click();
  await page.getByRole("textbox", { name: "Project name" }).fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: `New concept in ${name}` }).click();
  await page
    .getByRole("textbox", { name: "Concept name" })
    .fill(`${name} concept`);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New draft", exact: true }),
  ).toBeVisible();
  if (!createInitialDraft) return name;
  await page.getByRole("button", { name: "New draft", exact: true }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "New - Initial flow", exact: true }),
  ).toBeVisible();
  return name;
}

test("inspection measures real clipping, captures PNG and leaves selection and viewport unchanged", async ({ page }, testInfo) => {
  await initialize(page, `Inspection ${Date.now()}`);
  const mcp = await client();
  try {
    const draft = await call(mcp, "read_diagram", { kind: "draft" });
    await call(mcp, "edit_draft", { conceptId: draft.conceptId, draftId: draft.id, expectedRevision: draft.revision, operationId: crypto.randomUUID(), operations: [
      { kind: "add_node", node: { id: "caller", type: "agent", label: "This heading is intentionally much too long to fit inside the block", text: "A very long body line\n".repeat(35), x: 3000, y: 2000 } },
      { kind: "add_node", node: { id: "worker", type: "subagent", label: "Research", x: 3000, y: 2350 } },
      { kind: "add_edge", edge: { id: "delegate", source: "caller", target: "worker", kind: "subagent", label: "Find evidence" } },
    ] });
    const pane = page.locator(".draft-pane");
    await expect(pane.locator(".react-flow__node")).toHaveCount(2);
    await pane.getByRole("button", { name: "Fit to view", exact: true }).click();
    const transform = await pane.locator(".react-flow__viewport").getAttribute("style");
    const response = await mcp.callTool({ name: "inspect_diagram", arguments: { kind: "draft" } });
    expect(response.isError).toBeFalsy();
    const content = response.content as any[];
    const result = JSON.parse(content[0].text);
    expect(result.status).toBe("rendered");
    expect(result.view).toBe("shared_canvas");
    expect(result.bounds.width).toBeLessThan(400);
    expect(result.bounds.height).toBeLessThan(700);
    expect(result.issues).toEqual(expect.arrayContaining([
      { kind: "heading_clipped", ids: ["caller"] }, { kind: "body_scrolls", ids: ["caller"] },
    ]));
    expect(result.issues.some((i: any) => i.kind === "subagent_side_target")).toBe(false);
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    const png = Buffer.from(content[1].data, "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    await testInfo.attach("inspection-preview", { body: png, contentType: "image/png" });
    await page.screenshot({ path: testInfo.outputPath("inspection-browser.png") });
    await import("node:fs/promises").then((fs) => fs.writeFile(testInfo.outputPath("inspection-preview.png"), png));
    expect(await pane.locator(".react-flow__viewport").getAttribute("style")).toBe(transform);
    const noImage = await call(mcp, "inspect_diagram", { kind: "draft", includeImage: false });
    expect(noImage.status).toBe("rendered");
    expect(noImage.preview).toBeUndefined();
    const saved = await readWorkspaceLayout(mcp, page);
    expect(saved.selectedDraft.graph.edges[0].targetHandle).toBe("in-top");
    const repaired = await call(mcp, "edit_draft", { conceptId: draft.conceptId, draftId: draft.id, expectedRevision: saved.selectedDraft.revision,
      operationId: crypto.randomUUID(), operations: [{ kind: "update_node", id: "caller", patch: { label: "Main", text: "Delegate the search" } }] });
    expect(repaired.revision).toBeGreaterThan(result.revision);
    const clean = await call(mcp, "inspect_diagram", { kind: "draft", includeImage: false });
    expect(clean.status).toBe("rendered");
    expect(clean.issues).toEqual([]);
    const alternative = await call(mcp, "create_draft", { conceptId: draft.conceptId, name: "Preview without navigation", sourceDraftId: draft.id,
      expectedSourceRevision: clean.revision, operationId: crypto.randomUUID() });
    const snapshot = await mcp.callTool({ name: "inspect_diagram", arguments: { kind: "draft", diagramId: alternative.draftId } });
    const snapshotContent = snapshot.content as any[];
    expect(snapshot.isError).toBeFalsy();
    expect(JSON.parse(snapshotContent[0].text)).toMatchObject({ status: "rendered", view: "saved_preview", issues: [] });
    expect(snapshotContent[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect((await call(mcp, "read_diagram", { kind: "draft" })).id).toBe(draft.id);
    expect(await page.locator('[data-canvas^="inspection-"]').count()).toBe(0);
    await page.getByRole("button", { name: "Apply draft", exact: true }).click();
    const main = await call(mcp, "read_diagram", { kind: "main" });
    const mainInspection = await call(mcp, "inspect_diagram", { kind: "main", includeImage: false });
    expect(mainInspection).toMatchObject({ status: "rendered", kind: "main", diagramId: main.id, revision: main.number, issues: [] });
  } finally { await mcp.close(); }
});

test("Arrange respects bottom calls; routes avoid blocks and labels stay clear; bends persist and undo", async ({ page }) => {
  await initialize(page, `Routing ${Date.now()}`);
  const mcp = await client();
  const pane = page.locator(".draft-pane");
  try {
    const workspace = await call(mcp, "read_workspace");
    const draft = workspace.selectedDraft;
    const nodes = [
      { id: "caller", type: "agent", label: "Main Agent", x: 0, y: 0, width: 250, height: 180 },
      { id: "save", type: "process", label: "Save response", x: 950, y: 0, width: 250, height: 180 },
      { id: "blocker", type: "store", label: "Intervening block", x: 450, y: -50, width: 250, height: 270 },
      { id: "review", type: "subagent", label: "Review", x: 30, y: 450, width: 250, height: 180 },
      { id: "author", type: "subagent", label: "Author", x: 450, y: 450, width: 250, height: 180 },
      { id: "research", type: "subagent", label: "Shared research", x: 250, y: 850, width: 250, height: 180 },
    ];
    await call(mcp, "edit_draft", { conceptId: workspace.concept.id, draftId: draft.id, expectedRevision: draft.revision, operationId: crypto.randomUUID(), operations: [
      ...nodes.map((node) => ({ kind: "add_node", node })),
      { kind: "add_edge", edge: { id: "route", source: "caller", target: "save", label: "Save validated response and continuation references" } },
      ...[["caller", "review"], ["caller", "author"], ["review", "research"], ["author", "research"]].map(([source, target], i) => ({ kind: "add_edge", edge: { id: `call-${i}`, source, target, kind: "subagent", targetHandle: "in-top" } })),
    ] });
    await expect(pane.locator(".react-flow__node")).toHaveCount(nodes.length);
    await pane.getByRole("button", { name: "Fit to view", exact: true }).click();
    const checkGeometry = async () => {
      // Sample the actual rounded SVG paths in screen coordinates. Ports sit
      // on block borders; no interior point may pass underneath a block.
      return pane.evaluate((element) => {
        const blocks = [...element.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect());
        const hits: string[] = [];
        for (const path of element.querySelectorAll<SVGPathElement>(".react-flow__edge-path")) {
          const matrix = path.getScreenCTM()!;
          for (let d = 2; d < path.getTotalLength() - 2; d += 3) {
            const p = path.getPointAtLength(d).matrixTransform(matrix);
            if (blocks.some((b) => p.x > b.left + 2 && p.x < b.right - 2 && p.y > b.top + 2 && p.y < b.bottom - 2)) { hits.push(path.id); break; }
          }
        }
        for (const label of element.querySelectorAll<HTMLElement>(".edge-label")) {
          if (!label.textContent) continue;
          const a = label.getBoundingClientRect();
          if (blocks.some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)) hits.push(`label:${label.dataset.edgeId}`);
        }
        return hits;
      });
    };
    await expect.poll(checkGeometry).toEqual([]);
    const arrangedResponse = page.waitForResponse((r) => r.url().endsWith("/api/arrange") && r.ok());
    await pane.getByRole("button", { name: "Arrange", exact: true }).click();
    const arranged = await (await arrangedResponse).json();
    await fitArrangedDraft(page, arranged);
    const byId = new Map<string, any>(arranged.graph.nodes.map((n: any) => [n.id, n]));
    for (const e of arranged.graph.edges.filter((e: any) => e.kind === "subagent")) {
      expect(byId.get(e.target).y).toBeGreaterThan(byId.get(e.source).y + byId.get(e.source).height + 48);
    }
    expect(byId.get("save").x).toBeGreaterThan(byId.get("caller").x + 250 + 180);
    await expect.poll(checkGeometry).toEqual([]);

    const edge = pane.locator('.react-flow__edge[data-id="route"]');
    const selectRoute = () => selectConnection(page, edge);
    await selectRoute();
    const grip = pane.getByRole("button", { name: /Move connection segment/ }).first();
    await expect(grip).toBeVisible();
    const before = await edge.locator(".react-flow__edge-path").getAttribute("d");
    const bounds = (await grip.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 60, { steps: 10 });
    await page.mouse.up();
    await expect(pane.getByRole("button", { name: "Reset connection route", exact: true })).toBeVisible();
    await expect(edge.locator(".react-flow__edge-path")).not.toHaveAttribute("d", before!);
    await expect.poll(checkGeometry).toEqual([]);
    const moved = await readWorkspaceLayout(mcp, page);
    const pins = moved.selectedDraft.graph.edges.find((e: any) => e.id === "route").waypoints;
    expect(pins.length).toBeGreaterThan(0);
    await page.reload();
    await expect(pane.locator(".react-flow__node")).toHaveCount(nodes.length);
    await expect(page.getByRole("button", { name: "Shared with agents", exact: true })).toBeVisible();
    const restored = await readWorkspaceLayout(mcp, page);
    expect(restored.selectedDraft.graph.edges.find((e: any) => e.id === "route").waypoints).toEqual(pins);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(async () => {
      const value = await readWorkspaceLayout(mcp, page);
      return value.selectedDraft.graph.edges.find((e: any) => e.id === "route").waypoints;
    }).toBeUndefined();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect.poll(async () => {
      const value = await readWorkspaceLayout(mcp, page);
      return value.selectedDraft.graph.edges.find((e: any) => e.id === "route").waypoints;
    }).toEqual(pins);
    await selectRoute();
    await pane.getByRole("button", { name: "Reset connection route", exact: true }).click();
    await expect(pane.getByRole("button", { name: "Reset connection route", exact: true })).toHaveCount(0);
    await expect.poll(checkGeometry).toEqual([]);
    await page.screenshot({ path: ".local/arrange-routing.png" });
  } finally { await mcp.close(); }
});

test("Arrange keeps branches compact and aligns the search collection Fetch connection", async ({ page }) => {
  await initialize(page, `Compact layout ${Date.now()}`);
  const mcp = await client();
  const pane = page.locator(".draft-pane");
  try {
    const workspace = await call(mcp, "read_workspace");
    const nodes = [
      ["main", "agent", 200], ["validate", "process", 200], ["naming", "agent", 650],
      ["tall-peer", "subagent", 650], ["worker", "subagent", 200],
      ["research", "subagent", 300], ["search", "process", 180], ["index", "store", 180],
    ].map(([id, type, height]) => ({ id, type, label: id, x: 0, y: 0, width: 280, height }));
    const edges = [
      { id: "go", source: "main", target: "validate", label: "Go" },
      { id: "naming", source: "validate", target: "naming", label: "Queue naming if eligible" },
      { id: "left-call", source: "main", target: "tall-peer", kind: "subagent", sourceHandle: "subagent-left", targetHandle: "in-top" },
      { id: "right-call", source: "main", target: "worker", kind: "subagent", sourceHandle: "subagent-right", targetHandle: "in-top" },
      { id: "nested-call", source: "worker", target: "research", kind: "subagent", targetHandle: "in-top" },
      { id: "fetch", source: "research", target: "search", kind: "fetch" },
      { id: "collection", source: "search", target: "index", kind: "fetch", label: "Search selected collection" },
    ];
    await call(mcp, "edit_draft", { conceptId: workspace.concept.id, draftId: workspace.selectedDraft.id, expectedRevision: workspace.selectedDraft.revision,
      operationId: crypto.randomUUID(), operations: [
        ...nodes.map((node) => ({ kind: "add_node", node })), ...edges.map((edge) => ({ kind: "add_edge", edge })),
      ] });
    await expect(pane.locator(".react-flow__node")).toHaveCount(nodes.length);
    const response = page.waitForResponse((r) => r.url().endsWith("/api/arrange") && r.ok());
    await pane.getByRole("button", { name: "Arrange", exact: true }).click();
    const arranged = await (await response).json();
    await fitArrangedDraft(page, arranged);
    const byId = new Map<string, any>(arranged.graph.nodes.map((n: any) => [n.id, n]));
    expect(byId.get("validate").x - byId.get("main").x - 280).toBeLessThan(140);
    expect(byId.get("worker").y - byId.get("main").y - 200).toBeLessThanOrEqual(120);
    expect(byId.get("research").y - byId.get("worker").y - 200).toBeLessThanOrEqual(120);
    for (const id of ["fetch", "collection"]) {
      const path = pane.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`);
      await expect.poll(() => path.evaluate((p) => (p as SVGPathElement).getBBox().height)).toBeLessThan(1);
    }
    await expect.poll(() => pane.evaluate((element) => {
      const blocks = [...element.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect());
      return [...element.querySelectorAll<HTMLElement>(".edge-label")].filter((label) => {
        const a = label.getBoundingClientRect();
        return !!label.textContent && blocks.some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
      }).map((label) => label.dataset.edgeId);
    })).toEqual([]);
    await page.screenshot({ path: ".local/compact-arrange.png" });
  } finally { await mcp.close(); }
});

test("mixed flow keeps neighboring connectors in their corridor after resizing and zooming", async ({ page }) => {
  await initialize(page, `Connection corridors ${Date.now()}`);
  const mcp = await client();
  const pane = page.locator(".draft-pane");
  try {
    const workspace = await call(mcp, "read_workspace");
    const nodes = [
      ["request", "interface", 300.25, 100.5], ["context", "process", 300.5, 200.25],
      ["main", "agent", 300.25, 200.5], ["validate", "process", 300.75, 200.25],
      ["history", "store", 300.25, 200.5], ["show", "interface", 300.25, 200.5],
      ["naming", "agent", 300.5, 200.5], ["review", "subagent", 350.5, 255.25],
      ["author", "subagent", 350.25, 220.5], ["research", "subagent", 375.5, 290.25],
      ["search", "process", 300.25, 200.5], ["index", "store", 300.5, 200.25],
    ].map(([id, type, width, height]) => ({ id, type, label: id, x: 0, y: 0, width, height }));
    const edges = [
      { id: "submit", source: "request", target: "context", label: "Submit request" },
      { id: "context", source: "context", target: "main", label: "Supply routing context" },
      { id: "finish", source: "main", target: "validate" },
      { id: "load-state", source: "context", target: "history", kind: "fetch" },
      { id: "save-state", source: "validate", target: "history", kind: "fetch", label: "Save completed turn and result references" },
      { id: "show", source: "validate", target: "show", label: "Present validated result" },
      { id: "name", source: "validate", target: "naming", label: "Queue naming if eligible" },
      { id: "review", source: "main", target: "review", kind: "subagent", sourceHandle: "subagent-left", targetHandle: "in-top" },
      { id: "author", source: "main", target: "author", kind: "subagent", sourceHandle: "subagent-right", targetHandle: "in-top" },
      { id: "research", source: "main", target: "research", kind: "subagent", targetHandle: "in-top" },
      { id: "review-research", source: "review", target: "research", kind: "subagent", targetHandle: "in-top" },
      { id: "author-research", source: "author", target: "research", kind: "subagent", targetHandle: "in-top" },
      { id: "fetch", source: "research", target: "search", kind: "fetch" },
      { id: "collection", source: "search", target: "index", kind: "fetch", label: "Search selected collection" },
    ];
    await call(mcp, "edit_draft", { conceptId: workspace.concept.id, draftId: workspace.selectedDraft.id,
      expectedRevision: workspace.selectedDraft.revision, operationId: crypto.randomUUID(),
      operations: [...nodes.map((node) => ({ kind: "add_node", node })), ...edges.map((edge) => ({ kind: "add_edge", edge }))] });
    await expect(pane.locator(".react-flow__node")).toHaveCount(nodes.length);
    const response = page.waitForResponse((r) => r.url().endsWith("/api/arrange") && r.ok());
    await pane.getByRole("button", { name: "Arrange", exact: true }).click();
    const arranged = await (await response).json();
    await fitArrangedDraft(page, arranged);
    const checkCorridors = () => pane.evaluate((element) => {
      const failures: unknown[] = [];
      const blocks = [...element.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect());
      for (const label of element.querySelectorAll<HTMLElement>(".edge-label")) {
        const a = label.getBoundingClientRect();
        if (label.textContent && blocks.some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top))
          failures.push({ label: label.dataset.edgeId });
      }
      for (const path of element.querySelectorAll<SVGPathElement>(".react-flow__edge-path")) {
        for (let d = 2; d < path.getTotalLength() - 2; d += 3) {
          const p = path.getPointAtLength(d).matrixTransform(path.getScreenCTM()!);
          if (blocks.some((b) => p.x > b.left + 2 && p.x < b.right - 2 && p.y > b.top + 2 && p.y < b.bottom - 2)) {
            failures.push({ intersectsBlock: path.id }); break;
          }
        }
      }
      for (const id of ["submit", "context", "save-state", "collection"]) {
        const path = element.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`)!;
        const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength()), box = path.getBBox();
        if (box.y < Math.min(start.y, end.y) - 1 || box.y + box.height > Math.max(start.y, end.y) + 1)
          failures.push({ id, start: start.y, end: end.y, top: box.y, bottom: box.y + box.height });
      }
      return failures;
    });
    await expect.poll(checkCorridors).toEqual([]);
    await pane.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.poll(checkCorridors).toEqual([]);
    await page.screenshot({ path: ".local/connection-corridors.png" });
  } finally { await mcp.close(); }
});

for (const [name, fixture] of [["legacy saved main", legacyMainFlow], ["mixed ports", mixedPortFlow]] as const) {
  test(`${name} stays free of label loops through repeated Arrange, zoom, and reload`, async ({ page }) => {
    test.setTimeout(45000);
    await initialize(page, `Stable routes ${name} ${Date.now()}`);
    const mcp = await client();
    const pane = page.locator(".draft-pane");
    try {
      const workspace = await call(mcp, "read_workspace");
      await call(mcp, "edit_draft", { conceptId: workspace.concept.id, draftId: workspace.selectedDraft.id,
        expectedRevision: workspace.selectedDraft.revision, operationId: crypto.randomUUID(),
        operations: [...fixture.nodes.map((node) => ({ kind: "add_node", node })), ...fixture.edges.map((edge) => ({ kind: "add_edge", edge }))] });
      await expect(pane.locator(".react-flow__node")).toHaveCount(fixture.nodes.length);
      await page.getByRole("button", { name: "Apply draft", exact: true }).click();
      await expect(page.locator(".main-pane .react-flow__node")).toHaveCount(fixture.nodes.length);
      const saved = (await readWorkspaceLayout(mcp, page)).selectedMain;
      const check = () => page.evaluate((destinations) => {
        const failures: unknown[] = [];
        for (const pane of document.querySelectorAll(".main-pane,.draft-pane")) {
          const blocks = [...pane.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect());
          const tracks: {id: string | null; destination: string; source: {x:number;y:number}; target: {x:number;y:number}; lines: {a:{x:number;y:number};b:{x:number;y:number}}[]}[] = [];
          for (const edge of pane.querySelectorAll(".react-flow__edge")) {
            const path = edge.querySelector<SVGPathElement>(".react-flow__edge-path")!;
            const a = path.getPointAtLength(0), b = path.getPointAtLength(path.getTotalLength()), box = path.getBBox();
            if (!edge.classList.contains("subagent-connection") && (box.y < Math.min(a.y, b.y) - 2 || box.y + box.height > Math.max(a.y, b.y) + 2))
              failures.push({ pane: pane.className, edge: edge.getAttribute("data-id"), top: box.y, bottom: box.y + box.height, a: a.y, b: b.y });
            if (edge.getAttribute("data-id") === "connection-5" && box.width > 0.1)
              failures.push({pane:pane.className,edge:"connection-5",unnecessaryElbow:box.width});
            const lines: typeof tracks[number]["lines"] = [];
            let cursor = {x:0,y:0};
            // Inspect the straight SVG runs; perpendicular crossings and
            // rounded corners must not count as sharing a track.
            for (const part of path.getAttribute("d")!.match(/[MLQ][^MLQ]*/g)!) {
              const numbers = part.slice(1).trim().split(/[ ,]+/).map(Number);
              const next={x:numbers.at(-2)!,y:numbers.at(-1)!};
              if (part[0] === "L") lines.push({a:cursor,b:next});
              cursor=next;
            }
            tracks.push({id:edge.getAttribute("data-id"),destination:destinations[edge.getAttribute("data-id")!],source:a,target:b,lines});
          }
          for (let i=0;i<tracks.length;i++) for (let j=0;j<i;j++) {
            const a=tracks[i],b=tracks[j];
            // Converging connections may share their final track. Branches
            // going to different destinations must remain distinguishable.
            if (a.destination === b.destination) continue;
            const same = (p:{x:number;y:number},q:{x:number;y:number}) => Math.abs(p.x-q.x)+Math.abs(p.y-q.y)<=2;
            const allowed=(Number(same(a.source,b.source))+Number(same(a.target,b.target)))*36;
            let overlap=0;
            for (const p of a.lines) for (const q of b.lines) {
              const horizontal=Math.abs(p.a.y-p.b.y)<0.01;
              if (horizontal !== (Math.abs(q.a.y-q.b.y)<0.01)) continue;
              if (Math.abs(horizontal ? p.a.y-q.a.y : p.a.x-q.a.x)>1) continue;
              const axis=horizontal ? "x" : "y";
              overlap+=Math.max(0,Math.min(Math.max(p.a[axis],p.b[axis]),Math.max(q.a[axis],q.b[axis]))-Math.max(Math.min(p.a[axis],p.b[axis]),Math.min(q.a[axis],q.b[axis])));
            }
            if (overlap>allowed+2) failures.push({pane:pane.className,edges:[a.id,b.id],overlap,allowed});
          }
          for (const label of pane.querySelectorAll<HTMLElement>(".edge-label")) {
            if (!label.textContent) continue;
            const a = label.getBoundingClientRect();
            if (blocks.some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top))
              failures.push({ pane: pane.className, label: label.dataset.edgeId });
          }
        }
        return failures;
      }, Object.fromEntries(fixture.edges.map(edge => [edge.id, JSON.stringify([edge.target,edge.targetHandle])])));
      // The original saved geometry must render correctly before Arrange.
      await expect.poll(check).toEqual([]);
      let positions: unknown;
      for (let i = 0; i < 8; i++) {
        const response = page.waitForResponse((r) => r.url().endsWith("/api/arrange") && r.ok());
        await pane.getByRole("button", { name: "Arrange", exact: true }).click();
        const arranged = await (await response).json();
        await fitArrangedDraft(page, arranged);
        if (i === 0) positions = arranged.graph.nodes;
        else expect(arranged.graph.nodes).toEqual(positions);
        await expect.poll(check).toEqual([]);
        await pane.getByRole("button", { name: i % 2 ? "Zoom out" : "Zoom in", exact: true }).click();
        await expect.poll(check).toEqual([]);
      }
      await page.reload();
      await expect(pane.locator(".react-flow__node")).toHaveCount(fixture.nodes.length);
      await expect.poll(check).toEqual([]);
      const restored = await readWorkspaceLayout(mcp, page);
      expect(restored.selectedMain.graph).toEqual(saved.graph);
      await page.screenshot({ path: `.local/stable-routes-${name.replaceAll(" ", "-")}.png` });
    } finally { await mcp.close(); }
  });
}

test("Forest appearance persists, syncs between tabs, and remains available on narrow screens", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveCSS("color-scheme", "dark");
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(root).toHaveCSS("color-scheme", "light");
  await page.reload();
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();
  await expect(root).toHaveAttribute("data-theme", "light");

  const secondTab = await context.newPage();
  try {
    await secondTab.goto("/");
    await expect(secondTab.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(secondTab.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(root).toHaveAttribute("data-theme", "dark");
    await page.setViewportSize({ width: 640, height: 800 });
    await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeVisible();
  } finally {
    await secondTab.close();
  }
});

test("Forest soft tints identify all block types in drafts, selections, the palette and saved main", async ({
  page,
}) => {
  await initialize(page, `Forest ${Date.now()}`);
  const types = [
    ["Process", "process", "rgb(43, 56, 40)", "rgb(168, 198, 154)"],
    ["Agent", "agent", "rgb(50, 45, 64)", "rgb(192, 173, 224)"],
    ["Sub-agent", "subagent", "rgb(38, 53, 68)", "rgb(150, 188, 224)"],
    ["Interface", "interface", "rgb(35, 60, 53)", "rgb(142, 207, 193)"],
    ["Decision", "decision", "rgb(62, 53, 38)", "rgb(221, 192, 132)"],
    ["Data store", "store", "rgb(61, 48, 42)", "rgb(214, 170, 148)"],
  ];
  const draft = page.locator(".draft-pane");
  for (const [name, type, fill, accent] of types) {
    const add = page.getByRole("button", { name: `Add ${name}`, exact: true });
    await expect(add).toHaveCSS("color", accent);
    await add.click();
    await expect(draft.locator(`.block-${type}`)).toHaveCSS("background-color", fill);
    await expect(draft.locator(`.block-${type} .block-kind`)).toHaveCSS("color", accent);
  }
  await draft.getByRole("button", { name: "Arrange", exact: true }).click();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  await draft.getByRole("button", { name: "Fit to view", exact: true }).click();
  const agent = draft.locator(".block-agent");
  await agent.locator(".block-kind").click();
  await expect(agent).toHaveClass(/is-selected/);
  await expect(agent).toHaveCSS("background-color", "rgb(50, 45, 64)");
  await expect(agent).toHaveCSS("border-top-color", "rgb(155, 199, 166)");

  await page.getByRole("button", { name: "Apply draft", exact: true }).click();
  for (const [, type, fill] of types) {
    await expect(page.locator(`.main-pane .block-${type}`)).toHaveCSS("background-color", fill);
  }
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(agent).toHaveCSS("background-color", "rgb(251, 252, 255)");
  await expect(draft.locator(".canvas")).toHaveCSS("background-color", "rgb(249, 252, 245)");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(agent).toHaveCSS("background-color", "rgb(50, 45, 64)");
});

test("saved main connection labels match draft labels in both themes", async ({ page }) => {
  await initialize(page, `Connection labels ${Date.now()}`);
  const mcp = await client();
  try {
    const workspace = await call(mcp, "read_workspace");
    await call(mcp, "edit_draft", {
      conceptId: workspace.concept.id,
      draftId: workspace.selectedDraft.id,
      expectedRevision: workspace.selectedDraft.revision,
      operationId: crypto.randomUUID(),
      operations: [
        { kind: "add_node", node: { id: "agent", type: "agent", label: "Agent", x: 0, y: 0, width: 250, height: 180 } },
        { kind: "add_node", node: { id: "process", type: "process", label: "Process", x: 600, y: 0, width: 250, height: 180 } },
        { kind: "add_node", node: { id: "worker", type: "subagent", label: "Worker", x: 0, y: 400, width: 250, height: 180 } },
        { kind: "add_edge", edge: { id: "flow", source: "agent", target: "process", label: "Continue with validated output" } },
        { kind: "add_edge", edge: { id: "fetch", source: "agent", sourceHandle: "fetch", target: "process", kind: "fetch", label: "Fetch reference data" } },
        { kind: "add_edge", edge: { id: "call", source: "agent", sourceHandle: "subagent", target: "worker", targetHandle: "in-top", kind: "subagent", label: "Delegate review" } },
      ],
    });
    await expect(page.locator(".draft-pane .edge-label")).toHaveCount(3);
    await page.getByRole("button", { name: "Apply draft", exact: true }).click();
    await expect(page.locator(".main-pane .edge-label")).toHaveCount(3);
    const appearance = (label: Locator) => label.evaluate((element) => {
      const style = getComputedStyle(element);
      return Object.fromEntries([
        "opacity", "color", "background-color", "font-family", "font-size",
        "font-weight", "line-height", "padding", "border-radius", "white-space",
      ].map((property) => [property, style.getPropertyValue(property)]));
    });
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await page.getByRole("button", { name: "Switch to light mode" }).click();
      for (const id of ["flow", "fetch", "call"]) {
        const selector = `.edge-label[data-edge-id="${id}"] button`;
        const main = page.locator(`.main-pane ${selector}`);
        const draft = page.locator(`.draft-pane ${selector}`);
        await expect(main).toBeDisabled();
        await expect(draft).toBeEnabled();
        await expect(main).toHaveCSS("opacity", "1");
        expect(await appearance(main)).toEqual(await appearance(draft));
      }
      await page.screenshot({ path: `.local/connection-labels-${theme}.png` });
    }
  } finally {
    await mcp.close();
  }
});

test("appearance switching still works when theme storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === "flowcanvas:theme") throw new DOMException("Storage unavailable", "SecurityError");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "flowcanvas:theme") throw new DOMException("Storage unavailable", "SecurityError");
      return set.call(this, key, value);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("a shared new Concept with no diagrams is readable and accepts its first agent draft", async ({
  page,
}) => {
  const name = await initialize(page, `Empty concept ${Date.now()}`, false);
  const mcp = await client();
  try {
    const selected = await call(mcp, "read_workspace");
    expect(selected.status).toBe("ready");
    expect(selected.concept.name).toBe(`${name} concept`);
    expect(selected.selectedMain).toBeNull();
    expect(selected.selectedDraft).toBeNull();
    expect(selected.drafts).toEqual([]);
    expect(selected.versions).toEqual([]);
    await call(mcp, "create_draft", {
      conceptId: selected.concept.id,
      name: "Agent initial flow",
      sourceVersionId: null,
      operationId: crypto.randomUUID(),
    });
    await expect(
      page.getByRole("tab", { name: "New - Agent initial flow", exact: true }),
    ).toBeVisible();
    const updated = await call(mcp, "read_workspace");
    expect(updated.selectedDraft.name).toBe("Agent initial flow");
    expect(updated.selectedMain).toBeNull();
  } finally {
    await mcp.close();
  }
});
test("block text preserves the caret and saves on blur rather than while typing", async ({
  page,
}) => {
  await initialize(page, `Caret ${Date.now()}`);
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  const notes = page.getByRole("textbox", { name: "Block text", exact: true });
  const original =
    "First line of notes\nSecond line stays here\nThird line of notes";
  await notes.fill(original);
  await notes.blur();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  let saves = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/edit") saves++;
  });
  const cursor = original.indexOf("line");
  await notes.evaluate((element: HTMLTextAreaElement, position) => {
    element.focus();
    element.setSelectionRange(position, position);
  }, cursor);
  await notes.pressSequentially("new ");
  const expected = original.slice(0, cursor) + "new " + original.slice(cursor);
  await expect(notes).toHaveValue(expected);
  expect(
    await notes.evaluate(
      (element: HTMLTextAreaElement) => element.selectionStart,
    ),
  ).toBe(cursor + 4);
  // Wait beyond the former autosave delay: a focused text edit must not save.
  await page.waitForTimeout(500);
  expect(saves).toBe(0);
  await expect(
    page.getByText("Text saves when you leave the field"),
  ).toBeVisible();
  expect(
    await notes.evaluate(
      (element: HTMLTextAreaElement) => element.selectionStart,
    ),
  ).toBe(cursor + 4);
  const start = expected.indexOf("Second");
  await notes.evaluate((element: HTMLTextAreaElement, position) => {
    element.setSelectionRange(position, position + 6);
  }, start);
  await notes.pressSequentially("Updated");
  const replaced = expected.replace("Second", "Updated");
  await expect(notes).toHaveValue(replaced);
  expect(
    await notes.evaluate(
      (element: HTMLTextAreaElement) => element.selectionStart,
    ),
  ).toBe(start + 7);
  await notes.press("Backspace");
  const finalText = replaced.replace("Updated", "Update");
  await expect(notes).toHaveValue(finalText);
  const mcp = await client();
  try {
    const selected = await call(mcp, "read_workspace");
    expect(selected.selectedDraft.graph.nodes[0].text).toBe(finalText);
    expect(
      await notes.evaluate(
        (element: HTMLTextAreaElement) => element.selectionStart,
      ),
    ).toBe(start + 6);
    const heading = page.getByRole("textbox", {
      name: "Block heading",
      exact: true,
    });
    await heading.fill("Primary agent");
    await heading.blur();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await heading.evaluate((element: HTMLInputElement) => {
      element.focus();
      element.setSelectionRange(8, 8);
    });
    const savedBeforeHeadingEdit = saves;
    await heading.pressSequentially("request ");
    await expect(heading).toHaveValue("Primary request agent");
    expect(
      await heading.evaluate(
        (element: HTMLInputElement) => element.selectionStart,
      ),
    ).toBe(16);
    await page.waitForTimeout(500);
    expect(saves).toBe(savedBeforeHeadingEdit);
    await heading.blur();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    expect(saves).toBe(savedBeforeHeadingEdit + 1);
    expect(
      await heading.evaluate(
        (element: HTMLInputElement) => element.selectionStart,
      ),
    ).toBe(16);
    await page.reload();
    await expect(notes).toHaveValue(finalText);
    await expect(heading).toHaveValue("Primary request agent");
  } finally {
    await mcp.close();
  }
});

test("an earlier save finishing does not save a text field still being edited", async ({
  page,
}) => {
  await initialize(page, `Deferred text ${Date.now()}`);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstSave = new Promise<void>((resolve) => {
    started = resolve;
  });
  let saves = 0;
  await page.route("**/api/edit", async (route) => {
    saves++;
    if (saves === 1) {
      started();
      await gate;
    }
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Add Agent", exact: true }).click();
    await firstSave;
    const notes = page.getByRole("textbox", {
      name: "Block text",
      exact: true,
    });
    await notes.fill("Keep editing while an earlier save finishes");
    release();
    await expect(
      page.getByText("Text saves when you leave the field"),
    ).toBeVisible();
    await page.waitForTimeout(500);
    expect(saves).toBe(1);
    await expect(notes).toHaveValue(
      "Keep editing while an earlier save finishes",
    );
    await notes.blur();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    expect(saves).toBe(2);
    await page.reload();
    await expect(notes).toHaveValue(
      "Keep editing while an earlier save finishes",
    );
  } finally {
    release();
  }
});

test("fitting a manually shortened block removes its scrollbar with wrapped notes", async ({
  page,
}) => {
  await initialize(page, `Manual fit ${Date.now()}`);
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  const pane = page.locator(".draft-pane");
  const node = pane.locator(".react-flow__node");
  const notes = pane.getByRole("textbox", { name: "Block text", exact: true });
  // Reserve the scrollbar width used by desktop browsers even in headless mode.
  await page.addStyleTag({
    content:
      ".draft-pane textarea:not([aria-hidden]) { scrollbar-gutter: stable; }",
  });
  await notes.fill("a".repeat(106) + "\nReturn result.");
  await node.locator(".block-kind").click();
  const bottom = node.locator(
    ".react-flow__resize-control.bottom.right.handle",
  );
  const bounds = await bottom.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y - 50, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(() =>
      notes.evaluate(
        (element: HTMLTextAreaElement) =>
          element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  await pane
    .getByRole("button", { name: "Fit block height to contents", exact: true })
    .click();
  await expect
    .poll(() =>
      notes.evaluate(
        (element: HTMLTextAreaElement) =>
          element.scrollHeight <= element.clientHeight,
      ),
    )
    .toBe(true);
});

test("selected blocks fit their height to notes without changing width, with undo and persistence", async ({
  page,
}) => {
  await initialize(page, `Fit height ${Date.now()}`);
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  const pane = page.locator(".draft-pane");
  const fit = pane.getByRole("button", {
    name: "Fit block height to contents",
    exact: true,
  });
  await expect(fit).toHaveCount(0);
  const mcp = await client();
  try {
    const initial = (await readWorkspaceLayout(mcp, page)).selectedDraft.graph
      .nodes[0];
    const notes = pane.getByRole("textbox", {
      name: "Block text",
      exact: true,
    });
    const content = Array.from(
      { length: 190 },
      (_, index) =>
        `${index + 1}. ${index % 4 === 0 ? "A longer line that wraps across the existing block width and must be measured at that width." : "A line of notes."}`,
    ).join("\n");
    await notes.fill(content);
    await expect
      .poll(() =>
        notes.evaluate(
          (element: HTMLTextAreaElement) =>
            element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    await pane.locator(".block-kind").click();
    await expect(fit).toBeVisible();
    // Measuring screen dimensions here would produce the wrong result after zooming.
    await pane.getByRole("button", { name: "Zoom out", exact: true }).click();
    await pane.getByRole("button", { name: "Zoom out", exact: true }).click();
    await fit.click();
    const fitted = (await readWorkspaceLayout(mcp, page)).selectedDraft.graph
      .nodes[0];
    expect(fitted.height).toBeGreaterThan(3000);
    expect(fitted.width).toBe(initial.width);
    expect(fitted.x).toBe(initial.x);
    expect(fitted.y).toBe(initial.y);
    expect(fitted.text).toBe(content);
    await expect
      .poll(() =>
        notes.evaluate(
          (element: HTMLTextAreaElement) =>
            element.scrollHeight <= element.clientHeight,
        ),
      )
      .toBe(true);
    // Fitting an already fitted block should not keep adding spare height.
    await fit.click();
    expect(
      (await readWorkspaceLayout(mcp, page)).selectedDraft.graph.nodes[0].height,
    ).toBe(fitted.height);
    await notes.fill("Short note");
    await fit.click();
    const compact = (await readWorkspaceLayout(mcp, page)).selectedDraft.graph
      .nodes[0];
    expect(compact.height).toBeLessThan(fitted.height);
    expect(compact.width).toBe(initial.width);
    await expect
      .poll(() =>
        notes.evaluate(
          (element: HTMLTextAreaElement) =>
            element.scrollHeight <= element.clientHeight,
        ),
      )
      .toBe(true);
    await pane.getByRole("button", { name: "Undo", exact: true }).click();
    expect(
      (await readWorkspaceLayout(mcp, page)).selectedDraft.graph.nodes[0].height,
    ).toBe(fitted.height);
    await pane.getByRole("button", { name: "Redo", exact: true }).click();
    expect(
      (await readWorkspaceLayout(mcp, page)).selectedDraft.graph.nodes[0].height,
    ).toBe(compact.height);
    await pane
      .getByRole("button", { name: "Apply draft", exact: true })
      .click();
    await page.reload();
    await expect(notes).toHaveValue("Short note");
    const restored = await readWorkspaceLayout(mcp, page);
    expect(restored.selectedDraft.graph.nodes[0].height).toBe(compact.height);
    expect(restored.selectedMain.graph.nodes[0].height).toBe(compact.height);
    await pane.locator(".block-kind").click();
    await expect(fit).toBeVisible();
    await expect(
      page
        .locator(".main-pane")
        .getByRole("button", { name: "Fit block height to contents" }),
    ).toHaveCount(0);
    await page.screenshot({ path: ".local/fitted-block.png" });
    await pane
      .locator(".react-flow__pane")
      .click({ position: { x: 20, y: 20 } });
    await expect(fit).toHaveCount(0);
  } finally {
    await mcp.close();
  }
});

test("copying a draft includes current edits and creates an independent tab that survives source deletion", async ({
  page,
}) => {
  await initialize(page, `Copy drafts ${Date.now()}`);
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Block heading", exact: true })
    .fill("Original");
  await page.getByRole("button", { name: "Apply draft", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "v1 - Initial flow", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Block text", exact: true })
    .fill("Latest draft notes");
  await page.getByRole("button", { name: "Copy draft", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Copy draft", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Draft name" })).toHaveValue(
    "Initial flow (copy)",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.getByRole("button", { name: "Copy draft", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Draft name" }).fill("Alternative");
  await dialog
    .getByRole("button", { name: "Create copy", exact: true })
    .click();
  const copiedTab = page.getByRole("tab", {
    name: "v1 - Alternative",
    exact: true,
  });
  await expect(copiedTab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("textbox", { name: "Block text", exact: true }),
  ).toHaveValue("Latest draft notes");
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  const mcp = await client();
  try {
    const initial = await call(mcp, "read_workspace");
    const sourceId = initial.drafts.find(
      (draft: any) => draft.name === "Initial flow",
    ).id;
    expect(initial.selectedDraft.id).not.toBe(sourceId);
    expect(initial.selectedDraft.revision).toBe(0);
    expect(initial.selectedMain.graph.nodes[0]).not.toHaveProperty("text");
    const source = await call(mcp, "read_diagram", {
      conceptId: initial.concept.id,
      kind: "draft",
      diagramId: sourceId,
    });
    expect(initial.selectedDraft.graph).toEqual(source.graph);
    await page
      .getByRole("textbox", { name: "Block heading", exact: true })
      .fill("Independent alternative");
    await page
      .getByRole("textbox", { name: "Block text", exact: true })
      .fill("Copy notes");
    await call(mcp, "read_workspace");
    const unchanged = await call(mcp, "read_diagram", {
      conceptId: initial.concept.id,
      kind: "draft",
      diagramId: sourceId,
    });
    expect(unchanged.graph.nodes[0].label).toBe("Original");
    expect(unchanged.graph.nodes[0].text).toBe("Latest draft notes");
    await page
      .getByRole("button", { name: "Delete draft Initial flow", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Delete draft?", exact: true })
      .getByRole("button", { name: "Delete draft", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(copiedTab).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await expect(copiedTab).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Block heading", exact: true }),
    ).toHaveValue("Independent alternative");
    await expect(
      page.getByRole("textbox", { name: "Block text", exact: true }),
    ).toHaveValue("Copy notes");
    await page
      .getByRole("button", { name: "Apply draft", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "v2 - Alternative", exact: true }),
    ).toBeVisible();
    const oldMain = await call(mcp, "read_diagram", {
      conceptId: initial.concept.id,
      kind: "main",
      diagramId: initial.selectedMain.id,
    });
    expect(oldMain.graph.nodes[0].label).toBe("Original");
  } finally {
    await mcp.close();
  }
});

test("canvas layout switches between full panes and resets a resized split without losing draft edits", async ({ page }) => {
  await initialize(page, `Canvas layout ${Date.now()}`);
  const control = page.getByRole("group", { name: "Canvas layout", exact: true });
  const main = page.getByRole("region", { name: "Main canvas", exact: true });
  const draft = page.getByRole("region", { name: "Draft canvas", exact: true });
  const mainOnly = control.getByRole("button", { name: "Main flow only", exact: true });
  const balanced = control.getByRole("button", { name: "Balanced view", exact: true });
  const draftOnly = control.getByRole("button", { name: "Draft only", exact: true });
  const checkBalanced = async () => {
    await expect(main).toBeVisible();
    await expect(draft).toBeVisible();
    await expect(balanced).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => Math.abs((await main.boundingBox())!.width - (await draft.boundingBox())!.width)).toBeLessThan(1);
  };
  const checkFullWidth = async (pane: Locator) => {
    await expect.poll(async () => Math.abs((await pane.boundingBox())!.width - ((await page.locator(".panes").boundingBox())!.width - 2))).toBeLessThan(1);
    await expect(page.getByRole("separator", { name: "Resize canvases" })).toHaveCount(0);
  };
  await checkBalanced();
  await page.getByRole("separator", { name: "Resize canvases" }).press("ArrowRight");
  expect((await main.boundingBox())!.width).toBeGreaterThan((await draft.boundingBox())!.width);
  await balanced.click();
  await checkBalanced();

  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  const resumeId = await page.evaluate(() => sessionStorage.getItem("flowcanvas:session"));
  const session = await (await page.request.post("/api/session", { data: { resumeId } })).json();
  const headers = { "x-session-id": session.id, "x-session-token": session.token };
  await page.getByRole("textbox", { name: "Block text", exact: true }).fill("Keep these pending notes when switching layouts");
  await mainOnly.click();
  await expect(mainOnly).toHaveAttribute("aria-pressed", "true");
  await expect(main).toBeVisible();
  await expect(page.locator(".draft-pane")).toBeHidden();
  await checkFullWidth(main);
  const saved = await (await page.request.get(`/api/drafts/${session.selection.draftId}`, { headers })).json();
  expect(saved.graph.nodes[0].text).toBe("Keep these pending notes when switching layouts");
  const currentSession = await (await page.request.post("/api/session", { data: { resumeId } })).json();
  expect(currentSession.selection).toEqual(session.selection);
  await page.screenshot({ path: ".local/layout-main-only.png" });

  await balanced.click();
  await checkBalanced();
  await expect(page.getByRole("textbox", { name: "Block text", exact: true })).toHaveValue(saved.graph.nodes[0].text);
  await draftOnly.click();
  await expect(draftOnly).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".main-pane")).toBeHidden();
  await expect(draft).toBeVisible();
  await checkFullWidth(draft);
  await page.getByRole("button", { name: "Apply draft", exact: true }).click();
  await expect(page.getByRole("tab", { name: "v1 - Initial flow", exact: true })).toBeVisible();
  await expect(draftOnly).toHaveAttribute("aria-pressed", "true");
  await checkFullWidth(draft);
  await page.screenshot({ path: ".local/layout-draft-only.png" });

  await mainOnly.click();
  await page.getByRole("button", { name: "New draft", exact: true }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await checkBalanced();
  for (const width of [850, 640]) {
    await page.setViewportSize({ width, height: 960 });
    for (const button of [mainOnly, balanced, draftOnly]) {
      await expect(button).toBeVisible();
      const bounds = (await button.boundingBox())!;
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
  }
  await page.setViewportSize({ width: 1512, height: 960 });
  await balanced.click();
  await expect.poll(async () => {
    const node = await main.locator(".react-flow__node").boundingBox();
    const canvas = await main.locator(".canvas").boundingBox();
    return !!node && !!canvas && node.x >= canvas.x && node.y >= canvas.y &&
      node.x + node.width <= canvas.x + canvas.width &&
      node.y + node.height <= canvas.y + canvas.height;
  }).toBe(true);
  await page.screenshot({ path: ".local/layout-balanced.png" });
});

test("deleting the last draft in Draft only view restores the main flow", async ({ page }) => {
  await initialize(page, `Last draft layout ${Date.now()}`);
  await page.getByRole("button", { name: "Draft only", exact: true }).click();
  await page.getByRole("button", { name: "Delete draft Initial flow", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete draft?", exact: true })
    .getByRole("button", { name: "Delete draft", exact: true }).click();
  await expect(page.getByRole("region", { name: "Main canvas", exact: true })).toBeVisible();
  await expect(page.locator(".draft-pane")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Canvas layout", exact: true })).toHaveCount(0);
});

test("draft tabs shrink beside fixed actions and scroll when full", async ({ page }) => {
  await initialize(page, `Compact draft tabs ${Date.now()}`);
  const bar = page.locator(".draft-tabbar");
  const tabs = bar.locator(".draft-tabs");
  const tools = bar.locator(".draft-tools");
  const initialWidth = (await tabs.locator(".draft-tab").first().boundingBox())!.width;
  const initialTools = (await tools.boundingBox())!;

  const checkActions = async () => {
    const tabBounds = (await tabs.boundingBox())!;
    const toolBounds = (await tools.boundingBox())!;
    expect(tabBounds.x + tabBounds.width).toBeLessThanOrEqual(toolBounds.x + 1);
    expect(toolBounds.x).toBeCloseTo(initialTools.x, 0);
    for (const name of ["Copy draft", "Undo", "Redo", "Arrange", "Apply draft"]) {
      await expect(tools.getByRole("button", { name, exact: true })).toBeVisible();
    }
  };
  for (let i = 2; i <= 8; i++) {
    await page.getByRole("button", { name: "New draft", exact: true }).click();
    await page.getByRole("textbox", { name: "Draft name" }).fill(`Alternative ${i}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(i);
    await expect(tabs.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
    await checkActions();
    if (i === 3) {
      expect((await tabs.locator(".draft-tab").first().boundingBox())!.width).toBeLessThan(initialWidth);
    }
  }
  expect(await tabs.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const selected = tabs.getByRole("tab", { selected: true });
  const selectedBounds = (await tabs.locator(".draft-tab.selected").boundingBox())!;
  const tabBounds = (await tabs.boundingBox())!;
  expect(selectedBounds.x).toBeGreaterThanOrEqual(tabBounds.x);
  expect(selectedBounds.x + selectedBounds.width).toBeLessThanOrEqual(tabBounds.x + tabBounds.width + 1);
  await selected.focus();
  await page.keyboard.press("F2");
  const rename = page.getByRole("dialog", { name: "Rename draft", exact: true });
  await expect(rename).toBeVisible();
  await rename.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".draft-toolbar")).toHaveCount(0);
  const barBounds = (await bar.boundingBox())!;
  const canvasBounds = (await page.locator(".draft-canvas-wrapper").boundingBox())!;
  expect(canvasBounds.y).toBeCloseTo(barBounds.y + barBounds.height, 0);
  await page.screenshot({ path: ".local/draft-tabbar.png" });
});

test("draft tab crosses confirm deletion inside the draft pane and preserve saved main versions", async ({
  page,
}) => {
  await initialize(page, `Delete drafts ${Date.now()}`);
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Block heading", exact: true })
    .fill("Preserved main");
  await page.getByRole("button", { name: "Apply draft", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "v1 - Initial flow", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New draft tab", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Draft name" }).fill("Alternative");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const alternative = page.getByRole("tab", {
    name: "v1 - Alternative",
    exact: true,
  });
  await expect(alternative).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("button", { name: "Delete draft Initial flow", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete draft?",
    exact: true,
  });
  await expect(dialog).toContainText("Initial flow");
  await expect(alternative).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  const paneBounds = await page
    .getByRole("region", { name: "Draft canvas" })
    .boundingBox();
  const modalBounds = await dialog.boundingBox();
  expect(
    Math.abs(
      paneBounds!.x +
        paneBounds!.width / 2 -
        (modalBounds!.x + modalBounds!.width / 2),
    ),
  ).toBeLessThan(2);
  expect(
    Math.abs(
      paneBounds!.y +
        paneBounds!.height / 2 -
        (modalBounds!.y + modalBounds!.height / 2),
    ),
  ).toBeLessThan(2);
  await page.screenshot({ path: ".local/delete-draft-confirmation.png" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "v1 - Initial flow", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete draft Initial flow", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Delete draft", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "v1 - Initial flow", exact: true }),
  ).toHaveCount(0);
  await expect(alternative).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(alternative).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "v1 - Initial flow", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Delete draft Alternative", exact: true })
    .click();
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alternative).toBeVisible();
  await page
    .getByRole("button", { name: "Delete draft Alternative", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Delete draft", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Draft canvas" })).toHaveCount(
    0,
  );
  await expect(
    page
      .getByRole("region", { name: "Main canvas" })
      .getByText("Preserved main", { exact: true }),
  ).toBeVisible();
  const mcp = await client();
  try {
    const selected = await call(mcp, "read_workspace");
    expect(selected.selectedDraft).toBeNull();
    expect(selected.drafts).toEqual([]);
    expect(selected.selectedMain.graph.nodes[0].label).toBe("Preserved main");
    expect(selected.versions).toEqual([]);
    expect((await call(mcp, "read_concept")).versions).toHaveLength(1);
  } finally {
    await mcp.close();
  }
});

test("draft deletion refuses edits that arrive while confirmation is open", async ({
  page,
}) => {
  await initialize(page, `Delete conflict ${Date.now()}`);
  await page
    .getByRole("button", { name: "Delete draft Initial flow", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete draft?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const mcp = await client();
  try {
    const selected = await call(mcp, "read_workspace");
    await call(mcp, "edit_draft", {
      conceptId: selected.concept.id,
      draftId: selected.selectedDraft.id,
      expectedRevision: selected.selectedDraft.revision,
      operationId: crypto.randomUUID(),
      operations: [{ kind: "rename", name: "Changed by agent" }],
    });
    await dialog
      .getByRole("button", { name: "Delete draft", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("changed");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "New - Changed by agent", exact: true }),
    ).toBeVisible();
  } finally {
    await mcp.close();
  }
});

test("draft edits apply as immutable versions, remain open, and restore after reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await initialize(page);
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Block heading", exact: true })
    .fill("Primary agent");
  await page
    .getByRole("textbox", { name: "Block text", exact: true })
    .fill('Receive requests\n  preserve indentation\n{"result": "schema"}');
  // Apply without waiting for the debounce: the UI must flush the final keystroke.
  await page.getByRole("button", { name: "Apply draft", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "v1 - Initial flow", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Main version" }),
  ).toHaveValue(/.+/);
  await page
    .getByRole("textbox", { name: "Block text", exact: true })
    .fill("Second iteration");
  await page.getByRole("button", { name: "Apply draft", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "v2 - Initial flow", exact: true }),
  ).toBeVisible();
  const main = page.getByRole("region", { name: "Main canvas", exact: true });
  await main.getByRole("combobox").selectOption({ label: "v1" });
  await expect(
    main.getByText("preserve indentation", { exact: false }),
  ).toBeVisible();
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("button", { name: "New draft", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Draft name" })
    .fill("Older alternative");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "v1 - Older alternative", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Block text", exact: true }),
  ).toHaveValue(/preserve indentation/);
  await page.getByRole("button", { name: "Apply draft", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "v3 - Older alternative", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "v2 - Initial flow", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Shared with agents", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "v3 - Older alternative", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("textbox", { name: "Block heading", exact: true }),
  ).toHaveValue("Primary agent");
  await page.screenshot({ path: ".local/workspace.png" });
  expect(errors).toEqual([]);
});

test("real browser selections and pending text are read through MCP; a second tab never changes context", async ({
  page,
  context,
}) => {
  await initialize(page, `Context ${Date.now()}`);
  await page.getByRole("button", { name: "Add Process", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Block text", exact: true })
    .fill("Current selected text");
  const mcp = await client();
  try {
    const currentDraft = await call(mcp, "read_diagram", { kind: "draft" });
    expect(currentDraft.kind).toBe("draft");
    expect(currentDraft.graph.nodes[0].text).toBe("Current selected text");
    expect(currentDraft.graph.nodes[0]).not.toHaveProperty("x");
    const initial = await call(mcp, "read_workspace");
    expect(initial.status).toBe("ready");
    expect(initial.selectedDraft.id).toBe(currentDraft.id);
    expect(initial.selectedDraft.graph.nodes[0].text).toBe(
      "Current selected text",
    );
    const second = await context.newPage();
    await second.goto("/");
    await expect(
      second.getByRole("button", {
        name: "Share this tab with agents",
        exact: true,
      }),
    ).toBeVisible();
    await second
      .getByRole("button", { name: "New project", exact: true })
      .first()
      .click();
    const secondProject = `SECONDARY_PROJECT_${Date.now()}`;
    await second
      .getByRole("textbox", { name: "Project name" })
      .fill(secondProject);
    await second.getByRole("button", { name: "Create", exact: true }).click();
    await second
      .getByRole("button", {
        name: `New concept in ${secondProject}`,
        exact: true,
      })
      .click();
    await second
      .getByRole("textbox", { name: "Concept name" })
      .fill("SECONDARY_SELECTION");
    await second.getByRole("button", { name: "Create", exact: true }).click();
    const shared = await call(mcp, "read_workspace");
    expect(shared.concept.id).toBe(initial.concept.id);
    expect((await call(mcp, "read_diagram", { kind: "draft" })).id).toBe(currentDraft.id);
    expect(JSON.stringify(shared)).not.toContain("SECONDARY_SELECTION");
    await page.close();
    await expect
      .poll(async () => (await call(mcp, "read_workspace")).status)
      .toBe("no_active_workspace");
    await expect(
      second.getByRole("button", {
        name: "Share this tab with agents",
        exact: true,
      }),
    ).toBeVisible();
    await second
      .getByRole("button", { name: "Share this tab with agents", exact: true })
      .click();
    const newShared = await call(mcp, "read_workspace");
    expect(newShared.concept.name).toBe("SECONDARY_SELECTION");
    expect((await call(mcp, "read_concept")).concept.id).toBe(newShared.concept.id);
    expect((await call(mcp, "read_diagram", { kind: "draft" })).status).toBe("no_draft_selected");
  } finally {
    await mcp.close();
  }
});

test("agent edits appear in the canvas and undo/redo preserve the main snapshot", async ({
  page,
}) => {
  await initialize(page, `Agent edits ${Date.now()}`);
  const mcp = await client();
  try {
    const workspace = await call(mcp, "read_workspace");
    const draft = workspace.selectedDraft;
    const node = {
      id: "agent-created",
      type: "agent",
      label: "Created through MCP",
      text: "Agent responsibilities",
      x: 50,
      y: 50,
      width: 250,
      height: 160,
    };
    const result = await call(mcp, "edit_draft", {
      conceptId: workspace.concept.id,
      draftId: draft.id,
      expectedRevision: draft.revision,
      operationId: crypto.randomUUID(),
      operations: [{ kind: "add_node", node }],
    });
    expect(result.revision).toBe(draft.revision + 1);
    await expect(
      page.getByRole("textbox", { name: "Block heading", exact: true }),
    ).toHaveValue("Created through MCP");
    await page
      .getByRole("button", { name: "Apply draft", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "v1 - Initial flow", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Block heading", exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Main canvas" })
        .getByText("Created through MCP"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Block heading", exact: true }),
    ).toHaveValue("Created through MCP");
  } finally {
    await mcp.close();
  }
});

test("duplicate, delete and automatic layout work with graph edits", async ({
  page,
}) => {
  await initialize(page, `Editor ${Date.now()}`);
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  await page.getByRole("button", { name: "Add Decision", exact: true }).click();
  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  const canvas = page.locator(".draft-pane");
  await canvas.locator(".block-kind").filter({ hasText: "Agent" }).click();
  await canvas.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Block heading", exact: true }),
  ).toHaveCount(3);
  await canvas.getByRole("button", { name: "Delete selection" }).click();
  await expect(
    page.getByRole("textbox", { name: "Block heading", exact: true }),
  ).toHaveCount(2);
});

test("Sub-agent call ports expand one to three to five, retain chosen slots, and survive undo and reload", async ({
  page,
}) => {
  await initialize(page, `Sub-agent calls ${Date.now()}`);
  const mcp = await client();
  try {
    const initial = await readWorkspaceLayout(mcp, page);
    await call(mcp, "edit_draft", {
      conceptId: initial.concept.id,
      draftId: initial.selectedDraft.id,
      expectedRevision: initial.selectedDraft.revision,
      operationId: crypto.randomUUID(),
      operations: [
        {
          kind: "add_node",
          node: {
            id: "caller",
            type: "agent",
            label: "Primary agent",
            text: "",
            x: 100,
            y: 0,
            width: 360,
            height: 160,
          },
        },
        {
          kind: "add_node",
          node: {
            id: "worker",
            type: "subagent",
            label: "Specialist",
            text: "",
            x: 155,
            y: 350,
            width: 250,
            height: 150,
          },
        },
      ],
    });
    const pane = page.locator(".draft-pane");
    const caller = pane.locator('.react-flow__node[data-id="caller"]');
    const worker = pane.locator('.react-flow__node[data-id="worker"]');
    await expect(caller).toBeVisible();
    await expect(worker).toBeVisible();
    await pane
      .getByRole("button", { name: "Fit to view", exact: true })
      .click();
    await expect(caller.locator(".subagent-handle")).toHaveCount(1);
    await expect(caller.locator('[data-handleid="out-bottom"]')).toHaveCount(0);
    const handles = [
      "subagent",
      "subagent-right",
      "subagent-left",
      "subagent-far-right",
      "subagent-far-left",
    ];
    for (const [index, handle] of handles.entries()) {
      const from = caller.locator(`[data-handleid="${handle}"]`);
      // Dropping a bottom call on the side must still enter the top input.
      const to = worker.locator(`[data-handleid="${index === 0 ? "in" : "in-top"}"]`);
      await from.hover();
      const start = (await from.boundingBox())!;
      const end = (await to.boundingBox())!;
      await page.mouse.move(
        start.x + start.width / 2,
        start.y + start.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
        steps: 15,
      });
      await page.mouse.up();
      await expect(pane.locator(".subagent-connection")).toHaveCount(index + 1);
      await expect(caller.locator(".subagent-handle")).toHaveCount(
        index >= 2 ? 5 : 3,
      );
    }
    await expect(caller.locator(".subagent-handle.connectable")).toHaveCount(0);
    const ports = await caller
      .locator(".subagent-handle")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          id: element.getAttribute("data-handleid"),
          left: element.getBoundingClientRect().x,
        })),
      );
    expect(
      ports.find((port) => port.id === "subagent-far-left")!.left,
    ).toBeLessThan(ports.find((port) => port.id === "subagent-left")!.left);
    expect(
      ports.find((port) => port.id === "subagent-right")!.left,
    ).toBeLessThan(
      ports.find((port) => port.id === "subagent-far-right")!.left,
    );
    const selected = await readWorkspaceLayout(mcp, page);
    expect(
      selected.selectedDraft.graph.edges.map((edge: any) => edge.sourceHandle),
    ).toEqual(handles);
    expect(selected.selectedDraft.graph.edges.every((edge: any) => edge.targetHandle === "in-top")).toBe(true);
    for (const edge of await pane
      .locator(".subagent-connection .react-flow__edge-path")
      .all()) {
      await expect(edge).toHaveAttribute("marker-start", /url/);
      await expect(edge).toHaveAttribute("marker-end", /url/);
    }
    await call(mcp, "edit_draft", {
      conceptId: initial.concept.id,
      draftId: initial.selectedDraft.id,
      expectedRevision: selected.selectedDraft.revision,
      operationId: crypto.randomUUID(),
      operations: selected.selectedDraft.graph.edges.map((edge: any) => ({
        kind: "delete_edge",
        id: edge.id,
      })),
    });
    await expect(caller.locator(".subagent-handle")).toHaveCount(1);
    await expect(pane.locator(".subagent-connection")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(caller.locator(".subagent-handle")).toHaveCount(5);
    await expect(pane.locator(".subagent-connection")).toHaveCount(5);
    await page
      .getByRole("button", { name: "Apply draft", exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Main canvas", exact: true })
        .locator(".subagent-connection"),
    ).toHaveCount(5);
    await page.reload();
    await expect(caller.locator(".subagent-handle")).toHaveCount(5);
    await expect(pane.locator(".subagent-connection")).toHaveCount(5);
    const restored = await readWorkspaceLayout(mcp, page);
    expect(
      restored.selectedMain.graph.edges.map((edge: any) => edge.sourceHandle),
    ).toEqual(handles);
    await page.screenshot({ path: ".local/subagent-calls.png" });
  } finally {
    await mcp.close();
  }
});

test("Fetch ports create two-headed data connections alongside normal flow and persist in main", async ({
  page,
}) => {
  await initialize(page, `Fetch ${Date.now()}`);
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  await page
    .getByRole("button", { name: "Add Data store", exact: true })
    .click();
  const arranged = page.waitForResponse(
    (response) => response.url().endsWith("/api/arrange") && response.ok(),
  );
  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await fitArrangedDraft(page, await (await arranged).json());
  const pane = page.locator(".draft-pane");
  const caller = pane
    .locator(".react-flow__node")
    .filter({ has: page.locator(".block-agent") });
  const provider = pane
    .locator(".react-flow__node")
    .filter({ has: page.locator(".block-store") });
  const target = provider.locator('[data-handleid="in"]');
  const fetchPort = caller.locator('[data-handleid="fetch"]');
  const flowPort = caller.locator('[data-handleid="out"]');
  const drag = async (handleId: string) => {
    const source = caller.locator(`[data-handleid="${handleId}"]`);
    await expect
      .poll(async () => {
        const bounds = await pane.locator(".canvas").boundingBox();
        const handles = await Promise.all([
          source.boundingBox(),
          target.boundingBox(),
        ]);
        return (
          !!bounds &&
          handles.every(
            (handle) =>
              handle &&
              handle.x >= bounds.x &&
              handle.x + handle.width <= bounds.x + bounds.width &&
              handle.y >= bounds.y &&
              handle.y + handle.height <= bounds.y + bounds.height,
          )
        );
      })
      .toBe(true);
    await source.hover();
    const start = (await source.boundingBox())!;
    const end = (await target.boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
      steps: 15,
    });
    await page.mouse.up();
  };
  await drag("fetch");
  const fetchEdge = pane.locator(".react-flow__edge.fetch-connection");
  await expect(fetchEdge).toHaveCount(1);
  await expect(fetchEdge.locator(".react-flow__edge-path")).toHaveAttribute(
    "marker-start",
    /url/,
  );
  await expect(fetchEdge.locator(".react-flow__edge-path")).toHaveAttribute(
    "marker-end",
    /url/,
  );
  const fetchBounds = (await fetchPort.boundingBox())!;
  const flowBounds = (await flowPort.boundingBox())!;
  expect(fetchBounds.y).toBeLessThan(flowBounds.y);
  expect(Math.abs(fetchBounds.x - flowBounds.x)).toBeLessThan(1);
  await drag("out");
  const flowEdge = pane.locator(".react-flow__edge.flow-connection");
  await expect(flowEdge).toHaveCount(1);
  await expect(flowEdge.locator(".react-flow__edge-path")).not.toHaveAttribute(
    "marker-start",
  );
  // Arrange again now that connections define the flow direction, keeping labels
  // clear of the vertically stacked disconnected-node layout used to draw them.
  const connectedLayout = page.waitForResponse(
    (response) => response.url().endsWith("/api/arrange") && response.ok(),
  );
  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await fitArrangedDraft(page, await (await connectedLayout).json());
  await pane.locator(".fetch-label button").dblclick();
  await page
    .getByRole("textbox", { name: "Connection label", exact: true })
    .fill("Load profile");
  await page
    .getByRole("textbox", { name: "Connection label", exact: true })
    .press("Enter");
  const mcp = await client();
  try {
    const selected = await readWorkspaceLayout(mcp, page);
    const fetch = selected.selectedDraft.graph.edges.find(
      (edge: any) => edge.kind === "fetch",
    );
    expect(fetch.sourceHandle).toBe("fetch");
    expect(fetch.label).toBe("Load profile");
    expect(
      selected.selectedDraft.graph.edges.find(
        (edge: any) => edge.kind === "flow",
      ).sourceHandle,
    ).toBe("out");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(pane.locator(".fetch-label button")).toHaveText("Fetch");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(pane.locator(".fetch-label button")).toHaveText(
      "Load profile",
    );
    await page.getByRole("button", { name: "Arrange", exact: true }).click();
    await page
      .getByRole("button", { name: "Apply draft", exact: true })
      .click();
    const main = page.getByRole("region", { name: "Main canvas", exact: true });
    await expect(
      main.locator(".fetch-connection .react-flow__edge-path"),
    ).toHaveAttribute("marker-start", /url/);
    await page.reload();
    await expect(pane.locator(".fetch-label button")).toHaveText(
      "Load profile",
    );
    const restored = await readWorkspaceLayout(mcp, page);
    expect(
      restored.selectedMain.graph.edges.find(
        (edge: any) => edge.kind === "fetch",
      ),
    ).toEqual(fetch);
    await page.screenshot({ path: ".local/fetch-connections.png" });
  } finally {
    await mcp.close();
  }
});

test("draw and label connections, resize blocks, and preserve parallel edges and loops", async ({
  page,
}) => {
  await initialize(page, `Connections ${Date.now()}`);
  await page
    .getByRole("button", { name: "Add Interface", exact: true })
    .click();
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  const arranged = page.waitForResponse(
    (response) => response.url().endsWith("/api/arrange") && response.ok(),
  );
  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await fitArrangedDraft(page, await (await arranged).json());
  const draftPane = page.locator(".draft-pane");
  const source = draftPane
    .locator(".react-flow__node")
    .filter({ has: page.locator(".block-interface") });
  const target = draftPane
    .locator(".react-flow__node")
    .filter({ has: page.locator(".block-agent") });
  // React Flow uses pointer movement rather than an HTML drag-and-drop event.
  // Hover after layout has settled, then move through intermediate points so the
  // connection gesture crosses its activation threshold before reaching the target.
  const from = source.locator('[data-handleid="out"]');
  const to = target.locator(".react-flow__handle-left");
  await expect
    .poll(async () => {
      const canvas = await draftPane.locator(".canvas").boundingBox();
      const handles = await Promise.all([from.boundingBox(), to.boundingBox()]);
      return (
        !!canvas &&
        handles.every(
          (handle) =>
            handle &&
            handle.x >= canvas.x &&
            handle.x + handle.width <= canvas.x + canvas.width &&
            handle.y >= canvas.y &&
            handle.y + handle.height <= canvas.y + canvas.height,
        )
      );
    })
    .toBe(true);
  await from.hover();
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, {
    steps: 15,
  });
  await page.mouse.up();
  await expect(draftPane.locator(".react-flow__edge")).toHaveCount(1);
  await selectConnection(page, draftPane.locator(".react-flow__edge"));
  await draftPane
    .getByRole("button", { name: "Edit connection label" })
    .dblclick();
  await draftPane
    .getByRole("textbox", { name: "Connection label" })
    .fill("request");
  await draftPane
    .getByRole("textbox", { name: "Connection label" })
    .press("Enter");
  await expect(
    draftPane.getByRole("button", { name: "Edit connection label" }),
  ).toHaveText("request");
  const mcp = await client();
  try {
    const before = await call(mcp, "read_workspace");
    const saved = before.selectedDraft;
    expect(saved.graph.edges[0].label).toBe("request");
    const edge = saved.graph.edges[0];
    await call(mcp, "edit_draft", {
      conceptId: before.concept.id,
      draftId: saved.id,
      expectedRevision: saved.revision,
      operationId: crypto.randomUUID(),
      operations: [
        {
          kind: "add_edge",
          edge: { ...edge, id: "parallel", label: "second request" },
        },
        {
          kind: "add_edge",
          edge: {
            ...edge,
            id: "loop",
            source: edge.target,
            target: edge.target,
            label: "retry",
          },
        },
      ],
    });
    await expect(draftPane.locator(".react-flow__edge")).toHaveCount(3);
    const paths = await draftPane
      .locator(".react-flow__edge-path")
      .evaluateAll((elements) => elements.map((e) => e.getAttribute("d")));
    expect(new Set(paths).size).toBe(3);
    await target.locator(".block-kind").click();
    const handle = target.locator(
      ".react-flow__resize-control.bottom.right.handle",
    );
    const bounds = await handle.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(
      bounds!.x + bounds!.width / 2,
      bounds!.y + bounds!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(bounds!.x + 65, bounds!.y + 45, { steps: 5 });
    await page.mouse.up();
    const after = await readWorkspaceLayout(mcp, page);
    expect(
      after.selectedDraft.graph.nodes.find((n: any) => n.type === "agent")
        .width,
    ).toBeGreaterThan(250);
    await page.screenshot({ path: ".local/connections.png" });
  } finally {
    await mcp.close();
  }
});

test("overlapping user and agent edits retain local content until explicitly resolved", async ({
  page,
}) => {
  await initialize(page, `Conflicts ${Date.now()}`);
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  const mcp = await client();
  try {
    const workspace = await call(mcp, "read_workspace");
    const draft = workspace.selectedDraft;
    const node = draft.graph.nodes[0];
    // Delay only browser saves so the remote edit deterministically commits first.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/edit", async (route) => {
      await gate;
      await route.continue();
    });
    await page
      .getByRole("textbox", { name: "Block text", exact: true })
      .fill("My pending text");
    await page.getByRole("textbox", { name: "Block text", exact: true }).blur();
    await call(mcp, "edit_draft", {
      conceptId: workspace.concept.id,
      draftId: draft.id,
      expectedRevision: draft.revision,
      operationId: crypto.randomUUID(),
      operations: [
        {
          kind: "update_node",
          id: node.id,
          patch: { text: "Remote saved text" },
        },
      ],
    });
    release();
    await expect(
      page.getByText("This draft changed in the same place.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Block text", exact: true }),
    ).toHaveValue("My pending text");
    await expect(
      page.getByRole("button", { name: "Apply draft", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Use saved draft", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Block text", exact: true }),
    ).toHaveValue("Remote saved text");
    await page.unroute("**/api/edit");
    const fresh = await call(mcp, "read_workspace");
    let releaseSafe!: () => void;
    const safeGate = new Promise<void>((resolve) => {
      releaseSafe = resolve;
    });
    await page.route("**/api/edit", async (route) => {
      await safeGate;
      await route.continue();
    });
    await page
      .getByRole("textbox", { name: "Block text", exact: true })
      .fill("Safe local text");
    await page.getByRole("textbox", { name: "Block text", exact: true }).blur();
    await call(mcp, "edit_draft", {
      conceptId: fresh.concept.id,
      draftId: fresh.selectedDraft.id,
      expectedRevision: fresh.selectedDraft.revision,
      operationId: crypto.randomUUID(),
      operations: [
        {
          kind: "update_node",
          id: node.id,
          patch: { label: "Remote heading" },
        },
      ],
    });
    releaseSafe();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Block text", exact: true }),
    ).toHaveValue("Safe local text");
    await expect(
      page.getByRole("textbox", { name: "Block heading", exact: true }),
    ).toHaveValue("Remote heading");
  } finally {
    await mcp.close();
  }
});

test("a browser popup with copied session storage cannot inherit the shared tab", async ({
  page,
}) => {
  await initialize(page, `Tab identity ${Date.now()}`);
  const popupEvent = page.waitForEvent("popup");
  await page.evaluate(() => window.open("/", "_blank"));
  const popup = await popupEvent;
  await expect(
    popup.getByRole("button", {
      name: "Share this tab with agents",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Shared with agents", exact: true }),
  ).toBeVisible();
});

test("a lost save response recovers across reload and retries without duplicate blocks", async ({
  page,
}) => {
  await initialize(page, `Recovery ${Date.now()}`);
  await page.route("**/api/edit", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Add Agent", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry saving", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Block heading", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("Unsaved edits recovered.", { exact: false }),
  ).toBeVisible();
  await page.unroute("**/api/edit");
  await page.getByRole("button", { name: "Retry saving", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  const mcp = await client();
  try {
    const result = await call(mcp, "read_workspace");
    expect(result.selectedDraft.graph.nodes).toHaveLength(1);
  } finally {
    await mcp.close();
  }
});
