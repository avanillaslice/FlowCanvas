---
name: flowcanvas
description: Use the local FlowCanvas application to sketch, inspect, edit, or compare process outlines, concepts, and backend or agent architecture during a discussion. Use when the user mentions FlowCanvas or refers to its shared concept, main canvas, or draft. Includes connection troubleshooting when its MCP tools are unavailable.
---

# FlowCanvas

FlowCanvas is a shared visual thinking surface for people and agents. It depicts an idea; it does not execute the agents or processes shown. Use it alongside the conversation to make a process, responsibility split, or alternative easy to understand. Default to a minimal overview, with implementation detail in chat or a separate detail draft. This skill supplies workflow guidance; the `flowcanvas` MCP connection supplies live application access.

## Connect and find context

Use the available FlowCanvas MCP tools directly. They may have a client-specific namespace; their operation names include `read_workspace`, `read_diagram`, `create_draft`, and `edit_draft`. A browser tab inventory, browser extension, and plugin search are not part of this connection.

If the tools are missing or authentication fails, read [local-connection.md](references/local-connection.md). Diagnose that connection before asking for a Concept ID or tab URL. A running website and a healthy configured server do not prove that the current chat has loaded the tools. Do not silently substitute browser automation or database writes for the missing connection. Connection setup and skill placement are manual and depend on the user's client; do not assume Codex or install anything as a diagnostic step.

The shared tab's active Concept, main version and draft are the native context. "My draft", "the current flow", and similar requests refer to those selections. Never ask the user for an ID or search the catalog to resolve the active selection. Other tabs are private context and must not be enumerated.

Choose the smallest read that answers the request:

- For "review my FlowCanvas draft", call `read_diagram` with `kind: "draft"` and no IDs. For the selected main, use `kind: "main"` and no IDs. Each returns only that complete flow.
- For current Concept metadata or discovering its draft/version references, call `read_concept` without an ID. It returns all references plus selected IDs and the selection revision, without graphs.
- Use `read_workspace` when both selected flows are needed, such as comparing the draft with main. It returns both complete flows and references to other diagrams.
- Use an explicit `diagramId` for a known nonselected diagram, or `conceptId` for another Concept. Use `list_concepts` only for discovery outside the active selection.
- Reuse sufficient fresh results during the same operation. For a new request about the current canvas, resolve the selection again rather than assuming an earlier diagram is still active. Refresh after user edits, selection changes, or revision conflicts.

All selection-based reads flush pending browser edits. They do not require a preceding workspace read. An explicit diagram read does not flush the browser; use a selection-based read when current unsaved user edits matter.

- A selected Concept with no diagrams is valid. Obtain its ID from `read_concept` or the missing-diagram response, then start its first draft with `create_draft` and `sourceVersionId: null`. Do not ask the user to create a diagram first.
- `no_active_workspace` means no live shared tab. Ask the user to open FlowCanvas and share the intended tab.
- `no_concept_selected` means the shared tab has no Concept selected. Ask the user to select one, or create a Project and Concept if requested.
- `no_draft_selected` or `no_main_selected` means that selection is absent; never silently substitute another draft or the latest main. Use Concept metadata if the task requires choosing or creating a diagram.
- A busy or changed-workspace error calls for a fresh selection-based read after the browser finishes saving. Do not infer stale selection or discard pending work.

Read responses contain JSON text. `inspect_diagram` can also return a PNG image block. Graphs and reference lists are complete, with no pagination. Diagrams use flat objects containing `kind`, `id`, `conceptId`, `graph` and revision/version metadata. Workspace selections contain the same diagram objects; its `drafts` and `versions` arrays exclude the selected diagrams. `read_concept` lists all diagrams. Ordinary reads omit timestamps, positions, dimensions and port handles. Missing node text or edge label means empty. Nodes and edges are sorted by ID for stable output, not execution order: follow edge source/target relationships. Branches, joins and cycles are expressed as edges, not duplicated paths; labels are descriptive, not executable conditions.

## Draft and compare

All diagram changes belong in drafts. Main versions are immutable. Only the user may Apply a draft with a manual UI click; never apply via MCP, browser automation, shell, or database access.

Read a target draft before editing and supply its latest `expectedRevision`. Use atomic batches of explicit operations. On a revision conflict, reread the draft, reconcile the user's intervening edits, and submit a new batch. Use a fresh `operationId` for each new request; reuse it only to retry an identical request.

For a new alternative, create a clearly named draft unless the user asked to revise the selected draft. When the alternative starts from an existing draft, read that draft and call `create_draft` with its `sourceDraftId` and `expectedSourceRevision`. This creates an independent copy of its current graph and layout with fresh undo history, retaining its main-version base but no link between drafts. Do not rebuild the graph manually. When starting from main, use the selected main's version ID, even if it is older than the latest main. If omitting explicit source IDs, pass `workspaceSelectionRevision` from a fresh `read_concept` or `read_workspace` selection read to copy the displayed main. Do not combine draft and main source selectors.

Applying leaves the draft open; it can be edited and applied again. The UI manages version prefixes such as `v2 - Draft name`; do not bake those prefixes into draft names. Before the first apply the prefix is `New`, and the first main is v1.

