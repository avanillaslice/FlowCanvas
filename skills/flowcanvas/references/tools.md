# Tools and graph operations

Use live input schemas as the authority. Definitions are in `src/server/mcp.ts`, `src/server/agent-contract.ts`, and `src/shared/model.ts` in the FlowCanvas installation.

| Tool | Purpose |
| --- | --- |
| `read_diagram` | Read the current draft with `{ "kind": "draft" }`, or current main with `{ "kind": "main" }`. Optional `diagramId` targets another diagram; optional `conceptId` checks ownership. |
| `inspect_diagram` | Measure rendered layout and return a PNG. Same selectors as `read_diagram`; `includeImage: false` returns measurements only. Nonselected saved diagrams render without changing selection. |
| `read_concept` | Read active Concept metadata, selected IDs and selection revision without graphs. Optional `conceptId` targets another Concept. Returns all draft/version references. |
| `read_workspace` | Read both selected flows and the shared Concept; lists contain references to all other diagrams. |
| `list_concepts` | List all Projects and Concepts, optionally filtered by `projectId`. Use for discovery outside the active selection. |
| `create_project` | Create a container using `name`, `operationId`. |
| `create_concept` | Create an empty Concept using `projectId`, `name`, `operationId`. |
| `create_draft` | Copy main or another draft, or start empty with `sourceVersionId: null`. |
| `edit_draft` | Apply an atomic batch using `conceptId`, `draftId`, `expectedRevision`, `operationId`, `operations`. |
| `arrange_draft` | Arrange a draft `RIGHT` or `DOWN` as one undoable change. |

There is no Apply tool. Creation does not generally navigate the browser. The first draft of the selected empty Concept is automatically selected by the UI when it refreshes.

## Read contracts

Current/my Concept, main and draft always mean the shared tab's active selections. No ID discovery or preceding `read_workspace` is needed. Selection reads flush pending browser edits; explicit ID reads fetch saved data. Use `read_workspace` only when both flows are relevant. Never silently substitute the latest main for a selected older version, or pick another draft when none is selected.

Results contain one text block with JSON and no `structuredContent`. Successful `inspect_diagram` calls with an image add a second MCP image block (`image/png`); base64 is never embedded in the JSON text. Graphs and lists are complete with no cursors or pagination. Errors use `isError: true` and JSON `{ "code": "...", "message": "..." }`, with optional `details`; revision conflicts include `details.currentRevision`.

- Project: `id`, `name`.
- Concept: `id`, `projectId`, `name`, `latestVersionId` (nullable).
- Draft reference: `id`, `name`, `revision`.
- Main reference: `id`, `number`.
- Draft diagram: `kind: "draft"`, `id`, `conceptId`, `name`, `revision`, nullable `originVersionId`/`baseVersionId`, `graph`.
- Main diagram: `kind: "main"`, `id`, `conceptId`, `number`, `sourceDraftId`, `sourceDraftRevision`, nullable `parentVersionId`/`basedOnVersionId`, `graph`.

`read_diagram` returns the diagram directly, without a `diagram` wrapper. `read_workspace` returns `status`, `selectionRevision`, `concept`, nullable `selectedMain`/`selectedDraft`, `drafts` and `versions`. Those reference arrays exclude selected diagrams. `read_concept` returns `concept`, `drafts`, `versions`; when using active selection it also returns `selectionRevision`, `selectedMainId`, `selectedDraftId`. Its reference arrays include all diagrams.

Selection reads can return `no_active_workspace` or `no_concept_selected`. A single-diagram read can return `no_draft_selected` or `no_main_selected`, with `conceptId` and `selectionRevision`. These statuses describe absent context, not errors to fix by guessing IDs. A selected empty Concept is valid and can receive its first draft.

Graphs contain `schemaVersion: 1`, `nodes`, `edges`. Nodes have `id`, `type`, `label`, and optional `text`. Edges have `id`, `source`, `target`, explicit `kind`, and optional `label`. Missing text/label means empty. Timestamps, coordinates, dimensions and port handles are omitted. Array order is deterministic by ID, not execution order. Follow connections to interpret branches, reconvergence and cycles; labels do not define executable branching or synchronization rules.

## Create and edit

`create_draft` takes `conceptId`, `name`, `operationId`, and one source choice:

- `sourceVersionId`: an explicit main-version ID, or null for an empty draft.
- `workspaceSelectionRevision`: from a fresh active `read_concept` or `read_workspace`, to copy the displayed main.
- `sourceDraftId` and `expectedSourceRevision`: from a fresh draft read. Omit both other source selectors.

