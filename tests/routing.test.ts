import { describe, expect, it } from "vitest";
import { routeConnections, sharedLength, type RouteInput } from "../src/shared/routing.js";
import { labelSize, moveSegment, placeLabel, roundedPath, routeConnection, segmentClear, labelLineSpace, minimumLabelLineSpace, type Obstacle, type Point } from "../src/shared/routing.js";

const nodes: Obstacle[] = [
  { x: 0, y: 0, width: 240, height: 160 },
  { x: 800, y: 0, width: 240, height: 160 },
];
const overlaps = (a: Obstacle, b: Obstacle) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function verify(route: ReturnType<typeof routeConnection>, obstacles: Obstacle[], text: string) {
  expect(route.points.length).toBeGreaterThan(1);
  for (let i = 1; i < route.points.length; i++) {
    expect(segmentClear(route.points[i - 1], route.points[i], obstacles)).toBe(true);
  }
  // Check the rendered corner curves as well as their orthogonal skeleton.
  const tokens = roundedPath(route.points, route.radius).match(/[MLQ]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!;
  let point = route.points[0];
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++];
    const end = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
    if (command === "Q") {
      const target = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
      for (let j = 1; j < 20; j++) {
        const t = j / 20, u = 1 - t;
        const p = { x: u * u * point.x + 2 * u * t * end.x + t * t * target.x, y: u * u * point.y + 2 * u * t * end.y + t * t * target.y };
        expect(obstacles.some((n) => p.x > n.x && p.x < n.x + n.width && p.y > n.y && p.y < n.y + n.height)).toBe(false);
      }
      point = target;
    } else point = end;
  }
  const size = labelSize(text), label = { x: route.label.x - size.width / 2, y: route.label.y - size.height / 2, ...size };
  expect(obstacles.some((n) => overlaps(n, label))).toBe(false);
  const a = route.points[route.label.segment], b = route.points[route.label.segment + 1];
  const horizontal = a.y === b.y;
  const at = horizontal ? route.label.x : route.label.y;
  const half = (horizontal ? size.width : size.height) / 2;
  expect(at - half - Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y)).toBeGreaterThanOrEqual(minimumLabelLineSpace - 0.001);
  expect(Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y) - at - half).toBeGreaterThanOrEqual(minimumLabelLineSpace - 0.001);
}
const route = (obstacles = nodes, text = "Request working context", extra: Partial<Parameters<typeof routeConnection>[0]> = {}) => routeConnection({
  source: { x: 240, y: 80 }, target: { x: 800, y: 80 }, sourceSide: "right", targetSide: "left", obstacles, label: labelSize(text), ...extra,
});