When editing, read [tools.md](references/tools.md) for operation shapes if the live schemas leave anything unclear. Verify the resulting graph and its rendered appearance as described below. Preserve deliberate user positioning during small edits.

## Compose a useful view

Decide what question this view answers before adding blocks. Infer the purpose from the conversation; ask only if ambiguity would materially change the diagram. A user journey, agent delegation hierarchy and infrastructure map can each be useful views, but combining all three usually obscures the idea. Keep one abstraction level in a view; add supporting stores or transport only when they explain the current question.

Start with the main path and add only the branches needed to explain it. A block should carry one clear responsibility. Do not turn every implementation requirement, API operation, logging concern or validation rule into a separate block. Keep alternatives and deeper detail in clearly named drafts rather than connecting every supporting concern into the overview. There is no fixed block limit: split the view when following it becomes difficult.

Use short headings, usually two to five words, that fit at the default block width. Put qualifiers, version names and longer explanations in chat or a brief body. Default to empty bodies. When body text is useful, aim for one or two short lines; the full technical inventory belongs elsewhere. Fixed-size blocks do not automatically grow to fit long notes, and text may scroll or headings may clip. Do not fill every optional field. Preserve user-authored detail unless asked to simplify it. Mark proposals and uncertainties explicitly.

Lay out progression left to right and delegated work beneath its caller. Choose connection meaning before choosing appearance. Use one Fetch or Sub-agent edge for request and return; avoid redundant return arrows. A normal flow arrow means progression, so do not use one merely to show every incidental write, log event or background dependency. Label edges only where the relationship, branch or trigger needs explanation.

For example, an authoring overview can show Request → Main → Compose response → Response, with Main delegating to Author and Author delegating to Research. Add an evidence store only if persistence is the subject under discussion. The transport, journal, retries, validation internals and detailed authoring instructions can be discussed in chat or another draft.

## Arrange and verify

After creating a diagram, call `arrange_draft`; it separates progression and delegated branches, but cannot rescue an overcrowded or mixed-purpose graph. Reread the saved diagram to check responsibilities, branches, reconvergence and call direction.

Then use `inspect_diagram` with the same kind and, for a known alternative, its `diagramId`. The tool returns measured clipping/overlap issues and a PNG. Inspect the image for readable headings, short bodies, crossings, long detours, label placement, hierarchy and overall density. Shorten or split content first; resize a block when the content really belongs there. Rearrange only when needed. Repeat inspection after a visual correction.

If the client or model cannot consume MCP images, request `includeImage: false` for measurements and state that appearance remains visually unverified. Structural editing remains available.

Consume the PNG as image content. If orchestrating tool calls, forward image blocks through the available image helper rather than printing the complete response or its base64 data as text.

`view: shared_canvas` means the actual displayed canvas was measured. `view: saved_preview` means a hidden or nonselected saved diagram was rendered with the same Canvas component in the shared tab, without navigation or changing the user's selection. Neither inspects a private tab. A preview of a very large graph may be scaled down: do not mistake a successful image capture for readability. Failure or unavailable statuses do not confirm appearance. If inspection is unavailable, state that graph structure was checked and appearance remains unverified; do not silently substitute browser automation or claim visual verification from graph JSON.

Keep the verification scoped to the change. For a wording edit, inspect that block and its surrounding view; do not rebuild or rearrange the whole diagram. Report what changed and any unresolved readability issue alongside the architectural discussion.

## Discuss architecture clearly

Use short, concrete headings for blocks and verb phrases for connections. Choose Interface for entry/exit boundaries, Agent or Sub-agent for agent behavior, Process for deterministic work, Decision for branching, and Data store for persistence. Label decision branches and distinguish calls, results, retries, or asynchronous handoffs when that distinction matters.

Use a Fetch connection when one block requests data from another and receives a response, without handing off the normal process flow. Set edge `kind: "fetch"`; the backend selects the appropriate ports. A single edge represents request and return. Use normal flow connections for progression and decision branches. See the connection fields in [tools.md](references/tools.md) when creating or changing a Fetch connection.

Use a Sub-agent call connection when a block delegates work and receives a result. Set `kind: "subagent"` and omit handles: the backend assigns a free bottom output on the caller and the top input on the called block. Each block supports up to five outgoing calls; there is no need to manage the UI's progressive reveal. A single two-headed edge represents call and return. Label the purpose or trigger when useful. If more than five calls are needed, discuss grouping or restructuring rather than bypassing the limit with a different connection type. Existing diagrams may retain older side-input calls; inspection flags these. Correct ports explicitly when relevant, without rewriting unrelated user connections.

For comparisons, explain the architectural difference and its practical tradeoffs using the drafts' names. Keep detailed reasoning, implementation considerations, and most explanatory content in chat; keep the canvas focused on the overview. Match discussion depth to the user's request and include the key decision, open questions, and what changed on the canvas. Do not create diagrams or alter drafts merely because a conversation mentions software architecture; use the canvas when requested or clearly part of the ongoing FlowCanvas work.