The source must be in the same Concept. Draft copies preserve blocks, text, connections and layout internally, retaining the main base but no ongoing relationship between drafts. A copy starts at revision zero with fresh undo history. A stale source revision rejects the copy. Reuse an operation ID only for an identical retry.

`create_draft` returns `draftId`, `conceptId`, `revision`, `baseVersionId`. `edit_draft` returns `draftId`, `revision`, `baseVersionId`. `arrange_draft` returns `draftId`, `revision`. Read the target draft before editing and reread after meaningful edits to verify the resulting graph. On a conflict, reconcile current contents before retrying with a new operation ID.

Operation examples (separate examples, not a complete batch):

```json
{ "kind": "add_node", "node": { "id": "agent-1", "type": "agent", "label": "Request agent" } }
{ "kind": "update_node", "id": "agent-1", "patch": { "text": "Updated responsibilities" } }
{ "kind": "delete_node", "id": "agent-1" }
{ "kind": "add_edge", "edge": { "id": "next", "source": "agent-1", "target": "step-1", "kind": "flow", "label": "Continue" } }
{ "kind": "update_edge", "id": "next", "patch": { "label": "Continue after validation" } }
{ "kind": "delete_edge", "id": "next" }
{ "kind": "rename", "name": "Alternative routing" }
```

Node types are `interface`, `agent`, `subagent`, `process`, `decision`, `store`. IDs must be unique within each element collection. Create endpoint nodes before edges. Omit coordinates, dimensions and handles: the backend supplies initial positions/sizes and allocates connection ports. Use `arrange_draft` after creating a flow or when layout is requested; preserve deliberate layout during small edits. Set text/label to `""` explicitly when clearing existing content.

`arrange_draft` takes `conceptId`, `draftId`, `expectedRevision`, `operationId`, and optional `direction: "RIGHT"` or `"DOWN"`. It changes layout, preserving semantic graph content.

## Connection semantics

- `flow`: normal progression or a decision branch. Omitted kind on creation means flow; reads always include it.
- `fetch`: one data request and response. Source is caller, target is provider; it does not hand off normal process flow.
- `subagent`: one delegated call and its return. Source is caller, target is called sub-agent. At most five outgoing calls per source, including separate calls to the same target. Slots are allocated automatically.

```json
{ "kind": "add_edge", "edge": { "id": "lookup", "source": "agent-1", "target": "data-store", "kind": "fetch", "label": "Load records" } }
{ "kind": "add_edge", "edge": { "id": "review", "source": "agent-1", "target": "reviewer", "kind": "subagent", "label": "Review proposed changes" } }
{ "kind": "update_edge", "id": "lookup", "patch": { "kind": "flow" } }
```

New or reconnected Sub-agent calls use bottom output → top input automatically, including when the caller supplied a side target. Changing kind selects the appropriate ports; changing away from Sub-agent defaults to the side input unless another input is explicitly requested. Label-only and waypoint-only edits preserve existing ports and layout. Older diagrams are not automatically migrated. To correct an existing side-input Sub-agent call, use `update_edge` with `patch: { "targetHandle": "in-top" }`. A single Fetch or Sub-agent edge represents both call and return; do not add a redundant return edge. Deleting a call frees its slot. Exceeding five calls from one source fails atomically.

## Rendered inspection

```json
{ "kind": "draft" }
{ "kind": "draft", "diagramId": "known-alternative-id", "includeImage": false }
```

`inspect_diagram` flushes the shared tab before capturing. A rendered result contains `status: "rendered"`, `kind`, `diagramId`, `revision` (main uses its version number), `view`, graph-coordinate `bounds`, `issues`, `issuesTruncated`, `selectedNodeIds`, `selectedEdgeIds`, and optional `preview: { width, height }`. Images fit within 1600 × 1200 pixels; large flows are scaled. Capture failure can return valid measurements with `imageError: "capture_failed"` and no image.

`view: "shared_canvas"` measures the displayed canvas; `"saved_preview"` renders a hidden or nonselected saved snapshot through the same Canvas component in the shared tab. It does not navigate, mutate the graph or inspect another tab. Explicit IDs deliberately access saved diagrams, just as `read_diagram` does. Selection or draft revision changes during capture reject the result as `workspace_changed`.

Issues contain `kind` and affected element `ids`: `heading_clipped`, `body_scrolls`, `block_overlap`, `label_overlap` (edge then block), or `subagent_side_target` (edge). Measurements do not judge semantics, route crossings, or overall readability: inspect the PNG too. Main and draft reads retain their compact semantic-only contracts.

Absent workspace/selection statuses match selection reads. `not_displayed`, `render_pending` or `render_failed` mean rendering was unavailable or not confirmed; do not report a successful visual check. Inspection requires the updated browser client connected to the local service. It never applies a draft.
