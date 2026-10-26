import { z } from "zod";

const box = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative().finite(), height: z.number().nonnegative().finite() }).strict();
export const inspectionIssueSchema = z.object({
  kind: z.enum(["heading_clipped", "body_scrolls", "block_overlap", "label_overlap", "subagent_side_target"]),
  ids: z.array(z.string().max(160)).max(2),
}).strict();
export const renderedReportSchema = z.object({
  status: z.literal("rendered"),
  view: z.enum(["shared_canvas", "saved_preview"]),
  revision: z.number().int().nonnegative(),
  bounds: box,
  issues: z.array(inspectionIssueSchema).max(10000),
  issuesTruncated: z.boolean(),
  selectedNodeIds: z.array(z.string().max(160)).max(1000),
  selectedEdgeIds: z.array(z.string().max(160)).max(4000),
  image: z.object({
    // Only locally rendered PNG data, never remote URLs or HTML.
    data: z.string().max(6_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    width: z.number().int().positive().max(1600),
    height: z.number().int().positive().max(1200),
  }).strict().optional(),
  imageError: z.literal("capture_failed").optional(),
}).strict();
export const browserReportSchema = z.union([
  renderedReportSchema,
  z.object({ status: z.enum(["not_displayed", "render_pending", "render_failed"]) }).strict(),
]);
export type BrowserReport = z.infer<typeof browserReportSchema>;
export type InspectionIssue = z.infer<typeof inspectionIssueSchema>;
