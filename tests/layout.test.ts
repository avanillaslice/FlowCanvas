import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { ELK } from "elkjs/lib/elk-api.js";
import { arrangeGraph } from "../src/server/layout.js";
import { graphSchema, fetchPortOffset } from "../src/shared/model.js";
import {
  connectionText,
  labelSize,
  routeConnection,
} from "../src/shared/routing.js";

const Elk = createRequire(import.meta.url)(
  "elkjs/lib/elk.bundled.js",
) as new () => ELK;
const block = (id: string, height = 180) => ({
  id,
  type: "agent",
  label: id,
  x: 0,
  y: 0,
  width: 250,
  height,
});
const layout = (nodes: unknown[], edges: unknown[]) =>
  arrangeGraph(
    graphSchema.parse({ schemaVersion: 1, nodes, edges }),
    new Elk(),
    "RIGHT",
  );

describe("compact Arrange", () => {
  it("balances real fan-outs around their source ports instead of lifting all leaves above the caller", async () => {
    for (const count of [3,5,7]) {
      const graph=await layout([block("source"),...Array.from({length:count},(_,i)=>block(`leaf-${i}`))],Array.from({length:count},(_,i)=>({id:`edge-${i}`,source:"source",target:`leaf-${i}`,kind:i === 0 ? "fetch" : "flow",sourceHandle:i === 0 ? "fetch" : "out",label:"Next"})));
      const source=graph.nodes[0], leaves=graph.nodes.slice(1).sort((a,b)=>a.y-b.y);
      const center=source.y+source.height/2;
      expect(center).toBeGreaterThan(leaves[0].y+leaves[0].height/2);
      expect(center).toBeLessThan(leaves.at(-1)!.y+leaves.at(-1)!.height/2);
      expect(Math.abs(center-leaves[Math.floor(count/2)].y-leaves[Math.floor(count/2)].height/2)).toBeLessThan(30);
      for (let i=1;i<leaves.length;i++) expect(leaves[i].y-leaves[i-1].y-leaves[i-1].height).toBeGreaterThanOrEqual(60);
    }
  });
  it("prioritizes neighboring steps over a connection that spans intervening blocks", async () => {
    const graph = await layout(
      [block("a"), block("b"), block("c"), block("d")],
      [
        { id: "ab", source: "a", target: "b", label: "Next" },
        { id: "bc", source: "b", target: "c", label: "Next" },
        { id: "cd", source: "c", target: "d", label: "Next" },
        {
          id: "long",
          source: "a",
          target: "d",
          kind: "fetch",
          sourceHandle: "fetch",
          label: "Load prior state",
        },
      ],
    );
    for (const edge of graph.edges.slice(0, 3)) {
      const a = graph.nodes.find((n) => n.id === edge.source)!,
        b = graph.nodes.find((n) => n.id === edge.target)!;
      expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThan(
        0.02,
      );
    }
    const [a, , , d] = graph.nodes;
    const source = {
        x: a.x + a.width,
        y: a.y + a.height / 2 - fetchPortOffset,
      },
      target = { x: d.x, y: d.y + d.height / 2 };
    const route = routeConnection({
      source,
      target,
      sourceSide: "right",
      targetSide: "left",
      obstacles: graph.nodes,
      label: labelSize("Load prior state"),
    });
    expect(
      route.points.some(
        (p) =>
          p.y < Math.min(source.y, target.y) ||
          p.y > Math.max(source.y, target.y),
      ),
    ).toBe(true);
  });

  it("leaves room for labels and port leads when adjacent branches cannot all be straight", async () => {
    const graph = await layout(
      [block("source"), block("one"), block("two"), block("three")],
      [
        { id: "one", source: "source", target: "one", label: "Submit request" },
        {
          id: "two",
          source: "source",
          target: "two",
          label: "Supply routing context",
        },
        {
          id: "three",
          source: "source",
          target: "three",
          label: "Save completed turn and result references",
        },
      ],
    );
    let bends = 0;
    for (const edge of graph.edges) {
      const a = graph.nodes.find((n) => n.id === edge.source)!,
        b = graph.nodes.find((n) => n.id === edge.target)!;
      const source = { x: a.x + a.width, y: a.y + a.height / 2 },
        target = { x: b.x, y: b.y + b.height / 2 };
      if (Math.abs(source.y - target.y) > 1) bends++;
      const route = routeConnection({
        source,
        target,
        sourceSide: "right",
        targetSide: "left",
        obstacles: graph.nodes,
        label: labelSize(connectionText(edge)),
      });
      expect(
        route.points.every(
          (p) =>
            p.y >= Math.min(source.y, target.y) - 0.01 &&
            p.y <= Math.max(source.y, target.y) + 0.01,
        ),
      ).toBe(true);
    }
    expect(bends).toBeGreaterThan(0);
  });

  it("reserves each connection's label width without expanding shorter connections", async () => {
    const graph = await layout(
      [block("a"), block("b"), block("c")],
      [
        {
          id: "long",
          source: "a",
          target: "b",
          label: "Search selected collection",
        },
        { id: "short", source: "b", target: "c", label: "Go" },
      ],
    );
    const [a, b, c] = graph.nodes;
    const longGap = b.x - a.x - a.width,
      shortGap = c.x - b.x - b.width;
    const width = labelSize(graph.edges[0].label).width;
    expect(longGap).toBeGreaterThanOrEqual(width + 32);
    expect(longGap).toBeLessThanOrEqual(width + 60);
    expect(shortGap).toBeLessThan(longGap - 60);
  });

  it("aligns Fetch ports through a variable-height search chain so the lines are straight", async () => {
    const graph = await layout(
      [block("research", 360), block("search"), block("index", 220)],
      [
        {
          id: "fetch",
          source: "research",
          target: "search",
          kind: "fetch",
          sourceHandle: "fetch",
        },
        {
          id: "collection",
          source: "search",
          target: "index",
          kind: "fetch",
          sourceHandle: "fetch",
          label: "Search selected collection",
        },
      ],
    );
    for (const edge of graph.edges) {
      const a = graph.nodes.find((n) => n.id === edge.source)!,
        b = graph.nodes.find((n) => n.id === edge.target)!;
      const source = {
        x: a.x + a.width,
        y: a.y + a.height / 2 - fetchPortOffset,
      };
      const target = { x: b.x, y: b.y + b.height / 2 };
      expect(Math.abs(source.y - target.y)).toBeLessThan(0.02);
      const route = routeConnection({
        source,
        target,
        sourceSide: "right",
        targetSide: "left",
        obstacles: graph.nodes,
        label: labelSize(connectionText(edge)),
      });
      expect(route.points).toHaveLength(2);
      expect(route.points[0]).toEqual(source);
      expect(route.points[1]).toEqual(target);
    }
  });

  it("places children near their caller despite a much taller main-flow block in another column", async () => {
    const graph = await layout(
      [block("main"), block("save", 1000), block("worker")],
      [
        { id: "flow", source: "main", target: "save" },
        {
          id: "call",
          source: "main",
          target: "worker",
          kind: "subagent",
          sourceHandle: "subagent",
          targetHandle: "in-top",
        },
      ],
    );
    const [main, save, worker] = graph.nodes;
    expect(worker.y - main.y - main.height).toBeGreaterThanOrEqual(96);
    expect(worker.y - main.y - main.height).toBeLessThanOrEqual(120);
    expect(worker.y).toBeLessThan(save.y + save.height);
  });

  it("keeps nested children close to their own parent instead of the tallest sibling", async () => {
    const graph = await layout(
      [block("main"), block("tall", 900), block("short"), block("nested")],
      [
        {
          id: "left",
          source: "main",
          target: "tall",
          kind: "subagent",
          sourceHandle: "subagent-left",
          targetHandle: "in-top",
        },
        {
          id: "right",
          source: "main",
          target: "short",
          kind: "subagent",
          sourceHandle: "subagent-right",
          targetHandle: "in-top",
        },
        {
          id: "nested-call",
          source: "short",
          target: "nested",
          kind: "subagent",
          sourceHandle: "subagent",
          targetHandle: "in-top",
        },
      ],
    );
    const [, tall, short, nested] = graph.nodes;
    expect(nested.y - short.y - short.height).toBeGreaterThanOrEqual(96);
    expect(nested.y - short.y - short.height).toBeLessThanOrEqual(120);
    expect(nested.y).toBeLessThan(tall.y + tall.height);
  });
});
