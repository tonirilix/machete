# Build the desktop app with Electron, React, and TypeScript

The app initially targets personal use on macOS while preserving a path to
Windows and Linux. Use Electron with React and TypeScript, accepting its larger
runtime in exchange for a shared UI and future platform portability. The chosen
workflow uses explicit clipboard capture and manual pasting, which fit Electron's
built-in clipboard and global shortcut APIs; additional native integrations
require a separate justification.
