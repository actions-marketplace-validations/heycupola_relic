---
"@repo/cli": patch
"@repo/tui": patch
---

Fix extra blank space in TUI modals. The password prompt and log out confirmation now fit their content. The change password dialog no longer leaves empty rows when the new password field isn't focused, and password requirements stay visible while you fill in the form. The secret editor drops an empty row under its status line, gives that row to the editor, and says "1 secret" instead of "1 secrets".
