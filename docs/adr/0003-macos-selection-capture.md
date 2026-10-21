# Read selections inside the macOS app

The user extended capture to read selected text from other apps without a manual
Copy step. Use a small in-process Node-API bridge to macOS Accessibility so the
permission belongs to Machete; a separate helper or AppleScript process can
introduce a different permission identity. Read before taking focus, use a
clipboard-preserving Copy fallback for apps without accessible selection text,
and save each successful shortcut capture as a separate clip in Inbox. The
shortcut is an explicit save action, so it never opens the draft editor or
appends to an unfinished manual draft. Failed or empty selections save nothing.

This replaces the original behavior of appending shortcut captures to a draft.
Manual composition retains its draft until Save or Discard; appending clipboard
text is an explicit action inside that editor. Keeping these paths independent
makes the shortcut predictable even while a manual draft exists.
