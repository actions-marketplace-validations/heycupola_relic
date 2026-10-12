//! Relic Runner - Secure secret injection and process spawning.
//!
//! Provides a single FFI entry point (`run_with_secrets`) that receives a
//! command and secrets as JSON, injects them as environment variables into
//! a child process, and returns its exit code. All network operations
//! (auth, fetching secrets) are handled by the TypeScript CLI.

use std::{
    collections::HashMap,
    ffi::{CStr, OsString},
    os::raw::c_char,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicU32,
};
use zeroize::Zeroizing;

/// PID of the active child process; read by `forward_signal` to relay signals.
static CHILD_PID: AtomicU32 = AtomicU32::new(0);

/// Relays the incoming signal to the child so it can shut down gracefully.
#[cfg(unix)]
unsafe extern "C" fn forward_signal(sig: libc::c_int) {
    let pid = CHILD_PID.load(std::sync::atomic::Ordering::SeqCst);
    if pid != 0 {
        libc::kill(pid as libc::pid_t, sig);
    }
}

/// Swallows Ctrl+C and Ctrl+Break while registered around the child's
/// lifetime. Windows delivers console control events to every process attached
/// to the console, so the child already receives them; the runner only needs
/// to survive long enough to collect the child's exit code.
#[cfg(windows)]
unsafe extern "system" fn ignore_console_interrupt(ctrl_type: u32) -> windows_sys::core::BOOL {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT};

    (ctrl_type == CTRL_C_EVENT || ctrl_type == CTRL_BREAK_EVENT) as _
}

/// Sets `RLIMIT_CORE` to zero to prevent core dumps that could leak secrets.
#[cfg(unix)]
fn disable_core_dumps() {
    unsafe {
        let rlim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        libc::setrlimit(libc::RLIMIT_CORE, &rlim);
    }
}

/// Minimal set of env vars re-inherited after `env_clear()` so the child can function.
#[cfg_attr(not(unix), allow(dead_code))]
const UNIX_INHERITED_ENV_KEYS: &[&str] = &[
    "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ",
];

/// Windows equivalent of `UNIX_INHERITED_ENV_KEYS`. Names are matched
/// case-insensitively. `SYSTEMROOT` in particular must survive: without it
/// Winsock, the CRT, and most system DLLs fail to initialize.
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_INHERITED_ENV_KEYS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "COMPUTERNAME",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "PSMODULEPATH",
    "TERM",
    "LANG",
    "TZ",
];

/// Extensions `CreateProcessW` can launch directly (`.com`, `.exe`) or that
/// std routes through `cmd.exe` with safe argument escaping (`.bat`, `.cmd`).
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_SPAWNABLE_EXTENSIONS: &[&str] = &["com", "exe", "bat", "cmd"];

#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

#[cfg(unix)]
fn inherited_env() -> Vec<(OsString, OsString)> {
    filter_inherited_env(std::env::vars_os(), UNIX_INHERITED_ENV_KEYS, false)
}

#[cfg(windows)]
fn inherited_env() -> Vec<(OsString, OsString)> {
    filter_inherited_env(std::env::vars_os(), WINDOWS_INHERITED_ENV_KEYS, true)
}

fn filter_inherited_env(
    vars: impl Iterator<Item = (OsString, OsString)>,
    allowlist: &[&str],
    case_insensitive: bool,
) -> Vec<(OsString, OsString)> {
    vars.filter(|(key, _)| {
        let Some(key) = key.to_str() else {
            return false;
        };
        allowlist.iter().any(|allowed| {
            if case_insensitive {
                allowed.eq_ignore_ascii_case(key)
            } else {
                *allowed == key
            }
        })
    })
    .collect()
}

