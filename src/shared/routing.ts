import type { FlowEdge } from "./model.js";

export type Point = { x: number; y: number };
export type Obstacle = Point & { width: number; height: number; id?: string };
export type LabelSize = { width: number; height: number };
export type RouteInput = {
  source: Point;
  target: Point;
  sourceSide: "right" | "bottom";
  targetSide: "left" | "top";
  obstacles: Obstacle[];
  label: LabelSize;
  waypoints?: Point[];
  offset?: number;
  occupied?: Point[][];
};
type Segment = [Point, Point];
const laneSpacing = 18;
const segments = (points: Point[]): Segment[] =>
  points.slice(1).map((p, i) => [points[i], p]);
/** Parallel shared length; perpendicular crossings have no cost. */
export function sharedLength(a: Point[], b: Point[], separation = 1) {
  return segments(a).reduce(
    (sum, [p, q]) =>
      sum +
      segments(b).reduce((part, [r, s]) => {
        const horizontal = p.y === q.y;
        if (horizontal !== (r.y === s.y)) return part;
        const apart = Math.abs(horizontal ? p.y - r.y : p.x - r.x);
        if (apart >= separation) return part;
        const overlap = horizontal
          ? Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) -
            Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x))
          : Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) -
            Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y));
        return part + Math.max(0, overlap);
      }, 0),
    0,
  );
}
const pathLength = (points: Point[]) =>
  points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);
const trafficCost = (points: Point[], occupied: Point[][]) =>
  occupied.reduce((sum, path) => sum + sharedLength(points, path, 12) * 8, 0);
const routeCost = (points: Point[], occupied: Point[][]) =>
  pathLength(points) +
  Math.max(0, points.length - 2) * 20 +
  trafficCost(points, occupied);
type Box = { left: number; right: number; top: number; bottom: number };
export const lineClearance = 24;
export const labelLineSpace = 16;
export const minimumLabelLineSpace = 8;
export const portLead = 36;
export const portAlignmentTolerance = 2;

/** Budget used by Arrange for the same port leads drawn by the router. */
export function horizontalConnectionGap(
  label: LabelSize,
  aligned: boolean,
  offset = 0,
) {
  const reserve = offset
    ? 2 * (portLead + offset) + 12
    : aligned
      ? 12
      : portLead + 12;
  return Math.max(portLead * 2 + 4, label.width + labelLineSpace * 2 + reserve);
}

export function connectionText(edge: Pick<FlowEdge, "label" | "kind">) {
  return (
    edge.label ||
    (edge.kind === "fetch"
      ? "Fetch"
      : edge.kind === "subagent"
        ? "Sub-agent call"
        : "")
  );
}

