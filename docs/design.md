# Machete MVP

The user accepted interview recommendations Q1-Q22 and requested a simpler
approach to backup and further design detail. The user confirmed this consolidated
MVP and requested shadcn/ui components for the Electron renderer.

## Purpose and platform

- A reusable collection of commands, links, and reference text for personal use.
- macOS first, preserving a path to Windows and Linux later.
- Electron with React and TypeScript. See
  [ADR 0002](adr/0002-electron-desktop.md).
- Local data on one Mac, with manual export/import for transfer and backup. See
  [ADR 0001](adr/0001-local-collection.md).

## Capture

- Save clips deliberately. On macOS, read the source app's selected text before
  taking focus. Use Accessibility and a clipboard-preserving Copy fallback;
  see [ADR 0003](adr/0003-macos-selection-capture.md). Clipboard capture remains
  available explicitly, and manual entry uses the same editor.
- Cmd+Shift+Space opens capture. The shortcut is configurable, and a registration
  conflict is visible to the user.
- Start each new capture in Inbox, with a board selector before saving.
- Preview or edit before explicitly saving. Enter inserts a newline; Cmd+Enter
  saves. Preserve whitespace in multiline text and code.
- Keep one unfinished draft separate from saved clips. It survives hiding and
  restart. Successful selection or clipboard captures append with a blank line,
  preserving the draft's board. Manual entry resumes it. Provide an explicit
  Discard action. Failed selection capture leaves existing content intact and
  explains the failure; it never substitutes stale clipboard content.

## Library and reuse

- One compact window with clear browsing and capture modes, a Dock icon, and
  menu bar access on macOS. Closing the window keeps the app running.
- Plain text and URLs, organized in flat named boards with one board per clip.
- Clips are editable references that remain available after copying.
- Newest-saved clips appear first; editing and copying preserve their positions.
- Each explicit save creates an independent clip, including duplicate content.
- Case-insensitive content search across boards, with an optional board filter.
  Trash is searched separately.
- Copy selected clips in visible list order, separated by blank lines, preserving
  internal whitespace. The user pastes into the destination app manually.

## Organization and recovery

- Inbox is permanent. Deleting a custom board moves its active clips to Inbox.
- Deleted clips remain in recoverable Trash until explicitly emptied.
- Export/import preserves the complete collection of boards and clips.
- Confirmed backup simplification following the user's scope correction: basic
  file validation and confirmation before replacing the collection. Dedicated
  restore-preview screens and automatic pre-import backups are deferred.

## Scope boundary

Automatic clipboard history, synchronization, images, attachments, rich text,
task completion, manual clip ordering, automatic
pasting, and backup merging are outside the first version.

Further interview rounds on implementation details are unnecessary for this MVP.
Use simple implementation defaults, documenting architectural tradeoffs when
they meet the ADR criteria. Revisit product decisions when a concrete prototype
or daily use exposes a need.

## First implementation milestone

Prove the core loop: copy text in another app, invoke capture, edit and save it
to a board, find it, and copy it back. Verify local persistence after restart and
the window's focus behavior during this loop. Build the remaining accepted MVP
features around that working loop.

## Technical exploration

The delegated exploration returned these constraints. They inform later decisions
without deciding product scope:

- Electron supports standard global shortcuts while the app lacks focus.
  Registration can fail when another app owns the shortcut. See
  [globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut).
- Electron supports reading and writing the system clipboard. Reading copied
  content when capture is invoked supports explicit saving. See
  [clipboard](https://www.electronjs.org/docs/latest/api/clipboard).
- Inference from Electron's documented accelerator model: double Shift is a
  timed sequence of modifier presses rather than a normal accelerator and would
  need an additional event monitor or hook. See
  [accelerator](https://www.electronjs.org/docs/latest/api/accelerator).
- Capturing selections directly from other apps requires additional platform
  integration and depends on what those apps expose. On macOS, selected text
  can be exposed through Accessibility. See
  [selected text](https://developer.apple.com/documentation/applicationservices/kaxselectedtextattribute).
- Hiding an Electron window does not itself guarantee reactivation of a specific
  external app. Electron's focused-window API concerns its own windows, and
  macOS activation requests are not guaranteed. Focus return needs practical
  validation. See
  [BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) and
  [macOS activation](https://developer.apple.com/documentation/appkit/nsrunningapplication/activate%28from%3Aoptions%3A%29).
