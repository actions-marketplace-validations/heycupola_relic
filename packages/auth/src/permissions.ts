import { chmod } from "node:fs/promises";

export interface SpawnResult {
  exitCode: number;
  stdout: string;
}

export type SpawnSync = (command: string[]) => SpawnResult;

export interface RestrictOptions {
  platform?: NodeJS.Platform;
  spawn?: SpawnSync;
}

function defaultSpawn(command: string[]): SpawnResult {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

export function parseWhoamiSid(output: string): string | null {
  return output.match(/"(S-1-[\d-]+)"/)?.[1] ?? null;
}

/**
 * Limits a file to the current user: `0600` on Unix; on Windows, drops
 * inherited ACEs and grants full control to the current user's SID only.
 * Returns `false` when the Windows ACL could not be applied.
 */
export async function restrictToCurrentUser(
  path: string,
  { platform = process.platform, spawn = defaultSpawn }: RestrictOptions = {},
): Promise<boolean> {
  if (platform !== "win32") {
    await chmod(path, 0o600);
    return true;
  }

  try {
    const whoami = spawn(["whoami", "/user", "/fo", "csv", "/nh"]);
    const sid = whoami.exitCode === 0 ? parseWhoamiSid(whoami.stdout) : null;
    if (!sid) return false;

    return spawn(["icacls", path, "/inheritance:r", "/grant:r", `*${sid}:F`]).exitCode === 0;
  } catch {
    return false;
  }
}
