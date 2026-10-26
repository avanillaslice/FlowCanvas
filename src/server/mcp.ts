import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Store, AppError } from "./store.js";
import { Workspace } from "./workspace.js";
import {
  responseSchemas, projectResponse, conceptResponse, draftReference,
  versionReference, draftResponse, mainResponse, agentEditSchema, prepareAgentEdit,
} from "./agent-contract.js";

const id = z.string().min(1).max(160);
const operationId = id.describe(
  "Unique idempotency key. Reuse only when retrying the identical request.",
);
export function createMcp(store: Store, workspace: Workspace) {
  const server = new McpServer(
    { name: "flowcanvas", version: "0.1.0" },
    {
      instructions:
        'FlowCanvas is a shared visual planning canvas; it does not execute the depicted process. Current/my Concept, main and draft mean selections in the shared tab: use read_diagram with kind="draft" or "main" and no IDs for one flow, read_concept for selected metadata, or read_workspace when both flows are needed. Never ask for IDs or search the catalog to resolve current selection. Selection reads flush browser edits. Reuse sufficient fresh context; refresh after user edits, selection changes or conflicts. Results are JSON text with complete graphs/reference lists and no pagination; inspect_diagram can add a PNG image block. Nodes/edges are sorted by ID, not execution order. Missing text/label means empty. Edge kind flow=progression, fetch=request/response, subagent=delegation/return; the latter two use source as caller and target as provider. Branches, joins and cycles are edges; labels are descriptive, not executable conditions. Build focused views with short headings and sparse optional bodies. The server manages layout/ports; subagent calls leave bottom outputs and enter top inputs. Arrange new flows and inspect_diagram to verify appearance; semantic graph reads alone cannot prove readability. An empty Concept is valid: create_draft with sourceVersionId=null to begin. Edit drafts only with a fresh expectedRevision. Only the user can Apply manually in the UI; never apply via browser or shell tools. Secondary tabs are private context.',
    },
  );
  const tool = (
    name: keyof typeof responseSchemas,
    description: string,
    schema: z.ZodRawShape,
    readonly: boolean,
    run: (input: any) => unknown,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readonly,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        try {
          const raw = await run(input) as any;
          const image = name === "inspect_diagram" ? raw.image : undefined;
          const payload = image ? { ...raw, image: undefined, preview: { width: image.width, height: image.height } } : raw;
          if (image) delete payload.image;
          const value = responseSchemas[name].parse(payload);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(value) },
              ...(image ? [{ type: "image" as const, mimeType: "image/png", data: image.data }] : []),
            ],
          };
        } catch (e) {
          const error =
            e instanceof AppError
              ? { code: e.code, message: e.message, details: e.details }
              : {
                  code: "invalid_request",
                  message: e instanceof Error ? e.message : "Invalid request.",
                };
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(error) }],
          };
        }
      },
    );
  };
  tool(
    "read_workspace",
    "Read both selected flows and Concept metadata from the shared tab. For only the current draft or main use read_diagram with kind and no IDs. Returns status, selectionRevision, concept, selectedMain, selectedDraft, and complete drafts/versions reference lists excluding the selected diagrams. No pagination. A selected empty Concept is ready with null diagrams; create its first draft with sourceVersionId=null.",
    {},
    true,
    async () => {
      const value = await workspace.read();
      if (value.status !== "ready") return value;
      return {
        ...value, concept: conceptResponse(value.concept),
        selectedMain: value.selectedMain ? mainResponse(value.selectedMain) : null,
        selectedDraft: value.selectedDraft ? draftResponse(value.selectedDraft) : null,
        drafts: value.drafts.map(draftReference), versions: value.versions.map(versionReference),
      };
    },
  );
  tool(
    "list_concepts",
    "List all Projects (id/name, including empty containers) and Concepts (id/projectId/name/latestVersionId), optionally filtered by projectId. No pagination or graphs. Use only for discovery outside the current selection.",
    {
      projectId: id.optional(),
    },
    true,
    ({ projectId }) => {
      const projects = store
        .projects()
        .filter((p) => !projectId || p.id === projectId);
      const concepts = store.concepts(projectId);
      return {
        projects: projects.map(projectResponse),
        concepts: concepts.map(conceptResponse),
      };
    },
  );
  tool(
    "read_concept",
    "Read Concept metadata and ALL draft (id/name/revision) and main-version (id/number) references, without graphs or pagination. Omit conceptId for the active Concept; this flushes browser edits and also returns selectionRevision, selectedMainId and selectedDraftId. No ID lookup is needed for the current Concept.",
    {
      conceptId: id.optional(),
    },
    true,
    async ({ conceptId }) => {
      let selected;
      if (conceptId === undefined) {
        const selection = await workspace.readSelection();
        if (selection.status !== "ready") return selection;
        conceptId = selection.conceptId;
        selected = {
          selectionRevision: selection.selectionRevision,
          selectedMainId: selection.versionId, selectedDraftId: selection.draftId,
        };
      }
      const detail = store.detail(conceptId);
      return {
        concept: conceptResponse(detail.concept),
        drafts: detail.drafts.map(draftReference),
        versions: detail.versions.map(versionReference),
        ...selected,
      };
    },
  );
  tool(
    "read_diagram",
    'Read one complete flow. For "my/current draft" call with kind="draft" only; for current main use kind="main" only. IDs omitted means the shared tab selection, flushed before reading. Explicit diagramId reads that diagram; optional conceptId checks ownership. Returns a flat object with kind, id, conceptId, graph and revision/base metadata (draft) or number/provenance (main). Missing selection returns a status, never a guessed diagram. Graph has schemaVersion/nodes/edges, explicit edge kinds, no layout/ports, no pagination. Use before editing a draft.',
    { conceptId: id.optional(), kind: z.enum(["draft", "main"]), diagramId: id.optional() },
    true,
    async ({ conceptId, kind, diagramId }) => {
      if (diagramId === undefined) {
        const selection = await workspace.readSelection();
        if (selection.status !== "ready") return selection;
        if (conceptId !== undefined && conceptId !== selection.conceptId)
          throw new AppError("wrong_concept", "The selected diagram belongs to another Concept. Supply an explicit diagramId for another Concept.");
        conceptId = selection.conceptId;
        diagramId = kind === "draft" ? selection.draftId : selection.versionId;
        if (diagramId === null) return {
          status: kind === "draft" ? "no_draft_selected" : "no_main_selected",
          conceptId, selectionRevision: selection.selectionRevision,
        };
      }
      const diagram = kind === "draft" ? draftResponse(store.draft(diagramId)) : mainResponse(store.version(diagramId));
      if (conceptId !== undefined && diagram.conceptId !== conceptId)
        throw new AppError(
          "wrong_concept",
          "Diagram does not belong to that Concept.",
        );
      return diagram;
    },
  );
  tool(
    "inspect_diagram",
    'Inspect a rendered diagram. Omit IDs for the current kind; explicit diagramId can preview a newly created alternative without opening it. Returns revision, measured clipping/overlap issues, graph bounds and selected element IDs; includeImage (default true) adds a PNG image content block. view=shared_canvas measures the displayed canvas; view=saved_preview renders the saved snapshot using the same Canvas in the shared tab, without changing pan, zoom or selection. No private-tab access. Use after Arrange and meaningful visual changes. Failure statuses do not confirm appearance. Measurements are layout checks, not proof of semantic correctness or edge clarity; examine the image too.',
    { kind: z.enum(["draft", "main"]), diagramId: id.optional(), conceptId: id.optional(), includeImage: z.boolean().default(true) },
    true,
    ({ kind, diagramId, conceptId, includeImage }) => workspace.inspect(kind, diagramId, conceptId, includeImage),
  );
  tool(
    "create_project",
    "Create a named Project container. Does not change the browser selection.",
    { name: z.string().min(1).max(160), operationId },
    false,
    ({ name, operationId }) => ({
      project: projectResponse(store.createProject(name, operationId)),
    }),
  );
  tool(
    "create_concept",
    "Create a Concept in a Project with no saved main versions. Does not navigate the browser.",
    { projectId: id, name: z.string().min(1).max(160), operationId },
    false,
    ({ projectId, name, operationId }) => ({
      concept: conceptResponse(store.createConcept(projectId, name, operationId)),
    }),
  );
  tool(
    "create_draft",
    "Create an independent draft from a main version or another draft. To copy a draft, supply sourceDraftId and expectedSourceRevision from its latest read; do not also supply sourceVersionId or workspaceSelectionRevision. Copies preserve graph/layout and the main base, with no relationship between drafts. Set sourceVersionId=null for an empty draft. Otherwise omit source selectors and supply workspaceSelectionRevision from an active read_concept or read_workspace to copy the displayed main.",
    {
      conceptId: id,
      name: z.string().min(1).max(160),
      sourceVersionId: id.nullable().optional(),
      sourceDraftId: id.optional(),
      expectedSourceRevision: z.number().int().nonnegative().optional(),
      workspaceSelectionRevision: z.number().int().nonnegative().optional(),
      operationId,
    },
    false,
    ({
      conceptId,
      name,
      sourceVersionId,
      sourceDraftId,
      expectedSourceRevision,
      workspaceSelectionRevision,
      operationId,
    }) => {
      if (
        sourceDraftId !== undefined &&
        (sourceVersionId !== undefined ||
          workspaceSelectionRevision !== undefined)
      )
        throw new AppError(
          "invalid_request",
          "Choose either a source draft or a main version, not both.",
        );
      if (
        (sourceDraftId !== undefined) !==
        (expectedSourceRevision !== undefined)
      )
        throw new AppError(
          "invalid_request",
          "Copying a draft requires both sourceDraftId and expectedSourceRevision from its latest read.",
        );
      const source =
        sourceDraftId !== undefined
          ? null
          : sourceVersionId === undefined
            ? workspace.resolveSource(
                conceptId,
                workspaceSelectionRevision ?? -1,
              )
            : sourceVersionId;
      const draft =
        sourceDraftId !== undefined
          ? store.copyDraft(
              conceptId,
              sourceDraftId,
              name,
              expectedSourceRevision!,
              operationId,
            )
          : store.createDraft(conceptId, name, source, operationId);
      return {
        draftId: draft.id,
        conceptId,
        revision: draft.revision,
        baseVersionId: draft.baseVersionId,
      };
    },
  );
  tool(
    "edit_draft",
    'Atomically edit a draft using IDs and expectedRevision from its latest read. Omit coordinates/dimensions and handles; the server supplies defaults. Use short headings and empty or brief bodies for an overview. Edge kind: flow=progression, fetch=request/response, subagent=delegation/return (maximum five per caller, bottom output to top input automatically). Changing kind selects both ports. Label-only edits preserve existing geometry. Arrange a new flow, then inspect_diagram to check appearance. Text is plain text. Stale batches fail atomically. Returns draftId/revision/baseVersionId.',
    { conceptId: id, ...agentEditSchema.shape },
    false,
    ({ conceptId, ...input }) => {
      if (store.draft(input.draftId).conceptId !== conceptId)
        throw new AppError(
          "wrong_concept",
          "Draft belongs to another Concept.",
        );
      const draft = store.edit(prepareAgentEdit(input));
      return {
        draftId: draft.id,
        revision: draft.revision,
        baseVersionId: draft.baseVersionId,
      };
    },
  );
  tool(
    "arrange_draft",
    "Explicitly arrange a draft left-to-right or top-to-bottom. Preserves graph contents and saves positions as one undoable action. Never changes main.",
    {
      conceptId: id,
      draftId: id,
      expectedRevision: z.number().int().nonnegative(),
      operationId,
      direction: z.enum(["RIGHT", "DOWN"]).default("RIGHT"),
    },
    false,
    async ({
      conceptId,
      draftId,
      expectedRevision,
      operationId,
      direction,
    }) => {
      if (store.draft(draftId).conceptId !== conceptId)
        throw new AppError(
          "wrong_concept",
          "Draft belongs to another Concept.",
        );
      const draft = await store.arrange(
        draftId,
        expectedRevision,
        operationId,
        direction,
      );
      return { draftId, revision: draft.revision };
    },
  );
  return server;
}
