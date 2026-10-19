---
"@repo/cli": minor
"@repo/tui": minor
---

Copy secrets and edit multi-line values in the TUI. Press `y` on a secret to copy its value (or `Y` for `KEY=value`). The clipboard clears after 30 seconds and falls back to OSC 52 over SSH. The TUI no longer captures the mouse, so the terminal's own drag-to-select and copy work everywhere. The secret editor now supports selection, select all, copy, cut, and undo/redo. Multi-line values such as JSON configs keep their line breaks: they are written in single quotes in `.env` format and shown as nested objects in JSON format, and unchanged JSON values keep their original text when saved. Pasting into name fields now keeps spaces.
