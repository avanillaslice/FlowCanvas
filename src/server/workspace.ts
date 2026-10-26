import { randomUUID } from "node:crypto";
import { AppError, Store } from "./store.js";
import { emptySelection, type Selection } from "../shared/model.js";
import { browserReportSchema, type BrowserReport } from "../shared/inspection.js";

type Session = {
  id: string;
  token: string;
  selection: Selection;
  touched: number;
  closed: boolean;
  wasOwner: boolean;
  send?: (event: string, data: unknown) => void;
};
export class Workspace {
  sessions = new Map<string, Session>();
  ownerId: string | null = null;
  generation = 0;
  selectionRevision = 0;
  inspectionMs = 10000;
  inspections = new Map<string, { sessionId: string; resolve: (report: BrowserReport) => void }>();
  pending = new Map<
    string,
    { sessionId: string; resolve: (success: boolean) => void }
  >();
  constructor(
    public store: Store,
    public leaseMs = 45000,
    public flushMs = 4000,
  ) {}
  private owner() {
    const owner = this.ownerId ? this.sessions.get(this.ownerId) : undefined;
    if (owner && (owner.closed || Date.now() - owner.touched > this.leaseMs)) {
      this.ownerId = null;
      this.generation++;
    }
    return this.ownerId ? owner : undefined;
  }
  register(resumeId?: string) {
    this.owner();
    const previous = resumeId ? this.sessions.get(resumeId) : undefined;
    if (previous) {
      previous.touched = Date.now();
      previous.closed = false;
      if (!this.ownerId && previous.wasOwner) {
        this.ownerId = previous.id;
        this.generation++;
      }
      return this.publicSession(previous);
    }
    const session: Session = {
      id: randomUUID(),
      token: randomUUID(),
      selection: emptySelection(),
      touched: Date.now(),
      closed: false,
      wasOwner: false,
    };
    const saved = this.store.setting<Selection>("lastSelection");
    if (saved) {
      try {
        this.store.validateSelection(saved);
        session.selection = saved;
      } catch {
        /* Deleted or invalid saved target: start empty. */
      }
    }
    this.sessions.set(session.id, session);
    if (!this.ownerId) {
      this.ownerId = session.id;
      session.wasOwner = true;
      this.generation++;
    }
    return this.publicSession(session);
  }
  authenticate(sessionId: string, token: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.token !== token || session.closed)
      throw new AppError(
        "invalid_session",
        "This browser session expired. Reload the application.",
        401,
      );
    return session;
  }
  publicSession(session: Session) {
    return {
      id: session.id,
      token: session.token,
      shared: this.ownerId === session.id,
      selection: session.selection,
      generation: this.generation,
    };
  }
  touch(sessionId: string) {
    this.owner();
    const session = this.sessions.get(sessionId)!;
    session.touched = Date.now();
    return { shared: this.ownerId === sessionId, generation: this.generation };
  }
  claim(sessionId: string) {
    const previous = this.owner();
    if (previous) previous.wasOwner = false;
    const session = this.sessions.get(sessionId)!;
    session.wasOwner = true;
    this.ownerId = sessionId;
    this.generation++;
    this.store.setSetting("lastSelection", session.selection);
    this.broadcast("ownership", {});
    return { shared: true, generation: this.generation };
  }
  select(sessionId: string, selection: Selection) {
    this.store.validateSelection(selection);
    const session = this.sessions.get(sessionId)!;
    session.selection = selection;
    session.touched = Date.now();
    if (this.owner()?.id === sessionId) {
      this.selectionRevision++;
      this.store.setSetting("lastSelection", selection);
    }
    return selection;
  }
  close(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.closed = true;
      session.send = undefined;
    }
    for (const [id, request] of this.inspections) if (request.sessionId === sessionId) {
      this.inspections.delete(id);
      request.resolve({ status: "render_failed" });
    }
    if (this.ownerId === sessionId) {
      this.ownerId = null;
      this.generation++;
    }
  }
  deleteDraft(draftId: string, expectedRevision: number, operationId: string) {
    const result = this.store.deleteDraft(
      draftId,
      expectedRevision,
      operationId,
    );
    for (const session of this.sessions.values()) {
      if (session.selection.draftId !== draftId) continue;
      session.selection = {
        ...session.selection,
        draftId: result.replacementDraftId,
      };
      if (session.id === this.ownerId) this.selectionRevision++;
    }
    this.store.changed(result.conceptId);
    return result;
  }
  broadcast(event: string, data: { conceptId?: string }) {
    for (const session of this.sessions.values()) {
      if (
        !session.closed &&
        (!data.conceptId || data.conceptId === session.selection.conceptId)
      )
        session.send?.(event, data);
    }
  }
  acknowledge(sessionId: string, requestId: string, success: boolean) {
    const request = this.pending.get(requestId);
    if (request?.sessionId === sessionId) {
      this.pending.delete(requestId);
      request.resolve(success);
    }
  }
  acknowledgeInspection(sessionId: string, requestId: string, report: unknown) {
    const pending = this.inspections.get(requestId);
    if (pending?.sessionId !== sessionId) return;
    const parsed = browserReportSchema.parse(report);
    this.inspections.delete(requestId);
    pending.resolve(parsed);
  }
  async inspect(kind: "draft" | "main", diagramId: string | undefined, conceptId: string | undefined, includeImage: boolean) {
    const selection = await this.readSelection();
    if (selection.status !== "ready") return selection;
    const selectedId = kind === "draft" ? selection.draftId : selection.versionId;
    if (diagramId === undefined) {
      if (conceptId !== undefined && conceptId !== selection.conceptId)
        throw new AppError("wrong_concept", "The selected diagram belongs to another Concept.");
      diagramId = selectedId ?? undefined;
      if (!diagramId) return { status: kind === "draft" ? "no_draft_selected" as const : "no_main_selected" as const,
        conceptId: selection.conceptId, selectionRevision: selection.selectionRevision };
    }
    const diagram = kind === "draft" ? this.store.draft(diagramId) : this.store.version(diagramId);
    if (conceptId !== undefined && diagram.conceptId !== conceptId)
      throw new AppError("wrong_concept", "Diagram does not belong to that Concept.");
    const revision = "revision" in diagram ? diagram.revision : diagram.number;
    const identity = { kind, diagramId, revision };
    // Explicit diagrams are rendered from saved snapshots in the shared tab,
    // never by navigating or querying another browser tab's private state.
    const session = this.owner()!;
    const generation = this.generation, selectionRevision = this.selectionRevision;
    const requestId = randomUUID();
    const report = await new Promise<BrowserReport>((resolve) => {
      const timer = setTimeout(() => {
        this.inspections.delete(requestId);
        resolve({ status: "render_failed" });
      }, this.inspectionMs);
      this.inspections.set(requestId, { sessionId: session.id, resolve: (value) => {
        clearTimeout(timer); resolve(value);
      } });
      try {
        session.send!("inspect", { requestId, canvasId: kind === "main" ? `main-${diagramId}` : diagramId,
          revision, includeImage, graph: diagram.graph, editable: kind === "draft" });
      } catch {
        this.inspections.delete(requestId);
        clearTimeout(timer);
        resolve({ status: "render_failed" });
      }
    });
    if (this.owner()?.id !== session.id || generation !== this.generation || selectionRevision !== this.selectionRevision)
      throw new AppError("workspace_changed", "The shared workspace changed during inspection. Inspect it again.", 409);
    if (kind === "draft" && this.store.draft(diagramId).revision !== revision)
      throw new AppError("workspace_changed", "The draft changed during inspection. Inspect its latest revision.", 409);
    if (report.status === "rendered") {
      if (report.revision !== revision)
        throw new AppError("workspace_changed", "The browser rendered a different revision. Inspect it again.", 409);
      const issues = diagram.graph.edges.filter((e) => e.kind === "subagent" && e.targetHandle !== "in-top")
        .map((e) => ({ kind: "subagent_side_target" as const, ids: [e.id] }));
      report.issuesTruncated ||= report.issues.length + issues.length > 10000;
      report.issues.push(...issues.slice(0, 10000 - report.issues.length));
      if (!includeImage) delete report.image;
    }
    return { ...report, ...identity };
  }
  private async flush(session: Session) {
    if (!session.send)
      throw new AppError(
        "workspace_disconnected",
        "The shared browser tab is not connected.",
        409,
      );
    const requestId = randomUUID();
    const success = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, this.flushMs);
      this.pending.set(requestId, {
        sessionId: session.id,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      session.send!("flush", { requestId });
    });
    if (!success)
      throw new AppError(
        "workspace_busy",
        "The shared tab has pending edits or could not confirm its current contents. Try again.",
        409,
      );
  }
  async readSelection() {
    const owner = this.owner();
    if (!owner) return { status: "no_active_workspace" as const };
    const generation = this.generation;
    await this.flush(owner);
    if (this.owner()?.id !== owner.id || generation !== this.generation)
      throw new AppError(
        "workspace_changed",
        "The shared workspace changed during this read. Read it again.",
        409,
      );
    const { conceptId, versionId, draftId } = owner.selection;
    if (!conceptId)
      return {
        status: "no_concept_selected" as const,
        selectionRevision: this.selectionRevision,
      };
    return {
      status: "ready" as const, selectionRevision: this.selectionRevision,
      conceptId, versionId, draftId,
    };
  }
  async read() {
    const selection = await this.readSelection();
    if (selection.status !== "ready") return selection;
    return this.store.db.transaction(() => {
      const { conceptId, versionId, draftId } = selection;
      const detail = this.store.detail(conceptId);
      return {
        status: "ready" as const,
        selectionRevision: selection.selectionRevision,
        concept: detail.concept,
        selectedMain: versionId ? this.store.version(versionId) : null,
        selectedDraft: draftId ? this.store.draft(draftId) : null,
        drafts: detail.drafts.filter((draft) => draft.id !== draftId),
        versions: detail.versions.filter((version) => version.id !== versionId),
      };
    })();
  }
  resolveSource(conceptId: string, selectionRevision: number) {
    const owner = this.owner();
    if (
      !owner ||
      owner.selection.conceptId !== conceptId ||
      this.selectionRevision !== selectionRevision
    )
      throw new AppError(
        "workspace_changed",
        "Read the workspace again or provide an explicit source version.",
        409,
      );
    return owner.selection.versionId;
  }
}
