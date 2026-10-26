import type { ELK, ElkNode } from "elkjs/lib/elk-api.js";
import {
  type Graph,
  subagentHandles,
  fetchPortOffset,
} from "../shared/model.js";
import {
  connectionText,
  labelSize,
  labelLineSpace,
  horizontalConnectionGap,
  portAlignmentTolerance,
} from "../shared/routing.js";

/** Lay out the normal flow in each branch, then place call branches below it. */
export async function arrangeGraph(
  graph: Graph,
  elk: ELK,
  direction: "RIGHT" | "DOWN",
) {
  const result = structuredClone(graph);
  const owners = new Map(graph.nodes.map((n) => [n.id, n.id]));
  const root = (id: string): string => {
    const parent = owners.get(id)!;
    if (parent === id) return id;
    const value = root(parent);
    owners.set(id, value);
    return value;
  };
  const delegation = graph.edges.filter((e) => e.kind === "subagent");
  const linkedByCalls = (a: string, b: string) => {
    const adjacency = new Map<string, Set<string>>();
    for (const e of delegation) {
      const from = root(e.source),
        to = root(e.target);
      if (from === to) continue;
      const targets = adjacency.get(from) ?? new Set<string>();
      targets.add(to);
      adjacency.set(from, targets);
    }
    const reachable = (from: string, to: string) => {
      const pending = [from],
        seen = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!;
        if (id === to) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(...(adjacency.get(id) ?? []));
      }
      return false;
    };
    return reachable(a, b) || reachable(b, a);
  };
  for (const edge of graph.edges) {
    if (edge.kind === "subagent") continue;
    const a = root(edge.source),
      b = root(edge.target);
    // A normal return/join must not merge a delegated branch back into its
    // caller's row. Cross-branch connections are routed after node placement.
    if (a !== b && !linkedByCalls(a, b)) owners.set(b, a);
  }
  const groups = new Map<string, Graph["nodes"]>();
  for (const node of result.nodes) {
    const id = root(node.id);
    groups.set(id, [...(groups.get(id) ?? []), node]);
  }
  const calls = graph.edges.filter(
    (e) => e.kind === "subagent" && root(e.source) !== root(e.target),
  );
  const children = new Map(
    [...groups.keys()].map((id) => [
      id,
      calls.filter((e) => root(e.source) === id).map((e) => root(e.target)),
    ]),
  );

  // Collapse call cycles before ranking. Shared sub-agents are placed beneath
  // every caller; a cycle cannot impose an infinitely descending hierarchy.
  let nextIndex = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    active = new Set<string>(),
    cluster = new Map<string, number>();
  let clusterCount = 0;
  const visit = (id: string) => {
    indices.set(id, nextIndex);
    low.set(id, nextIndex++);
    stack.push(id);
    active.add(id);
    for (const child of children.get(id)!) {
      if (!indices.has(child)) {
        visit(child);
        low.set(id, Math.min(low.get(id)!, low.get(child)!));
      } else if (active.has(child))
        low.set(id, Math.min(low.get(id)!, indices.get(child)!));
    }
    if (low.get(id) === indices.get(id)) {
      let member: string;
      do {
        member = stack.pop()!;
        active.delete(member);
        cluster.set(member, clusterCount);
      } while (member !== id);
      clusterCount++;
    }
  };
  for (const id of groups.keys()) if (!indices.has(id)) visit(id);
  const ranks = new Map<number, number>();
  const rank = (id: number): number => {
    if (ranks.has(id)) return ranks.get(id)!;
    const parents = calls.filter(
      (e) =>
        cluster.get(root(e.target)) === id &&
        cluster.get(root(e.source)) !== id,
    );
    const value = Math.max(
      0,
      ...parents.map((e) => rank(cluster.get(root(e.source))!) + 1),
    );
    ranks.set(id, value);
    return value;
  };
  for (let i = 0; i < clusterCount; i++) rank(i);

  const layouts = await Promise.all(
    [...groups].map(async ([id, nodes]) => {
      const edges = graph.edges.filter(
        (e) =>
          e.kind !== "subagent" &&
          root(e.source) === id &&
          root(e.target) === id,
      );
      const labels = edges.map((e) => labelSize(connectionText(e)));
      const outgoing = new Map<string, string[]>();
      for (const edge of edges) {
        const targets = outgoing.get(edge.source) ?? [];
        targets.push(edge.target);
        outgoing.set(edge.source, targets);
      }
      const shortcut = (edge: Graph["edges"][number]) => {
        // An alternate path through other blocks identifies a long connection
        // such as loading state across several steps of the main flow.
        const pending = (outgoing.get(edge.source) ?? []).filter(
          (target) => target !== edge.target,
        );
        const seen = new Set([edge.source]);
        while (pending.length) {
          const id = pending.pop()!;
          if (id === edge.target) return true;
          if (seen.has(id)) continue;
          seen.add(id);
          pending.push(...(outgoing.get(id) ?? []));
        }
        return false;
      };
      const portId = (node: string, handle: string) =>
        JSON.stringify(["port", node, handle]);
      const shortcuts = new Set(edges.filter(shortcut).map((e) => e.id));
      const directTargets = new Map<string, Set<string>>();
      for (const edge of edges) {
        if (shortcuts.has(edge.id)) continue;
        const targets = directTargets.get(edge.source) ?? new Set<string>();
        targets.add(edge.target);
        directTargets.set(edge.source, targets);
      }
      const balanceBranches = [...directTargets.values()].some(
        (targets) => targets.size > 1,
      );
      const layout = await elk.layout<ElkNode>({
        id: `branch-${id}`,
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": direction,
          "elk.edgeRouting": "ORTHOGONAL",
          // Balance fan-out around its caller instead of aligning one extreme
          // leaf and pushing every other destination above the main flow.
          "elk.layered.nodePlacement.favorStraightEdges": balanceBranches
            ? "false"
            : "true",
          "elk.spacing.nodeNode": "60",
          // ELK puts this margin on each side of an edge label. Supplying
          // labels lets each layer reserve its own width instead of the
          // longest label expanding every gap in the branch.
          "elk.layered.spacing.nodeNodeBetweenLayers": String(
            labelLineSpace + 4,
          ),
          "elk.spacing.edgeNode": "30",
        },
        children: nodes.map((n) => ({
          id: n.id,
          width: n.width,
          height: n.height,
          layoutOptions: { "elk.portConstraints": "FIXED_POS" },
          ports: [
            ...new Set(
              edges.flatMap((e) => [
                ...(e.source === n.id
                  ? [e.sourceHandle === "fetch" ? "fetch" : "out"]
                  : []),
                ...(e.target === n.id ? [e.targetHandle] : []),
              ]),
            ),
          ].map((handle) => ({
            id: portId(n.id, handle),
            width: 0,
            height: 0,
            x:
              handle === "in" ? 0 : handle === "in-top" ? n.width / 2 : n.width,
            y:
              handle === "in-top"
                ? 0
                : n.height / 2 - (handle === "fetch" ? fetchPortOffset : 0),
            layoutOptions: {
              "elk.port.side":
                handle === "in"
                  ? "WEST"
                  : handle === "in-top"
                    ? "NORTH"
                    : "EAST",
            },
          })),
        })),
        edges: edges.map((e, i) => ({
          id: e.id,
          layoutOptions: {
            "elk.layered.priority.straightness": shortcuts.has(e.id)
              ? "0"
              : "10",
          },
          sources: [
            portId(e.source, e.sourceHandle === "fetch" ? "fetch" : "out"),
          ],
          targets: [portId(e.target, e.targetHandle)],
          labels: [
            {
              text: connectionText(e) || "\u200b",
              width: Math.max(36, labels[i].width),
              height: Math.max(1, labels[i].height),
            },
          ],
        })),
      });
      for (const placed of layout.children ?? []) {
        const node = nodes.find((n) => n.id === placed.id)!;
        node.x = placed.x ?? 0;
        node.y = placed.y ?? 0;
      }
      if (direction === "RIGHT") {
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const ordered = [...edges].sort(
          (a, b) => byId.get(a.target)!.x - byId.get(b.target)!.x,
        );
        for (const edge of ordered) {
          const source = byId.get(edge.source)!,
            target = byId.get(edge.target)!;
          if (
            target.x <= source.x ||
            nodes.some(
              (n) =>
                n.id !== source.id &&
                n.id !== target.id &&
                n.x >= source.x + source.width &&
                n.x + n.width <= target.x,
            )
          )
            continue;
          const sourceY =
            source.y +
            source.height / 2 -
            (edge.sourceHandle === "fetch" ? fetchPortOffset : 0);
          const targetY =
            target.y + (edge.targetHandle === "in-top" ? 0 : target.height / 2);
          const label = labelSize(connectionText(edge));
          const parallel = graph.edges
            .slice(0, graph.edges.indexOf(edge))
            .filter(
              (e) => e.source === edge.source && e.target === edge.target,
            ).length;
          // A bent route loses its final 36px to the horizontal port lead.
          // Reserve that lead as well as the label's visible line margins;
          // otherwise the renderer has to take an outside detour to fit it.
          const required = horizontalConnectionGap(
            label,
            Math.abs(sourceY - targetY) <= portAlignmentTolerance,
            parallel * 22,
          );
          const delta = required - (target.x - source.x - source.width);
          if (delta > 0) {
            const boundary = target.x;
            for (const n of nodes) if (n.x >= boundary) n.x += delta;
          }
        }
      }
      return {
        id,
        nodes,
        width: Math.max(
          layout.width ?? 0,
          ...nodes.map((n) => n.x + n.width + 12),
        ),
        height: layout.height ?? 0,
        rank: ranks.get(cluster.get(id)!)!,
        desired: 0,
        x: 0,
      };
    }),
  );
  const nodeById = new Map(result.nodes.map((n) => [n.id, n]));
  const placed: Graph["nodes"] = [];
  let rootY = 40;
  for (
    let level = 0;
    level <= Math.max(0, ...layouts.map((l) => l.rank));
    level++
  ) {
    const row = layouts.filter((l) => l.rank === level);
    for (const branch of row) {
      const parents = calls.filter(
        (e) =>
          root(e.target) === branch.id &&
          ranks.get(cluster.get(root(e.source))!)! < level,
      );
      branch.desired = parents.length
        ? parents.reduce((sum, e) => {
            const source = nodeById.get(e.source)!,
              target = nodeById.get(e.target)!;
            const slot = subagentHandles.indexOf(
              e.sourceHandle as (typeof subagentHandles)[number],
            );
            const fraction = [0.5, 0.32, 0.68, 0.14, 0.86][slot] ?? 0.5;
            return (
              sum +
              source.x +
              source.width * fraction -
              target.x -
              target.width / 2
            );
          }, 0) / parents.length
        : 40;
    }
    row.sort((a, b) => a.desired - b.desired);
    let right = -Infinity;
    for (const branch of row) {
      branch.x = level === 0 ? 40 : Math.max(branch.desired, right);
      right = branch.x + branch.width + 64;
    }
    const shift = row.length
      ? row.reduce((sum, b) => sum + b.desired - b.x, 0) / row.length
      : 0;
    // Independent roots retain a compact vertical stack, matching disconnected
    // blocks before the user has connected them into a flow.
    for (const branch of row) {
      const parents = calls.filter(
        (e) =>
          root(e.target) === branch.id &&
          ranks.get(cluster.get(root(e.source))!)! < level,
      );
      let y =
        level === 0
          ? rootY
          : Math.max(
              40,
              ...parents.map((e) => {
                const source = nodeById.get(e.source)!,
                  target = nodeById.get(e.target)!;
                const gap = Math.max(
                  104,
                  labelSize(connectionText(e)).height + labelLineSpace * 2 + 16,
                );
                return source.y + source.height + gap - target.y;
              }),
            );
      // Only blocks in this branch's columns can push it farther down. A tall
      // unrelated sibling (or a lower row of the main flow) must not do so.
      while (true) {
        let nextY = y;
        for (const n of branch.nodes)
          for (const other of placed) {
            const x = n.x + branch.x + shift;
            if (
              x < other.x + other.width + 24 &&
              x + n.width + 24 > other.x &&
              n.y + y < other.y + other.height + 32 &&
              n.y + y + n.height + 32 > other.y
            )
              nextY = Math.max(nextY, other.y + other.height + 32 - n.y);
          }
        if (nextY === y) break;
        y = nextY;
      }
      for (const n of branch.nodes) {
        n.x += branch.x + shift;
        n.y += y;
      }
      placed.push(...branch.nodes);
      if (level === 0) rootY = y + branch.height + 64;
    }
  }
  const left = Math.min(...result.nodes.map((n) => n.x));
  for (const node of result.nodes) {
    node.x = Math.round((node.x - left + 40) * 100) / 100;
    node.y = Math.round(node.y * 100) / 100;
  }
  // Arrange is the explicit way to discard manual pins and get a fresh route.
  for (const edge of result.edges) delete edge.waypoints;
  return result;
}
