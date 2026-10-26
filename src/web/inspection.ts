import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createElement } from "react";
import { Canvas } from "./Canvas.js";
import type { BrowserReport, InspectionIssue } from "../shared/inspection.js";
import type { Graph } from "../shared/model.js";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const overlaps = (a: DOMRect, b: DOMRect) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;

/** Inspect the shared tab's actual DOM without panning, fitting or selecting it. */
export async function inspectRenderedDiagram(canvasId: string, revision: number, includeImage: boolean, expectedNodeCount: number, view: "shared_canvas" | "saved_preview" = "shared_canvas"): Promise<BrowserReport> {
  // Saving/refreshing can finish just before React commits its new graph.
  let root: HTMLElement | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    root = [...document.querySelectorAll<HTMLElement>("[data-canvas]")].find((n) => n.dataset.canvas === canvasId);
    if (!root || !root.getBoundingClientRect().width || !root.getBoundingClientRect().height)
      return { status: "not_displayed" };
    if (root.dataset.revision === String(revision) && root.dataset.saved === "true" &&
        !root.querySelector(".react-flow__node.dragging") && root.querySelectorAll(".react-flow__node").length === expectedNodeCount) break;
    await frame();
  }
  if (!root || root.dataset.revision !== String(revision) || root.dataset.saved !== "true" ||
      root.querySelector(".react-flow__node.dragging") || root.querySelectorAll(".react-flow__node").length !== expectedNodeCount) return { status: "render_pending" };
  await document.fonts.ready;
  await frame(); await frame();
  const viewport = root.querySelector<HTMLElement>(".react-flow__viewport");
  if (!viewport) return { status: "render_pending" };
  const nodes = [...root.querySelectorAll<HTMLElement>(".react-flow__node")];
  const labels = [...root.querySelectorAll<HTMLElement>(".edge-label")];
  const issues: InspectionIssue[] = [];
  let issuesTruncated = false;
  const add = (kind: InspectionIssue["kind"], ids: string[]) => {
    if (issues.length < 10000) issues.push({ kind, ids }); else issuesTruncated = true;
  };
  for (const node of nodes) {
    const id = node.dataset.id!;
    const title = node.querySelector<HTMLElement>(".block-title");
    const body = node.querySelector<HTMLElement>(".block-text");
    if (title && title.scrollWidth > title.clientWidth + 1) add("heading_clipped", [id]);
    if (body && ((body as HTMLTextAreaElement).value || body.textContent) && (body.scrollHeight > body.clientHeight + 1 || body.scrollWidth > body.clientWidth + 1)) add("body_scrolls", [id]);
  }
  const rects = nodes.map((n) => n.getBoundingClientRect());
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++)
    if (overlaps(rects[i], rects[j])) add("block_overlap", [nodes[i].dataset.id!, nodes[j].dataset.id!]);
  for (const label of labels) {
    const rect = label.getBoundingClientRect();
    for (let i = 0; i < nodes.length; i++) if (overlaps(rect, rects[i]))
      add("label_overlap", [label.dataset.edgeId!, nodes[i].dataset.id!]);
  }
  // Node positions are independent of the user's pan and zoom.
  const boxes = nodes.map((node) => {
    const matrix = new DOMMatrix(getComputedStyle(node).transform);
    return { x: matrix.m41, y: matrix.m42, width: node.offsetWidth, height: node.offsetHeight };
  });
  // Include routed edges and labels, which may extend outside the block bounds.
  const transform = new DOMMatrix(getComputedStyle(viewport).transform);
  const viewportRect = viewport.getBoundingClientRect();
  for (const element of root.querySelectorAll<SVGPathElement | HTMLElement>(".react-flow__edge-path, .edge-label")) {
    const r = element.getBoundingClientRect();
    boxes.push({ x: (r.left - viewportRect.left) / transform.a, y: (r.top - viewportRect.top) / transform.a,
      width: r.width / transform.a, height: r.height / transform.a });
  }
  const x = (boxes.length ? Math.min(...boxes.map((b) => b.x)) : 0) - 24;
  const y = (boxes.length ? Math.min(...boxes.map((b) => b.y)) : 0) - 24;
  const width = Math.max(x + 100, ...boxes.map((b) => b.x + b.width)) - x + 24;
  const height = Math.max(y + 100, ...boxes.map((b) => b.y + b.height)) - y + 24;
  const report: Extract<BrowserReport, { status: "rendered" }> = {
    status: "rendered", view, revision, bounds: { x, y, width, height }, issues, issuesTruncated,
    selectedNodeIds: nodes.filter((n) => n.classList.contains("selected")).map((n) => n.dataset.id!),
    selectedEdgeIds: [...root.querySelectorAll<HTMLElement>(".react-flow__edge.selected")].map((n) => n.dataset.id!),
  };
  if (includeImage) {
    try {
      const { toPng } = await import("html-to-image");
      const scale = Math.min(1, 1600 / width, 1200 / height);
      const imageWidth = Math.max(1, Math.ceil(width * scale)), imageHeight = Math.max(1, Math.ceil(height * scale));
      const backgroundColor = getComputedStyle(root).backgroundColor;
      const url = await toPng(viewport, {
        width: imageWidth, height: imageHeight, pixelRatio: 1, backgroundColor,
        skipFonts: true,
        style: { transform: `scale(${scale}) translate(${-x}px, ${-y}px)`, transformOrigin: "0 0" },
        filter: (n) => !(n instanceof Element && n.matches(".react-flow__handle, .react-flow__resize-control, .block-fit-height, .edge-bend, .edge-reset, textarea:placeholder-shown")),
      });
      const data = url.slice(url.indexOf(",") + 1);
      if (data.length > 6_000_000) throw new Error("Preview too large");
      report.image = { data, width: imageWidth, height: imageHeight };
    } catch { report.imageError = "capture_failed"; }
  }
  // A tab/diagram may change while the image is being rendered.
  if (!root.isConnected || root.dataset.revision !== String(revision) || root.dataset.saved !== "true" ||
      root.querySelector(".react-flow__node.dragging") || !root.getBoundingClientRect().width || !root.getBoundingClientRect().height)
    return { status: "render_pending" };
  return report;
}

/** Render an explicit saved snapshot through the same Canvas, without navigating. */
export async function inspectDiagramRequest(request: {
  requestId: string; canvasId: string; revision: number; includeImage: boolean; graph: Graph; editable: boolean;
}): Promise<BrowserReport> {
  const current = await inspectRenderedDiagram(request.canvasId, request.revision, request.includeImage, request.graph.nodes.length);
  if (current.status !== "not_displayed") return current;
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:-20000px;top:0;width:1600px;height:1200px;display:flex;pointer-events:none";
  container.inert = true;
  container.setAttribute("aria-hidden", "true");
  document.body.append(container);
  const root = createRoot(container);
  const id = `inspection-${request.requestId}`;
  try {
    flushSync(() => root.render(createElement(Canvas, {
      id, graph: request.graph, revision: request.revision, editable: request.editable,
      onChange: () => {}, onMessage: () => {},
    })));
    return await inspectRenderedDiagram(id, request.revision, request.includeImage, request.graph.nodes.length, "saved_preview");
  } finally { root.unmount(); container.remove(); }
}
