import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { ELK } from "elkjs/lib/elk-api.js";
import { z } from "zod";
import { arrangeGraph } from "./layout.js";
import {
  editSchema,
  graphSchema,
  normalizeConnections,
  emptyGraph,
  type Concept,
  type Draft,
  type Graph,
  type MainVersion,
  type Project,
  type ConceptDetail,
  type Selection,
} from "../shared/model.js";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}
const id = () => randomUUID();
const now = () => new Date().toISOString();
const validName = (value: string) =>
  z.string().trim().min(1).max(160).parse(value);
const clone = <T>(x: T): T => structuredClone(x);
const Elk = createRequire(import.meta.url)(
  "elkjs/lib/elk.bundled.js",
) as new () => ELK;
type HistoryState = { graph: Graph; name: string };

export class Store {
  db: Database.Database;
  history = new Map<string, HistoryState[]>();
  redos = new Map<string, HistoryState[]>();
  changed: (conceptId?: string) => void = () => {};
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    const schemaVersion = Number(
      this.db.pragma("user_version", { simple: true }),
    );
    if (schemaVersion > 2) {
      this.db.close();
      throw new Error(
        "This database was created by a newer FlowCanvas version. Use that version rather than downgrading the database.",
      );
    }
    if (schemaVersion === 1 && path !== ":memory:") {
      // Back up the complete database, including committed WAL contents, before migration.
      this.db
        .prepare("VACUUM INTO ?")
        .run(`${path}.backup-v1-${randomUUID()}.db`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS concepts (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, latestVersionId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, conceptId TEXT NOT NULL REFERENCES concepts(id), name TEXT NOT NULL, originVersionId TEXT, baseVersionId TEXT, graph TEXT NOT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, conceptId TEXT NOT NULL REFERENCES concepts(id), number INTEGER NOT NULL, sourceDraftId TEXT NOT NULL REFERENCES drafts(id), sourceDraftRevision INTEGER NOT NULL, parentVersionId TEXT, basedOnVersionId TEXT, graph TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(conceptId,number));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_drafts (draftId TEXT PRIMARY KEY REFERENCES drafts(id), deletedAt TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_version_update BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'Main versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_version_delete BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT,'Main versions are immutable'); END;
      PRAGMA user_version = 2;
    `);
  }
  close() {
    this.db.close();
  }
  private receipt<T>(operationId: string, payload: unknown): T | undefined {
    const old = this.db
      .prepare("SELECT * FROM receipts WHERE id=?")
      .get(operationId) as { fingerprint: string; result: string } | undefined;
    if (!old) return undefined;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    if (old.fingerprint !== fingerprint)
      throw new AppError(
        "operation_reused",
        "This operation ID was used for different input.",
        409,
      );
    return JSON.parse(old.result) as T;
  }
  private once<T>(operationId: string, payload: unknown, work: () => T): T {
    z.string().min(1).max(160).parse(operationId);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    return this.db.transaction(() => {
      const old = this.receipt<T>(operationId, payload);
      if (old) return old;
      const result = work();
      this.db
        .prepare("INSERT INTO receipts VALUES (?,?,?)")
        .run(operationId, fingerprint, JSON.stringify(result));
      return result;
    })();
  }
  projects(): Project[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY createdAt,id")
      .all() as Project[];
  }
  concepts(projectId?: string): Concept[] {
    return (
      projectId
        ? this.db
            .prepare(
              "SELECT * FROM concepts WHERE projectId=? ORDER BY createdAt,id",
            )
            .all(projectId)
        : this.db.prepare("SELECT * FROM concepts ORDER BY createdAt,id").all()
    ) as Concept[];
  }
  concept(conceptId: string): Concept {
    const row = this.db
      .prepare("SELECT * FROM concepts WHERE id=?")
      .get(conceptId) as Concept | undefined;
    if (!row) throw new AppError("not_found", "Concept not found.", 404);
    return row;
  }
  draft(draftId: string): Draft {
    const row = this.db
      .prepare(
        "SELECT * FROM drafts WHERE id=? AND NOT EXISTS (SELECT 1 FROM deleted_drafts WHERE draftId=drafts.id)",
      )
      .get(draftId) as (Omit<Draft, "graph"> & { graph: string }) | undefined;
    if (!row) throw new AppError("not_found", "Draft not found.", 404);
    return { ...row, graph: JSON.parse(row.graph) };
  }
  version(versionId: string): MainVersion {
    const row = this.db
      .prepare("SELECT * FROM versions WHERE id=?")
      .get(versionId) as
      | (Omit<MainVersion, "graph"> & { graph: string })
      | undefined;
    if (!row) throw new AppError("not_found", "Main version not found.", 404);
    return { ...row, graph: JSON.parse(row.graph) };
  }
  detail(conceptId: string): ConceptDetail {
    return {
      concept: this.concept(conceptId),
      drafts: this.db
        .prepare(
          "SELECT id,conceptId,name,originVersionId,baseVersionId,revision,createdAt,updatedAt FROM drafts WHERE conceptId=? AND NOT EXISTS (SELECT 1 FROM deleted_drafts WHERE draftId=drafts.id) ORDER BY createdAt,id",
        )
        .all(conceptId) as ConceptDetail["drafts"],
      versions: this.db
        .prepare(
          "SELECT id,conceptId,number,sourceDraftId,sourceDraftRevision,parentVersionId,basedOnVersionId,createdAt FROM versions WHERE conceptId=? ORDER BY number DESC",
        )
        .all(conceptId) as ConceptDetail["versions"],
    };
  }
  createProject(name: string, operationId: string): Project {
    name = validName(name);
    const result = this.once(operationId, ["createProject", name], () => {
      const row = { id: id(), name, createdAt: now(), updatedAt: now() };
      this.db
        .prepare(
          "INSERT INTO projects VALUES (@id,@name,@createdAt,@updatedAt)",
        )
        .run(row);
      return row;
    });
    this.changed();
    return result;
  }
  createConcept(projectId: string, name: string, operationId: string): Concept {
    name = validName(name);
    const result = this.once(
      operationId,
      ["createConcept", projectId, name],
      () => {
        if (!this.projects().some((p) => p.id === projectId))
          throw new AppError("not_found", "Project not found.", 404);
        const row: Concept = {
          id: id(),
          projectId,
          name,
          latestVersionId: null,
          createdAt: now(),
          updatedAt: now(),
        };
        this.db
          .prepare(
            "INSERT INTO concepts VALUES (@id,@projectId,@name,@latestVersionId,@createdAt,@updatedAt)",
          )
          .run(row);
        return row;
      },
    );
    this.changed(result.id);
    return result;
  }
  rename(kind: "project" | "concept", targetId: string, name: string) {
    name = validName(name);
    const result = this.db
      .prepare(
        `UPDATE ${kind === "project" ? "projects" : "concepts"} SET name=?,updatedAt=? WHERE id=?`,
      )
      .run(name, now(), targetId);
    if (!result.changes)
      throw new AppError("not_found", "Item not found.", 404);
    this.changed();
  }
  createDraft(
    conceptId: string,
    name: string,
    sourceVersionId: string | null,
    operationId: string,
  ): Draft {
    name = validName(name);
    const result = this.once(
      operationId,
      ["createDraft", conceptId, name, sourceVersionId],
      () => {
        this.concept(conceptId);
        const version = sourceVersionId ? this.version(sourceVersionId) : null;
        if (version && version.conceptId !== conceptId)
          throw new AppError(
            "wrong_concept",
            "Source version belongs to another Concept.",
          );
        return this.insertDraft(
          conceptId,
          name,
          sourceVersionId,
          version?.graph ?? emptyGraph(),
        );
      },
    );
    this.changed(conceptId);
    return result;
  }
  private insertDraft(
    conceptId: string,
    name: string,
    baseVersionId: string | null,
    graph: Graph,
  ): Draft {
    const row: Draft = {
      id: id(),
      conceptId,
      name,
      originVersionId: baseVersionId,
      baseVersionId,
      graph: clone(graph),
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.db
      .prepare(
        "INSERT INTO drafts VALUES (@id,@conceptId,@name,@originVersionId,@baseVersionId,@graph,@revision,@createdAt,@updatedAt)",
      )
      .run({ ...row, graph: JSON.stringify(row.graph) });
    return row;
  }
  copyDraft(
    conceptId: string,
    sourceDraftId: string,
    name: string,
    expectedSourceRevision: number,
    operationId: string,
  ): Draft {
    name = validName(name);
    const result = this.once(
      operationId,
      ["copyDraft", conceptId, sourceDraftId, name, expectedSourceRevision],
      () => {
        const source = this.draft(sourceDraftId);
        if (source.conceptId !== conceptId)
          throw new AppError(
            "wrong_concept",
            "Source draft belongs to another Concept.",
          );
        this.expect(source, expectedSourceRevision);
        return this.insertDraft(
          conceptId,
          name,
          source.baseVersionId,
          source.graph,
        );
      },
    );
    this.changed(conceptId);
    return result;
  }
  private expect(row: Draft, revision: number) {
    if (row.revision !== revision)
      throw new AppError(
        "revision_conflict",
        "This draft changed. Refresh it before retrying your edit.",
        409,
        { currentRevision: row.revision },
      );
  }
  deleteDraft(draftId: string, expectedRevision: number, operationId: string) {
    const result = this.once(
      operationId,
      ["deleteDraft", draftId, expectedRevision],
      () => {
        const draft = this.draft(draftId);
        this.expect(draft, expectedRevision);
        const drafts = this.detail(draft.conceptId).drafts;
        const index = drafts.findIndex((item) => item.id === draftId);
        const replacementDraftId =
          drafts[index + 1]?.id ?? drafts[index - 1]?.id ?? null;
        // Keep the source row for immutable main-version foreign keys; normal reads exclude it.
        this.db
          .prepare("INSERT INTO deleted_drafts VALUES (?,?)")
          .run(draftId, now());
        this.db
          .prepare("UPDATE concepts SET updatedAt=? WHERE id=?")
          .run(now(), draft.conceptId);
        const saved = this.setting<Selection>("lastSelection");
        if (saved?.draftId === draftId)
          this.setSetting("lastSelection", {
            ...saved,
            draftId: replacementDraftId,
          });
        return { draftId, conceptId: draft.conceptId, replacementDraftId };
      },
    );
    this.history.delete(draftId);
    this.redos.delete(draftId);
    // The workspace updates live selections before broadcasting this change.
    return result;
  }
  private saveDraft(row: Draft) {
    row.revision++;
    row.updatedAt = now();
    this.db
      .prepare(
        "UPDATE drafts SET name=@name,graph=@graph,revision=@revision,baseVersionId=@baseVersionId,updatedAt=@updatedAt WHERE id=@id",
      )
      .run({
        id: row.id,
        name: row.name,
        graph: JSON.stringify(row.graph),
        revision: row.revision,
        baseVersionId: row.baseVersionId,
        updatedAt: row.updatedAt,
      });
    this.db
      .prepare("UPDATE concepts SET updatedAt=? WHERE id=?")
      .run(row.updatedAt, row.conceptId);
    return row;
  }
  edit(input: z.input<typeof editSchema>): Draft {
    const parsed = editSchema.parse(input);
    let before: HistoryState | undefined;
    const result = this.once(parsed.operationId, ["edit", parsed], () => {
      const row = this.draft(parsed.draftId);
      this.expect(row, parsed.expectedRevision);
      before = { graph: clone(row.graph), name: row.name };
      for (const op of parsed.operations) {
        if (op.kind === "rename") {
          row.name = validName(op.name);
          continue;
        }
        if (op.kind === "add_node") row.graph.nodes.push(op.node);
        if (op.kind === "add_edge") row.graph.edges.push({
          ...op.edge,
          // Calls leave the caller's bottom and enter the provider's top.
          targetHandle: op.edge.kind === "subagent" ? "in-top" : op.edge.targetHandle,
        });
        if (op.kind === "update_node") {
          const node = row.graph.nodes.find((n) => n.id === op.id);
          if (!node)
            throw new AppError("not_found", "Block no longer exists.", 404);
          Object.assign(node, op.patch);
        }
        if (op.kind === "update_edge") {
          const edge = row.graph.edges.find((e) => e.id === op.id);
          if (!edge)
            throw new AppError(
              "not_found",
              "Connection no longer exists.",
              404,
            );
          Object.assign(edge, op.patch);
          // Do not migrate legacy geometry during unrelated text/route edits.
          if (op.patch.kind !== undefined || op.patch.source !== undefined ||
              op.patch.target !== undefined || op.patch.sourceHandle !== undefined ||
              op.patch.targetHandle !== undefined) {
            if (edge.kind === "subagent") edge.targetHandle = "in-top";
            else if (op.patch.kind !== undefined && op.patch.targetHandle === undefined)
              edge.targetHandle = "in";
          }
        }
        if (op.kind === "delete_node") {
          row.graph.nodes = row.graph.nodes.filter((n) => n.id !== op.id);
          row.graph.edges = row.graph.edges.filter(
            (e) => e.source !== op.id && e.target !== op.id,
          );
        }
        if (op.kind === "delete_edge")
          row.graph.edges = row.graph.edges.filter((e) => e.id !== op.id);
      }
      row.graph = graphSchema.parse(normalizeConnections(row.graph));
      return this.saveDraft(row);
    });
    if (before) {
      this.history.set(result.id, [
        ...(this.history.get(result.id) ?? []).slice(-99),
        before,
      ]);
      this.redos.delete(result.id);
    }
    this.changed(result.conceptId);
    return result;
  }
  undo(
    draftId: string,
    expectedRevision: number,
    direction: "undo" | "redo",
    operationId: string,
  ): Draft {
    let applied = false;
    let previous: HistoryState;
    let next: HistoryState;
    const from = direction === "undo" ? this.history : this.redos;
    const to = direction === "undo" ? this.redos : this.history;
    const result = this.once(
      operationId,
      [direction, draftId, expectedRevision],
      () => {
        const row = this.draft(draftId);
        this.expect(row, expectedRevision);
        const entry = from.get(draftId)?.at(-1);
        if (!entry)
          throw new AppError("no_history", `Nothing to ${direction}.`);
        previous = { graph: clone(row.graph), name: row.name };
        next = clone(entry);
        row.graph = next.graph;
        row.name = next.name;
        applied = true;
        return this.saveDraft(row);
      },
    );
    if (applied) {
      from.get(draftId)!.pop();
      to.set(draftId, [...(to.get(draftId) ?? []).slice(-99), previous!]);
    }
    this.changed(result.conceptId);
    return result;
  }
  apply(
    draftId: string,
    expectedRevision: number,
    operationId: string,
  ): { version: MainVersion; draft: Draft } {
    const result = this.once(
      operationId,
      ["apply", draftId, expectedRevision],
      () => {
        const draft = this.draft(draftId);
        this.expect(draft, expectedRevision);
        const concept = this.concept(draft.conceptId);
        const number =
          (
            this.db
              .prepare(
                "SELECT MAX(number) AS number FROM versions WHERE conceptId=?",
              )
              .get(concept.id) as { number: number | null }
          ).number ?? 0;
        const version: MainVersion = {
          id: id(),
          conceptId: concept.id,
          number: number + 1,
          sourceDraftId: draft.id,
          sourceDraftRevision: draft.revision,
          parentVersionId: concept.latestVersionId,
          basedOnVersionId: draft.baseVersionId,
          graph: clone(draft.graph),
          createdAt: now(),
        };
        this.db
          .prepare(
            "INSERT INTO versions VALUES (@id,@conceptId,@number,@sourceDraftId,@sourceDraftRevision,@parentVersionId,@basedOnVersionId,@graph,@createdAt)",
          )
          .run({ ...version, graph: JSON.stringify(version.graph) });
        this.db
          .prepare(
            "UPDATE concepts SET latestVersionId=?,updatedAt=? WHERE id=?",
          )
          .run(version.id, now(), concept.id);
        draft.baseVersionId = version.id;
        this.saveDraft(draft);
        return { version, draft };
      },
    );
    this.changed(result.draft.conceptId);
    return result;
  }
  async arrange(
    draftId: string,
    expectedRevision: number,
    operationId: string,
    direction: "RIGHT" | "DOWN" = "RIGHT",
  ) {
    const payload = ["arrange", draftId, expectedRevision, direction];
    const previous = this.receipt<Draft>(operationId, payload);
    if (previous) return previous;
    const draft = this.draft(draftId);
    this.expect(draft, expectedRevision);
    if (!draft.graph.nodes.length)
      return this.once(operationId, payload, () => draft);
    const graph = await arrangeGraph(draft.graph, new Elk(), direction);
    let changed = false;
    const result = this.once(operationId, payload, () => {
      const current = this.draft(draftId);
      this.expect(current, expectedRevision);
      current.graph = graphSchema.parse(graph);
      changed = true;
      return this.saveDraft(current);
    });
    if (changed) {
      this.history.set(draftId, [
        ...(this.history.get(draftId) ?? []).slice(-99),
        { graph: draft.graph, name: draft.name },
      ]);
      this.redos.delete(draftId);
    }
    this.changed(draft.conceptId);
    return result;
  }
  validateSelection(selection: Selection) {
    if (!selection.conceptId) {
      if (selection.versionId || selection.draftId)
        throw new AppError("bad_selection", "Select a Concept first.");
      return;
    }
    this.concept(selection.conceptId);
    if (
      selection.versionId &&
      this.version(selection.versionId).conceptId !== selection.conceptId
    )
      throw new AppError(
        "wrong_concept",
        "Version is outside selected Concept.",
      );
    if (
      selection.draftId &&
      this.draft(selection.draftId).conceptId !== selection.conceptId
    )
      throw new AppError("wrong_concept", "Draft is outside selected Concept.");
  }
  setting<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
}
