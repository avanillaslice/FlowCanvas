import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  createContext,
  useContext,
  memo,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  NodeResizer,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  useUpdateNodeInternals,
  BaseEdge,
  EdgeLabelRenderer,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import {
  Bot,
  GitBranch,
  Database,
  Workflow,
  Monitor,
  Users,
  Scan,
  ZoomIn,
  ZoomOut,
  Copy,
  Trash2,
  Plus,
  ArrowDownRight,
  FoldVertical,
} from "lucide-react";
import {
  blockNames,
  blockTypes,
  subagentHandles,
  fetchPortOffset,
  isSubagentHandle,
  type Block,
  type Graph,
  type Operation,
} from "../shared/model.js";
import {
  connectionText,
  labelSize,
  routeConnection,
  routeConnections,
  roundedPath,
  moveSegment,
  type Point,
  type Obstacle,
  type LabelSize,
} from "../shared/routing.js";
const icons = {
  interface: Monitor,
  agent: Bot,
  subagent: Users,
  process: Workflow,
  decision: GitBranch,
  store: Database,
};
const EditContext = createContext<{
  editable: boolean;
  change: (ops: Operation[], deferSave?: boolean) => void;
  commit: () => void;
}>({ editable: false, change: () => {}, commit: () => {} });
type BlockNode = Node<{ block: Block; subagentCalls: string[] }, "block">;
const RoutingContext = createContext<{
  routes: Map<string, ReturnType<typeof routeConnection>>;
  obstacles: Obstacle[];
  measure: (id: string, text: string, size: LabelSize) => void;
}>({ routes: new Map(), obstacles: [], measure: () => {} });
function useBlockField(value: string, block: Block) {
  const [localValue, setLocalValue] = useState(value);
  const pending = useRef<string[]>([]);
  const lastModelValue = useRef(value);
  useEffect(() => {
    const echoed = pending.current.lastIndexOf(value);
    if (echoed >= 0) {
      // A graph update can echo an earlier keystroke after a later one was typed.
      // Acknowledge it without replacing the live field or moving its caret.
      pending.current.splice(0, echoed + 1);
    } else if (value !== lastModelValue.current) {
      pending.current = [];
      setLocalValue(value);
    }
    lastModelValue.current = value;
  }, [value, block]);
  const change = (next: string) => {
    pending.current.push(next);
    setLocalValue(next);
  };
  return [localValue, change] as const;
}
const BlockView = memo(({ data, selected }: NodeProps<BlockNode>) => {
  const { editable, change, commit } = useContext(EditContext);
  const block = data.block;
  // React Flow receives graph updates after the input event. Keep controlled
  // field values synchronous so React never restores an older value/caret.
  const [label, setLabel] = useBlockField(block.label, block);
  const [text, setText] = useBlockField(block.text, block);
  const blockElement = useRef<HTMLDivElement>(null);
  const notesElement = useRef<HTMLTextAreaElement>(null);
  const fitHeight = () => {
    const element = blockElement.current;
    const notes = notesElement.current;
    if (!element || !notes) return;
    // Use the live text area width, including space already lost to a scrollbar.
    // Measuring the full CSS width can miss wrapped lines while that scrollbar
    // is still present. clientWidth is independent of canvas zoom.
    // A separate field can shrink as well as grow without moving the live caret.
    const measure = notes.cloneNode() as HTMLTextAreaElement;
    measure.value = text;
    measure.placeholder = "";
    measure.tabIndex = -1;
    measure.setAttribute("aria-hidden", "true");
    Object.assign(measure.style, {
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      width: `${notes.clientWidth}px`,
      height: "0",
      minHeight: "0",
      flex: "none",
      overflow: "hidden",
      scrollbarGutter: "auto",
    });
    element.append(measure);
    const height = Math.max(
      110,
      Math.ceil(
        element.offsetHeight - notes.offsetHeight + measure.scrollHeight + 1,
      ),
    );
    measure.remove();
    if (height !== block.height)
      change([{ kind: "update_node", id: block.id, patch: { height } }]);
  };
  const Icon = icons[block.type];
  const calls = data.subagentCalls;
  const visibleCount =
    calls.length >= 3 || calls.some((handle) => handle.includes("far-"))
      ? 5
      : calls.length
        ? 3
        : 1;
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(block.id);
  }, [block.id, visibleCount, updateNodeInternals]);
  return (
    <div
      ref={blockElement}
      className={`block block-${block.type} ${selected ? "is-selected" : ""}`}
    >
      <NodeResizer
        isVisible={editable && selected}
        minWidth={180}
        minHeight={110}
        onResizeEnd={(_e, size) =>
          change([
            {
              kind: "update_node",
              id: block.id,
              patch: {
                x: size.x,
                y: size.y,
                width: size.width,
                height: size.height,
              },
            },
          ])
        }
      />
      {editable && selected && (
        <button
          type="button"
          className="block-fit-height nodrag nopan"
          aria-label="Fit block height to contents"
          title="Fit height to contents"
          onClick={fitHeight}
        >
          <FoldVertical size={14} />
        </button>
      )}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        isConnectable={editable}
      />
      <Handle
        type="target"
        position={Position.Top}
        id="in-top"
        isConnectable={editable}
      />
      <div className="block-kind">
        <Icon size={13} />
        <span>{blockNames[block.type]}</span>
      </div>
      {editable ? (
        <input
          className="block-title nodrag nopan"
          aria-label="Block heading"
          value={label}
          maxLength={160}
          onChange={(e) => {
            setLabel(e.target.value);
            change(
              [
                {
                  kind: "update_node",
                  id: block.id,
                  patch: { label: e.target.value },
                },
              ],
              true,
            );
          }}
          onBlur={(e) => {
            if (!e.target.value.trim()) {
              setLabel(blockNames[block.type]);
              change([
                {
                  kind: "update_node",
                  id: block.id,
                  patch: { label: blockNames[block.type] },
                },
              ]);
            }
            commit();
          }}
        />
      ) : (
        <div className="block-title">{block.label}</div>
      )}
      {editable ? (
        <textarea
          ref={notesElement}
          className="block-text nodrag nopan nowheel"
          aria-label="Block text"
          placeholder="Add notes, responsibilities, schema…"
          value={text}
          maxLength={30000}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            change(
              [
                {
                  kind: "update_node",
                  id: block.id,
                  patch: { text: e.target.value },
                },
              ],
              true,
            );
          }}
          onBlur={commit}
        />
      ) : (
        block.text && <div className="block-text nowheel">{block.text}</div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        id="fetch"
        className="fetch-handle"
        style={{ top: `calc(50% - ${fetchPortOffset}px)` }}
        title="Fetch: request data and receive a response"
        aria-label="Fetch connection output"
        isConnectable={editable}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        title="Flow output"
        isConnectable={editable}
      />
      {subagentHandles.slice(0, visibleCount).map((handle, index) => (
        <Handle
          key={handle}
          type="source"
          position={Position.Bottom}
          id={handle}
          className={`subagent-handle${calls.includes(handle) ? " occupied" : ""}`}
          style={{ left: `${[50, 32, 68, 14, 86][index]}%` }}
          title={
            calls.includes(handle)
              ? "Sub-agent call (connected)"
              : "Call a sub-agent and receive a result"
          }
          aria-label={`Sub-agent call output ${index + 1}`}
          isConnectable={editable && !calls.includes(handle)}
        />
      ))}
    </div>
  );
});
const nodeTypes = { block: BlockView };
function ConnectionView(props: EdgeProps) {
  const { editable, change } = useContext(EditContext);
  const isFetch = props.data?.kind === "fetch";
  const isSubagent = props.data?.kind === "subagent";
  const flow = useReactFlow();
  const routing = useContext(RoutingContext);
  const text =
    connectionText({
      label: String(props.label ?? ""),
      kind: isFetch ? "fetch" : isSubagent ? "subagent" : "flow",
    }) || (editable && props.selected ? "Add label" : "");
  const estimate = labelSize(text);
  const labelElement = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{
    text: string;
    width: number;
    height: number;
  }>();
  const [preview, setPreview] = useState<Point[]>();
  const drag = useRef<{
    points: Point[];
    index: number;
    pins?: Point[];
  } | null>(null);
  useEffect(() => {
    const element = labelElement.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      // These are unscaled CSS dimensions, including fractional text widths.
      // offsetWidth rounds to an integer and can trigger a false "won't fit"
      // decision on an unchanged diagram at a different zoom level.
      const width = entry.borderBoxSize[0]?.inlineSize ?? element.offsetWidth,
        height = entry.borderBoxSize[0]?.blockSize ?? element.offsetHeight;
      setMeasured((old) =>
        old?.text === text && old.width === width && old.height === height
          ? old
          : { text, width, height },
      );
      routing.measure(props.id, text, { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, props.id, routing.measure]);
  const size = text && measured?.text === text ? measured : estimate;
  const route = useMemo(
    () =>
      (!preview && routing.routes.get(props.id)) ||
      routeConnection({
        source: { x: props.sourceX, y: props.sourceY },
        target: { x: props.targetX, y: props.targetY },
        sourceSide:
          props.sourcePosition === Position.Bottom ? "bottom" : "right",
        targetSide: props.targetPosition === Position.Top ? "top" : "left",
        obstacles: routing.obstacles,
        label: size,
        waypoints: preview ?? (props.data?.waypoints as Point[] | undefined),
        offset: Number(props.data?.offset ?? 0),
      }),
    [
      props.sourceX,
      props.sourceY,
      props.targetX,
      props.targetY,
      props.sourcePosition,
      props.targetPosition,
      props.data,
      routing,
      size.width,
      size.height,
      preview,
    ],
  );
  const path = roundedPath(route.points, route.radius);
  const { x: labelX, y: labelY } = route.label;
  const savePins = (waypoints: Point[]) =>
    change([{ kind: "update_edge", id: props.id, patch: { waypoints } }]);
  const controls = drag.current?.points ?? route.points;
  const [editing, setEditing] = useState(false);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
        style={{
          strokeWidth: props.selected ? 2.5 : 1.6,
          stroke: isFetch
            ? props.selected
              ? "var(--edge-fetch-selected)"
              : "var(--edge-fetch)"
            : isSubagent
              ? props.selected
                ? "var(--edge-subagent-selected)"
                : "var(--edge-subagent)"
              : props.selected
                ? "var(--edge-flow-selected)"
                : "var(--edge-flow)",
        }}
      />
      <EdgeLabelRenderer>
        <div
          ref={labelElement}
          data-edge-id={props.id}
          className={`edge-label nodrag nopan ${isFetch ? "fetch-label" : isSubagent ? "subagent-label" : ""} ${props.selected ? "selected" : ""}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: "all",
            width: text ? undefined : 22,
          }}
        >
          {editing && editable ? (
            <input
              aria-label="Connection label"
              autoFocus
              defaultValue={String(props.label ?? "")}
              onBlur={(e) => {
                change([
                  {
                    kind: "update_edge",
                    id: props.id,
                    patch: { label: e.target.value },
                  },
                ]);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <button
              aria-label="Edit connection label"
              disabled={!editable}
              onDoubleClick={() => setEditing(true)}
              onClick={() => {
                if (props.selected) setEditing(true);
              }}
            >
              {text}
            </button>
          )}
        </div>
        {editable && props.selected && (
          <>
            {controls.slice(1).map((b, index) => {
              const a = controls[index];
              if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 50) return null;
              const horizontal = a.y === b.y;
              // Offset the grip from the label to keep both easy to use.
              const t = route.label.segment === index ? 0.2 : 0.5;
              return (
                <button
                  key={index}
                  type="button"
                  className={`edge-bend nodrag nopan ${horizontal ? "horizontal" : "vertical"}`}
                  aria-label={`Move connection segment ${index + 1}`}
                  title="Drag to move this bend. Arrow keys adjust; Shift moves further."
                  style={{
                    transform: `translate(-50%, -50%) translate(${a.x + (b.x - a.x) * t}px,${a.y + (b.y - a.y) * t}px)`,
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    drag.current = { points: route.points, index };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    if (!drag.current) return;
                    const position = flow.screenToFlowPosition({
                      x: event.clientX,
                      y: event.clientY,
                    });
                    const pins = moveSegment(
                      drag.current.points,
                      drag.current.index,
                      position,
                    );
                    drag.current.pins = pins;
                    setPreview(pins);
                  }}
                  onPointerUp={(event) => {
                    const pins = drag.current?.pins;
                    drag.current = null;
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(
                        event.pointerId,
                      );
                    if (pins) savePins(pins);
                    setPreview(undefined);
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                    setPreview(undefined);
                  }}
                  onKeyDown={(event) => {
                    if (
                      ![
                        "ArrowUp",
                        "ArrowDown",
                        "ArrowLeft",
                        "ArrowRight",
                      ].includes(event.key)
                    )
                      return;
                    event.preventDefault();
                    event.stopPropagation();
                    const delta =
                      (event.shiftKey ? 25 : 10) *
                      (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1);
                    if (
                      (horizontal &&
                        ["ArrowLeft", "ArrowRight"].includes(event.key)) ||
                      (!horizontal &&
                        ["ArrowUp", "ArrowDown"].includes(event.key))
                    )
                      return;
                    savePins(
                      moveSegment(route.points, index, {
                        x: a.x + delta,
                        y: a.y + delta,
                      }),
                    );
                  }}
                />
              );
            })}
            {!!(props.data?.waypoints as Point[] | undefined)?.length && (
              <button
                type="button"
                className="edge-reset nodrag nopan"
                aria-label="Reset connection route"
                title="Reset connection route"
                style={{
                  transform: `translate(-50%, -50%) translate(${labelX}px,${labelY + size.height / 2 + 18}px)`,
                }}
                onClick={() => savePins([])}
              >
                Reset route
              </button>
            )}
          </>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { flow: ConnectionView };
function CanvasInner({
  graph,
  editable,
  onChange,
  onCommit,
  id,
  revision = 0,
  saved = true,
  fitRequest = 0,
  visible = true,
}: {
  graph: Graph;
  editable: boolean;
  onChange: (ops: Operation[], deferSave?: boolean) => void;
  onCommit?: () => void;
  id: string;
  revision?: number;
  saved?: boolean;
  onMessage: (message: string) => void;
  fitRequest?: number;
  visible?: boolean;
}) {
  const [nodes, setNodes] = useState<BlockNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [labelMeasurements, setLabelMeasurements] = useState<
    Record<string, LabelSize & { text: string }>
  >({});
  const measure = useCallback((id: string, text: string, size: LabelSize) => {
    setLabelMeasurements((old) =>
      old[id]?.text === text &&
      old[id].width === size.width &&
      old[id].height === size.height
        ? old
        : { ...old, [id]: { ...size, text } },
    );
  }, []);
  const routing = useMemo(() => {
    const obstacles = nodes.map((n) => ({
      id: n.id,
      ...n.position,
      width: n.measured?.width ?? n.width ?? n.data.block.width,
      height: n.measured?.height ?? n.height ?? n.data.block.height,
    }));
    const byId = new Map(obstacles.map((n) => [n.id, n]));
    const inputs = graph.edges.flatMap((edge, index) => {
      const source = byId.get(edge.source),
        target = byId.get(edge.target);
      if (!source || !target) return [];
      const bottom = isSubagentHandle(edge.sourceHandle),
        top = edge.targetHandle === "in-top";
      const slot = subagentHandles.indexOf(
        edge.sourceHandle as (typeof subagentHandles)[number],
      );
      const text = connectionText(edge),
        measured = labelMeasurements[edge.id];
      return [
        {
          id: edge.id,
          targetKey: JSON.stringify([edge.target, edge.targetHandle]),
          // React Flow attaches paths to the outside of each 8px handle.
          source: {
            x:
              source.x +
              (bottom
                ? source.width * ([0.5, 0.32, 0.68, 0.14, 0.86][slot] ?? 0.5)
                : source.width + 4),
            y:
              source.y +
              (bottom
                ? source.height + 4
                : source.height / 2 -
                  (edge.sourceHandle === "fetch" ? fetchPortOffset : 0)),
          },
          target: {
            x: target.x + (top ? target.width / 2 : -4),
            y: target.y + (top ? -4 : target.height / 2),
          },
          sourceSide: bottom ? ("bottom" as const) : ("right" as const),
          targetSide: top ? ("top" as const) : ("left" as const),
          obstacles,
          label: measured?.text === text ? measured : labelSize(text),
          waypoints: edge.waypoints,
          offset:
            graph.edges
              .slice(0, index)
              .filter(
                (other) =>
                  other.source === edge.source && other.target === edge.target,
              ).length * 22,
        },
      ];
    });
    return { routes: routeConnections(inputs), obstacles, measure };
  }, [nodes, graph.edges, labelMeasurements, measure]);
  const flow = useReactFlow<BlockNode>();
  const toNodes = useCallback(
    (g: Graph): BlockNode[] =>
      g.nodes.map((block) => ({
        id: block.id,
        type: "block",
        position: { x: block.x, y: block.y },
        width: block.width,
        height: block.height,
        style: { width: block.width, height: block.height },
        data: {
          block,
          subagentCalls: g.edges
            .filter(
              (edge) => edge.source === block.id && edge.kind === "subagent",
            )
            .map((edge) => edge.sourceHandle),
        },
      })),
    [],
  );
  useEffect(() => {
    setNodes((old) =>
      toNodes(graph).map((n) => ({
        ...n,
        selected: old.find((o) => o.id === n.id)?.selected,
      })),
    );
    setEdges((old) =>
      graph.edges.map((e, index) => ({
        ...e,
        sourceHandle: e.sourceHandle === "out-bottom" ? "out" : e.sourceHandle,
        type: "flow",
        selected: old.find((o) => o.id === e.id)?.selected,
        className:
          e.kind === "fetch"
            ? "fetch-connection"
            : e.kind === "subagent"
              ? "subagent-connection"
              : "flow-connection",
        markerStart:
          e.kind === "fetch" || e.kind === "subagent"
            ? {
                type: MarkerType.ArrowClosed,
                width: 16,
                height: 16,
                color:
                  e.kind === "fetch"
                    ? "var(--edge-fetch)"
                    : "var(--edge-subagent)",
                orient: "auto-start-reverse",
              }
            : undefined,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color:
            e.kind === "fetch"
              ? "var(--edge-fetch)"
              : e.kind === "subagent"
                ? "var(--edge-subagent)"
                : "var(--edge-flow)",
        },
        data: {
          kind: e.kind ?? "flow",
          waypoints: e.waypoints,
          offset:
            graph.edges
              .slice(0, index)
              .filter(
                (other) =>
                  other.source === e.source && other.target === e.target,
              ).length * 22,
        },
      })),
    );
  }, [graph, toNodes]);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(
      () => void flow.fitView({ padding: 0.2, maxZoom: 1 }),
      120,
    );
    return () => clearTimeout(timer);
  }, [id, flow, fitRequest, visible]);
  const add = (type: Block["type"]) => {
    const wrapper = document
      .querySelector(`[data-canvas="${id}"]`)
      ?.getBoundingClientRect();
    const center = wrapper
      ? flow.screenToFlowPosition({
          x: wrapper.x + wrapper.width * 0.45,
          y: wrapper.y + wrapper.height * 0.4,
        })
      : { x: 100, y: 100 };
    const offset = (graph.nodes.length % 5) * 24;
    onChange([
      {
        kind: "add_node",
        node: {
          id: crypto.randomUUID(),
          type,
          label: blockNames[type],
          text: "",
          x: Math.round(center.x + offset),
          y: Math.round(center.y + offset),
          width: 250,
          height: 160,
        },
      },
    ]);
  };
  const remove = () => {
    const selectedNodes = nodes.filter((n) => n.selected);
    const selectedEdges = edges.filter((e) => e.selected);
    const ops: Operation[] = [
      ...selectedNodes.map((n) => ({ kind: "delete_node" as const, id: n.id })),
      ...selectedEdges.map((e) => ({ kind: "delete_edge" as const, id: e.id })),
    ];
    if (ops.length) onChange(ops);
  };
  const duplicate = () => {
    const selected = nodes.filter((n) => n.selected);
    if (!selected.length) return;
    const ids = new Map(selected.map((n) => [n.id, crypto.randomUUID()]));
    const ops: Operation[] = selected.map((n) => ({
      kind: "add_node",
      node: {
        ...n.data.block,
        id: ids.get(n.id)!,
        x: n.position.x + 40,
        y: n.position.y + 40,
      },
    }));
    for (const edge of graph.edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target),
    ))
      ops.push({
        kind: "add_edge",
        edge: {
          ...edge,
          id: crypto.randomUUID(),
          source: ids.get(edge.source)!,
          target: ids.get(edge.target)!,
          ...(edge.waypoints
            ? {
                waypoints: edge.waypoints.map((p) => ({
                  x: p.x + 40,
                  y: p.y + 40,
                })),
              }
            : {}),
        },
      });
    onChange(ops);
  };
  const connect = (c: Connection) => {
    if (c.source && c.target)
      onChange([
        {
          kind: "add_edge",
          edge: {
            id: crypto.randomUUID(),
            source: c.source,
            target: c.target,
            kind: isSubagentHandle(c.sourceHandle)
              ? "subagent"
              : c.sourceHandle === "fetch"
                ? "fetch"
                : "flow",
            sourceHandle: isSubagentHandle(c.sourceHandle)
              ? c.sourceHandle
              : c.sourceHandle === "fetch"
                ? "fetch"
                : "out",
            targetHandle: isSubagentHandle(c.sourceHandle) || c.targetHandle === "in-top" ? "in-top" : "in",
            label: "",
          },
        },
      ]);
  };
  return (
    <EditContext.Provider
      value={useMemo(
        () => ({ editable, change: onChange, commit: onCommit ?? (() => {}) }),
        [editable, onChange, onCommit],
      )}
    >
      <RoutingContext.Provider value={routing}>
        <div
          className="canvas"
          data-canvas={id}
          data-revision={revision}
          data-saved={saved}
          tabIndex={0}
          onKeyDown={(e) => {
            if (
              !editable ||
              (e.target as HTMLElement).closest(
                "input,textarea,[contenteditable=true]",
              )
            )
              return;
            if (e.key === "Delete" || e.key === "Backspace") {
              e.preventDefault();
              remove();
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
              e.preventDefault();
              duplicate();
            }
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={(changes: NodeChange<BlockNode>[]) =>
              setNodes((current) => applyNodeChanges(changes, current))
            }
            onEdgesChange={(changes: EdgeChange[]) =>
              setEdges((current) => applyEdgeChanges(changes, current))
            }
            onNodeDragStop={(_event, _node, moved) =>
              onChange(
                moved.map((n) => ({
                  kind: "update_node",
                  id: n.id,
                  patch: { x: n.position.x, y: n.position.y },
                })),
              )
            }
            onConnect={connect}
            nodesDraggable={editable}
            nodesConnectable={editable}
            edgesReconnectable={false}
            deleteKeyCode={null}
            selectionKeyCode="Shift"
            multiSelectionKeyCode="Control"
            selectNodesOnDrag={false}
            minZoom={0.15}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="var(--canvas-dots)"
            />
          </ReactFlow>
          {editable && (
            <div className="block-palette" aria-label="Add a block">
              {blockTypes.map((type) => {
                const Icon = icons[type];
                return (
                  <button
                    key={type}
                    className={`palette-${type}`}
                    onClick={() => add(type)}
                    title={`Add ${blockNames[type]}`}
                    aria-label={`Add ${blockNames[type]}`}
                  >
                    <Icon size={17} />
                    <span>{blockNames[type]}</span>
                  </button>
                );
              })}
            </div>
          )}
          {!graph.nodes.length && (
            <div className="canvas-empty">
              <div className="empty-mark">
                <Workflow size={30} />
              </div>
              <h3>
                {editable
                  ? "Give the idea a shape"
                  : "The main flow starts here"}
              </h3>
              <p>
                {editable
                  ? "Add a block below, then connect the steps."
                  : "Create a draft and apply it when you’re ready."}
              </p>
              {editable && (
                <span className="empty-hint">
                  <ArrowDownRight size={15} /> Start with an interface or an
                  agent
                </span>
              )}
            </div>
          )}
          <div className="viewport-controls">
            <button
              onClick={() => void flow.zoomOut()}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOut size={16} />
            </button>
            <button
              onClick={() => void flow.zoomIn()}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <ZoomIn size={16} />
            </button>
            <span />
            <button
              onClick={() => void flow.fitView({ padding: 0.2, maxZoom: 1 })}
              title="Fit to view"
              aria-label="Fit to view"
            >
              <Scan size={17} />
            </button>
          </div>
          {editable && nodes.some((n) => n.selected) && (
            <div className="selection-controls">
              <button onClick={duplicate} title="Duplicate selection (Ctrl+D)">
                <Copy size={15} />
                Duplicate
              </button>
              <button onClick={remove} title="Delete selection">
                <Trash2 size={15} />
              </button>
            </div>
          )}
          <div className="canvas-count">
            {graph.nodes.length} blocks <span>·</span> {graph.edges.length}{" "}
            connections
          </div>
        </div>
      </RoutingContext.Provider>
    </EditContext.Provider>
  );
}
export function Canvas(props: Parameters<typeof CanvasInner>[0]) {
  return (
    <ReactFlowProvider key={props.id}>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