// Conservative font bounds are also available to Arrange on the server. The
// browser refines both dimensions using the rendered label, including wrapping.
export function labelSize(text: string): LabelSize {
  if (!text) return { width: 0, height: 0 };
  const lines = text.split("\n");
  const widths = lines.map((line) =>
    [...line].reduce(
      (sum, ch) =>
        sum +
        (/[ilI.,'!| :;]/.test(ch)
          ? 4
          : /[MW@#%\u0080-\uffff]/.test(ch)
            ? 10
            : 6),
      0,
    ),
  );
  const width = Math.min(180, Math.max(24, Math.max(...widths) + 12));
  return {
    width,
    height:
      widths.reduce(
        (sum, w) => sum + Math.max(1, Math.ceil(w / (width - 10))),
        0,
      ) *
        12 +
      6,
  };
}

const box = (n: Obstacle, pad = lineClearance): Box => ({
  left: n.x - pad,
  right: n.x + n.width + pad,
  top: n.y - pad,
  bottom: n.y + n.height + pad,
});
const inside = (p: Point, b: Box) =>
  p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom;
export function segmentClear(
  a: Point,
  b: Point,
  obstacles: Obstacle[],
  padding = 0,
) {
  return clear(
    a,
    b,
    obstacles.map((n) => box(n, padding)),
  );
}
function clear(a: Point, b: Point, boxes: Box[]) {
  if (a.x !== b.x && a.y !== b.y) return false;
  return !boxes.some((r) =>
    a.y === b.y
      ? a.y > r.top &&
        a.y < r.bottom &&
        Math.max(a.x, b.x) > r.left &&
        Math.min(a.x, b.x) < r.right
      : a.x > r.left &&
        a.x < r.right &&
        Math.max(a.y, b.y) > r.top &&
        Math.min(a.y, b.y) < r.bottom,
  );
}
const equal = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const distance = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export function simplify(points: Point[]) {
  const result: Point[] = [];
  for (const point of points) {
    if (result.length && equal(result.at(-1)!, point)) continue;
    while (result.length > 1) {
      const a = result.at(-2)!,
        b = result.at(-1)!;
      if (
        (a.x === b.x &&
          b.x === point.x &&
          (b.y - a.y) * (point.y - b.y) >= 0) ||
        (a.y === b.y && b.y === point.y && (b.x - a.x) * (point.x - b.x) >= 0)
      )
        result.pop();
      else break;
    }
    result.push(point);
  }
  return result;
}

// A small priority queue keeps obstacle routing responsive while blocks move.
class Queue {
  items: { key: number; cost: number }[] = [];
  push(item: { key: number; cost: number }) {
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].cost <= item.cost) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0],
      last = this.items.pop()!;
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (
          child + 1 < this.items.length &&
          this.items[child + 1].cost < this.items[child].cost
        )
          child++;
        if (last.cost <= this.items[child].cost) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

function findPath(
  start: Point,
  end: Point,
  boxes: Box[],
  verticalFirst = false,
  occupied: Point[][] = [],
): Point[] {
  if (equal(start, end)) return [start];
  const candidates = [
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
  ];
  if (verticalFirst) candidates.reverse();
  const simple = candidates.find(
    (points) =>
      points.slice(1).every((p, i) => clear(points[i], p, boxes)) &&
      !trafficCost(points, occupied),
  );
  if (simple) return simplify(simple);
  const traffic = occupied.flatMap(segments);
  const xs = [
    ...new Set([
      start.x,
      end.x,
      ...boxes.flatMap((b) => [b.left, b.right]),
      ...traffic
        .filter(([a, b]) => a.x === b.x)
        .flatMap(([a]) => [a.x - laneSpacing, a.x + laneSpacing]),
    ]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([
      start.y,
      end.y,
      ...boxes.flatMap((b) => [b.top, b.bottom]),
      ...traffic
        .filter(([a, b]) => a.y === b.y)
        .flatMap(([a]) => [a.y - laneSpacing, a.y + laneSpacing]),
    ]),
  ].sort((a, b) => a - b);
  const columns = xs.length;
  const point = (key: number): Point => {
    const cell = Math.floor(key / 2);
    return { x: xs[cell % columns], y: ys[Math.floor(cell / columns)] };
  };
  const first = (ys.indexOf(start.y) * columns + xs.indexOf(start.x)) * 2;
  const costs = new Map<number, number>([
    [first, 0],
    [first + 1, 0],
  ]);
  const previous = new Map<number, number>();
  const queue = new Queue();
  queue.push({ key: first, cost: distance(start, end) });
  queue.push({ key: first + 1, cost: distance(start, end) });
  while (queue.items.length) {
    const entry = queue.pop();
    const p = point(entry.key),
      cost = costs.get(entry.key)!;
    if (entry.cost > cost + distance(p, end)) continue;
    if (equal(p, end)) {
      const path = [p];
      let key = entry.key;
      while (previous.has(key)) {
        key = previous.get(key)!;
        path.push(point(key));
      }
      return simplify(path.reverse());
    }
    const cell = Math.floor(entry.key / 2),
      x = cell % columns,
      y = Math.floor(cell / columns);
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      if (x + dx < 0 || x + dx >= columns || y + dy < 0 || y + dy >= ys.length)
        continue;
      const direction = dx ? 0 : 1;
      const key = ((y + dy) * columns + x + dx) * 2 + direction;
      const next = point(key);
      if (!clear(p, next, boxes)) continue;
      const candidate =
        cost +
        distance(p, next) +
        (entry.key % 2 === direction ? 0 : 20) +
        trafficCost([p, next], occupied);
      if (candidate >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, candidate);
      previous.set(key, entry.key);
      queue.push({ key, cost: candidate + distance(next, end) });
    }
  }
  // Ports enclosed by overlapping blocks have no unobstructed exit.
  return [];
}

export function placeLabel(
  points: Point[],
  size: LabelSize,
  obstacles: Obstacle[],
  lineSpace = labelLineSpace,
) {
  let best: (Point & { segment: number; score: number }) | undefined;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1],
      horizontal = a.y === b.y;
    const half = (horizontal ? size.width : size.height) / 2;
    const low =
      Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y) +
      half +
      lineSpace;
    const high =
      Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y) -
      half -
      lineSpace;
    // SVG handle coordinates vary slightly with canvas zoom. An exact-fit
    // span must not become a whole-canvas detour over a fraction of a pixel.
    if (low > high + 0.25) continue;
    let intervals =
      low > high ? [[(low + high) / 2, (low + high) / 2]] : [[low, high]];
    for (const n of obstacles) {
      const r = {
        left: n.x - size.width / 2 - 10,
        right: n.x + n.width + size.width / 2 + 10,
        top: n.y - size.height / 2 - 10,
        bottom: n.y + n.height + size.height / 2 + 10,
      };
      if (
        horizontal
          ? a.y <= r.top || a.y >= r.bottom
          : a.x <= r.left || a.x >= r.right
      )
        continue;
      const from = horizontal ? r.left : r.top,
        to = horizontal ? r.right : r.bottom;
      intervals = intervals.flatMap(([l, h]) =>
        to <= l || from >= h
          ? [[l, h]]
          : [...(l < from ? [[l, from]] : []), ...(to < h ? [[to, h]] : [])],
      );
    }
    for (const [l, h] of intervals) {
      const middle = (low + high) / 2,
        at = Math.max(l, Math.min(h, middle));
      const score =
        distance(a, b) - Math.abs(at - middle) - (horizontal ? 0 : 30);
      if (!best || score > best.score)
        best = {
          x: horizontal ? at : a.x,
          y: horizontal ? a.y : at,
          segment: i,
          score,
        };
    }
  }
  return best;
}

