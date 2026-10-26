export const MIN_REDACT_LENGTH = 4;
export const MAX_OUTPUT_CHARS = 50_000;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 600;
const KILL_GRACE_MS = 2_000;
const STREAM_DRAIN_MS = 1_000;
const IS_POSIX = process.platform !== "win32";

const SHELL_PROGRAMS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

/** Bare `set` with no options/assignments — dumps the shell environment. */
const SHELL_BARE_SET_RE = /(?:^|[;&\n|]|&&|\|\|)\s*set\s*(?:[;&\n|]|$)/;

const POWERSHELL_ENV_DUMP_RE =
  /(?:Get-ChildItem|gci|dir|ls)\s+(?:-Path\s+|Path\s*=\s*)?Env:|\[System\.Environment\]::GetEnvironmentVariables/i;

interface RedactionEntry {
  key: string;
  value: string;
}

export class EnvDumpBlockedError extends Error {
  readonly pattern: string;

  constructor(pattern: string) {
    super(
      `Refusing env-dump command (${pattern}). Common dumps (env, printenv, bare set, PowerShell Env:) ` +
        "can leak secret values that best-effort redaction cannot fully scrub. " +
        "Re-run with allowDangerousEnvDump=true only if you understand the risk.",
    );
    this.name = "EnvDumpBlockedError";
    this.pattern = pattern;
  }
}

function programBasename(arg: string): string {
  const base = arg.split(/[/\\]/).pop() ?? arg;
  return base.toLowerCase();
}

/** True when `env` argv still has a command after options and NAME=value assignments. */
function envArgvHasCommand(args: string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      i += 1;
      break;
    }
    if (arg.startsWith("-")) {
      // `env -u NAME` / `env --unset=NAME` consume a following operand when needed.
      if (
        (arg === "-u" || arg === "--unset") &&
        i + 1 < args.length &&
        !args[i + 1]!.startsWith("-")
      ) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][\w]*=/.test(arg)) {
      i += 1;
      continue;
    }
    return true;
  }
  return i < args.length;
}

function extractShellScript(command: string[]): string | null {
  for (let i = 1; i < command.length; i++) {
    const flag = command[i]!.toLowerCase();
    if (
      flag === "-c" ||
      flag === "/c" ||
      flag === "-command" ||
      flag === "-encodedcommand" ||
      flag === "--%"
    ) {
      return command.slice(i + 1).join(" ");
    }
  }
  return null;
}

function detectShellEnvDump(script: string): string | null {
  if (POWERSHELL_ENV_DUMP_RE.test(script)) return "PowerShell Env:";
  if (SHELL_BARE_SET_RE.test(script)) return "set";
  if (/\bprintenv\b/.test(script)) return "printenv";
  // Prefer a conservative `env` match: bare `env` / `env -0` style, not `env FOO=bar cmd`.
  if (/(?:^|[;&\n|]|&&|\|\|)\s*(?:\/(?:usr\/)?bin\/)?env\s*(?:[;&\n|]|$)/.test(script)) {
    return "env";
  }
  if (/(?:^|[;&\n|]|&&|\|\|)\s*(?:\/(?:usr\/)?bin\/)?env\s+-[a-zA-Z0-9]*[0u]/.test(script)) {
    // `env -0` / `env -u` without a following command still dumps or is dump-adjacent; block
    // when there is no clear trailing command word after options/assignments.
    const after = script.replace(/^[\s\S]*?\benv\b/, "env");
    const tokens = after.trim().split(/\s+/);
    if (!envArgvHasCommand(tokens.slice(1))) return "env";
  }
  return null;
}

/**
 * Returns a human-readable dump pattern when `command` looks like a common environment dump.
 * Returns null for normal commands (including `env FOO=bar cmd`).
 */
export function detectEnvDumpCommand(command: string[]): string | null {
  if (command.length === 0) return null;

  const prog = programBasename(command[0]!);

  if (prog === "printenv" || prog === "printenv.exe") return "printenv";

  if (prog === "env" || prog === "env.exe") {
    return envArgvHasCommand(command.slice(1)) ? null : "env";
  }

  if ((prog === "set" || prog === "set.exe") && command.length === 1) return "set";

  if (SHELL_PROGRAMS.has(prog)) {
    const script = extractShellScript(command);
    if (script) {
      const hit = detectShellEnvDump(script);
      if (hit) return hit;
    }
  }

  return null;
}