/// Resolves a program name the way `cmd.exe` does (each `PATH` entry crossed
/// with `PATHEXT`), so `npm` finds `npm.cmd`. std only appends `.exe`. The
/// current directory is deliberately not searched.
#[cfg_attr(not(windows), allow(dead_code))]
fn resolve_windows_program(program: &str, path: &str, pathext: &str) -> Option<PathBuf> {
    let mut extensions: Vec<String> = pathext
        .split(';')
        .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|ext| WINDOWS_SPAWNABLE_EXTENSIONS.contains(&ext.as_str()))
        .collect();
    if extensions.is_empty() {
        extensions = WINDOWS_DEFAULT_PATHEXT
            .split(';')
            .map(|ext| ext.trim_start_matches('.').to_ascii_lowercase())
            .collect();
    }

    let has_spawnable_extension = Path::new(program)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            WINDOWS_SPAWNABLE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
        });

    let find_in = |base: &Path| -> Option<PathBuf> {
        if has_spawnable_extension {
            let candidate = base.join(program);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        extensions.iter().find_map(|ext| {
            let candidate = base.join(format!("{program}.{ext}"));
            candidate.is_file().then_some(candidate)
        })
    };

    let is_explicit_path =
        program.contains(['\\', '/']) || program.contains(':') || Path::new(program).has_root();
    if is_explicit_path {
        return find_in(Path::new(""));
    }

    path.split(';')
        .map(|dir| dir.trim().trim_matches('"'))
        .filter(|dir| !dir.is_empty())
        .find_map(|dir| find_in(Path::new(dir)))
}

/// Run a command with secrets injected as environment variables.
///
/// # Arguments
/// * `command_json` - JSON array: `["program", "arg1", "arg2"]`
/// * `secrets_json` - JSON object: `{"SECRET_KEY": "secret_value"}`
///
/// # Returns
/// * Exit code of the process, or -1 on error. On Unix this is 0-255, or 128 + N when
///   killed by signal N. On Windows it's the full 32-bit exit code reinterpreted as `i32`
///   (e.g. `0xC000013A` after Ctrl+C).
///
/// # Safety
/// Both pointers must be valid null-terminated C strings or null.
#[unsafe(no_mangle)]
pub extern "C" fn run_with_secrets(
    command_json: *const c_char,
    secrets_json: *const c_char,
) -> i32 {
    match run_with_secrets_impl(command_json, secrets_json) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("relic-runner error: {e}");
            -1
        }
    }
}

fn run_with_secrets_impl(
    command_json: *const c_char,
    secrets_json: *const c_char,
) -> Result<i32, String> {
    #[cfg(unix)]
    disable_core_dumps();

    let command: Vec<String> = parse_json_ptr(command_json, "command")?;

    if command.is_empty() {
        return Err("command array is empty".into());
    }

    let raw_secrets: HashMap<String, String> = if secrets_json.is_null() {
        HashMap::new()
    } else {
        parse_json_ptr(secrets_json, "secrets")?
    };

    // Validate secret keys
    for key in raw_secrets.keys() {
        if key.is_empty() {
            return Err("secret key must not be empty".into());
        }
        if key.contains('\0') {
            return Err(format!("secret key '{}' contains null byte", key));
        }
        if key.contains('=') {
            return Err(format!("secret key '{}' contains '='", key));
        }
    }

    // Wrap values in Zeroizing so they are wiped from memory on drop
    let secrets: HashMap<String, Zeroizing<String>> = raw_secrets
        .into_iter()
        .map(|(k, v)| (k, Zeroizing::new(v)))
        .collect();

    let program = &command[0];
    let args = &command[1..];

    let inherited = inherited_env();

    #[cfg(windows)]
    let mut cmd = {
        // Resolve against the child's PATH, which a secret may override.
        let env_value = |name: &str| -> Zeroizing<String> {
            let value = secrets
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str().to_owned())
                .or_else(|| {
                    inherited
                        .iter()
                        .find(|(key, _)| key.to_str().is_some_and(|k| k.eq_ignore_ascii_case(name)))
                        .and_then(|(_, value)| value.to_str().map(str::to_owned))
                })
                .unwrap_or_default();
            Zeroizing::new(value)
        };
        let resolved = resolve_windows_program(program, &env_value("PATH"), &env_value("PATHEXT"))
            .unwrap_or_else(|| PathBuf::from(program));
        Command::new(resolved)
    };

    #[cfg(not(windows))]
    let mut cmd = Command::new(program);

    cmd.args(args);
    cmd.env_clear();
    cmd.envs(inherited);

    for (key, value) in &secrets {
        cmd.env(key, value.as_str());
    }

    #[cfg(unix)]
    let _signals = SignalForwarding::install();

    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(
            Some(ignore_console_interrupt),
            1,
        );
    }

    let result = spawn_and_wait(&mut cmd, program);

    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(
            Some(ignore_console_interrupt),
            0,
        );
    }

    result
}