export function routeConnection(input: RouteInput) {
  const { source, target, obstacles, label } = input;
  let clearance = lineClearance;
  let boxes = obstacles.map((n) => box(n));
  const reach = portLead + (input.offset ?? 0);
  const stubs = (length: number) => ({
    start:
      input.sourceSide === "bottom"
        ? { x: source.x, y: source.y + length }
        : { x: source.x + length, y: source.y },
    end:
      input.targetSide === "top"
        ? { x: target.x, y: target.y - length }
        : { x: target.x - length, y: target.y },
  });
  let { start, end } = stubs(reach);
  const project = (p: Point) => {
    let result = { ...p };
    // A block can move onto a saved pin. Move that pin to a free boundary.
    for (let pass = 0; pass <= boxes.length; pass++) {
      const hit = boxes.find((b) => inside(result, b));
      if (!hit) return result;
      const candidates = [
        { x: hit.left, y: result.y },
        { x: hit.right, y: result.y },
        { x: result.x, y: hit.top },
        { x: result.x, y: hit.bottom },
      ];
      candidates.sort(
        (a, b) =>
          Number(boxes.some((r) => inside(a, r))) -
            Number(boxes.some((r) => inside(b, r))) ||
          distance(a, p) - distance(b, p),
      );
      result = candidates[0];
    }
    return result;
  };
  const join = (
    pins: Point[],
    verticalFirst = false,
    occupied: Point[][] = [],
  ) => {
    const result = [source];
    for (let i = 1; i < pins.length; i++) {
      const part = findPath(
        pins[i - 1],
        pins[i],
        boxes,
        verticalFirst,
        occupied,
      );
      if (!part.length) return [];
      result.push(...part);
    }
    return simplify([...result, target]);
  };
  const offset = (input.offset ?? 0) * 2;
  const makePins = () => {
    const lane =
      offset && !input.waypoints?.length
        ? input.sourceSide === "bottom"
          ? [
              { x: start.x + offset, y: start.y },
              { x: end.x + offset, y: end.y },
            ]
          : [
              { x: start.x, y: start.y - offset },
              { x: end.x, y: end.y - offset },
            ]
        : [];
    return [
      start,
      ...(input.waypoints?.length ? input.waypoints : lane).map(project),
      end,
    ];
  };
  let pins = makePins();
  let points = join(pins);
  if (
    input.sourceSide === "right" &&
    input.targetSide === "left" &&
    source.x < target.x &&
    Math.abs(source.y - target.y) <= portAlignmentTolerance &&
    !input.waypoints?.length &&
    !input.offset
  ) {
    // Browser measurements can differ by a fraction of a pixel even when
    // Arrange aligned the ports. Keep the long straight span in that case.
    const aligned = simplify([source, { x: target.x, y: source.y }, target]);
    // Handles are measured from the DOM while obstacles come from model
    // bounds. Ignore subpixel overlap with the two port borders themselves;
    // it must not turn a straight connector into an outside label detour.
    const borders = obstacles.map((n) =>
      box(
        n,
        (Math.abs(source.x - n.x - n.width) <= 1 &&
          source.y >= n.y &&
          source.y <= n.y + n.height) ||
          (Math.abs(target.x - n.x) <= 1 &&
            target.y >= n.y &&
            target.y <= n.y + n.height)
          ? -1
          : 0,
      ),
    );
    if (aligned.slice(1).every((p, i) => clear(aligned[i], p, borders)))
      points = aligned;
  }
  const actualBoxes = obstacles.map((n) => box(n, -1));
  for (const padding of [8, 2]) {
    if (
      points.length &&
      clear(source, start, actualBoxes) &&
      clear(end, target, actualBoxes)
    )
      break;
    // Tight manually positioned blocks may not have the usual 24px margin.
    // Keep the path outside their bodies while reducing only that margin.
    boxes = obstacles.map((n) => box(n, padding));
    clearance = padding;
    ({ start, end } = stubs(padding + 4));
    pins = makePins();
    points = join(pins);
  }
  let position = placeLabel(points, label, obstacles);
  if (label.width && !position) {
    // Both L-shaped routes can be equally short, but only one may have a
    // clear span for the label. Try the other elbow before leaving the gap.
    const alternate = join(pins, true);
    const placed = placeLabel(alternate, label, obstacles);
    if (placed) {
      points = alternate;
      position = placed;
    }
  }
  if (label.width && !position) {
    // Saved diagrams may predate Arrange's spacing budget. Keep a smaller,
    // still-visible line margin instead of forcing an otherwise clear label
    // into an outside loop just to preserve the preferred 16px margin.
    for (const candidate of [points, join(pins, true)]) {
      const placed = placeLabel(
        candidate,
        label,
        obstacles,
        minimumLabelLineSpace,
      );
      if (placed) {
        points = candidate;
        position = placed;
        break;
      }
    }
  }
  if (label.width && !position) {
    // Reserve a horizontal label runway outside the blocks when all shorter
    // routes lack room. This also handles very long and multiline labels.
    const width = label.width + labelLineSpace * 2;
    const ys = [
      Math.min(start.y, end.y, ...boxes.map((b) => b.top)) -
        label.height / 2 -
        16,
      Math.max(start.y, end.y, ...boxes.map((b) => b.bottom)) +
        label.height / 2 +
        16,
    ];
    let bestLength = Infinity;
    for (const y of ys) {
      const extra = Math.max(0, width - Math.abs(end.x - start.x)) / 2;
      const left = Math.min(start.x, end.x) - extra,
        right = Math.max(start.x, end.x) + extra;
      const a = { x: start.x <= end.x ? left : right, y },
        b = { x: start.x <= end.x ? right : left, y };
      // Enter and leave the label span vertically. A horizontal return from
      // its far end would retrace the line and leave a spur past the label.
      const towardBlocks =
        Math.sign((start.y + end.y) / 2 - y) * (label.height / 2 + 8);
      const candidate = join([
        start,
        ...pins.slice(1, -1),
        { x: a.x, y: y + towardBlocks },
        a,
        b,
        { x: b.x, y: y + towardBlocks },
        end,
      ]);
      const placed = placeLabel(candidate, label, obstacles);
      const length = candidate
        .slice(1)
        .reduce((sum, p, i) => sum + distance(candidate[i], p), 0);
      if (placed && length < bestLength) {
        points = candidate;
        position = placed;
        bestLength = length;
      }
    }
  }
  if (!points.length)
    points = [source, start, { x: start.x, y: end.y }, end, target];
  if (
    input.occupied?.length &&
    !input.waypoints?.length &&
    trafficCost(points, input.occupied) > 1
  ) {
    const candidate = join(pins, false, input.occupied);
    const placed =
      placeLabel(candidate, label, obstacles) ??
      placeLabel(candidate, label, obstacles, minimumLabelLineSpace);
    // Avoid shared tracks when a modest local detour is enough. Congested
    // diagrams may keep an overlap; do not create a whole-canvas loop for it.
    if (
      candidate.length &&
      (!label.width || placed) &&
      pathLength(candidate) <=
        pathLength(points) + Math.max(96, pathLength(points) * 0.25) &&
      routeCost(candidate, input.occupied) < routeCost(points, input.occupied)
    ) {
      points = candidate;
      position = placed;
    }
  }
  return {
    points,
    radius: Math.min(10, clearance),
    label: position ?? {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
      segment: 1,
    },
  };
}

