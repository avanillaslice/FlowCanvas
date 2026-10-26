import { z } from "zod";
import { renderedReportSchema } from "../shared/inspection.js";
import {
  nodeSchema, edgeSchema, operationSchema, editSchema,
  type Project, type Concept, type DraftRef, type VersionRef,
  type Draft, type MainVersion, type Graph,
} from "../shared/model.js";

const id = z.string().min(1);
const revision = z.number().int().nonnegative();
const project = z.object({ id, name: z.string() }).strict();
const concept = project.extend({ projectId: id, latestVersionId: id.nullable() });
const draftRef = project.extend({ revision });
const versionRef = z.object({ id, number: z.number().int().positive() }).strict();
const graph = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(nodeSchema.pick({ id: true, type: true, label: true }).extend({
    text: z.string().min(1).optional(),
  })),
  edges: z.array(edgeSchema.pick({ id: true, source: true, target: true }).extend({
    kind: z.enum(["flow", "fetch", "subagent"]),
    label: z.string().min(1).optional(),
  })),
}).strict();
const draft = draftRef.extend({
  kind: z.literal("draft"), conceptId: id,
  originVersionId: id.nullable(), baseVersionId: id.nullable(), graph,
});
const main = versionRef.extend({
  kind: z.literal("main"), conceptId: id, sourceDraftId: id,
  sourceDraftRevision: revision, parentVersionId: id.nullable(),
  basedOnVersionId: id.nullable(), graph,
});
const unavailable = z.union([
  z.object({ status: z.literal("no_active_workspace") }).strict(),
  z.object({ status: z.literal("no_concept_selected"), selectionRevision: revision }).strict(),
]);
const detail = z.object({
  concept, drafts: z.array(draftRef), versions: z.array(versionRef),
}).strict();
const acknowledgement = z.object({ draftId: id, revision }).strict();
const inspectionIdentity = { kind: z.enum(["draft", "main"]), diagramId: id, revision };

// Text-only MCP results cannot advertise outputSchema: the SDK requires
// structuredContent for that. Validate the JSON payload here instead.
export const responseSchemas = {
  inspect_diagram: z.union([
    unavailable,
    z.object({ status: z.enum(["no_draft_selected", "no_main_selected"]), conceptId: id, selectionRevision: revision }).strict(),
    z.object({ ...inspectionIdentity, status: z.enum(["not_displayed", "render_pending", "render_failed"]) }).strict(),
    renderedReportSchema.omit({ image: true }).extend({ ...inspectionIdentity,
      preview: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
    }),
  ]),
  read_workspace: z.union([unavailable, detail.extend({
    status: z.literal("ready"), selectionRevision: revision,
    selectedMain: main.nullable(), selectedDraft: draft.nullable(),
  })]),
  list_concepts: z.object({ projects: z.array(project), concepts: z.array(concept) }).strict(),
  read_concept: z.union([unavailable, detail, detail.extend({
    selectionRevision: revision, selectedMainId: id.nullable(), selectedDraftId: id.nullable(),
  })]),
  read_diagram: z.union([unavailable, draft, main, z.object({
    status: z.enum(["no_draft_selected", "no_main_selected"]),
    conceptId: id, selectionRevision: revision,
  }).strict()]),
  create_project: z.object({ project }).strict(),
  create_concept: z.object({ concept }).strict(),
  create_draft: acknowledgement.extend({ conceptId: id, baseVersionId: id.nullable() }),
  edit_draft: acknowledgement.extend({ baseVersionId: id.nullable() }),
  arrange_draft: acknowledgement,
};

export const projectResponse = ({ id, name }: Project) => ({ id, name });
export const conceptResponse = ({ id, projectId, name, latestVersionId }: Concept) =>
  ({ id, projectId, name, latestVersionId });
export const draftReference = ({ id, name, revision }: DraftRef) => ({ id, name, revision });
export const versionReference = ({ id, number }: VersionRef) => ({ id, number });

// Sort copies by ID for stable reads without changing stored/UI order.
const byId = <T extends { id: string }>(items: T[]) =>
  [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const graphResponse = (graph: Graph) => ({
  schemaVersion: graph.schemaVersion,
  nodes: byId(graph.nodes).map(({ id, type, label, text }) => ({
    id, type, label, ...(text ? { text } : {}),
  })),
  edges: byId(graph.edges).map(({ id, source, target, kind, label }) => ({
    id, source, target, kind: kind ?? "flow", ...(label ? { label } : {}),
  })),
});
export const draftResponse = (draft: Draft) => ({
  kind: "draft" as const, ...draftReference(draft), conceptId: draft.conceptId,
  originVersionId: draft.originVersionId, baseVersionId: draft.baseVersionId,
  graph: graphResponse(draft.graph),
});
export const mainResponse = (main: MainVersion) => ({
  kind: "main" as const, ...versionReference(main), conceptId: main.conceptId,
  sourceDraftId: main.sourceDraftId, sourceDraftRevision: main.sourceDraftRevision,
  parentVersionId: main.parentVersionId, basedOnVersionId: main.basedOnVersionId,
  graph: graphResponse(main.graph),
});

// Keep the browser/storage schema intact. MCP callers can omit presentation
// fields; explicit fields remain supported for existing clients.
const agentNode = nodeSchema.extend({
  x: nodeSchema.shape.x.default(0), y: nodeSchema.shape.y.default(0),
});
const agentEdge = edgeSchema.extend({ sourceHandle: edgeSchema.shape.sourceHandle.optional() });
export const agentEditSchema = editSchema.extend({
  operations: z.array(z.discriminatedUnion("kind", [
    operationSchema.options[0].extend({ node: agentNode }),
    operationSchema.options[1], operationSchema.options[2],
    operationSchema.options[3].extend({ edge: agentEdge }),
    operationSchema.options[4], operationSchema.options[5], operationSchema.options[6],
  ])).min(1).max(5000),
});
export function prepareAgentEdit(input: z.infer<typeof agentEditSchema>) {
  return {
    ...input,
    operations: input.operations.map((op) => {
      if (op.kind === "add_edge") return {
        ...op, edge: { ...op.edge, sourceHandle: op.edge.sourceHandle ??
          (op.edge.kind === "fetch" ? "fetch" as const : "out" as const) },
      };
      if (op.kind === "update_edge" && op.patch.kind !== undefined && op.patch.sourceHandle === undefined)
        return { ...op, patch: { ...op.patch, sourceHandle:
          op.patch.kind === "fetch" ? "fetch" as const : "out" as const } };
      return op;
    }),
  };
}
