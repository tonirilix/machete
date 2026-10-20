# Read selections inside the macOS app

The user extended capture to read selected text from other apps without a manual
Copy step. Use a small in-process Node-API bridge to macOS Accessibility so the
permission belongs to Cliptoboards; a separate helper or AppleScript process can
introduce a different permission identity. Read before taking focus, use a
clipboard-preserving Copy fallback for apps without accessible selection text,
and append successful captures to the draft without saving a clip automatically.