type RoutedConnection = RouteInput & {
  id: string;
  /** Stable node-and-port identity; isolated callers may use geometry instead. */
  targetKey?: string;
};
function sameDestination(a: RoutedConnection, b: RoutedConnection) {
  if (a.targetKey !== undefined || b.targetKey !== undefined)
    return a.targetKey !== undefined && a.targetKey === b.targetKey;
  return a.targetSide === b.targetSide && distance(a.target, b.target) <= 2;
}

/** Connections converging on the same destination may share tracks. For
 * different destinations, pinned and neighboring routes get first choice. */
export function routeConnections(inputs: RoutedConnection[]) {
  const routes = new Map<string, ReturnType<typeof routeConnection>>();
  const ordered = [...inputs].sort(
    (a, b) =>
      Number(!!b.waypoints?.length) - Number(!!a.waypoints?.length) ||
      distance(a.source, a.target) - distance(b.source, b.target) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const input of ordered) {
    const occupied = ordered
      .filter((other) => routes.has(other.id) && !sameDestination(input, other))
      .map((other) => {
        const points = routes.get(other.id)!.points.map((p) => ({ ...p }));
        // Edges using the same port necessarily share a short stem. Reserve
        // the rest of their route, including long horizontal AND vertical runs.
        if (points.length > 1 && distance(input.source, other.source) <= 2) {
          const [a, b] = points;
          const amount = Math.min(portLead, distance(a, b));
          a.x += Math.sign(b.x - a.x) * amount;
          a.y += Math.sign(b.y - a.y) * amount;
        }
        if (points.length > 1 && distance(input.target, other.target) <= 2) {
          const a = points.at(-1)!,
            b = points.at(-2)!;
          const amount = Math.min(portLead, distance(a, b));
          a.x += Math.sign(b.x - a.x) * amount;
          a.y += Math.sign(b.y - a.y) * amount;
        }
        return simplify(points);
      });
    routes.set(input.id, routeConnection({ ...input, occupied }));
  }
  return routes;
}

