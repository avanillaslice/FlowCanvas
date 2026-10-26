import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Workflow,
  Plus,
  ChevronDown,
  ChevronRight,
  Folder,
  Copy,
  Check,
  ArrowUpRight,
  Layers,
  PanelLeftClose,
  SplitSquareHorizontal,
  Undo2,
  Redo2,
  WandSparkles,
  CheckCheck,
  Circle,
  X,
  Pencil,
  AlertCircle,
  LoaderCircle,
  MousePointer2,
  Command,
  Network,
  Sun,
  Moon,
} from "lucide-react";
import {
  type Project,
  type Concept,
  type ConceptDetail,
  type Draft,
  type MainVersion,
  type Selection,
  emptySelection,
  emptyGraph,
} from "../shared/model.js";
import {
  api,
  getSession,
  setSession,
  operationId,
  type BrowserSession,
} from "./api.js";
import { DraftEditor, type EditorState } from "./editor.js";
import { Canvas } from "./Canvas.js";
import { inspectDiagramRequest } from "./inspection.js";
import { DeleteDraftDialog } from "./DeleteDraftDialog.js";
import { useTheme } from "./theme.js";
import { PaneLayoutControl, type PaneLayout } from "./PaneLayoutControl.js";

async function registerTab() {
  let tabKey =
    sessionStorage.getItem("flowcanvas:tab-key") ?? crypto.randomUUID();
  let resumeId = sessionStorage.getItem("flowcanvas:session") ?? undefined;
  if (navigator.locks) {
    const acquire = (key: string) =>
      new Promise<boolean>((resolve) => {
        void navigator.locks.request(
          `flowcanvas:${key}`,
          { ifAvailable: true },
          async (lock) => {
            resolve(!!lock);
            if (lock)
              await new Promise<void>((release) =>
                window.addEventListener("pagehide", () => release(), {
                  once: true,
                }),
              );
          },
        );
      });
    if (!(await acquire(tabKey))) {
      tabKey = crypto.randomUUID();
      resumeId = undefined;
      await acquire(tabKey);
    }
  }
  sessionStorage.setItem("flowcanvas:tab-key", tabKey);
  const session = await api<BrowserSession>("/session", { resumeId });
  sessionStorage.setItem("flowcanvas:session", session.id);
  setSession(session);
  return session;
}
type Dialog = {
  title: string;
  label: string;
  initial?: string;
  submitLabel?: string;
  action: (name: string) => Promise<void>;
};

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [session, updateSession] = useState<BrowserSession | null>(null);
  const [catalog, setCatalog] = useState<{
    projects: Project[];
    concepts: Concept[];
  }>({ projects: [], concepts: [] });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const selectionRef = useRef(selection);
  const [detail, setDetail] = useState<ConceptDetail | null>(null);
  const [version, setVersion] = useState<MainVersion | null>(null);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const editor = useRef<DraftEditor | null>(null);
  const selectedDraftTab = useRef<HTMLButtonElement | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [paneLayout, setPaneLayout] = useState<PaneLayout>("balanced");
  const [sidebar, setSidebar] = useState(true);
  const [split, setSplit] = useState(50);
  const [help, setHelp] = useState(false);
  const [fitRequest, setFitRequest] = useState(0);
  const [layoutFitRequest, setLayoutFitRequest] = useState(0);
  const changing = useRef(false);
  const transition = useRef<Promise<void> | null>(null);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const run = useCallback(async (fn: () => Promise<void>) => {
    try {
      setError("");
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }, []);
  const loadCatalog = useCallback(async () => {
    const data = await api<{ projects: Project[]; concepts: Concept[] }>(
      "/catalog",
    );
    setCatalog(data);
    return data;
  }, []);
  const select = useCallback(async (next: Selection, skipFlush = false) => {
    if (changing.current) return;
    changing.current = true;
    const work = (async () => {
      try {
        if (!skipFlush) await editor.current?.flush();
        await api("/selection", next);
        const [newDetail, newVersion, draft] = await Promise.all([
          next.conceptId
            ? api<ConceptDetail>(`/concepts/${next.conceptId}`)
            : null,
          next.versionId
            ? api<MainVersion>(`/versions/${next.versionId}`)
            : null,
          next.draftId ? api<Draft>(`/drafts/${next.draftId}`) : null,
        ]);
        editor.current?.dispose();
        editor.current = null;
        setEditorState(null);
        setDetail(newDetail);
        setVersion(newVersion);
        if (draft) editor.current = new DraftEditor(draft, setEditorState);
        if (draft && next.draftId !== selectionRef.current.draftId) {
          setPaneLayout((old) => old === "main" ? "balanced" : old);
        }
        selectionRef.current = next;
        setSelection(next);
        if (newDetail)
          setExpanded((old) => new Set([...old, newDetail.concept.projectId]));
      } finally {
        changing.current = false;
      }
    })();
    transition.current = work;
    try {
      await work;
    } finally {
      transition.current = null;
    }
  }, []);
  const refresh = useCallback(async () => {
    await loadCatalog();
    if (changing.current) return;
    const current = selectionRef.current;
    if (current.conceptId) {
      const next = await api<ConceptDetail>(`/concepts/${current.conceptId}`);
      setDetail(next);
      if (
        current.draftId &&
        !next.drafts.some((draft) => draft.id === current.draftId)
      ) {
        await select({ ...current, draftId: next.drafts[0]?.id ?? null }, true);
      } else if (
        !current.draftId &&
        !current.versionId &&
        next.drafts.length === 1
      ) {
        await select({ ...current, draftId: next.drafts[0].id });
      } else await editor.current?.refresh();
    }
  }, [loadCatalog, select]);

  const requestDeleteDraft = (draftId: string) =>
    void run(async () => {
      await editor.current?.flush();
      setDeleteTarget(await api<Draft>(`/drafts/${draftId}`));
    });
  const deleteDraft = async (target: Draft, requestId: string) => {
    const result = await api<{ replacementDraftId: string | null }>(
      "/drafts/delete",
      {
        draftId: target.id,
        expectedRevision: target.revision,
        operationId: requestId,
      },
    );
    sessionStorage.removeItem(`pending:${target.id}`);
    const current = selectionRef.current;
    if (current.draftId === target.id)
      await select({ ...current, draftId: result.replacementDraftId }, true);
    else await refresh();
    setDeleteTarget(null);
  };

  useEffect(() => {
    let stream: EventSource | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const boot = async () => {
      const s = await registerTab();
      if (closed) return;
      updateSession(s);
      const data = await loadCatalog();
      setExpanded(new Set(data.projects.map((p) => p.id)));
      await select(s.selection);
      stream = new EventSource(
        `/api/events?sessionId=${encodeURIComponent(s.id)}&sessionToken=${encodeURIComponent(s.token)}`,
      );
      stream.addEventListener("changed", () => {
        void run(refresh);
      });
      stream.addEventListener("ownership", () => {
        void heartbeat();
      });
      stream.addEventListener("flush", (event) => {
        const { requestId } = JSON.parse((event as MessageEvent).data);
        void (async () => {
          let success = false;
          try {
            if (transition.current) await transition.current;
            await editor.current?.flush();
            await api("/selection", selectionRef.current);
            success = true;
          } catch {
            /* Explicit busy result to the agent if unsaved edits remain. */
          }
          await api("/flush", { requestId, success });
        })().catch(() => {});
      });
      stream.addEventListener("inspect", (event) => {
        const request = JSON.parse((event as MessageEvent).data);
        void (async () => {
          let report;
          try {
            report = await inspectDiagramRequest(request);
          } catch {
            report = { status: "render_failed" };
          }
          await api("/inspection", { requestId: request.requestId, report });
        })().catch(() => {});
      });
      stream.addEventListener("error", () =>
        setError("The local connection was interrupted. Reconnecting…"),
      );
      stream.addEventListener("ready", () => {
        setError("");
        void run(refresh);
      });
      const heartbeat = async () => {
        try {
          const state = await api<{ shared: boolean; generation: number }>(
            "/heartbeat",
            {},
          );
          updateSession((old) => (old ? { ...old, ...state } : old));
        } catch (e) {
          setError(e instanceof Error ? e.message : "Connection lost.");
        }
      };
      timer = setInterval(() => void heartbeat(), 4000);
    };
    void run(boot);
    const close = () => {
      const s = getSession();
      if (s)
        navigator.sendBeacon(
          "/api/close",
          new Blob(
            [JSON.stringify({ sessionId: s.id, sessionToken: s.token })],
            { type: "application/json" },
          ),
        );
    };
    window.addEventListener("pagehide", close);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (editor.current && editor.current.state.status !== "saved") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      closed = true;
      stream?.close();
      clearInterval(timer);
      window.removeEventListener("pagehide", close);
      window.removeEventListener("beforeunload", beforeUnload);
      editor.current?.dispose();
    };
  }, [loadCatalog, select, refresh, run]);

  const createProject = () =>
    setDialog({
      title: "New project",
      label: "Project name",
      action: async (name) => {
        const project = await api<Project>("/projects", {
          name,
          operationId: operationId(),
        });
        await loadCatalog();
        setExpanded((old) => new Set([...old, project.id]));
      },
    });
  const createConcept = (projectId: string) =>
    setDialog({
      title: "New concept",
      label: "Concept name",
      action: async (name) => {
        const concept = await api<Concept>("/concepts", {
          projectId,
          name,
          operationId: operationId(),
        });
        await loadCatalog();
        await select({ conceptId: concept.id, versionId: null, draftId: null });
      },
    });
  const createDraft = () => {
    if (!detail) return;
    setDialog({
      title: "New draft",
      label: "Draft name",
      initial: detail.drafts.length
        ? `Alternative ${detail.drafts.length + 1}`
        : "Initial flow",
      action: async (name) => {
        await editor.current?.flush();
        const draft = await api<Draft>("/drafts", {
          conceptId: detail.concept.id,
          name,
          sourceVersionId: selectionRef.current.versionId,
          operationId: operationId(),
        });
        await select({ ...selectionRef.current, draftId: draft.id });
      },
    });
  };
  const applyDraft = async () => {
    if (!editor.current) return;
    setBusy(true);
    try {
      await editor.current.flush();
      const draft = editor.current.base;
      const result = await api<{ version: MainVersion; draft: Draft }>(
        "/apply",
        {
          draftId: draft.id,
          expectedRevision: draft.revision,
          operationId: operationId(),
        },
      );
      editor.current.accept(result.draft);
      await select(
        {
          conceptId: draft.conceptId,
          versionId: result.version.id,
          draftId: draft.id,
        },
        true,
      );
    } finally {
      setBusy(false);
    }
  };
  const copyDraft = () => {
    const source = editor.current?.state.draft;
    if (!source) return;
    let previousInput = "";
    let requestId = operationId();
    setDialog({
      title: "Copy draft",
      label: "Draft name",
      initial: `${source.name.slice(0, 153)} (copy)`,
      submitLabel: "Create copy",
      action: async (name) => {
        await editor.current?.flush();
        const saved = await api<Draft>(`/drafts/${source.id}`);
        const input = JSON.stringify([name, saved.revision]);
        if (input !== previousInput) {
          previousInput = input;
          requestId = operationId();
        }
        const draft = await api<Draft>("/drafts/copy", {
          conceptId: source.conceptId,
          sourceDraftId: source.id,
          name,
          expectedSourceRevision: saved.revision,
          operationId: requestId,
        });
        await select({ ...selectionRef.current, draftId: draft.id });
      },
    });
  };
  const renameDraft = () => {
    const draft = editor.current?.state.draft;
    if (!draft) return;
    setDialog({
      title: "Rename draft",
      label: "Draft name",
      initial: draft.name,
      action: async (name) => {
        editor.current?.change([{ kind: "rename", name }]);
        await editor.current?.flush();
        await refresh();
      },
    });
  };
  const prefix = (baseVersionId: string | null) =>
    baseVersionId
      ? `v${detail?.versions.find((v) => v.id === baseVersionId)?.number ?? "?"}`
      : "New";
  const latest = detail?.versions.find(
    (v) => v.id === detail.concept.latestVersionId,
  );
  const changes = useCallback(
    (operations: import("../shared/model.js").Operation[], deferSave = false) =>
      editor.current?.change(operations, deferSave),
    [],
  );
  const commitText = useCallback(() => {
    void run(async () => {
      await editor.current?.flush();
    });
  }, [run]);
  const activeDraft = editorState?.draft;
  const showMain = !activeDraft || paneLayout !== "draft";
  const showDraft = !!activeDraft && paneLayout !== "main";
  const showBoth = showMain && showDraft;
  useEffect(() => {
    setLayoutFitRequest((n) => n + 1);
  }, [paneLayout]);
  const changePaneLayout = (next: PaneLayout) =>
    void run(async () => {
      await editor.current?.flush();
      if (next === "balanced") {
        setSplit(50);
        setLayoutFitRequest((n) => n + 1);
      }
      setPaneLayout(next);
    });
  useEffect(() => {
    selectedDraftTab.current?.parentElement?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeDraft?.id, showDraft]);
  const onSplit = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const container =
      event.currentTarget.parentElement!.getBoundingClientRect();
    const move = (e: PointerEvent) =>
      setSplit(
        Math.min(
          70,
          Math.max(30, ((e.clientX - container.left) / container.width) * 100),
        ),
      );
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  if (!session)
    return (
      <div className="loading-screen">
        <Workflow size={32} />
        <h2>FlowCanvas</h2>
        {error ? (
          <>
            <p>{error}</p>
            <button
              className="button primary"
              onClick={() => location.reload()}
            >
              Reconnect
            </button>
          </>
        ) : (
          <p>Opening your workspace…</p>
        )}
      </div>
    );
  return (
    <div className={`app ${!sidebar ? "sidebar-hidden" : ""}`}>
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
          <div className="brand-icon">
            <Workflow size={23} />
          </div>
          <span>
            FlowCanvas<small>SPACE TO THINK</small>
          </span>
        </a>
        <div className="sidebar-heading">
          <span>CONCEPTS</span>
          <button
            className="icon-button"
            title="New project"
            aria-label="New project"
            onClick={createProject}
          >
            <Plus size={17} />
          </button>
        </div>
        <nav className="project-list">
          {catalog.projects.map((project) => (
            <div className="project-group" key={project.id}>
              <div className="project-row">
                <button
                  className="project-toggle"
                  onClick={() =>
                    setExpanded((old) => {
                      const next = new Set(old);
                      if (next.has(project.id)) next.delete(project.id);
                      else next.add(project.id);
                      return next;
                    })
                  }
                >
                  {expanded.has(project.id) ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                  <Folder size={16} />
                  <span>{project.name}</span>
                </button>
                <button
                  className="row-action icon-button"
                  title="Rename project"
                  aria-label={`Rename ${project.name}`}
                  onClick={() =>
                    setDialog({
                      title: "Rename project",
                      label: "Project name",
                      initial: project.name,
                      action: async (name) => {
                        await api("/rename", {
                          kind: "project",
                          id: project.id,
                          name,
                        });
                        await loadCatalog();
                      },
                    })
                  }
                >
                  <Pencil size={12} />
                </button>
                <button
                  className="row-action icon-button"
                  title="New concept"
                  aria-label={`New concept in ${project.name}`}
                  onClick={() => createConcept(project.id)}
                >
                  <Plus size={14} />
                </button>
              </div>
              {expanded.has(project.id) && (
                <div className="concept-list">
                  {catalog.concepts
                    .filter((c) => c.projectId === project.id)
                    .map((concept) => (
                      <button
                        key={concept.id}
                        className={`concept-row ${selection.conceptId === concept.id ? "active" : ""}`}
                        onClick={() =>
                          void run(async () => {
                            const info = await api<ConceptDetail>(
                              `/concepts/${concept.id}`,
                            );
                            await select({
                              conceptId: concept.id,
                              versionId: concept.latestVersionId,
                              draftId: info.drafts[0]?.id ?? null,
                            });
                          })
                        }
                      >
                        <Network size={14} />
                        <span>{concept.name}</span>
                        {selection.conceptId === concept.id && (
                          <span className="active-dot" />
                        )}
                      </button>
                    ))}
                  <button
                    className="new-concept"
                    onClick={() => createConcept(project.id)}
                  >
                    <Plus size={13} />
                    New concept
                  </button>
                </div>
              )}
            </div>
          ))}
          {!catalog.projects.length && (
            <div className="sidebar-empty">
              <p>A home for your next idea.</p>
              <button onClick={createProject}>
                <Plus size={14} />
                Create a project
              </button>
            </div>
          )}
        </nav>
        <button className="add-project" onClick={createProject}>
          <Plus size={15} />
          New project
        </button>
        <div className="sidebar-footer">
          <div className="local-dot" />
          <span>
            Local workspace<small>Saved on this computer</small>
          </span>
          <button
            className="icon-button"
            onClick={() => setHelp(true)}
            title="Workspace guide"
          >
            <Command size={16} />
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="workspace-header">
          <div className="header-title">
            <button
              className="icon-button sidebar-toggle"
              title="Toggle sidebar"
              aria-label="Toggle sidebar"
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeftClose size={18} />
            </button>
            <span className="breadcrumb">
              {catalog.projects.find((p) => p.id === detail?.concept.projectId)
                ?.name ?? "Your workspace"}
            </span>
            <span className="breadcrumb-divider">/</span>
            {detail ? (
              <button
                className="concept-title"
                title="Rename concept"
                onClick={() =>
                  setDialog({
                    title: "Rename concept",
                    label: "Concept name",
                    initial: detail.concept.name,
                    action: async (name) => {
                      await api("/rename", {
                        kind: "concept",
                        id: detail.concept.id,
                        name,
                      });
                      await refresh();
                    },
                  })
                }
              >
                {detail.concept.name}
                <ChevronDown size={13} />
              </button>
            ) : (
              <span className="concept-title">Overview</span>
            )}
          </div>
          <div className="header-actions">
            {detail && (
              <div className="header-draft-actions">
                {activeDraft && (
                  <PaneLayoutControl value={paneLayout} onChange={changePaneLayout} />
                )}
                <button
                  className="button primary"
                  title="New draft"
                  aria-label="New draft"
                  onClick={createDraft}
                >
                  <Plus size={15} />
                  New draft
                </button>
              </div>
            )}
            <button
              type="button"
              className="icon-button theme-toggle"
              onClick={toggleTheme}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button
              className={`share-badge ${session.shared ? "shared" : ""}`}
              title={
                session.shared
                  ? "This tab supplies the selected Concept and diagrams to Codex."
                  : "This tab is not shared. Click to make it the shared workspace."
              }
              onClick={() =>
                !session.shared &&
                void run(async () => {
                  const state = await api("/share", {});
                  updateSession((old) => (old ? { ...old, ...state } : old));
                })
              }
            >
              <span className="status-dot" />
              {session.shared
                ? "Shared with Codex"
                : "Share this tab with Codex"}
            </button>
            <button
              className="icon-button"
              onClick={() => setHelp(true)}
              title="Workspace guide"
            >
              <Command size={17} />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
            <button className="icon-button" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {detail ? (
          <>
            <div
              className="panes"
              style={{ "--main-width": `${split}%` } as React.CSSProperties}
            >
              <section
                className="pane main-pane"
                hidden={!showMain}
                style={{
                  flexBasis: showBoth ? `calc((100% - 8px) * ${split / 100})` : "100%",
                }}
                aria-label="Main canvas"
              >
                <div className="pane-header">
                  <div className="pane-heading">
                    <div className="pane-icon">
                      <Layers size={16} />
                    </div>
                    <span>Main flow</span>
                    <span className="readonly-badge">READ ONLY</span>
                  </div>
                  <div className="version-select">
                    <select
                      aria-label="Main version"
                      value={selection.versionId ?? ""}
                      onChange={(e) =>
                        void run(() =>
                          select({
                            ...selectionRef.current,
                            versionId: e.target.value || null,
                          }),
                        )
                      }
                    >
                      {!version && <option value="">No versions</option>}
                      {detail.versions.map((v) => (
                        <option key={v.id} value={v.id}>
                          v{v.number}
                          {v.id === detail.concept.latestVersionId
                            ? " · Latest"
                            : ""}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={12} />
                  </div>
                </div>
                {version && version.id !== detail.concept.latestVersionId && (
                  <div className="historical-banner">
                    Viewing v{version.number}. Latest is v{latest?.number}. New
                    drafts will copy this version.
                  </div>
                )}
                <Canvas
                  id={`main-${version?.id ?? detail.concept.id}`}
                  revision={version?.number ?? 0}
                  graph={version?.graph ?? emptyGraph()}
                  editable={false}
                  visible={showMain}
                  fitRequest={layoutFitRequest}
                  onChange={() => {}}
                  onMessage={setError}
                />
                <footer className="pane-footer">
                  <span>
                    <MousePointer2 size={12} />
                    Scroll to zoom · Drag to pan
                  </span>
                  <span>
                    {version
                      ? `Saved ${new Date(version.createdAt).toLocaleDateString()}`
                      : "Your applied drafts appear here"}
                  </span>
                </footer>
              </section>
              {activeDraft && (
                <>
                  {showBoth && (
                    <div
                      className="split-divider"
                      role="separator"
                      aria-label="Resize canvases"
                      aria-orientation="vertical"
                      tabIndex={0}
                      onPointerDown={onSplit}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowLeft")
                          setSplit((v) => Math.max(30, v - 5));
                        if (e.key === "ArrowRight")
                          setSplit((v) => Math.min(70, v + 5));
                      }}
                    >
                      <span />
                    </div>
                  )}
                  <section
                    className="pane draft-pane"
                    hidden={!showDraft}
                    aria-label="Draft canvas"
                  >
                    <div className="draft-tabbar">
                      <div
                        className="draft-tabs"
                        role="tablist"
                        aria-label="Drafts"
                      >
                        {detail.drafts.map((draft) => (
                          <div
                            key={draft.id}
                            className={`draft-tab${draft.id === activeDraft.id ? " selected" : ""}`}
                            role="presentation"
                          >
                            <button
                              ref={draft.id === activeDraft.id ? selectedDraftTab : undefined}
                              role="tab"
                              aria-selected={draft.id === activeDraft.id}
                              title={`${prefix(draft.baseVersionId)} - ${draft.name}`}
                              aria-keyshortcuts="F2"
                              onDoubleClick={() => {
                                if (draft.id === activeDraft.id) renameDraft();
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "F2" && draft.id === activeDraft.id) {
                                  e.preventDefault();
                                  renameDraft();
                                }
                              }}
                              onClick={() =>
                                void run(() =>
                                  select({
                                    ...selectionRef.current,
                                    draftId: draft.id,
                                  }),
                                )
                              }
                            >
                              <span className="draft-tab-dot" />
                              <span className="draft-tab-label">
                                {prefix(
                                  draft.id === activeDraft.id
                                    ? activeDraft.baseVersionId
                                    : draft.baseVersionId,
                                )}{" "}
                                -{" "}
                                {draft.id === activeDraft.id
                                  ? activeDraft.name
                                  : draft.name}
                              </span>
                            </button>
                            <button
                              className="draft-tab-close"
                              aria-label={`Delete draft ${draft.id === activeDraft.id ? activeDraft.name : draft.name}`}
                              title="Delete draft"
                              onClick={() => requestDeleteDraft(draft.id)}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                        <button
                          className="new-tab"
                          title="New draft"
                          aria-label="New draft tab"
                          onClick={createDraft}
                        >
                          <Plus size={15} />
                        </button>
                      </div>
                      <div className="draft-tools">
                        <button
                          className="icon-button"
                          title="Copy draft"
                          aria-label="Copy draft"
                          onClick={copyDraft}
                        >
                          <Copy size={15} />
                        </button>
                        <span className="tool-divider" />
                        <button
                          className="icon-button"
                          title="Undo (Ctrl+Z)"
                          aria-label="Undo"
                          disabled={!editorState?.canUndo}
                          onClick={() =>
                            void run(() => editor.current!.history("undo"))
                          }
                        >
                          <Undo2 size={16} />
                        </button>
                        <button
                          className="icon-button"
                          title="Redo (Ctrl+Shift+Z)"
                          aria-label="Redo"
                          disabled={!editorState?.canRedo}
                          onClick={() =>
                            void run(() => editor.current!.history("redo"))
                          }
                        >
                          <Redo2 size={16} />
                        </button>
                        <span className="tool-divider" />
                        <button
                          className="button subtle arrange"
                          title="Arrange"
                          aria-label="Arrange"
                          onClick={() =>
                            void run(async () => {
                              await editor.current!.arrange();
                              setFitRequest((n) => n + 1);
                            })
                          }
                        >
                          <WandSparkles size={15} />
                          Arrange
                        </button>
                        <button
                          className="button apply-button"
                          title="Apply draft"
                          aria-label="Apply draft"
                          disabled={busy || editorState?.status === "conflict"}
                          onClick={() => void run(applyDraft)}
                        >
                          {busy ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : (
                            <CheckCheck size={15} />
                          )}
                          Apply draft
                        </button>
                      </div>
                    </div>
                    {editorState &&
                      ["error", "conflict"].includes(editorState.status) && (
                        <div className="save-error" role="alert">
                          <span>{editorState.message}</span>
                          {editorState.status === "conflict" ? (
                            <div>
                              <button
                                onClick={() =>
                                  void run(() => editor.current!.resolve(false))
                                }
                              >
                                Use saved draft
                              </button>
                              <button
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      "Replace the saved draft with the contents currently shown? Other edits to this draft will be replaced.",
                                    )
                                  )
                                    void run(() =>
                                      editor.current!.resolve(true),
                                    );
                                }}
                              >
                                Save my contents
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() =>
                                void run(() => editor.current!.flush())
                              }
                            >
                              Retry saving
                            </button>
                          )}
                        </div>
                      )}
                    <div
                      className="draft-canvas-wrapper"
                      onKeyDown={(e) => {
                        if ((e.target as HTMLElement).closest("input,textarea"))
                          return;
                        if (
                          (e.ctrlKey || e.metaKey) &&
                          e.key.toLowerCase() === "z"
                        ) {
                          e.preventDefault();
                          void run(() =>
                            editor.current!.history(
                              e.shiftKey ? "redo" : "undo",
                            ),
                          );
                        }
                      }}
                    >
                      <Canvas
                        id={activeDraft.id}
                        revision={activeDraft.revision}
                        saved={editorState?.status === "saved"}
                        graph={activeDraft.graph}
                        editable
                        visible={showDraft}
                        onChange={changes}
                        onCommit={commitText}
                        onMessage={setError}
                        fitRequest={fitRequest + layoutFitRequest}
                      />
                    </div>
                    <footer className="pane-footer">
                      <span>
                        {editorState?.status === "saving" ? (
                          <LoaderCircle className="spin" size={12} />
                        ) : editorState?.status === "saved" ? (
                          <Check size={12} />
                        ) : (
                          <AlertCircle size={12} />
                        )}{" "}
                        {editorState?.status === "saving"
                          ? "Saving…"
                          : editorState?.status === "saved"
                            ? "All changes saved"
                            : editorState?.status === "editing"
                              ? "Text saves when you leave the field"
                              : "Unsaved changes kept"}
                      </span>
                      <span>Draft edits never change main</span>
                    </footer>
                    {deleteTarget && (
                      <DeleteDraftDialog
                        key={deleteTarget.id}
                        draft={deleteTarget}
                        close={() => setDeleteTarget(null)}
                        confirm={(requestId) =>
                          deleteDraft(deleteTarget, requestId)
                        }
                      />
                    )}
                  </section>
                </>
              )}
              {!activeDraft && detail.drafts.length > 0 && (
                <div className="reopen-drafts">
                  <span>Continue a draft</span>
                  {detail.drafts.map((d) => (
                    <button
                      key={d.id}
                      onClick={() =>
                        void run(() =>
                          select({ ...selectionRef.current, draftId: d.id }),
                        )
                      }
                    >
                      {prefix(d.baseVersionId)} - {d.name}
                      <ArrowUpRight size={13} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="welcome">
            <div className="welcome-art">
              <div className="art-node">
                <MonitorIcon />
                Interface
              </div>
              <span />
              <div className="art-node agent">
                <Network size={18} />
                Agent
              </div>
              <span />
              <div className="art-node">
                <Workflow size={18} />
                Process
              </div>
            </div>
            <span className="eyebrow">A LITTLE ROOM FOR THE BIG PICTURE</span>
            <h1>
              Make space for
              <br />
              your next idea.
            </h1>
            <p>
              Sketch the flow. Explore an alternative.
              <br />
              Build a clearer picture, together.
            </p>
            <button className="button primary large" onClick={createProject}>
              <Plus size={17} />
              {catalog.projects.length
                ? "New project"
                : "Create your first project"}
            </button>
            {catalog.projects.length > 0 && (
              <span className="welcome-hint">
                Or open a concept from the sidebar.
              </span>
            )}
            <div className="welcome-bottom">
              <span>
                <Layers size={15} />A clear main flow
              </span>
              <span>
                <SplitSquareHorizontal size={15} />
                Room for alternatives
              </span>
              <span>
                <Check size={15} />
                Always saved locally
              </span>
            </div>
          </div>
        )}
      </main>
      {dialog && (
        <NameDialog
          dialog={dialog}
          close={() => setDialog(null)}
          onError={setError}
        />
      )}
      {help && (
        <div className="modal-backdrop" onMouseDown={() => setHelp(false)}>
          <section
            className="modal guide"
            role="dialog"
            aria-modal="true"
            aria-label="Workspace guide"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              onClick={() => setHelp(false)}
            >
              <X size={18} />
            </button>
            <div className="modal-symbol">
              <Workflow size={23} />
            </div>
            <h2>A space to think together</h2>
            <p>
              Main is a saved snapshot. Make changes in drafts, then use{" "}
              <strong>Apply draft</strong> to save a new main version. Your
              draft stays open.
            </p>
            <p>
              Drag from the upper-right blue square to fetch data from another
              block. Fetch connections have arrows at both ends for the request
              and response. Use the centered output for the normal flow.
            </p>
            <p>
              Bottom ports call sub-agents and receive results through the
              called block’s top input. Connect the
              first port to reveal more: one, then three, then five. Each port
              holds one call, with arrows at both ends.
            </p>
            <p>
              Arrange keeps the main flow horizontal and places sub-agent calls
              below their callers. Connections route around blocks and leave
              room for their labels. Select a connection, then drag its square
              grips to move the bends. Reset route restores that connection;
              Arrange resets all manual routes. Both can be undone.
            </p>
            <p>
              The shared tab tells Codex which Concept, main version, and draft
              you’re discussing. Other browser tabs don’t change that context.
            </p>
            <div className="shortcut-list">
              <span>
                Select several blocks<kbd>Shift + drag</kbd>
              </span>
              <span>
                Duplicate selected blocks<kbd>Ctrl + D</kbd>
              </span>
              <span>
                Undo / redo draft edits<kbd>Ctrl + Z / Shift + Z</kbd>
              </span>
              <span>
                Remove selected elements<kbd>Delete</kbd>
              </span>
              <span>
                Label a connection<kbd>Double-click label</kbd>
              </span>
            </div>
            <button className="button primary" onClick={() => setHelp(false)}>
              Got it
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
function MonitorIcon() {
  return (
    <div className="tiny-interface">
      <span />
    </div>
  );
}
function NameDialog({
  dialog,
  close,
  onError,
}: {
  dialog: Dialog;
  close: () => void;
  onError: (s: string) => void;
}) {
  const [name, setName] = useState(dialog.initial ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setName(dialog.initial ?? "");
    setMessage("");
  }, [dialog]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await dialog.action(name.trim());
      close();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={() => !saving && close()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <button
          className="modal-close icon-button"
          type="button"
          onClick={close}
          aria-label="Close dialog"
        >
          <X size={18} />
        </button>
        <div className="modal-symbol">
          {dialog.title === "Copy draft" ? (
            <Copy size={23} />
          ) : (
            <Plus size={23} />
          )}
        </div>
        <h2 id="dialog-title">{dialog.title}</h2>
        <label>
          {dialog.label}
          <input
            autoFocus
            value={name}
            maxLength={160}
            onChange={(e) => setName(e.target.value)}
            placeholder="Give your idea a name"
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        {message && <p className="form-error">{message}</p>}
        <div className="modal-actions">
          <button type="button" className="button subtle" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={saving || !name.trim()}>
            {saving
              ? "Saving…"
              : (dialog.submitLabel ??
                (dialog.title.startsWith("Rename") ? "Save name" : "Create"))}
          </button>
        </div>
      </form>
    </div>
  );
}