fn spawn_and_wait(cmd: &mut Command, program: &str) -> Result<i32, String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to execute '{}': {}", program, e))?;

    CHILD_PID.store(child.id(), std::sync::atomic::Ordering::SeqCst);

    let status = child.wait();

    CHILD_PID.store(0, std::sync::atomic::Ordering::SeqCst);

    let status = status.map_err(|e| format!("failed to wait for '{}': {}", program, e))?;

    Ok(exit_code(status))
}

/// Shell convention: a child terminated by signal N exits with 128 + N.
fn exit_code(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(1)
}

/// Forwards SIGINT/SIGTERM to the child while alive; restores the previous handlers on drop.
#[cfg(unix)]
struct SignalForwarding {
    previous_int: libc::sighandler_t,
    previous_term: libc::sighandler_t,
}

#[cfg(unix)]
impl SignalForwarding {
    fn install() -> Self {
        let handler = forward_signal as unsafe extern "C" fn(libc::c_int) as libc::sighandler_t;
        unsafe {
            Self {
                previous_int: libc::signal(libc::SIGINT, handler),
                previous_term: libc::signal(libc::SIGTERM, handler),
            }
        }
    }
}

#[cfg(unix)]
impl Drop for SignalForwarding {
    fn drop(&mut self) {
        unsafe {
            libc::signal(libc::SIGINT, self.previous_int);
            libc::signal(libc::SIGTERM, self.previous_term);
        }
    }
}