export function roundedPath(points: Point[], radius = 10) {
  if (!points.length) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1];
    const r = Math.min(radius, distance(a, b) / 2, distance(b, c) / 2);
    const before = {
      x: b.x + Math.sign(a.x - b.x) * r,
      y: b.y + Math.sign(a.y - b.y) * r,
    };
    const after = {
      x: b.x + Math.sign(c.x - b.x) * r,
      y: b.y + Math.sign(c.y - b.y) * r,
    };
    path += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  const end = points.at(-1)!;
  return `${path} L ${end.x} ${end.y}`;
}

/** Shift a segment perpendicular to itself without moving either port. */
export function moveSegment(points: Point[], index: number, position: Point) {
  const a = { ...points[index] },
    b = { ...points[index + 1] };
  const horizontal = a.y === b.y;
  if (index === 0) {
    a.x += Math.sign(b.x - a.x) * Math.min(portLead, distance(a, b) / 4);
    a.y += Math.sign(b.y - a.y) * Math.min(portLead, distance(a, b) / 4);
  }
  if (index === points.length - 2) {
    b.x += Math.sign(a.x - b.x) * Math.min(portLead, distance(a, b) / 4);
    b.y += Math.sign(a.y - b.y) * Math.min(portLead, distance(a, b) / 4);
  }
  const movedA = horizontal
    ? { x: a.x, y: position.y }
    : { x: position.x, y: a.y };
  const movedB = horizontal
    ? { x: b.x, y: position.y }
    : { x: position.x, y: b.y };
  return simplify([
    ...points.slice(1, index),
    ...(index === 0 ? [a] : []),
    movedA,
    movedB,
    ...(index === points.length - 2 ? [b] : []),
    ...points.slice(index + 2, -1),
  ]);
}
