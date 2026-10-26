import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import type { Selection } from "../src/shared/model.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const { app, workspace } = createApp(store, {
    token: "test-secret",
    flushMs: 100,
    leaseMs: 500,
  });
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer test-secret" } },
    }),
  );
  cleanup.push(() => client.close());
  const call = async (name: string, args: any = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result).not.toHaveProperty("structuredContent");
    expect(result.content).toHaveLength(1);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].type).toBe("text");
    return { error: !!result.isError, data: JSON.parse(content[0].text) };
  };
  const project = store.createProject("Test", randomUUID());
  const concept = store.createConcept(project.id, "Selected", randomUUID());
  const draft = store.createDraft(concept.id, "Visible", null, randomUUID());
  const selected: Selection = {
    conceptId: concept.id,
    versionId: null,
    draftId: draft.id,
  };
  return {
    store,
    workspace,
    url,
    client,
    call,
    project,
    concept,
    draft,
    selected,
  };
}
describe("MCP and shared context", () => {
  it("copies drafts through create_draft and rejects ambiguous or stale copy sources", async () => {
    const { draft, concept, call } = await setup();
    const args = {
      conceptId: concept.id,
      sourceDraftId: draft.id,
      expectedSourceRevision: 0,
      name: "Agent copy",
      operationId: randomUUID(),
    };
    const copied = await call("create_draft", args);
    expect(copied.error).toBe(false);
    expect(copied.data.draftId).not.toBe(draft.id);
    expect(copied.data.revision).toBe(0);
    expect(await call("create_draft", args)).toEqual(copied);
    for (const source of [
      { sourceVersionId: null },
      { workspaceSelectionRevision: 0 },
    ]) {
      const ambiguous = await call("create_draft", {
        ...args,
        ...source,
        operationId: randomUUID(),
      });
      expect(ambiguous.error).toBe(true);
      expect(ambiguous.data.code).toBe("invalid_request");
    }
    const missingRevision = await call("create_draft", {
      conceptId: concept.id,
      sourceDraftId: draft.id,
      name: "Missing",
      operationId: randomUUID(),
    });
    expect(missingRevision.error).toBe(true);
    await call("edit_draft", {
      conceptId: concept.id,
      draftId: draft.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      operations: [{ kind: "rename", name: "Changed source" }],
    });
    const stale = await call("create_draft", {
      ...args,
      operationId: randomUUID(),
    });
    expect(stale.error).toBe(true);
    expect(stale.data.code).toBe("revision_conflict");
  });
  it("lets Codex add five Sub-agent calls without source slots in one request and rejects a sixth", async () => {
    const { draft, concept, call, store } = await setup();
    const node = (id: string) => ({
      id,
      type: "subagent",
      label: id,
      text: "",
      x: 0,
      y: 0,
      width: 250,
      height: 150,
    });
    const nodes = [
      "caller",
      "worker-0",
      "worker-1",
      "worker-2",
      "worker-3",
      "worker-4",
      "worker-5",
    ];
    const edge = (index: number) => ({
      id: `delegate-${index}`,
      source: "caller",
      target: `worker-${index}`,
      kind: "subagent",
      targetHandle: "in-top",
      label: "",
    });
    const result = await call("edit_draft", {
      conceptId: concept.id,
      draftId: draft.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      operations: [
        ...nodes.map((id) => ({ kind: "add_node", node: node(id) })),
        ...Array.from({ length: 5 }, (_, index) => ({
          kind: "add_edge",
          edge: edge(index),
        })),
      ],
    });
    expect(result.error).toBe(false);
    const read = await call("read_diagram", {
      conceptId: concept.id,
      kind: "draft",
      diagramId: draft.id,
    });
    expect(read.data.graph.edges).toHaveLength(5);
    expect(
      new Set(
        store.draft(draft.id).graph.edges.map((edge: any) => edge.sourceHandle),
      ).size,
    ).toBe(5);
    const sixth = await call("edit_draft", {
      conceptId: concept.id,
      draftId: draft.id,
      expectedRevision: result.data.revision,
      operationId: randomUUID(),
      operations: [{ kind: "add_edge", edge: edge(5) }],
    });
    expect(sixth.error).toBe(true);
    expect(sixth.data.message).toContain("at most five");
  });
  it("creates and reads Fetch connections through the agent tools", async () => {
    const { draft, concept, call } = await setup();
    const node = (id: string) => ({
      id,
      type: "agent",
      label: id,
      text: "",
      x: 0,
      y: 0,
      width: 250,
      height: 150,
    });
    const edge = {
      id: "fetch-data",
      source: "caller",
      target: "data",
      kind: "fetch",
      sourceHandle: "fetch",
      targetHandle: "in",
      label: "Read data",
    };
    const result = await call("edit_draft", {
      conceptId: concept.id,
      draftId: draft.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      operations: [
        { kind: "add_node", node: node("caller") },
        { kind: "add_node", node: node("data") },
        { kind: "add_edge", edge },
      ],
    });
    expect(result.error).toBe(false);
    const read = await call("read_diagram", {
      conceptId: concept.id,
      kind: "draft",
      diagramId: draft.id,
    });
    expect(read.data.graph.edges).toEqual([{ id: edge.id, source: edge.source, target: edge.target, kind: edge.kind, label: edge.label }]);
  });
  it("completes a real HTTP handshake with inspection and no main mutation tool", async () => {
    const { client } = await setup();
    const definitions = (await client.listTools()).tools;
    const tools = definitions.map((t) => t.name);
    expect(tools).toHaveLength(10);
    expect(tools).toContain("inspect_diagram");
    expect(tools).toContain("edit_draft");
    expect(tools.some((n) => /apply|main.*(create|edit)/.test(n))).toBe(false);
    expect(definitions.find((t) => t.name === "read_diagram")!.inputSchema.required).toEqual(["kind"]);
    expect(definitions.find((t) => t.name === "read_concept")!.inputSchema.required ?? []).toEqual([]);
    expect(definitions.every((t) => t.outputSchema === undefined)).toBe(true);
  });
  it("returns selected content and only references to unselected diagrams", async () => {
    const { store, workspace, concept, selected, call } = await setup();
    const other = store.createDraft(concept.id, "Other", null, randomUUID());
    store.edit({
      draftId: other.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      operations: [
        {
          kind: "add_node",
          node: {
            id: "secret",
            type: "process",
            label: "UNSELECTED_SENTINEL",
            text: "hidden body",
            x: 0,
            y: 0,
            width: 250,
            height: 160,
          },
        },
      ],
    });
    const s = workspace.register();
    workspace.select(s.id, selected);
    workspace.sessions.get(s.id)!.send = (event, data: any) => {
      if (event === "flush") workspace.acknowledge(s.id, data.requestId, true);
    };
    const result = await call("read_workspace");
    expect(result.data.selectedDraft.id).toBe(selected.draftId);
    expect(JSON.stringify(result)).not.toContain("UNSELECTED_SENTINEL");
    expect(result.data.drafts.some((d: any) => d.id === other.id)).toBe(true);
    const fetched = await call("read_diagram", {
      conceptId: concept.id,
      kind: "draft",
      diagramId: other.id,
    });
    expect(JSON.stringify(fetched)).toContain("UNSELECTED_SENTINEL");
  });
  it("reads a shared empty Concept and creates its first draft without a main version", async () => {
    const { store, workspace, project, call } = await setup();
    const concept = store.createConcept(
      project.id,
      "Empty concept",
      randomUUID(),
    );
    const session = workspace.register();
    workspace.select(session.id, {
      conceptId: concept.id,
      versionId: null,
      draftId: null,
    });
    workspace.sessions.get(session.id)!.send = (event, data: any) => {
      if (event === "flush")
        workspace.acknowledge(session.id, data.requestId, true);
    };
    workspace.claim(session.id);
    const initial = await call("read_workspace");
    expect(initial.error).toBe(false);
    expect(initial.data.status).toBe("ready");
    expect(initial.data.concept.id).toBe(concept.id);
    expect(initial.data.selectedMain).toBeNull();
    expect(initial.data.selectedDraft).toBeNull();
    expect(initial.data.drafts).toEqual([]);
    expect(initial.data.versions).toEqual([]);
    const created = await call("create_draft", {
      conceptId: concept.id,
      name: "Initial architecture",
      sourceVersionId: null,
      operationId: randomUUID(),
    });
    expect(created.error).toBe(false);
    const diagram = await call("read_diagram", {
      conceptId: concept.id,
      kind: "draft",
      diagramId: created.data.draftId,
    });
    expect(diagram.data.graph).toEqual({
      schemaVersion: 1,
      nodes: [],
      edges: [],
    });
    expect(store.detail(concept.id).versions).toEqual([]);
  });
  it("does not expose secondary selections or automatically promote a secondary tab", async () => {
    const { workspace, selected, call } = await setup();
    const first = workspace.register();
    const second = workspace.register();
    workspace.select(first.id, selected);
    workspace.sessions.get(first.id)!.send = (event, data: any) => {
      if (event === "flush")
        workspace.acknowledge(first.id, data.requestId, true);
    };
    workspace.select(second.id, {
      conceptId: null,
      versionId: null,
      draftId: null,
    });
    expect((await call("read_workspace")).data.selectedDraft.id).toBe(
      selected.draftId,
    );
    workspace.close(first.id);
    workspace.touch(second.id);
    expect((await call("read_workspace")).data.status).toBe(
      "no_active_workspace",
    );
    workspace.claim(second.id);
    expect((await call("read_workspace")).error).toBe(true);
  });
  it("returns busy instead of stale context when the browser has not flushed", async () => {
    const { workspace, selected, call } = await setup();
    const s = workspace.register();
    workspace.select(s.id, selected);
    workspace.sessions.get(s.id)!.send = () => {};
    const result = await call("read_workspace");
    expect(result.error).toBe(true);
    expect(result.data.code).toBe("workspace_busy");
  });
  it("repairs shared selections when drafts are deleted and excludes deleted drafts from MCP", async () => {
    const { store, workspace, selected, concept, draft, call } = await setup();
    const next = store.createDraft(concept.id, "Next", null, randomUUID());
    const session = workspace.register();
    workspace.select(session.id, selected);
    workspace.sessions.get(session.id)!.send = (event, data: any) => {
      if (event === "flush")
        workspace.acknowledge(session.id, data.requestId, true);
    };
    workspace.deleteDraft(draft.id, draft.revision, randomUUID());
    const after = await call("read_workspace");
    expect(after.data.selectedDraft.id).toBe(next.id);
    expect(after.data.drafts).toEqual([]);
    const deleted = await call("read_diagram", {
      conceptId: concept.id,
      kind: "draft",
      diagramId: draft.id,
    });
    expect(deleted.error).toBe(true);
    expect(deleted.data.code).toBe("not_found");
    workspace.deleteDraft(next.id, 0, randomUUID());
    const empty = await call("read_workspace");
    expect(empty.data.status).toBe("ready");
    expect(empty.data.selectedDraft).toBeNull();
  });
  it("applies agent batches to drafts and returns a conflict on stale revisions", async () => {
    const { draft, concept, call } = await setup();
    const args = {
      conceptId: concept.id,
      draftId: draft.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      operations: [{ kind: "rename", name: "Agent alternative" }],
    };
    expect((await call("edit_draft", args)).data.revision).toBe(1);
    const stale = await call("edit_draft", {
      ...args,
      operationId: randomUUID(),
    });
    expect(stale.error).toBe(true);
    expect(stale.data.code).toBe("revision_conflict");
  });
  it("rejects unauthenticated MCP and browser writes, foreign origins and hosts", async () => {
    const { url } = await setup();
    expect(
      (
        await fetch(`${url}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://example.com",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const status = await new Promise<number>((resolve) => {
      const request = httpRequest(
        `${url}/api/health`,
        { headers: { Host: "evil.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.end();
    });
    expect(status).toBe(403);
  });
  it("returns complete compact metadata without pagination", async () => {
    const { store, concept, call } = await setup();
    for (let i = 0; i < 52; i++)
      store.createDraft(concept.id, `Draft ${i}`, null, randomUUID());
    const first = (await call("read_concept", { conceptId: concept.id })).data;
    expect(first.drafts).toHaveLength(53);
    expect(first).not.toHaveProperty("draftCursor");
    expect(first).not.toHaveProperty("versionCursor");
    expect(Object.keys(first.drafts[0]).sort()).toEqual(["id", "name", "revision"]);
    expect(JSON.stringify(first)).not.toContain('"graph"');
    expect(JSON.stringify(first)).not.toContain('"createdAt"');
  });

  it("reads only the selected flow without IDs, flushes edits, and follows selection changes", async () => {
    const { workspace, store, selected, draft, concept, call } = await setup();
    const main = store.apply(draft.id, 0, randomUUID()).version;
    const other = store.createDraft(concept.id, "Other", null, randomUUID());
    const session = workspace.register();
    workspace.select(session.id, { ...selected, versionId: main.id });
    workspace.sessions.get(session.id)!.send = (event, data: any) => {
      if (event !== "flush") return;
      const current = store.draft(draft.id);
      store.edit({ draftId: draft.id, expectedRevision: current.revision,
        operationId: randomUUID(), operations: [{ kind: "rename", name: "Flushed edit" }] });
      workspace.acknowledge(session.id, data.requestId, true);
    };
    const versionSpy = vi.spyOn(store, "version");
    const detailSpy = vi.spyOn(store, "detail");
    const read = await call("read_diagram", { kind: "draft" });
    expect(read.error).toBe(false);
    expect(read.data).toMatchObject({ kind: "draft", id: draft.id, conceptId: concept.id, name: "Flushed edit", revision: 2 });
    expect(versionSpy).not.toHaveBeenCalled();
    expect(detailSpy).not.toHaveBeenCalled();
    expect(read.data).not.toHaveProperty("diagram");
    // The selected main can be older than the latest saved version.
    store.apply(draft.id, store.draft(draft.id).revision, randomUUID());
    const mainRead = await call("read_diagram", { kind: "main" });
    expect(mainRead.data).toMatchObject({ kind: "main", id: main.id, number: 1 });
    const selectedMetadata = (await call("read_concept")).data;
    const copiedMain = await call("create_draft", {
      conceptId: selectedMetadata.concept.id, name: "Copy displayed main",
      workspaceSelectionRevision: selectedMetadata.selectionRevision, operationId: randomUUID(),
    });
    expect(copiedMain.data.baseVersionId).toBe(main.id);
    const secondary = workspace.register();
    workspace.select(secondary.id, { ...selected, draftId: other.id });
    expect((await call("read_diagram", { kind: "draft" })).data.id).toBe(draft.id);
    workspace.select(session.id, { ...selected, draftId: other.id });
    expect((await call("read_diagram", { kind: "draft" })).data.id).toBe(other.id);
    const metadata = await call("read_concept");
    expect(metadata.data).toMatchObject({ concept: { id: concept.id }, selectedDraftId: other.id, selectedMainId: null });
    expect(metadata.data).not.toHaveProperty("graph");
    const wrong = await call("read_diagram", { kind: "draft", conceptId: "another-concept" });
    expect(wrong.data.code).toBe("wrong_concept");
    // Explicit IDs work without a shared browser, including an optional ownership check.
    workspace.close(session.id);
    expect((await call("read_diagram", { kind: "draft", diagramId: other.id })).data.id).toBe(other.id);
    expect((await call("read_diagram", { kind: "draft", diagramId: other.id, conceptId: "wrong" })).data.code).toBe("wrong_concept");
    versionSpy.mockRestore();
    detailSpy.mockRestore();
  });

  it("reports absent, busy and changed selections instead of guessing a current diagram", async () => {
    const { workspace, selected, call } = await setup();
    expect((await call("read_diagram", { kind: "draft" })).data).toEqual({ status: "no_active_workspace" });
    expect((await call("read_concept")).data).toEqual({ status: "no_active_workspace" });
    const session = workspace.register();
    workspace.sessions.get(session.id)!.send = (event, data: any) => {
      if (event === "flush") workspace.acknowledge(session.id, data.requestId, true);
    };
    expect((await call("read_diagram", { kind: "draft" })).data.status).toBe("no_concept_selected");
    workspace.select(session.id, { ...selected, draftId: null });
    for (const kind of ["draft", "main"]) {
      expect((await call("read_diagram", { kind })).data).toMatchObject({
        status: `no_${kind}_selected`, conceptId: selected.conceptId,
      });
    }
    workspace.sessions.get(session.id)!.send = () => {};
    expect((await call("read_diagram", { kind: "draft" })).data.code).toBe("workspace_busy");
    const secondary = workspace.register();
    workspace.sessions.get(session.id)!.send = (event, data: any) => {
      if (event !== "flush") return;
      workspace.claim(secondary.id);
      workspace.acknowledge(session.id, data.requestId, true);
    };
    expect((await call("read_diagram", { kind: "draft" })).data.code).toBe("workspace_changed");
  });

  it("returns every branch, join and cycle in large flows without layout or empty fields", async () => {
    const { store, workspace, selected, concept, draft, call } = await setup();
    const nodes = Array.from({ length: 120 }, (_, i) => ({
      id: `node-${String(i).padStart(3, "0")}`, type: i === 0 ? "decision" : "process",
      label: `Step ${i}`, ...(i === 1 ? { text: "Keep this note" } : {}),
    }));
    const edges = nodes.slice(1).map((node, i) => ({
      id: `edge-${i}`, source: nodes[0].id, target: node.id, label: `Branch ${i}`,
    }));
    edges.push({ id: "join", source: nodes[1].id, target: nodes[119].id, label: "Join" });
    edges.push({ id: "cycle", source: nodes[119].id, target: nodes[0].id, label: "Retry" });
    const edited = await call("edit_draft", {
      conceptId: concept.id, draftId: draft.id, expectedRevision: 0, operationId: randomUUID(),
      operations: [...[...nodes].reverse().map((node) => ({ kind: "add_node", node })),
        ...edges.map((edge) => ({ kind: "add_edge", edge }))],
    });
    expect(edited.error).toBe(false);
    const result = (await call("read_diagram", { kind: "draft", diagramId: draft.id })).data;
    expect(result.graph.nodes).toEqual(nodes);
    expect(result.graph.edges).toHaveLength(edges.length);
    expect(result.graph.edges).toEqual(expect.arrayContaining(edges.map((edge) => ({ ...edge, kind: "flow" }))));
    expect(result.graph.edges.map((edge: any) => edge.id)).toEqual(edges.map((edge) => edge.id).sort());
    expect(store.draft(draft.id).graph.nodes[0]).toMatchObject({ x: 0, y: 0, width: 250, height: 150, text: "" });
    const main = store.apply(draft.id, edited.data.revision, randomUUID()).version;
    expect((await call("read_diagram", { kind: "main", diagramId: main.id })).data.graph).toEqual(result.graph);
    const session = workspace.register();
    workspace.select(session.id, { ...selected, versionId: main.id });
    workspace.sessions.get(session.id)!.send = (event, data: any) => {
      if (event === "flush") workspace.acknowledge(session.id, data.requestId, true);
    };
    const all = (await call("read_workspace")).data;
    expect(all.selectedDraft.graph).toEqual(result.graph);
    expect(all.selectedMain.graph).toEqual(result.graph);
    expect(all.drafts).toEqual([]);
    expect(all.versions).toEqual([]);
    expect(all).not.toHaveProperty("latestVersionId");
    for (const field of ["createdAt", "updatedAt", "x", "y", "width", "height", "sourceHandle", "targetHandle"]) {
      expect(JSON.stringify(all)).not.toContain(`"${field}":`);
    }
    const arranged = await call("arrange_draft", {
      conceptId: concept.id, draftId: draft.id, expectedRevision: store.draft(draft.id).revision,
      operationId: randomUUID(),
    });
    expect(arranged.error).toBe(false);
    expect((await call("read_diagram", { kind: "draft", diagramId: draft.id })).data.graph).toEqual(result.graph);
  });

  it("allocates and converts connection ports without exposing them and preserves retries", async () => {
    const { store, concept, draft, call } = await setup();
    const args = { conceptId: concept.id, draftId: draft.id, expectedRevision: 0,
      operationId: randomUUID(), operations: [
        ...["a", "b"].map((id) => ({ kind: "add_node", node: { id, type: "agent", label: id } })),
        { kind: "add_edge", edge: { id: "call", source: "a", target: "b", kind: "fetch" } },
      ] };
    const first = await call("edit_draft", args);
    expect(first.error).toBe(false);
    expect(await call("edit_draft", args)).toEqual(first);
    expect(store.draft(draft.id).graph.edges[0].sourceHandle).toBe("fetch");
    for (const kind of ["subagent", "flow", "fetch"]) {
      const changed = await call("edit_draft", {
        conceptId: concept.id, draftId: draft.id, expectedRevision: store.draft(draft.id).revision,
        operationId: randomUUID(), operations: [{ kind: "update_edge", id: "call", patch: { kind } }],
      });
      expect(changed.error).toBe(false);
      const current = (await call("read_diagram", { kind: "draft", diagramId: draft.id })).data;
      expect(current.graph.edges).toEqual([{ id: "call", source: "a", target: "b", kind }]);
      expect(store.draft(draft.id).graph.edges[0].sourceHandle).toBe(kind === "flow" ? "out" : kind);
      expect(store.draft(draft.id).graph.edges[0].targetHandle).toBe(kind === "subagent" ? "in-top" : "in");
    }
  });

  it("inspects only the selected shared diagram and returns PNG separately from JSON", async () => {
    const { workspace, selected, draft, concept, store, client, call } = await setup();
    const owner = workspace.register(), privateTab = workspace.register();
    workspace.select(owner.id, selected);
    workspace.select(privateTab.id, selected);
    let requests = 0;
    workspace.sessions.get(privateTab.id)!.send = (event) => {
      if (event === "inspect" || event === "flush") throw new Error("Private tab must not be inspected");
    };
    workspace.sessions.get(owner.id)!.send = (event, data: any) => {
      if (event === "flush") workspace.acknowledge(owner.id, data.requestId, true);
      if (event === "inspect") {
        requests++;
        expect(data.revision).toBe(0);
        // A different authenticated browser cannot answer this request.
        workspace.acknowledgeInspection(privateTab.id, data.requestId, { status: "not_displayed" });
        expect(workspace.inspections.has(data.requestId)).toBe(true);
        workspace.acknowledgeInspection(owner.id, data.requestId, {
          status: "rendered", view: data.canvasId === draft.id ? "shared_canvas" : "saved_preview", revision: 0, bounds: { x: 0, y: 0, width: 100, height: 100 },
          issues: [], issuesTruncated: false, selectedNodeIds: [], selectedEdgeIds: [],
          image: { data: "iVBORw0KGgo=", width: 100, height: 100 },
        });
      }
    };
    const result = await client.callTool({ name: "inspect_diagram", arguments: { kind: "draft" } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    const content = result.content as any[];
    expect(JSON.parse(content[0].text)).toMatchObject({ status: "rendered", diagramId: draft.id, preview: { width: 100, height: 100 } });
    expect(content[0].text).not.toContain("iVBOR");
    expect(content[1]).toEqual({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
    expect((await call("inspect_diagram", { kind: "draft", includeImage: false })).data.preview).toBeUndefined();
    const other = store.createDraft(concept.id, "Not displayed", null, randomUUID());
    expect((await call("inspect_diagram", { kind: "draft", diagramId: other.id, includeImage: false })).data.view).toBe("saved_preview");
    expect(requests).toBe(3);
    expect(workspace.inspections.size).toBe(0);
  });

  it("rejects stale rendered revisions and ownership changes and clears inspection timeouts", async () => {
    const { workspace, selected, call } = await setup();
    const owner = workspace.register(), second = workspace.register();
    workspace.select(owner.id, selected);
    let mode = "stale";
    workspace.sessions.get(owner.id)!.send = (event, data: any) => {
      if (event === "flush") workspace.acknowledge(owner.id, data.requestId, true);
      if (event === "inspect" && mode !== "timeout") {
        if (mode === "owner") workspace.claim(second.id);
        workspace.acknowledgeInspection(owner.id, data.requestId, mode === "owner" ? { status: "not_displayed" } : {
          status: "rendered", view: "shared_canvas", revision: 999, bounds: { x: 0, y: 0, width: 100, height: 100 },
          issues: [], issuesTruncated: false, selectedNodeIds: [], selectedEdgeIds: [],
        });
      }
    };
    expect((await call("inspect_diagram", { kind: "draft" })).data.code).toBe("workspace_changed");
    mode = "owner";
    expect((await call("inspect_diagram", { kind: "draft" })).data.code).toBe("workspace_changed");
    workspace.claim(owner.id);
    workspace.inspectionMs = 20;
    mode = "timeout";
    expect((await call("inspect_diagram", { kind: "draft" })).data.status).toBe("render_failed");
    expect(workspace.inspections.size).toBe(0);
  });

  it("returns every catalog and version reference without timestamps or cursors", async () => {
    const { store, project, concept, draft, selected, workspace, call } = await setup();
    const created = await call("create_project", { name: "Container", operationId: randomUUID() });
    expect(created.data.project).toEqual({ id: expect.any(String), name: "Container" });
    const added = await call("create_concept", { projectId: created.data.project.id, name: "Empty", operationId: randomUUID() });
    expect(added.data.concept).toEqual({ id: expect.any(String), projectId: created.data.project.id, name: "Empty", latestVersionId: null });
    for (let i = 0; i < 52; i++) {
      store.createConcept(project.id, `Concept ${i}`, randomUUID());
      store.apply(draft.id, store.draft(draft.id).revision, randomUUID());
      store.createDraft(concept.id, `Draft ${i}`, null, randomUUID());
    }
    const catalog = (await call("list_concepts")).data;
    expect(catalog.concepts).toHaveLength(54);
    expect(catalog.projects).toHaveLength(2);
    expect(catalog).not.toHaveProperty("nextCursor");
    expect(JSON.stringify(catalog)).not.toContain("createdAt");
    expect((await call("list_concepts", { projectId: project.id })).data.concepts).toHaveLength(53);
    const detail = (await call("read_concept", { conceptId: concept.id })).data;
    expect(detail.versions).toHaveLength(52);
    expect(detail.versions[0]).toEqual({ id: expect.any(String), number: 52 });
    const session = workspace.register();
    workspace.select(session.id, selected);
    workspace.sessions.get(session.id)!.send = (event, data: any) => {
      if (event === "flush") workspace.acknowledge(session.id, data.requestId, true);
    };
    const all = (await call("read_workspace")).data;
    expect(all.drafts).toHaveLength(52);
    expect(all.versions).toHaveLength(52);
    expect(all).not.toHaveProperty("draftCursor");
  });
});
