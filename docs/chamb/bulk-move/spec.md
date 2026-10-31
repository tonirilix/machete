# Bulk move selected clips to a board

## Goal

Let the user move every selected clip to another board in one action, including
to a board created on the spot. Today a clip can only be moved one at a time, from
its card's "Move to board" menu.

## Context (origin/main)

- Multi-select already exists: Cmd/Shift-click, checkboxes, Cmd+A
  (`src/renderer/src/App.tsx:197-217`, `:252-256`). The selection footer
  (`App.tsx:526-580`) offers Trash, Copy and, in Trash, Restore.
- The core `move-clips` command already takes many ids
  (`src/shared/library.ts:225-228`), but the only caller sends one id
  (`App.tsx:488-491`). No test covers `move-clips`.
- Boards are created only from the sidebar dialog (`App.tsx:596-670`) with
  `create-board`; the renderer reads the new id from `boards.at(-1)` (`App.tsx:628`).
- Bulk trash shows an Undo toast (`App.tsx:182-195`); moves show nothing.
- No automated test renders React components. Pure renderer helpers are tested
  from `tests/` (e.g. `tests/draft-editing.test.ts` imports
  `src/renderer/src/lib/draft-editing`).

## Constraints

- Use the glossary terms: clip, board, Inbox, Trash.
- Every mutation is a pure `applyCommand` case in `src/shared/library.ts`,
  validated by `commandSchema` (zod), reached through the existing
  `bridge.execute` → `clips:command` IPC path. No new IPC channel.
- No new dependencies. Use the existing shadcn/ui components
  (`dropdown-menu`, `dialog`, `input`, `button`) and `sonner` toasts.
- `npm run typecheck` and `npm test` pass.

## Decisions

- D1. Destinations are existing boards plus "New board…", which creates a board
  and moves the clips into it. Reason: covers both readings of "move to a new
  board" at small cost.
- D2. "New board…" is one atomic command (`move-clips-to-new-board`), not
  `create-board` then `move-clips`. Reason: one persisted write, so a failure
  never leaves an empty new board; stays a pure, unit-tested `applyCommand` case;
  no `boards.at(-1)` guess.
- D3. The bulk control is a "Move to board" dropdown in the selection footer.
  The per-card "Move to board" menu is unchanged and moves only that card.
  Reason: the footer is where bulk actions already live; changing the card menu
  could silently move clips selected earlier.
- D4. After a bulk move a toast says "Moved N clips to <Board>" with Undo; the
  selection clears. Undo returns each clip to its previous board. A board created
  by the move stays (empty) after Undo. Reason: matches bulk trash; clips moved
  from the All view can come from many boards; deleting the board on Undo would
  add a destructive side effect.
- D5 (made on the user's behalf). Undo is one atomic command, `place-clips`, that
  takes a list of `{ id, boardId }` placements. Reason: the clips' previous boards
  can differ, and a single `move-clips` cannot express that; one write keeps Undo
  all-or-nothing.
- D6 (made on the user's behalf). The footer menu lists all boards in sidebar
  order, except the board currently being viewed. In the All view it lists every
  board. The footer shows no Move control in the Trash view. Reason: moving to the
  board you are viewing does nothing; the card menu already hides Move for trashed
  clips.
- D7 (made on the user's behalf). The "New board…" dialog reuses the existing
  board-name dialog's rules (trimmed, 1–60 characters, case-insensitive unique).
  Errors show the existing error toast and keep the dialog open. Reason: one
  set of board-name rules.

## Out of scope

- A keyboard shortcut for move, and drag-and-drop to boards.
- Moving clips from the Trash view, or blocking `move-clips` on trashed clips in
  the core.
- Changing the per-card move menu, or adding "New board…" to it.
- Deleting the created board on Undo.
- Component-rendering test infrastructure (jsdom, Testing Library).

## Requirements

- R1. `applyCommand` has a `move-clips-to-new-board` command with `ids` and
  `name`. It creates a board with that name and moves every listed clip to it
  in one result. It rejects a duplicate or invalid name, or an unknown clip id,
  and in that case leaves the library unchanged.
- R2. `applyCommand` has a `place-clips` command with a non-empty list of
  `{ id, boardId }` placements. It sets each clip's board as given, in one result.
  It rejects an unknown clip or board, and leaves the library unchanged.
- R3. `tests/library.test.ts` covers `move-clips` with several ids, a missing
  board, and a missing clip.
- R4. When one or more clips are selected outside the Trash view, the selection
  footer shows a "Move to board" dropdown. In the Trash view it does not.
- R5. The dropdown lists every board except the one being viewed (all boards in
  the All view), then a "New board…" item.
- R6. Choosing a board moves all selected visible clips to it with one
  `move-clips` command.
- R7. "New board…" opens a board-name dialog. Submitting a valid name sends one
  `move-clips-to-new-board` command. An invalid or duplicate name shows the
  error, keeps the dialog open, and changes nothing.
- R8. After either kind of bulk move the selection clears and a toast reads
  "Moved N clips to <Board>" ("Moved 1 clip to <Board>" for one).
- R9. The toast's Undo sends one `place-clips` command that returns each moved
  clip to the board it was on before the move. A board created by the move stays.
- R10. The per-card "Move to board" menu still moves only that card.
- R11. README.md's "Use Machete" section documents moving selected clips, and
  docs/design.md's "Library and reuse" mentions bulk move.

## Acceptance

In `npm run dev`, select three clips from two different boards in the All view.
Use the footer's "Move to board" to move them to a third board: the toast says
"Moved 3 clips to <Board>", and all three are on that board. Click Undo: each is
back on its original board. Repeat with "New board…", typing a new name: the
board appears in the sidebar with the three clips. Undo returns them and leaves
the new board empty. Typing an existing board's name shows an error and moves
nothing. `npm run typecheck` and `npm test` pass.