fn parse_json_ptr<T: serde::de::DeserializeOwned>(
    ptr: *const c_char,
    name: &str,
) -> Result<T, String> {
    if ptr.is_null() {
        return Err(format!("{name} is null"));
    }

    let c_str = unsafe { CStr::from_ptr(ptr) };
    let str = c_str
        .to_str()
        .map_err(|_| format!("{name} is not valid UTF-8"))?;

    serde_json::from_str(str).map_err(|e| format!("failed to parse {name}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[cfg(unix)]
    const SUCCEEDING_COMMAND: &str = r#"["echo", "hello"]"#;
    #[cfg(windows)]
    const SUCCEEDING_COMMAND: &str = r#"["cmd", "/C", "exit 0"]"#;

    #[cfg(unix)]
    const EXIT_7_COMMAND: &str = r#"["sh", "-c", "exit 7"]"#;
    #[cfg(windows)]
    const EXIT_7_COMMAND: &str = r#"["cmd", "/C", "exit 7"]"#;

    fn run(command: &str, secrets: Option<&str>) -> i32 {
        let cmd = CString::new(command).unwrap();
        let secrets = secrets.map(|s| CString::new(s).unwrap());
        run_with_secrets(
            cmd.as_ptr(),
            secrets.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
        )
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "relic-runner-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn os_pair(key: &str, value: &str) -> (OsString, OsString) {
        (OsString::from(key), OsString::from(value))
    }

    #[test]
    fn parses_valid_command() {
        let json = CString::new(r#"["node", "app.js"]"#).unwrap();
        let result: Vec<String> = parse_json_ptr(json.as_ptr(), "command").unwrap();
        assert_eq!(result, vec!["node", "app.js"]);
    }

    #[test]
    fn rejects_empty_command() {
        assert_eq!(run("[]", None), -1);
    }

    #[test]
    fn reject_null_pointer() {
        let result: Result<Vec<String>, _> = parse_json_ptr(std::ptr::null(), "command");
        assert!(result.is_err());
    }

    #[test]
    fn run_with_null_secrets() {
        assert_eq!(run(SUCCEEDING_COMMAND, None), 0);
    }

    #[test]
    fn rejects_invalid_json() {
        let json = CString::new("not json").unwrap();
        let result: Result<Vec<String>, _> = parse_json_ptr(json.as_ptr(), "command");
        assert!(result.is_err());
    }

    #[test]
    fn rejects_empty_key() {
        assert_eq!(run(SUCCEEDING_COMMAND, Some(r#"{"": "value"}"#)), -1);
    }

    #[test]
    fn rejects_key_with_equals() {
        assert_eq!(run(SUCCEEDING_COMMAND, Some(r#"{"FOO=BAR": "value"}"#)), -1);
    }

    #[test]
    fn rejects_key_with_null_byte() {
        assert_eq!(
            run(SUCCEEDING_COMMAND, Some(r#"{"FOO\u0000BAR": "value"}"#)),
            -1
        );
    }

    #[test]
    fn runs_with_valid_secrets() {
        assert_eq!(
            run(SUCCEEDING_COMMAND, Some(r#"{"MY_SECRET": "hunter2"}"#)),
            0
        );
    }

    #[test]
    fn rejects_nonexistent_program() {
        assert_eq!(run(r#"["this_program_does_not_exist_xyz"]"#, None), -1);
    }

    #[test]
    fn propagates_exit_code() {
        assert_eq!(run(EXIT_7_COMMAND, None), 7);
    }

    #[test]
    #[cfg(unix)]
    fn injects_secrets_into_cleared_environment() {
        std::env::set_var("RELIC_RUNNER_TEST_LEAK_UNIX", "leaked");
        let command = r#"["sh", "-c", "test \"$MY_SECRET\" = hunter2 && test -z \"$RELIC_RUNNER_TEST_LEAK_UNIX\" && test -n \"$PATH\""]"#;
        assert_eq!(run(command, Some(r#"{"MY_SECRET": "hunter2"}"#)), 0);
    }

    #[test]
    #[cfg(windows)]
    fn injects_secrets_into_cleared_environment() {
        std::env::set_var("RELIC_RUNNER_TEST_LEAK_WINDOWS", "leaked");
        let dir = temp_dir("env");
        std::fs::write(
            dir.join("relic-env-check.cmd"),
            "@echo off\r\n\
             if not \"%MY_SECRET%\"==\"hunter2\" exit /b 2\r\n\
             if defined RELIC_RUNNER_TEST_LEAK_WINDOWS exit /b 3\r\n\
             if not defined SystemRoot exit /b 4\r\n\
             exit /b 0\r\n",
        )
        .unwrap();

        let path = format!("{};{}", dir.display(), std::env::var("PATH").unwrap());
        let secrets = serde_json::json!({ "MY_SECRET": "hunter2", "PATH": path }).to_string();
        assert_eq!(run(r#"["relic-env-check"]"#, Some(&secrets)), 0);
    }

    #[test]
    fn filters_unix_env_case_sensitively() {
        let vars = vec![
            os_pair("PATH", "/usr/bin"),
            os_pair("Path", "/ignored"),
            os_pair("AWS_SECRET_ACCESS_KEY", "parent-secret"),
        ];
        let filtered = filter_inherited_env(vars.into_iter(), UNIX_INHERITED_ENV_KEYS, false);
        assert_eq!(filtered, vec![os_pair("PATH", "/usr/bin")]);
    }

    #[test]
    fn filters_windows_env_case_insensitively() {
        let vars = vec![
            os_pair("Path", r"C:\Windows\System32"),
            os_pair("SystemRoot", r"C:\Windows"),
            os_pair("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            os_pair("GITHUB_TOKEN", "parent-secret"),
        ];
        let filtered = filter_inherited_env(vars.into_iter(), WINDOWS_INHERITED_ENV_KEYS, true);
        assert_eq!(
            filtered,
            vec![
                os_pair("Path", r"C:\Windows\System32"),
                os_pair("SystemRoot", r"C:\Windows"),
                os_pair("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            ]
        );
    }

    #[test]
    fn resolves_cmd_shim_from_path_and_pathext() {
        let empty = temp_dir("empty");
        let bin = temp_dir("bin");
        std::fs::write(bin.join("npm.cmd"), "").unwrap();
        std::fs::write(bin.join("npm.ps1"), "").unwrap();

        let path = format!("{};\"{}\"", empty.display(), bin.display());
        let resolved = resolve_windows_program("npm", &path, ".COM;.EXE;.BAT;.CMD;.PS1");
        assert_eq!(resolved, Some(bin.join("npm.cmd")));
    }

    #[test]
    fn prefers_earlier_pathext_entries() {
        let bin = temp_dir("order");
        std::fs::write(bin.join("tool.exe"), "").unwrap();
        std::fs::write(bin.join("tool.cmd"), "").unwrap();

        let resolved = resolve_windows_program("tool", &bin.display().to_string(), ".EXE;.CMD");
        assert_eq!(resolved, Some(bin.join("tool.exe")));
    }

    #[test]
    fn keeps_explicit_spawnable_extension() {
        let bin = temp_dir("explicit");
        std::fs::write(bin.join("node.exe"), "").unwrap();

        let resolved = resolve_windows_program(
            "node.exe",
            &bin.display().to_string(),
            WINDOWS_DEFAULT_PATHEXT,
        );
        assert_eq!(resolved, Some(bin.join("node.exe")));
    }

    #[test]
    fn resolves_relative_paths_without_searching_path() {
        let bin = temp_dir("relative");
        std::fs::write(bin.join("build.bat"), "").unwrap();
        let program = format!("{}/build", bin.display());

        let resolved = resolve_windows_program(&program, "", WINDOWS_DEFAULT_PATHEXT);
        assert_eq!(resolved, Some(PathBuf::from(format!("{program}.bat"))));
    }

    #[test]
    fn falls_back_to_default_pathext_and_ignores_unspawnable_extensions() {
        let bin = temp_dir("fallback");
        std::fs::write(bin.join("script.ps1"), "").unwrap();
        std::fs::write(bin.join("deploy.cmd"), "").unwrap();
        let path = bin.display().to_string();

        assert_eq!(resolve_windows_program("script", &path, ".PS1"), None);
        assert_eq!(
            resolve_windows_program("deploy", &path, ""),
            Some(bin.join("deploy.cmd"))
        );
    }

    #[test]
    fn returns_none_when_program_is_missing() {
        let bin = temp_dir("missing");
        assert_eq!(
            resolve_windows_program(
                "missing",
                &bin.display().to_string(),
                WINDOWS_DEFAULT_PATHEXT
            ),
            None
        );
    }

    #[test]
    #[cfg(unix)]
    fn signal_terminated_child_exits_with_128_plus_signal() {
        let cmd = CString::new(r#"["sh", "-c", "kill -TERM $$"]"#).unwrap();
        assert_eq!(
            run_with_secrets(cmd.as_ptr(), std::ptr::null()),
            128 + libc::SIGTERM
        );
    }

    #[test]
    #[cfg(unix)]
    fn core_dumps_disabled() {
        disable_core_dumps();
        unsafe {
            let mut rlim = libc::rlimit {
                rlim_cur: 1,
                rlim_max: 1,
            };
            libc::getrlimit(libc::RLIMIT_CORE, &mut rlim);
            assert_eq!(rlim.rlim_cur, 0);
            assert_eq!(rlim.rlim_max, 0);
        }
    }
}
