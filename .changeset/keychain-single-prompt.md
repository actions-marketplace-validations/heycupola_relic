---
"@repo/cli": patch
"@repo/auth": patch
---

Ask for keychain access only once when the TUI starts. On macOS, opening the TUI used to show the "relic wants to access key com.relic.tui" prompt twice, because two parts of the TUI read the stored password at the same time before the first read finished. Concurrent reads now share a single keychain request.
