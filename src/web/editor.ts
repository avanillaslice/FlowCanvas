import {
  normalizeConnections,
  type Draft,
  type Graph,
  type Operation,
} from "../shared/model.js";
import { api, ApiError, operationId } from "./api.js";
export type EditorState = {
  draft: Draft;
  status: "saved" | "editing" | "saving" | "error" | "conflict";
  message: string;
  canUndo: boolean;
  canRedo: boolean;
};
const copy = <T>(x: T): T => structuredClone(x);
function apply(draft: Draft, operations: Operation[]) {
  const result = copy(draft);
  for (const op of operations) {
    if (op.kind === "rename") result.name = op.name;
    if (op.kind === "add_node") result.graph.nodes.push(copy(op.node));
    if (op.kind === "add_edge") result.graph.edges.push(copy(op.edge));
    if (op.kind === "update_node")
      Object.assign(
        result.graph.nodes.find((n) => n.id === op.id) ?? {},
        op.patch,
      );
    if (op.kind === "update_edge")
      Object.assign(
        result.graph.edges.find((e) => e.id === op.id) ?? {},
        op.patch,
      );
    if (op.kind === "delete_node") {
      result.graph.nodes = result.graph.nodes.filter((n) => n.id !== op.id);
      result.graph.edges = result.graph.edges.filter(
        (e) => e.source !== op.id && e.target !== op.id,
      );
    }
    if (op.kind === "delete_edge")
      result.graph.edges = result.graph.edges.filter((e) => e.id !== op.id);
  }
  result.graph = normalizeConnections(result.graph);
  return result;
}
function canRebase(before: Draft, after: Draft, operations: Operation[]) {
  let old = copy(before);
  let current = copy(after);
  for (const op of operations) {
    if (op.kind === "rename" && old.name !== current.name) return false;
    if (
      op.kind === "add_node" &&
      current.graph.nodes.some((n) => n.id === op.node.id)
    )
      return false;
    if (
      op.kind === "add_edge" &&
      (current.graph.edges.some((e) => e.id === op.edge.id) ||
        !current.graph.nodes.some((n) => n.id === op.edge.source) ||
        !current.graph.nodes.some((n) => n.id === op.edge.target))
    )
      return false;
    if (op.kind === "update_node" || op.kind === "update_edge") {
      const a =
        op.kind === "update_node"
          ? old.graph.nodes.find((n) => n.id === op.id)
          : old.graph.edges.find((e) => e.id === op.id);
      const b =
        op.kind === "update_node"
          ? current.graph.nodes.find((n) => n.id === op.id)
          : current.graph.edges.find((e) => e.id === op.id);
      if (
        !a ||
        !b ||
        Object.keys(op.patch).some(
          (key) =>
            JSON.stringify((a as any)[key]) !== JSON.stringify((b as any)[key]),
        )
      )
        return false;
    }
    if (
      op.kind === "delete_node" &&
      (JSON.stringify(old.graph.nodes.find((n) => n.id === op.id)) !==
        JSON.stringify(current.graph.nodes.find((n) => n.id === op.id)) ||
        JSON.stringify(
          old.graph.edges.filter(
            (e) => e.source === op.id || e.target === op.id,
          ),
        ) !==
          JSON.stringify(
            current.graph.edges.filter(
              (e) => e.source === op.id || e.target === op.id,
            ),
          ))
    )
      return false;
    if (
      op.kind === "delete_edge" &&
      JSON.stringify(old.graph.edges.find((e) => e.id === op.id)) !==
        JSON.stringify(current.graph.edges.find((e) => e.id === op.id))
    )
      return false;
    old = apply(old, [op]);
    current = apply(current, [op]);
  }
  return true;
}
export class DraftEditor {
  base: Draft;
  state: EditorState;
  pending: Operation[] = [];
  retry?: {
    draftId: string;
    expectedRevision: number;
    operationId: string;
    operations: Operation[];
  };
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  remote?: Draft;
  disposed = false;
  private deferredSave = false;
  constructor(
    draft: Draft & { canUndo?: boolean; canRedo?: boolean },
    public notify: (state: EditorState) => void,
  ) {
    this.base = copy(draft);
    this.state = {
      draft,
      status: "saved",
      message: "",
      canUndo: draft.canUndo ?? false,
      canRedo: draft.canRedo ?? false,
    };
    const saved = sessionStorage.getItem(`pending:${draft.id}`);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        this.pending = data.pending ?? [];
        this.retry = data.retry;
        this.base = data.base ?? draft;
        this.state.draft = apply(this.base, [
          ...(this.retry?.operations ?? []),
          ...this.pending,
        ]);
        this.state.status = "error";
        this.state.message =
          "Unsaved edits recovered. Retry saving to continue.";
      } catch {
        /* Ignore a damaged recovery entry. */
      }
    }
    this.emit();
  }
  private emit() {
    if (!this.disposed) this.notify({ ...this.state });
  }
  private persist() {
    if (this.pending.length || this.retry)
      sessionStorage.setItem(
        `pending:${this.base.id}`,
        JSON.stringify({
          pending: this.pending,
          retry: this.retry,
          base: this.base,
        }),
      );
    else sessionStorage.removeItem(`pending:${this.base.id}`);
  }
  change(operations: Operation[], deferSave = false) {
    this.deferredSave = deferSave;
    for (const operation of operations) {
      const previous = this.pending.at(-1);
      if (
        deferSave &&
        operation.kind === "update_node" &&
        previous?.kind === "update_node" &&
        previous.id === operation.id
      ) {
        // Keep the final field contents rather than a full copy per keystroke.
        this.pending[this.pending.length - 1] = {
          ...previous,
          patch: { ...previous.patch, ...operation.patch },
        };
      } else this.pending.push(operation);
    }
    this.state.draft = apply(this.state.draft, operations);
    if (this.state.status !== "conflict") {
      this.state.status = deferSave ? "editing" : "saving";
      this.state.message = "";
      clearTimeout(this.timer);
      if (!deferSave)
        this.timer = setTimeout(() => {
          void this.flush(false).catch(() => {});
        }, 0);
    }
    this.persist();
    this.emit();
  }
  async flush(includeDeferred = true): Promise<void> {
    clearTimeout(this.timer);
    if (includeDeferred) this.deferredSave = false;
    if (this.running) {
      await this.running;
      if (this.pending.length && !this.deferredSave) return this.flush(false);
      return;
    }
    if (this.state.status === "conflict") throw new Error(this.state.message);
    this.running = this.saveLoop();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  private async saveLoop() {
    let rebases = 0;
    while (this.retry || (this.pending.length && !this.deferredSave)) {
      const batch = this.retry ?? {
        draftId: this.base.id,
        expectedRevision: this.base.revision,
        operationId: operationId(),
        operations: this.pending.splice(0),
      };
      this.retry = batch;
      this.state.status = "saving";
      this.persist();
      this.emit();
      try {
        const saved = await api<Draft>("/edit", batch);
        this.base = saved;
        this.retry = undefined;
        this.state.draft = apply(saved, this.pending);
        this.state.canUndo = true;
        this.state.canRedo = false;
      } catch (error) {
        if (error instanceof ApiError && error.code === "revision_conflict") {
          const remote = await api<Draft>(`/drafts/${this.base.id}`);
          const operations = [...batch.operations, ...this.pending];
          if (rebases++ < 3 && canRebase(this.base, remote, operations)) {
            this.base = remote;
            this.retry = undefined;
            this.pending = operations;
            this.state.draft = apply(remote, operations);
            continue;
          }
          this.remote = remote;
          this.state.status = "conflict";
          this.state.message =
            "This draft changed in the same place. Your edits are kept below; choose which contents to save.";
        } else {
          this.state.status = "error";
          this.state.message =
            error instanceof Error ? error.message : "Could not save.";
        }
        this.persist();
        this.emit();
        throw error;
      }
      this.persist();
    }
    this.state.status = this.pending.length ? "editing" : "saved";
    this.state.message = "";
    this.emit();
  }
  async refresh() {
    if (this.running || this.pending.length || this.retry) return;
    const draft = await api<Draft & { canUndo: boolean; canRedo: boolean }>(
      `/drafts/${this.base.id}`,
    );
    if (this.pending.length || this.running || this.disposed) return;
    this.base = draft;
    this.state = {
      draft,
      status: "saved",
      message: "",
      canUndo: draft.canUndo,
      canRedo: draft.canRedo,
    };
    this.emit();
  }
  async resolve(useMine: boolean) {
    const remote = await api<Draft>(`/drafts/${this.base.id}`);
    if (useMine) {
      const local = this.state.draft;
      const operations: Operation[] = [
        ...remote.graph.nodes.map((n) => ({
          kind: "delete_node" as const,
          id: n.id,
        })),
        ...local.graph.nodes.map((node) => ({
          kind: "add_node" as const,
          node,
        })),
        ...local.graph.edges.map((edge) => ({
          kind: "add_edge" as const,
          edge,
        })),
        { kind: "rename", name: local.name },
      ];
      this.base = remote;
      this.retry = undefined;
      this.pending = operations;
      this.state.status = "saving";
      await this.flush();
    } else {
      this.base = remote;
      this.pending = [];
      this.retry = undefined;
      this.state.draft = remote;
      this.state.status = "saved";
      this.state.message = "";
      this.persist();
      this.emit();
    }
  }
  async history(direction: "undo" | "redo") {
    await this.flush();
    const result = await api<Draft>("/history", {
      draftId: this.base.id,
      expectedRevision: this.base.revision,
      operationId: operationId(),
      direction,
    });
    this.base = result;
    this.state.draft = result;
    await this.refresh();
  }
  async arrange() {
    await this.flush();
    const result = await api<Draft>("/arrange", {
      draftId: this.base.id,
      expectedRevision: this.base.revision,
      operationId: operationId(),
    });
    this.base = result;
    this.state.draft = result;
    await this.refresh();
  }
  accept(draft: Draft) {
    this.base = draft;
    this.state.draft = draft;
    this.state.status = "saved";
    this.emit();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