/** Throws {@link EnvDumpBlockedError} unless `allowDangerousEnvDump` is true. */
export function assertEnvDumpAllowed(command: string[], allowDangerousEnvDump = false): void {
  const pattern = detectEnvDumpCommand(command);
  if (pattern && !allowDangerousEnvDump) {
    throw new EnvDumpBlockedError(pattern);
  }
}

/** Longest values first so a secret that contains another is replaced as a whole. */
function redactionEntries(secrets: Record<string, string>): RedactionEntry[] {
  const seen = new Set<string>();
  const entries: RedactionEntry[] = [];
  for (const [key, value] of Object.entries(secrets)) {
    if (value.length < MIN_REDACT_LENGTH || seen.has(value)) continue;
    seen.add(value);
    entries.push({ key, value });
  }
  return entries.sort((a, b) => b.value.length - a.value.length);
}

/** Best-effort: only verbatim occurrences are caught, not encoded or transformed values. */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let result = text;
  for (const { key, value } of redactionEntries(secrets)) {
    if (result.includes(value)) {
      result = result.split(value).join(`[REDACTED:${key}]`);
    }
  }
  return result;
}

/** Drops a trailing partial secret left behind when output was cut off mid-value. */
function stripTrailingSecretPrefix(text: string, secrets: Record<string, string>): string {
  let longest = 0;
  for (const { value } of redactionEntries(secrets)) {
    for (let length = Math.min(value.length - 1, text.length); length > longest; length--) {
      if (text.endsWith(value.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest > 0 ? text.slice(0, text.length - longest) : text;
}

interface CapturedStream {
  text: string;
  truncated: boolean;
}

async function captureStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  registerCancel: (cancel: () => void) => void,
): Promise<CapturedStream> {
  const reader = stream.getReader();
  registerCancel(() => {
    reader.cancel().catch(() => undefined);
  });
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (text.length >= limit) {
        truncated = true;
        continue;
      }
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) {
        text = text.slice(0, limit);
        truncated = true;
      }
    }
    if (!truncated) text += decoder.decode();
  } catch {
    // stream cancelled after a timeout; keep what was captured
  }

  return { text, truncated };
}

export interface RunCapturedOptions {
  command: string[];
  env: Record<string, string>;
  secrets: Record<string, string>;
  timeoutMs: number;
  maxOutputChars?: number;
  cwd?: string;
}

export interface RunCapturedResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function finalizeOutput(
  captured: CapturedStream,
  secrets: Record<string, string>,
  maxChars: number,
): { text: string; truncated: boolean } {
  let text = redactSecrets(captured.text, secrets);
  let truncated = captured.truncated;
  if (truncated) {
    text = stripTrailingSecretPrefix(text, secrets);
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  text = text.trimEnd();
  return { text: truncated ? `${text}\n... (truncated)` : text, truncated };
}

/**
 * Runs a command with a hard timeout, capturing at most `maxOutputChars` per stream while
 * draining the rest (so the child never blocks on a full pipe), and redacts secret values.
 */
export async function runCommandCaptured(options: RunCapturedOptions): Promise<RunCapturedResult> {
  const maxChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const longestSecret = Math.max(0, ...Object.values(options.secrets).map((v) => v.length));
  // Capture a little extra so a secret straddling the limit is still redacted as a whole.
  const captureLimit = maxChars + longestSecret;

  // A separate process group lets a timeout kill the whole tree (e.g. `sh -c "sleep 30"`).
  const proc = Bun.spawn(options.command, {
    env: options.env,
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: IS_POSIX,
  });

  const killTree = (signal: NodeJS.Signals) => {
    try {
      if (IS_POSIX) process.kill(-proc.pid, signal);
      else proc.kill(signal);
    } catch {
      // already exited
    }
  };

  const cancels: Array<() => void> = [];
  const registerCancel = (cancel: () => void) => cancels.push(cancel);

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
  }, options.timeoutMs);

  // Background processes may keep the pipes open after the command exits; stop waiting for them.
  void proc.exited.then(() => {
    drainTimer = setTimeout(() => {
      for (const cancel of cancels) cancel();
    }, STREAM_DRAIN_MS);
  });

  try {
    const [stdout, stderr] = await Promise.all([
      captureStream(proc.stdout, captureLimit, registerCancel),
      captureStream(proc.stderr, captureLimit, registerCancel),
    ]);
    await proc.exited;

    const out = finalizeOutput(stdout, options.secrets, maxChars);
    const err = finalizeOutput(stderr, options.secrets, maxChars);
    return {
      exitCode: proc.exitCode,
      signal: proc.signalCode == null ? null : String(proc.signalCode),
      timedOut,
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
    };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
    clearTimeout(drainTimer);
  }
}
