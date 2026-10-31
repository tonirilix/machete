# Roadmap — Bulk move selected clips to a board

Move every selected clip to another board, or to a new board, in one action from
the selection footer, with an Undo toast. See `docs/chamb/bulk-move/spec.md`.

### Phase 1 — Core commands for bulk move, new-board move and Undo
- **Status:** verified
- **After:** none
- **Covers:** R1, R2, R3
- **Type:** feature
- **Size:** S
- **Surface:** core
- **Visual delta:** none
- **Validation:** none
- **Premises:** `move-clips` already takes many ids (`src/shared/library.ts:225-228`); commands are validated by `commandSchema` and applied by `applyCommand` in `src/shared/library.ts`; main parses with the same `commandSchema` (`src/main/index.ts:233-241`), so a new command needs no IPC change
- **DoD:**
  1. `grep -n "move-clips-to-new-board" src/shared/library.ts` shows a schema entry and an `applyCommand` case
  2. `grep -n "place-clips" src/shared/library.ts` shows a schema entry and an `applyCommand` case
  3. `tests/library.test.ts` has tests for `move-clips` with several ids, a missing board, and a missing clip
  4. `tests/library.test.ts` has tests showing `move-clips-to-new-board` creates the board and moves the clips, and rejects a duplicate name and an unknown clip id
  5. `tests/library.test.ts` has tests showing `place-clips` sets each clip's board independently, and rejects an unknown clip and an unknown board
  6. `npm run typecheck` passes
  7. `npm test` passes
- **Notes:** `git grep -c move-clips origin/main -- src tests` → 1 use in App.tsx, 2 in library.ts, 0 in tests. Typecheck and test baselines are taken by `chamb baseline` and the planner.

### Phase 2 — Footer "Move to board" for existing boards, with Undo toast
- **Status:** verified
- **After:** Phase 1
- **Covers:** R4, R5, R6, R8, R9, R10
- **Type:** feature
- **Size:** M
- **Surface:** ui
- **Visual delta:** minor
- **Validation:** In `npm run dev`, select clips from two boards in the All view, move them with the footer's "Move to board" to a third board, check the toast text, then click Undo and check each clip is back on its own board; check the Trash view shows no Move control; check a card's own "Move to board" still moves only that card
- **Premises:** The selection footer is at `src/renderer/src/App.tsx:526-580`; bulk trash's Undo toast at `App.tsx:182-195` is the pattern to follow; pure renderer helpers can be unit-tested from `tests/` as `tests/draft-editing.test.ts` does
- **DoD:**
  1. A pure helper module `src/renderer/src/lib/bulk-move.ts` exports the move-target list (all boards except the one being viewed), the Undo placements (each clip's board before the move), and the toast message
  2. `tests/bulk-move.test.ts` covers the target list for a board view and the All view, the Undo placements for clips from different boards, and the message for 1 and for several clips ("Moved 1 clip to X", "Moved 3 clips to X")
  3. `grep -n "move-clips" src/renderer/src/App.tsx` shows the footer sending one `move-clips` command with all selected visible ids
  4. `grep -n "place-clips" src/renderer/src/App.tsx` shows the toast's Undo action
  5. `npm run typecheck` passes
  6. `npm test` passes
  7. Human check: the Validation steps above behave as described
- **Notes:** none

### Phase 3 — "New board…" destination in the footer menu
- **Status:** verified
- **After:** Phase 2
- **Covers:** R7, R8, R9
- **Type:** feature
- **Size:** S
- **Surface:** ui
- **Visual delta:** minor
- **Validation:** In `npm run dev`, select clips from two boards, choose "New board…", enter a new name: the board appears in the sidebar with the clips and the toast says "Moved N clips to <name>"; click Undo: the clips return and the new board stays empty; repeat with an existing board's name: an error shows, the dialog stays open, nothing moves
- **Premises:** The sidebar's board-name dialog is at `src/renderer/src/App.tsx:596-670`; `run` keeps a dialog open on failure because it returns null (`App.tsx:131-141`)
- **DoD:**
  1. `grep -n "New board" src/renderer/src/App.tsx` shows the footer menu item
  2. `grep -n "move-clips-to-new-board" src/renderer/src/App.tsx` shows one command sent on dialog submit
  3. `npm run typecheck` passes
  4. `npm test` passes
  5. Human check: the Validation steps above behave as described
- **Notes:** none

### Phase 4 — Document bulk move
- **Status:** pending
- **After:** Phase 3
- **Covers:** R11
- **Type:** chore
- **Size:** S
- **Surface:** docs
- **Visual delta:** none
- **Validation:** none
- **Premises:** README.md's "Use Machete" section lists the selection shortcuts ("Cmd/Shift+click: select clips")
- **DoD:**
  1. `grep -n "Move to board" README.md` finds the bulk-move entry in "Use Machete"
  2. `grep -ni "move" docs/design.md` finds bulk move under "Library and reuse"
  3. `npx prettier --check README.md docs/design.md` passes
- **Notes:** none
