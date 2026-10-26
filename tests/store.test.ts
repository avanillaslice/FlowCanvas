import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.js";
import { subagentHandles, type Block } from "../src/shared/model.js";
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.db.open) store.close();
  }
});
const uuid = () => randomUUID();
const block = (label = "Primary agent"): Block => ({
  id: uuid(),
  type: "agent",
  label,
  text: "",
  x: 0,
  y: 0,
  width: 250,
  height: 160,
});
function setup(path = ":memory:") {
  const store = new Store(path);
  stores.push(store);
  const project = store.createProject("Backend", uuid());
  const concept = store.createConcept(project.id, "Agent flow", uuid());
  const draft = store.createDraft(concept.id, "Initial flow", null, uuid());
  return { store, project, concept, draft };
}
describe("draft and main lifecycle", () => {
  it("uses top inputs for new sub-agent calls while preserving legacy ports on note edits and immutable main", () => {
    const { store, draft } = setup();
    const nodes = [block("Caller"), block("Worker")];
    const edited = store.edit({ draftId: draft.id, expectedRevision: 0, operationId: uuid(), operations: [
      ...nodes.map((node) => ({ kind: "add_node" as const, node })),
      { kind: "add_edge", edge: { id: "call", kind: "subagent", source: nodes[0].id, target: nodes[1].id, targetHandle: "in" } },
    ] });
    expect(edited.graph.edges[0].targetHandle).toBe("in-top");
    const legacy = structuredClone(edited.graph);
    legacy.edges[0].targetHandle = "in";
    store.db.prepare("UPDATE drafts SET graph=? WHERE id=?").run(JSON.stringify(legacy), draft.id);
    const main = store.apply(draft.id, edited.revision, uuid()).version;
    const notes = store.edit({ draftId: draft.id, expectedRevision: store.draft(draft.id).revision, operationId: uuid(), operations: [
      { kind: "update_edge", id: "call", patch: { label: "Delegate research" } },
    ] });
    expect(notes.graph.edges[0].targetHandle).toBe("in");
    const reconnected = store.edit({ draftId: draft.id, expectedRevision: notes.revision, operationId: uuid(), operations: [
      { kind: "update_edge", id: "call", patch: { targetHandle: "in" } },
    ] });
    expect(reconnected.graph.edges[0].targetHandle).toBe("in-top");
    expect(store.version(main.id).graph).toEqual(legacy);
    expect(store.undo(draft.id, reconnected.revision, "undo", uuid()).graph.edges[0].targetHandle).toBe("in");
  });
  it("copies the current draft independently, preserves its main base and connection kinds, and starts fresh history", () => {
    const { store, draft, concept } = setup();
    const caller = block("Original");
    const worker = { ...block("Worker"), type: "subagent" as const };
    const data = { ...block("Records"), type: "store" as const };
    const source = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [
        ...[caller, worker, data].map((node) => ({
          kind: "add_node" as const,
          node,
        })),
        {
          kind: "add_edge",
          edge: {
            id: "next",
            source: caller.id,
            target: data.id,
            kind: "flow",
            label: "Next",
          },
        },
        {
          kind: "add_edge",
          edge: {
            id: "fetch",
            source: caller.id,
            target: data.id,
            kind: "fetch",
            sourceHandle: "fetch",
            label: "Read records",
          },
        },
        {
          kind: "add_edge",
          edge: {
            id: "delegate",
            source: caller.id,
            target: worker.id,
            kind: "subagent",
            label: "Review",
          },
        },
      ],
    });
    const applied = store.apply(draft.id, source.revision, uuid());
    const latest = store.edit({
      draftId: draft.id,
      expectedRevision: applied.draft.revision,
      operationId: uuid(),
      operations: [
        {
          kind: "update_node",
          id: caller.id,
          patch: { text: "Latest draft notes", x: 450, width: 360 },
        },
      ],
    });
    const request = uuid();
    const copied = store.copyDraft(
      concept.id,
      draft.id,
      "Alternative",
      latest.revision,
      request,
    );
    expect(copied.id).not.toBe(draft.id);
    expect(copied.graph).toEqual(latest.graph);
    expect(copied.baseVersionId).toBe(applied.version.id);
    expect(copied.originVersionId).toBe(applied.version.id);
    expect(copied.revision).toBe(0);
    expect(store.history.has(copied.id)).toBe(false);
    expect(() => store.undo(copied.id, 0, "undo", uuid())).toThrow(
      "Nothing to undo",
    );
    expect(
      store.copyDraft(
        concept.id,
        draft.id,
        "Alternative",
        latest.revision,
        request,
      ),
    ).toEqual(copied);
    expect(store.detail(concept.id).drafts).toHaveLength(2);
    const changed = store.edit({
      draftId: copied.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [
        {
          kind: "update_node",
          id: caller.id,
          patch: { label: "Independent alternative" },
        },
      ],
    });
    expect(store.draft(draft.id)).toEqual(latest);
    store.deleteDraft(draft.id, latest.revision, uuid());
    expect(store.draft(copied.id)).toEqual(changed);
    expect(
      store.apply(copied.id, changed.revision, uuid()).version.number,
    ).toBe(2);
    expect(store.version(applied.version.id)).toEqual(applied.version);
  });
  it("rejects stale, deleted, and cross-Concept draft copy sources without creating copies", () => {
    const { store, draft, concept, project } = setup();
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [{ kind: "rename", name: "Changed" }],
    });
    expect(() =>
      store.copyDraft(concept.id, draft.id, "Copy", 0, uuid()),
    ).toThrow("changed");
    const other = store.createConcept(project.id, "Other", uuid());
    expect(() =>
      store.copyDraft(other.id, draft.id, "Copy", edited.revision, uuid()),
    ).toThrow("another Concept");
    expect(store.detail(concept.id).drafts).toHaveLength(1);
    expect(store.detail(other.id).drafts).toEqual([]);
    store.deleteDraft(draft.id, edited.revision, uuid());
    expect(() =>
      store.copyDraft(concept.id, draft.id, "Copy", edited.revision, uuid()),
    ).toThrow("Draft not found");
    expect(store.detail(concept.id).drafts).toEqual([]);
  });
  it("assigns all five Sub-agent slots in one batch and rejects a sixth atomically", () => {
    const { store, draft } = setup();
    const caller = block();
    const workers = Array.from({ length: 6 }, (_, index) => ({
      ...block(`Worker ${index}`),
      type: "subagent" as const,
    }));
    const call = (index: number) => ({
      id: `call-${index}`,
      source: caller.id,
      target: workers[index].id,
      kind: "subagent" as const,
      targetHandle: "in-top" as const,
      label: `Delegate ${index}`,
    });
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [
        { kind: "add_node", node: caller },
        ...workers.map((node) => ({ kind: "add_node" as const, node })),
        ...workers.slice(0, 5).map((_, index) => ({
          kind: "add_edge" as const,
          edge: call(index),
        })),
      ],
    });
    expect(edited.graph.edges.map((edge) => edge.sourceHandle)).toEqual([
      ...subagentHandles,
    ]);
    expect(() =>
      store.edit({
        draftId: draft.id,
        expectedRevision: edited.revision,
        operationId: uuid(),
        operations: [
          { kind: "rename", name: "Must roll back" },
          { kind: "add_edge", edge: call(5) },
        ],
      }),
    ).toThrow("at most five");
    expect(store.draft(draft.id)).toEqual(edited);
    const freed = store.edit({
      draftId: draft.id,
      expectedRevision: edited.revision,
      operationId: uuid(),
      operations: [{ kind: "delete_edge", id: "call-1" }],
    });
    const replaced = store.edit({
      draftId: draft.id,
      expectedRevision: freed.revision,
      operationId: uuid(),
      operations: [{ kind: "add_edge", edge: call(5) }],
    });
    expect(replaced.graph.edges.at(-1)?.sourceHandle).toBe("subagent-left");
    const applied = store.apply(draft.id, replaced.revision, uuid());
    expect(applied.version.graph.edges).toEqual(replaced.graph.edges);
  });
  it("preserves chosen Sub-agent slots and rejects reused slots or normal flow on bottom ports", () => {
    const { store, draft } = setup();
    const caller = block();
    const worker = { ...block("Worker"), type: "subagent" as const };
    const edge = {
      id: uuid(),
      source: caller.id,
      target: worker.id,
      kind: "subagent" as const,
      sourceHandle: "subagent-right" as const,
    };
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [
        { kind: "add_node", node: caller },
        { kind: "add_node", node: worker },
        { kind: "add_edge", edge },
      ],
    });
    expect(edited.graph.edges[0].sourceHandle).toBe("subagent-right");
    expect(() =>
      store.edit({
        draftId: draft.id,
        expectedRevision: edited.revision,
        operationId: uuid(),
        operations: [{ kind: "add_edge", edge: { ...edge, id: uuid() } }],
      }),
    ).toThrow("only one call");
    expect(() =>
      store.edit({
        draftId: draft.id,
        expectedRevision: edited.revision,
        operationId: uuid(),
        operations: [
          { kind: "update_edge", id: edge.id, patch: { kind: "flow" } },
        ],
      }),
    ).toThrow("dedicated bottom slot");
    expect(store.draft(draft.id)).toEqual(edited);
    const undone = store.undo(draft.id, edited.revision, "undo", uuid());
    expect(undone.graph.edges).toEqual([]);
    const redone = store.undo(draft.id, undone.revision, "redo", uuid());
    expect(redone.graph.edges[0].sourceHandle).toBe("subagent-right");
  });
  it("moves retired bottom flow outputs to the right on edits without rewriting old main snapshots", () => {
    const { store, draft } = setup();
    const caller = block();
    const target = block("Next step");
    const legacy = {
      schemaVersion: 1,
      nodes: [caller, target],
      edges: [
        {
          id: "legacy-flow",
          source: caller.id,
          target: target.id,
          sourceHandle: "out-bottom",
          targetHandle: "in-top",
          label: "Next",
        },
      ],
    };
    store.db
      .prepare("UPDATE drafts SET graph=? WHERE id=?")
      .run(JSON.stringify(legacy), draft.id);
    const applied = store.apply(draft.id, 0, uuid());
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: applied.draft.revision,
      operationId: uuid(),
      operations: [{ kind: "rename", name: "Updated" }],
    });
    expect(edited.graph.edges[0].sourceHandle).toBe("out");
    expect(store.version(applied.version.id).graph).toEqual(legacy);
  });
  it("preserves Fetch connection semantics across layout, main snapshots, and undo/redo", async () => {
    const { store, draft } = setup();
    const caller = block("Caller");
    const data = { ...block("Data source"), type: "store" as const };
    const edge = {
      id: uuid(),
      source: caller.id,
      target: data.id,
      kind: "fetch" as const,
      sourceHandle: "fetch" as const,
      targetHandle: "in" as const,
      label: "Load records",
    };
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [
        { kind: "add_node", node: caller },
        { kind: "add_node", node: data },
        { kind: "add_edge", edge },
      ],
    });
    const arranged = await store.arrange(draft.id, edited.revision, uuid());
    const applied = store.apply(draft.id, arranged.revision, uuid());
    expect(applied.version.graph.edges).toEqual([edge]);
    const renamed = store.edit({
      draftId: draft.id,
      expectedRevision: applied.draft.revision,
      operationId: uuid(),
      operations: [
        {
          kind: "update_edge",
          id: edge.id,
          patch: { label: "Fetch settings" },
        },
      ],
    });
    const undone = store.undo(draft.id, renamed.revision, "undo", uuid());
    expect(undone.graph.edges).toEqual([edge]);
    const redone = store.undo(draft.id, undone.revision, "redo", uuid());
    expect(redone.graph.edges[0]).toEqual({ ...edge, label: "Fetch settings" });
    expect(store.version(applied.version.id).graph.edges).toEqual([edge]);
  });
  it("keeps legacy flow edges valid and rejects Fetch connections on normal output ports atomically", () => {
    const { store, draft } = setup();
    const caller = block();
    const target = block("Target");
    const edge = {
      id: uuid(),
      source: caller.id,
      target: target.id,
      sourceHandle: "out" as const,
      targetHandle: "in" as const,
      label: "Next",
    };
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [
        { kind: "add_node", node: caller },
        { kind: "add_node", node: target },
        { kind: "add_edge", edge },
      ],
    });
    expect(edited.graph.edges).toEqual([edge]);
    for (const patch of [
      { kind: "fetch" as const },
      { sourceHandle: "fetch" as const },
    ]) {
      expect(() =>
        store.edit({
          draftId: draft.id,
          expectedRevision: edited.revision,
          operationId: uuid(),
          operations: [
            { kind: "rename", name: "Must roll back" },
            { kind: "update_edge", id: edge.id, patch },
          ],
        }),
      ).toThrow("Fetch connections must use");
      expect(store.draft(draft.id)).toEqual(edited);
    }
  });
  it("deletes applied drafts without changing immutable main history and persists deletion", () => {
    const directory = mkdtempSync(join(tmpdir(), "flowcanvas-delete-"));
    const path = join(directory, "data.db");
    const { store, draft, concept } = setup(path);
    const applied = store.apply(draft.id, 0, uuid());
    const alternative = store.createDraft(
      concept.id,
      "Alternative",
      applied.version.id,
      uuid(),
    );
    store.setSetting("lastSelection", {
      conceptId: concept.id,
      versionId: applied.version.id,
      draftId: draft.id,
    });
    const request = uuid();
    const result = store.deleteDraft(draft.id, applied.draft.revision, request);
    expect(result.replacementDraftId).toBe(alternative.id);
    expect(
      store.deleteDraft(draft.id, applied.draft.revision, request),
    ).toEqual(result);
    expect(() => store.draft(draft.id)).toThrow("Draft not found");
    expect(store.detail(concept.id).drafts.map((d) => d.id)).toEqual([
      alternative.id,
    ]);
    expect(store.version(applied.version.id)).toEqual(applied.version);
    expect(store.db.pragma("foreign_key_check")).toEqual([]);
    expect(store.setting<any>("lastSelection").draftId).toBe(alternative.id);
    store.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(() => reopened.draft(draft.id)).toThrow("Draft not found");
    expect(reopened.version(applied.version.id)).toEqual(applied.version);
    expect(
      reopened.createDraft(
        concept.id,
        "From saved main",
        applied.version.id,
        uuid(),
      ).graph,
    ).toEqual(applied.version.graph);
  });
  it("rejects deleting a draft that changed since confirmation and clears its history on deletion", () => {
    const { store, draft, concept } = setup();
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [{ kind: "add_node", node: block() }],
    });
    expect(() => store.deleteDraft(draft.id, 0, uuid())).toThrow("changed");
    expect(store.draft(draft.id).revision).toBe(edited.revision);
    expect(
      store.deleteDraft(draft.id, edited.revision, uuid()).replacementDraftId,
    ).toBeNull();
    expect(store.history.has(draft.id)).toBe(false);
    expect(store.detail(concept.id).drafts).toEqual([]);
    expect(() =>
      store.edit({
        draftId: draft.id,
        expectedRevision: edited.revision,
        operationId: uuid(),
        operations: [{ kind: "rename", name: "Revive" }],
      }),
    ).toThrow("Draft not found");
  });
  it("backs up schema v1 before migrating and preserves existing drafts", () => {
    const directory = mkdtempSync(join(tmpdir(), "flowcanvas-migrate-"));
    const path = join(directory, "data.db");
    const { store, draft } = setup(path);
    store.db.exec("DROP TABLE deleted_drafts; PRAGMA user_version = 1;");
    store.close();
    const migrated = new Store(path);
    stores.push(migrated);
    expect(migrated.draft(draft.id)).toEqual(draft);
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(2);
    const backups = readdirSync(directory).filter((name) =>
      name.includes(".backup-v1-"),
    );
    expect(backups).toHaveLength(1);
    const backup = new Database(join(directory, backups[0]), {
      readonly: true,
    });
    try {
      expect(backup.pragma("user_version", { simple: true })).toBe(1);
      expect(
        backup.prepare("SELECT id FROM drafts WHERE id=?").get(draft.id),
      ).toEqual({ id: draft.id });
    } finally {
      backup.close();
    }
  });
  it("keeps one draft editable across applications and updates its prefix base", () => {
    const { store, draft, concept } = setup();
    const node = block();
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [{ kind: "add_node", node }],
    });
    const first = store.apply(draft.id, edited.revision, uuid());
    const secondEdit = store.edit({
      draftId: draft.id,
      expectedRevision: first.draft.revision,
      operationId: uuid(),
      operations: [
        {
          kind: "update_node",
          id: node.id,
          patch: { text: "Second iteration" },
        },
      ],
    });
    const second = store.apply(draft.id, secondEdit.revision, uuid());
    expect([first.version.number, second.version.number]).toEqual([1, 2]);
    expect(store.version(first.version.id).graph.nodes[0].text).toBe("");
    expect(second.draft.baseVersionId).toBe(second.version.id);
    expect(second.draft.id).toBe(draft.id);
    expect(store.detail(concept.id).drafts).toHaveLength(1);
  });
  it("copies an older displayed version and appends without rewriting later history", () => {
    const { store, draft, concept } = setup();
    const first = store.apply(draft.id, 0, uuid());
    const second = store.apply(draft.id, 1, uuid());
    const alternative = store.createDraft(
      concept.id,
      "Alternative",
      first.version.id,
      uuid(),
    );
    const third = store.apply(alternative.id, 0, uuid());
    expect(third.version.number).toBe(3);
    expect(third.version.basedOnVersionId).toBe(first.version.id);
    expect(third.version.parentVersionId).toBe(second.version.id);
    expect(store.draft(draft.id).baseVersionId).toBe(second.version.id);
  });
  it("deduplicates an apply retry and rejects reuse for different input", () => {
    const { store, draft, concept } = setup();
    const op = uuid();
    const first = store.apply(draft.id, 0, op);
    expect(store.apply(draft.id, 0, op)).toEqual(first);
    expect(store.detail(concept.id).versions).toHaveLength(1);
    expect(() => store.apply(draft.id, 1, op)).toThrow("different input");
  });
  it("rejects stale edits atomically instead of overwriting an agent or user change", () => {
    const { store, draft } = setup();
    const node = block();
    store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [{ kind: "add_node", node }],
    });
    expect(() =>
      store.edit({
        draftId: draft.id,
        expectedRevision: 0,
        operationId: uuid(),
        operations: [{ kind: "rename", name: "Lost update" }],
      }),
    ).toThrow("changed");
    expect(store.draft(draft.id).name).toBe("Initial flow");
  });
  it("rolls back an invalid batch and preserves the revision", () => {
    const { store, draft } = setup();
    expect(() =>
      store.edit({
        draftId: draft.id,
        expectedRevision: 0,
        operationId: uuid(),
        operations: [
          { kind: "add_node", node: block() },
          {
            kind: "add_edge",
            edge: {
              id: uuid(),
              source: "missing",
              target: "missing",
              sourceHandle: "out",
              targetHandle: "in",
              label: "",
            },
          },
        ],
      }),
    ).toThrow("existing blocks");
    expect(store.draft(draft.id).graph.nodes).toHaveLength(0);
    expect(store.draft(draft.id).revision).toBe(0);
  });
  it("allows cycles, self-loops and parallel edges, and removes dangling edges on delete", () => {
    const { store, draft } = setup();
    const a = block("A");
    const b = block("B");
    const edges = [
      [a.id, a.id],
      [a.id, b.id],
      [a.id, b.id],
      [b.id, a.id],
    ].map(([source, target]) => ({
      id: uuid(),
      source,
      target,
      sourceHandle: "out" as const,
      targetHandle: "in" as const,
      label: "",
    }));
    const result = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [
        { kind: "add_node", node: a },
        { kind: "add_node", node: b },
        ...edges.map((edge) => ({ kind: "add_edge" as const, edge })),
      ],
    });
    expect(result.graph.edges).toHaveLength(4);
    const deleted = store.edit({
      draftId: draft.id,
      expectedRevision: result.revision,
      operationId: uuid(),
      operations: [{ kind: "delete_node", id: a.id }],
    });
    expect(deleted.graph.edges).toHaveLength(0);
  });
  it("undoes and redoes an edit batch without modifying applied main snapshots", () => {
    const { store, draft } = setup();
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [{ kind: "add_node", node: block() }],
    });
    const applied = store.apply(draft.id, edited.revision, uuid());
    const undo = store.undo(draft.id, applied.draft.revision, "undo", uuid());
    expect(undo.graph.nodes).toHaveLength(0);
    expect(store.version(applied.version.id).graph.nodes).toHaveLength(1);
    expect(
      store.undo(draft.id, undo.revision, "redo", uuid()).graph.nodes,
    ).toHaveLength(1);
  });
  it("stores immutable main snapshots and preserves content across restart", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "flowcanvas-test-")),
      "data.db",
    );
    const { store, draft, concept } = setup(path);
    const applied = store.apply(draft.id, 0, uuid());
    expect(() =>
      store.db
        .prepare("UPDATE versions SET number=8 WHERE id=?")
        .run(applied.version.id),
    ).toThrow("immutable");
    expect(() =>
      store.db
        .prepare("DELETE FROM versions WHERE id=?")
        .run(applied.version.id),
    ).toThrow("immutable");
    store.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.detail(concept.id).versions[0].number).toBe(1);
    expect(reopened.draft(draft.id).baseVersionId).toBe(applied.version.id);
  });
  it("rejects cross-Concept sources", () => {
    const { store, draft, project } = setup();
    const v = store.apply(draft.id, 0, uuid()).version;
    const other = store.createConcept(project.id, "Other", uuid());
    expect(() => store.createDraft(other.id, "Wrong", v.id, uuid())).toThrow(
      "another Concept",
    );
  });
  it("arranges variable-size blocks as one undoable edit", async () => {
    const { store, draft } = setup();
    const a = block("A");
    const b = block("B");
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [
        { kind: "add_node", node: a },
        { kind: "add_node", node: b },
      ],
    });
    const result = await store.arrange(draft.id, edited.revision, uuid());
    expect(result.graph.nodes[0].y).not.toBe(result.graph.nodes[1].y);
    expect(store.undo(draft.id, result.revision, "undo", uuid()).graph).toEqual(
      edited.graph,
    );
  });
  it("makes layout retries idempotent without accepting different requests under one ID", async () => {
    const { store, draft } = setup();
    const edited = store.edit({
      draftId: draft.id,
      expectedRevision: 0,
      operationId: uuid(),
      operations: [{ kind: "add_node", node: block() }],
    });
    const op = uuid();
    const first = await store.arrange(draft.id, edited.revision, op);
    expect(await store.arrange(draft.id, edited.revision, op)).toEqual(first);
    await expect(
      store.arrange(draft.id, edited.revision, op, "DOWN"),
    ).rejects.toThrow("different input");
  });
  it("arranges nested and shared sub-agents below all callers while keeping flow horizontal", async () => {
    const { store, draft } = setup();
    const nodes = ["Request", "Main", "Save", "Review", "Author", "Research", "Search"].map((label) => ({ ...block(label), id: label }));
    const edited = store.edit({ draftId: draft.id, expectedRevision: 0, operationId: uuid(), operations: [
      ...nodes.map((node) => ({ kind: "add_node" as const, node })),
      ...[["Request", "Main"], ["Main", "Save"], ["Research", "Search"]].map(([source, target], i) => ({
        kind: "add_edge" as const, edge: { id: `flow-${i}`, source, target, label: "A longer connection label that needs space" },
      })),
      ...[["Main", "Review"], ["Main", "Author"], ["Main", "Research"], ["Review", "Research"], ["Author", "Research"]].map(([source, target], i) => ({
        kind: "add_edge" as const, edge: { id: `call-${i}`, source, target, kind: "subagent" as const, label: "Sub-agent call" },
      })),
    ] });
    const arranged = await store.arrange(draft.id, edited.revision, uuid());
    const byId = new Map(arranged.graph.nodes.map((n) => [n.id, n]));
    for (const edge of arranged.graph.edges) {
      const a = byId.get(edge.source)!, b = byId.get(edge.target)!;
      if (edge.kind === "subagent") expect(b.y).toBeGreaterThan(a.y + a.height + 48);
      else expect(b.x - a.x - a.width).toBeGreaterThan(200);
    }
    for (const [i, a] of arranged.graph.nodes.entries()) for (const b of arranged.graph.nodes.slice(i + 1)) {
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    expect(store.undo(draft.id, arranged.revision, "undo", uuid()).graph).toEqual(edited.graph);
  });

  it("persists routing pins through history and snapshots, and resets them in Arrange", async () => {
    const { store, draft } = setup();
    const a = block("A"), b = block("B"), edgeId = uuid();
    const edited = store.edit({ draftId: draft.id, expectedRevision: 0, operationId: uuid(), operations: [
      { kind: "add_node", node: a }, { kind: "add_node", node: b },
      { kind: "add_edge", edge: { id: edgeId, source: a.id, target: b.id } },
    ] });
    const waypoints = [{ x: 400, y: 300 }, { x: 600, y: 300 }];
    const moved = store.edit({ draftId: draft.id, expectedRevision: edited.revision, operationId: uuid(), operations: [
      { kind: "update_edge", id: edgeId, patch: { waypoints } },
    ] });
    expect(store.draft(draft.id).graph.edges[0].waypoints).toEqual(waypoints);
    const undone = store.undo(draft.id, moved.revision, "undo", uuid());
    expect(undone.graph.edges[0].waypoints).toBeUndefined();
    const redone = store.undo(draft.id, undone.revision, "redo", uuid());
    expect(redone.graph.edges[0].waypoints).toEqual(waypoints);
    const main = store.apply(draft.id, redone.revision, uuid()).version;
    const copy = store.createDraft(draft.conceptId, "Copy pins", main.id, uuid());
    expect(copy.graph.edges[0].waypoints).toEqual(waypoints);
    const arranged = await store.arrange(draft.id, store.draft(draft.id).revision, uuid());
    expect(arranged.graph.edges[0].waypoints).toBeUndefined();
    expect(store.undo(draft.id, arranged.revision, "undo", uuid()).graph.edges[0].waypoints).toEqual(waypoints);
    expect(store.version(main.id).graph.edges[0].waypoints).toEqual(waypoints);
  });

  it("keeps a delegated branch below its caller even when its normal output rejoins the main flow", async () => {
    const { store, draft } = setup();
    const nodes = ["Main", "Save", "Worker", "Research"].map((label) => ({ ...block(label), id: label }));
    const edited = store.edit({ draftId: draft.id, expectedRevision: 0, operationId: uuid(), operations: [
      ...nodes.map((node) => ({ kind: "add_node" as const, node })),
      ...[["Main", "Save"], ["Worker", "Save"], ["Research", "Save"]].map(([source, target], i) => ({
        kind: "add_edge" as const, edge: { id: `flow-${i}`, source, target },
      })),
      ...[["Main", "Worker"], ["Worker", "Research"]].map(([source, target], i) => ({
        kind: "add_edge" as const, edge: { id: `call-${i}`, source, target, kind: "subagent" as const },
      })),
    ] });
    const arranged = await store.arrange(draft.id, edited.revision, uuid());
    const byId = new Map(arranged.graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("Worker")!.y).toBeGreaterThan(byId.get("Main")!.y + byId.get("Main")!.height);
    expect(byId.get("Research")!.y).toBeGreaterThan(byId.get("Worker")!.y + byId.get("Worker")!.height);
  });
});
