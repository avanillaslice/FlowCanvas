import { z } from "zod";

export const blockTypes = [
  "interface",
  "agent",
  "subagent",
  "process",
  "decision",
  "store",
] as const;
export const blockNames: Record<(typeof blockTypes)[number], string> = {
  interface: "Interface",
  agent: "Agent",
  subagent: "Sub-agent",
  process: "Process",
  decision: "Decision",
  store: "Data store",
};
const name = z.string().trim().min(1).max(160);
const coordinate = z.number().finite().min(-100000).max(100000);
export const subagentHandles = [
  "subagent",
  "subagent-left",
  "subagent-right",
  "subagent-far-left",
  "subagent-far-right",
] as const;
export const fetchPortOffset = 26;
export function isSubagentHandle(
  value: string | null | undefined,
): value is (typeof subagentHandles)[number] {
  return subagentHandles.some((handle) => handle === value);
}
export const nodeSchema = z
  .object({
    id: z.string().min(1).max(160),
    type: z.enum(blockTypes),
    label: z.string().max(160),
    text: z.string().max(30000).default(""),
    x: coordinate,
    y: coordinate,
    width: z.number().finite().min(180).max(2000).default(250),
    // Even the maximum-length multiline notes can be fitted without scrolling.
    height: z.number().finite().min(100).max(1_000_000).default(150),
  })
  .strict();
export const edgeSchema = z
  .object({
    id: z.string().min(1).max(160),
    source: z.string().min(1),
    target: z.string().min(1),
    kind: z.enum(["flow", "fetch", "subagent"]).optional(),
    sourceHandle: z
      .enum(["out", "out-bottom", "fetch", ...subagentHandles])
      .default("out")
      .describe(
        'For kind="subagent", omit this field to assign a free bottom slot automatically (maximum five per source block). out-bottom is a retired flow port; normal flow uses out.',
      ),
    targetHandle: z.enum(["in", "in-top"]).default("in").describe(
      'Omit for automatic ports. New or reconnected Sub-agent calls enter in-top; other connections default to in. Existing saved geometry is preserved on label-only edits.',
    ),
    label: z.string().max(1000).default(""),
    // Optional manual routing pins; omitted in existing snapshots and MCP reads.
    waypoints: z.array(z.object({ x: coordinate, y: coordinate }).strict()).max(200).optional(),
  })
  .strict();
export const graphSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z.array(nodeSchema).max(1000),
    edges: z.array(edgeSchema).max(4000),
  })
  .strict()
  .superRefine((g, ctx) => {
    const nodes = new Set(g.nodes.map((n) => n.id));
    if (
      nodes.size !== g.nodes.length ||
      new Set(g.edges.map((e) => e.id)).size !== g.edges.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Element IDs must be unique within a graph.",
      });
    if (g.edges.some((e) => !nodes.has(e.source) || !nodes.has(e.target)))
      ctx.addIssue({
        code: "custom",
        message: "Connections must reference existing blocks.",
      });
    const calls = new Map<string, number>();
    const slots = new Set<string>();
    for (const [index, edge] of g.edges.entries()) {
      if ((edge.kind === "fetch") !== (edge.sourceHandle === "fetch"))
        ctx.addIssue({
          code: "custom",
          path: ["edges", index],
          message:
            'Fetch connections must use kind="fetch" and sourceHandle="fetch" together. Flow connections use the normal output ports.',
        });
      if ((edge.kind === "subagent") !== isSubagentHandle(edge.sourceHandle))
        ctx.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "Sub-agent calls must use a dedicated bottom slot.",
        });
      if (edge.kind === "subagent") {
        const count = (calls.get(edge.source) ?? 0) + 1;
        calls.set(edge.source, count);
        if (count > 5)
          ctx.addIssue({
            code: "custom",
            path: ["edges", index],
            message: "Each block supports at most five Sub-agent calls.",
          });
        const slot = `${edge.source}:${edge.sourceHandle}`;
        if (slots.has(slot))
          ctx.addIssue({
            code: "custom",
            path: ["edges", index],
            message:
              "Each Sub-agent slot can have only one call. Omit sourceHandle to assign a free slot.",
          });
        slots.add(slot);
      }
    }
  });
export const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add_node"), node: nodeSchema }).strict(),
  z
    .object({
      kind: z.literal("update_node"),
      id: z.string(),
      patch: nodeSchema.omit({ id: true }).partial(),
    })
    .strict(),
  z.object({ kind: z.literal("delete_node"), id: z.string() }).strict(),
  z.object({ kind: z.literal("add_edge"), edge: edgeSchema }).strict(),
  z
    .object({
      kind: z.literal("update_edge"),
      id: z.string(),
      patch: edgeSchema.omit({ id: true }).partial(),
    })
    .strict(),
  z.object({ kind: z.literal("delete_edge"), id: z.string() }).strict(),
  z.object({ kind: z.literal("rename"), name }).strict(),
]);
export const editSchema = z
  .object({
    draftId: z.string(),
    expectedRevision: z.number().int().nonnegative(),
    operationId: z.string().min(1).max(160),
    operations: z.array(operationSchema).min(1).max(5000),
  })
  .strict();
export const selectionSchema = z
  .object({
    conceptId: z.string().nullable(),
    versionId: z.string().nullable(),
    draftId: z.string().nullable(),
  })
  .strict();
export type Graph = z.infer<typeof graphSchema>;
export type Block = z.infer<typeof nodeSchema>;
export type FlowEdge = z.infer<typeof edgeSchema>;
/** Allocate bottom slots independently of the UI's progressive handle visibility. */
export function normalizeConnections(graph: Graph): Graph {
  const used = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== "subagent" || !isSubagentHandle(edge.sourceHandle))
      continue;
    const slots = used.get(edge.source) ?? new Set<string>();
    slots.add(edge.sourceHandle);
    used.set(edge.source, slots);
  }
  return {
    ...graph,
    edges: graph.edges.map((edge) => {
      if (edge.kind === "subagent" && !isSubagentHandle(edge.sourceHandle)) {
        const slots = used.get(edge.source) ?? new Set<string>();
        const handle = subagentHandles.find(
          (candidate) => !slots.has(candidate),
        );
        if (handle) {
          slots.add(handle);
          used.set(edge.source, slots);
          return { ...edge, sourceHandle: handle };
        }
      }
      // Retired flow outputs remain readable without rewriting immutable snapshots.
      if (edge.kind !== "subagent" && edge.sourceHandle === "out-bottom")
        return { ...edge, sourceHandle: "out" as const };
      return edge;
    }),
  };
}
export type Operation = z.infer<typeof operationSchema>;
export type Selection = z.infer<typeof selectionSchema>;
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
export interface Concept {
  id: string;
  projectId: string;
  name: string;
  latestVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Draft {
  id: string;
  conceptId: string;
  name: string;
  originVersionId: string | null;
  baseVersionId: string | null;
  graph: Graph;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface MainVersion {
  id: string;
  conceptId: string;
  number: number;
  sourceDraftId: string;
  sourceDraftRevision: number;
  parentVersionId: string | null;
  basedOnVersionId: string | null;
  graph: Graph;
  createdAt: string;
}
export type DraftRef = Omit<Draft, "graph">;
export type VersionRef = Omit<MainVersion, "graph">;
export interface ConceptDetail {
  concept: Concept;
  drafts: DraftRef[];
  versions: VersionRef[];
}
export const emptyGraph = (): Graph => ({
  schemaVersion: 1,
  nodes: [],
  edges: [],
});
export const emptySelection = (): Selection => ({
  conceptId: null,
  versionId: null,
  draftId: null,
});