describe("obstacle-aware connections", () => {
  it("allows converging calls to share their destination track without bending a clear straight call", () => {
    const obstacles = [
      { x:956,y:312,width:300,height:200 },
      { x:918.5,y:974,width:375,height:289 },
      { x:712.5,y:616,width:349,height:254 },
      { x:1149.5,y:616,width:351,height:220 },
    ];
    const inputs = [
      {id:"main",source:{x:1106,y:516}},
      {id:"review",source:{x:887,y:874}},
      {id:"author",source:{x:1325,y:840}},
    ].map(input => ({...input,target:{x:1106,y:970},sourceSide:"bottom" as const,targetSide:"top" as const,obstacles,label:labelSize("Sub-agent call")}));
    const routes=routeConnections(inputs);
    expect(routes.get("main")!.points).toEqual([inputs[0].source,inputs[0].target]);
    expect(sharedLength(routes.get("main")!.points,routes.get("review")!.points)).toBeGreaterThan(36);
    for (const input of inputs) {
      expect(routes.get(input.id)).toEqual(routeConnection(input));
      verify(routes.get(input.id)!,obstacles,"Sub-agent call");
    }
    expect(routeConnections([...inputs].reverse())).toEqual(routes);
    const identified=inputs.map(input=>({...input,targetKey:"research:top"}));
    expect(routeConnections(identified)).toEqual(routes);
    // Coincident coordinates alone must not merge different blocks or ports.
    for (const key of ["another-block:top","research:another-port"]) {
      const separate=routeConnections(identified.map(input=>({...input,targetKey:input.id === "main" ? key : input.targetKey})));
      expect(separate.get("main")!.points).not.toEqual(routes.get("main")!.points);
      expect(sharedLength(separate.get("main")!.points,separate.get("review")!.points)).toBeLessThanOrEqual(36);
    }
  });
  it("separates shared horizontal and vertical tracks without penalizing perpendicular crossings", () => {
    for (const [a,b] of [
      [{x:0,y:80},{x:0,y:110}],
      [{x:0,y:80},{x:0,y:80}],
    ]) {
      const inputs = [
        {id:"a",source:a,target:{x:600,y:240}},
        {id:"b",source:b,target:{x:800,y:300}},
      ].map(input => ({...input,sourceSide:"right" as const,targetSide:"left" as const,obstacles:[],label:labelSize("Next")}));
      // Force the vertical example to use a common target-column track.
      if (b.y === 110) inputs[1].target.x=600;
      expect(sharedLength(routeConnection(inputs[0]).points, routeConnection(inputs[1]).points)).toBeGreaterThan(80);
      const routes = routeConnections(inputs);
      // A common output may share its fixed port stem, then must split.
      expect(sharedLength(routes.get("a")!.points,routes.get("b")!.points)).toBeLessThanOrEqual(b.y === 80 ? 36 : 1);
      expect(routeConnections([...inputs].reverse())).toEqual(routes);
      for (const input of inputs) {
        const result=routes.get(input.id)!;
        expect(result.points[0]).toEqual(input.source);
        expect(result.points.at(-1)).toEqual(input.target);
        expect(result.points.length).toBeLessThan(9);
      }
    }
    const crossing: (RouteInput & {id:string})[] = [
      {id:"horizontal",source:{x:0,y:150},target:{x:600,y:150},sourceSide:"right",targetSide:"left",obstacles:[],label:labelSize("")},
      {id:"vertical",source:{x:300,y:0},target:{x:300,y:300},sourceSide:"bottom",targetSide:"top",obstacles:[],label:labelSize("")},
    ];
    const routes=routeConnections(crossing);
    for (const input of crossing) expect(routes.get(input.id)!.points).toEqual(routeConnection(input).points);
  });

  it("preserves user pins, shares only a short common-port stem, and keeps alternatives outside blocks", () => {
    const obstacles=[...nodes,{x:420,y:0,width:100,height:200}];
    const inputs: (RouteInput & {id:string})[] = [
      {id:"manual",source:{x:240,y:80},target:{x:800,y:80},sourceSide:"right",targetSide:"left",obstacles,label:labelSize("Pinned"),waypoints:[{x:300,y:300},{x:700,y:300}]},
      {id:"auto",source:{x:240,y:80},target:{x:800,y:80},sourceSide:"right",targetSide:"left",obstacles,label:labelSize("Automatic")},
    ];
    const routes=routeConnections(inputs);
    expect(routes.get("manual")).toEqual(routeConnection(inputs[0]));
    for (const input of inputs) verify(routes.get(input.id)!,obstacles,input.id === "manual" ? "Pinned" : "Automatic");
    expect(sharedLength(routes.get("manual")!.points,routes.get("auto")!.points)).toBeLessThanOrEqual(72);
  });

  it("keeps a safe short route in a congested corridor when separating tracks would require a large detour", () => {
    const obstacles=[...nodes,{x:260,y:-200,width:520,height:255},{x:260,y:105,width:520,height:300}];
    const input={source:{x:240,y:80},target:{x:800,y:80},sourceSide:"right" as const,targetSide:"left" as const,obstacles,label:labelSize("Go")};
    const baseline=routeConnection(input);
    const result=routeConnection({...input,occupied:[baseline.points]});
    verify(result,obstacles,"Go");
    expect(result.points).toEqual(baseline.points);
    expect(result.points).toHaveLength(2);
  });

  it("routes around intervening blocks and reserves visible line around its label", () => {
    const obstacles = [...nodes, { x: 420, y: -50, width: 200, height: 300 }];
    const result = route(obstacles);
    verify(result, obstacles, "Request working context");
    expect(result.points.some((p) => p.y < -50 || p.y > 250)).toBe(true);
    expect(roundedPath(result.points)).toContain("Q");
  });

  it("keeps labels clear of blocks alongside an otherwise unobstructed vertical line", () => {
    const obstacles = [{ x: 0, y: 0, width: 240, height: 160 }, { x: 0, y: 500, width: 240, height: 160 },
      { x: 140, y: 240, width: 200, height: 180 }];
    const text = "A wider label beside this branch";
    const result = route(obstacles, text, { source: { x: 120, y: 160 }, target: { x: 120, y: 500 }, sourceSide: "bottom", targetSide: "top" });
    verify(result, obstacles, text);
  });

  it("reserves a clear route for multiline and maximum-length labels", () => {
    for (const text of ["Request context\nwith citations and validation", "W".repeat(1000)]) {
      const obstacles = [...nodes, { x: 350, y: -100, width: 300, height: 380 }];
      verify(route(obstacles, text), obstacles, text);
    }
  });

  it("routes self loops outside their own block and separates parallel connections", () => {
    const loop = route([nodes[0]], "Retry", { target: { x: 0, y: 80 } });
    verify(loop, [nodes[0]], "Retry");
    expect(route(nodes, "Fetch").points).not.toEqual(route(nodes, "Fetch", { offset: 22 }).points);
  });

  it("retains manual bends while rerouting around a block moved onto a saved pin", () => {
    const pins = [{ x: 300, y: 350 }, { x: 700, y: 350 }];
    const first = route(nodes, "Context", { waypoints: pins });
    expect(first.points).toContainEqual(pins[0]);
    expect(first.points.some((p, i) => i > 0 && p.y === pins[1].y && first.points[i - 1].y === p.y && first.points[i - 1].x <= pins[1].x && p.x >= pins[1].x)).toBe(true);
    const obstacles = [...nodes, { x: 280, y: 300, width: 200, height: 160 }];
    verify(route(obstacles, "Context", { waypoints: pins }), obstacles, "Context");
  });

  it("moves a straight segment without moving its ports", () => {
    const points: Point[] = [{ x: 240, y: 80 }, { x: 800, y: 80 }];
    const pins = moveSegment(points, 0, { x: 500, y: 220 });
    expect(pins).toContainEqual({ x: 276, y: 220 });
    expect(pins).not.toContainEqual(points[0]);
    expect(pins).not.toContainEqual(points[1]);
    const result = route(nodes, "Context", { waypoints: pins });
    verify(result, nodes, "Context");
    expect(result.points[0]).toEqual(points[0]);
    expect(result.points.at(-1)).toEqual(points[1]);
  });

  it("chooses a free part of a segment when its midpoint would cover a block", () => {
    const label = placeLabel([{ x: 0, y: 0 }, { x: 0, y: 700 }], { width: 180, height: 20 }, [
      { x: 40, y: 270, width: 200, height: 200 },
    ])!;
    expect(label).toBeDefined();
    expect(label.y < 260 || label.y > 480).toBe(true);
  });

  it("uses a narrow clear exit when a nearby block obstructs the usual port lead", () => {
    for (const x of [270, 248]) {
      const obstacles = [...nodes, { x, y: -20, width: 200, height: 240 }];
      verify(route(obstacles, "Context"), obstacles, "Context");
    }
  });

  it("keeps almost-aligned ports straight despite fractional browser measurements", () => {
    const text = "Search selected collection";
    const obstacles = [{ x: 0, y: 0, width: 240, height: 180 }, { x: 460, y: -15.9999, width: 240, height: 160 }];
    const result = route(obstacles, text, { source: { x: 240, y: 64 }, target: { x: 460, y: 64.0001 } });
    verify(result, obstacles, text);
    expect(result.points.every((p) => Math.abs(p.y - 64) < 0.001)).toBe(true);
    expect(result.points.length).toBeLessThanOrEqual(3);
  });

  it("ignores subpixel overlap at measured port borders when fitting a horizontal label", () => {
    const obstacles = [{ x: 0, y: 0, width: 240, height: 180 }, { x: 460, y: -16, width: 240, height: 160 }];
    const result = route(obstacles, "Search selected collection", { source: { x: 239.95, y: 64 }, target: { x: 460.05, y: 64.0001 } });
    expect(result.points.length).toBeLessThanOrEqual(3);
    expect(result.points.every((p) => Math.abs(p.y - 64) < 0.001)).toBe(true);
    expect(Math.abs(result.label.y - 64)).toBeLessThan(0.001);
  });

  it("does not turn a fractionally short label span into a loop", () => {
    for (const text of ["Fetch", "Supply routing context", "Search selected collection"]) {
      const size = labelSize(text), span = size.width + labelLineSpace * 2;
      const source = { x: 244.0002, y: 80 }, target = { x: 244 + span, y: 80.0001 };
      const obstacles = [{ x: 0, y: 0, width: 240, height: 160 }, { x: target.x + 4, y: 0.0001, width: 240, height: 160 }];
      const result = routeConnection({ source, target, sourceSide: "right", targetSide: "left", obstacles, label: size });
      expect(result.points.every((p) => Math.abs(p.y - 80) < 0.001)).toBe(true);
    }
  });

  it("does not retrace the label span when a short connection needs a detour", () => {
    const text = "Search selected collection";
    const obstacles = [{ x: 0, y: 0, width: 240, height: 180 }, { x: 410, y: 0, width: 240, height: 180 }];
    const result = route(obstacles, text, { source: { x: 240, y: 64 }, target: { x: 410, y: 90 } });
    verify(result, obstacles, text);
    for (let i = 1; i < result.points.length - 1; i++) {
      const a = result.points[i - 1], b = result.points[i], c = result.points[i + 1];
      expect(a.y === b.y && b.y === c.y && (b.x - a.x) * (c.x - b.x) < 0).toBe(false);
      expect(a.x === b.x && b.x === c.x && (b.y - a.y) * (c.y - b.y) < 0).toBe(false);
    }
  });
});
