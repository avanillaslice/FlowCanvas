# Canvas guide

[Back to README](../README.md)

## Projects, Concepts, and versions

A Project contains named Concepts. Each Concept has saved main versions and editable draft tabs. Main diagrams are read-only snapshots; all diagram changes happen in drafts.

A new Concept has no main version. Its first draft uses the prefix `New`. **Apply draft** creates main v1 and changes that draft's prefix to `v1`. The draft stays open; another application creates v2 while preserving v1. Only a manual browser action can apply a draft. Agents have no apply tool.

Select an older main version before creating a draft to explore an alternative from that snapshot. Applying it creates the next main version without merging with the latest main. Other drafts keep their contents and prefixes.

**Copy draft** creates an independent copy after saving pending edits. The copy retains blocks, notes, connections, layout, and the main-version prefix, with a new ID and fresh undo history. Editing or deleting either draft does not affect the other.

The cross on a draft tab opens a deletion confirmation. Cancel or Escape keeps it. Deleting a draft preserves main versions and selects another available draft, or closes the draft pane if none remain. If the draft changes during confirmation, review it before retrying. Hiding the draft pane does not discard drafts.

## Blocks and connections

The palette provides **Interface**, **Agent**, **Sub-agent**, **Process**, **Decision**, and **Data store** blocks. Each has a heading and optional plain multiline notes. Notes preserve spacing and line breaks; Markdown is not rendered.

| Connection | Create it from | Meaning |
| --- | --- | --- |
| Flow | Centred right output to another block's input | One-way progression or a decision branch |
| Fetch | Small blue square above the right output | A data request and response, with arrowheads at both ends |
| Sub-agent call | Bottom output to the called block | Delegation and return, with arrowheads at both ends |

Sub-agent calls enter the called block's top input, including when dragged onto a side input. A block supports five outgoing calls. One centred bottom slot appears initially; using it reveals a pair, and filling all three reveals the final pair. Occupied slots cannot start another call; deleting a call frees its slot. Agents can add calls in a batch and let the backend allocate ports.

Double-click a connection label to edit it. Branches, loops, parallel connections, and disconnected blocks are supported. Labels describe relationships rather than executable conditions.

Older diagrams can retain side-input sub-agent calls until explicitly reconnected or converted. Text edits and immutable main versions preserve those ports. Older bottom flow connections display on the right-side output.

## Layout and controls

Drag blocks to position them and use resize controls on a selected block. The button at the top right of a selected draft block fits its height to its contents without changing its width. Long notes can scroll inside a block.

**Arrange** spaces normal flow horizontally, balances branches, and places sub-agent calls beneath their callers, including shared and nested calls. It uses saved block dimensions and leaves room for labels. Arrangement is an explicit, undoable action.

Connections route around blocks as they move or resize. Routes can cross and share tracks into the same destination port; routes to different destinations remain separate where space permits. Select a connection and drag its square segment grips to adjust bends. Arrow keys adjust a focused grip; hold Shift for larger movements.

Manual routes save with the draft and support undo/redo. **Reset route** restores one automatic route. **Arrange** resets all manual routes as part of its single undoable action.

Main and draft panes have independent pan, zoom, and fit controls. Resize the divider or change the pane layout to give either view more space. Viewing a main version does not change its saved diagram.

| Action | Shortcut while the draft canvas is focused |
| --- | --- |
| Select multiple blocks | Shift + drag |
| Duplicate selected blocks and their internal connections | Ctrl + D |
| Delete selected elements | Delete |
| Undo a draft edit | Ctrl + Z |
| Redo a draft edit | Ctrl + Shift + Z |

Text fields retain normal text-editing shortcuts. The in-app **Workspace guide** also lists controls.

## Saving and conflicts

Headings and notes save when their field loses focus. Other edits save immediately. Applying a draft and selection-based agent reads flush pending text first.

Failed or conflicting edits remain available locally for explicit resolution. They do not silently overwrite another participant's saved changes. Pending edits are journaled in browser session storage until acknowledged; after a failed save or reload, the draft can recover those edits and offer retry.

Undo and redo cover up to 100 actions per draft during the running service session, including agent edits. Restarting the service clears undo history; saved drafts and main history persist. Applying a version is separate from graph undo.

## Shared tabs and appearance

The first browser tab supplies context to connected agents. Additional tabs keep separate identities and do not automatically change it. Duplicating a tab creates a separate identity. Closing the shared tab ends sharing after disconnect detection; an already-open secondary tab needs **Share this tab with agents**. Refreshing the shared tab resumes its identity.

Secondary tabs' selections are excluded from agent context. Saved Concepts and diagrams remain deliberately queryable by ID. See [agent integration](agents.md#shared-context) for retrieval details.

FlowCanvas starts in Forest dark mode. The header's sun/moon button switches between dark and light. The choice is remembered in the browser and shared across its open tabs. Blocks have type names and distinct colours; selection adds a sage outline while retaining the type colour.
