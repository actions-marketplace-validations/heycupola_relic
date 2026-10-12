# @repo/runner

Rust library for secure secret injection into child processes. Loaded via Bun FFI from the CLI. Secrets are injected as environment variables into a sandboxed child process and wiped from memory after use.

## FFI Interface

Single exported function:

```c
int32_t run_with_secrets(const char *command_json, const char *secrets_json);
```

- `command_json`: JSON array of strings (command + arguments), e.g. `["npm", "run", "deploy"]`
- `secrets_json`: JSON object of key-value pairs, e.g. `{"DATABASE_URL": "postgres://..."}`
- Returns the child process exit code, or `-1` on error. On Unix that's 0-255, or 128 + N when the child is killed by signal N; on Windows it's the full 32-bit exit code

## Security

### Memory

Secret values are stored in `Zeroizing<String>` (from the `zeroize` crate). Memory is overwritten with zeroes when dropped. The TypeScript side also zeroes its buffers after the FFI call.

### Core Dumps

On Unix, `RLIMIT_CORE` is set to zero before spawning the child process. This prevents core dumps that could leak secrets to disk.

Windows has no per-process equivalent. Crash dumps are controlled by Windows Error Reporting, which does not write local dumps unless `LocalDumps` is configured in the registry.

### Environment Isolation

The child process starts with a cleared environment (`env_clear()`). Only a small allowlist of system variables is inherited. On Unix:

```
PATH, HOME, USER, SHELL, TERM, LANG, LC_ALL, LC_CTYPE, TMPDIR, TZ
```

On Windows (matched case-insensitively, original casing preserved):

```
PATH, PATHEXT, SYSTEMROOT, SYSTEMDRIVE, WINDIR, COMSPEC, TEMP, TMP, HOME,
USERPROFILE, USERNAME, USERDOMAIN, HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA,
PROGRAMDATA, ALLUSERSPROFILE, PUBLIC, PROGRAMFILES, PROGRAMFILES(X86),
PROGRAMW6432, COMMONPROGRAMFILES, COMMONPROGRAMFILES(X86), COMMONPROGRAMW6432,
COMPUTERNAME, OS, NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE,
PROCESSOR_IDENTIFIER, PROCESSOR_LEVEL, PROCESSOR_REVISION, PSMODULEPATH, TERM,
LANG, TZ
```

Secrets are then injected on top of this clean environment.

### Program Resolution (Windows)

`std::process::Command` only appends `.exe` when searching `PATH`, so `npm` would not find `npm.cmd`. On Windows the runner resolves bare names against the child's `PATH` and `PATHEXT` (restricted to `.com`, `.exe`, `.bat`, `.cmd`), skipping the current directory. `.bat` and `.cmd` files are launched through std's `cmd.exe` escaping, which rejects arguments it cannot quote safely.

### Signal Forwarding

On Unix, SIGTERM and SIGINT are intercepted and forwarded to the child process via a global `AtomicU32` PID, allowing the child to shut down gracefully.

On Windows, Ctrl+C and Ctrl+Break reach every process attached to the console, including the child. The runner registers a console control handler while the child runs so it ignores those events, waits for the child to exit, and returns its exit code.

### Key Validation

Secret keys are validated before injection:

- No empty keys
- No null bytes in keys
- No `=` characters in keys (prevents env injection)

## Platform Support

| Feature | Unix | Windows |
|---------|------|---------|
| Environment clearing | Yes (allowlist) | Yes (allowlist) |
| Core dump prevention | Yes (`RLIMIT_CORE`) | No (Windows Error Reporting policy) |
| Signal forwarding | Yes (SIGTERM, SIGINT) | Ctrl+C / Ctrl+Break delivered by the console; runner waits for the child |
| `PATHEXT` resolution | n/a | Yes (`.com`, `.exe`, `.bat`, `.cmd`) |
| Exit code | 0-255, `-1` if killed by a signal | Full 32-bit code as `i32` |
| Secret injection | Yes | Yes |
| Zeroizing | Yes | Yes |

Prebuilt binaries are provided for: `darwin-arm64`, `darwin-x64`, `linux-x64`, `win32-x64`.

## Build

```bash
cargo build --release
```

Output:

| Platform | Library |
|----------|---------|
| macOS | `librelic_runner.dylib` |
| Linux | `librelic_runner.so` |
| Windows | `relic_runner.dll` |

## TypeScript Integration

The CLI loads the library via Bun `dlopen`:

```typescript
import { dlopen, FFIType } from "bun:ffi";

const lib = dlopen(libPath, {
  run_with_secrets: {
    args: [FFIType.cstring, FFIType.cstring],
    returns: FFIType.i32,
  },
});
```

Library search order:

1. `apps/cli/prebuilds/<platform>/` (production)
2. `packages/runner/target/release/` (development)
3. `packages/runner/target/debug/` (development fallback)

## Dependencies

- `libc` - Unix system calls (setrlimit, signal, kill)
- `windows-sys` - Windows console control handler (`SetConsoleCtrlHandler`)
- `serde` + `serde_json` - JSON deserialization
- `zeroize` - Secure memory wiping

## Development

```bash
cargo build          # Debug build
cargo build --release  # Release build
cargo test
cargo clippy -- -D warnings
cargo fmt --check
```
