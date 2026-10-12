---
"@repo/cli": patch
---

`relic run` now shows the backend's error message, such as "Environment not found", instead of the generic "Server Error". When the environment is missing, it also explains how to create it or pick an existing one.
