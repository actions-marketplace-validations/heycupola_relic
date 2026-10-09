import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWhoamiSid, restrictToCurrentUser, type SpawnSync } from "./permissions";

const SID = "S-1-5-21-3623811015-3361044348-30300820-1013";
const tempDir = mkdtempSync(join(tmpdir(), "relic-permissions-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function recordingSpawn(results: Record<string, { exitCode: number; stdout?: string }>) {
  const calls: string[][] = [];
  const spawn: SpawnSync = (command) => {
    calls.push(command);
    const result = results[command[0] ?? ""] ?? { exitCode: 1 };
    return { exitCode: result.exitCode, stdout: result.stdout ?? "" };
  };
  return { calls, spawn };
}

describe("parseWhoamiSid", () => {
  test("extracts the SID from whoami CSV output", () => {
    expect(parseWhoamiSid(`"desktop-abc\\dev","${SID}"\r\n`)).toBe(SID);
  });

  test("returns null for unexpected output", () => {
    expect(parseWhoamiSid("ERROR: access denied")).toBeNull();
  });
});

describe("restrictToCurrentUser", () => {
  test.skipIf(process.platform === "win32")("sets mode 0600 on Unix", async () => {
    const file = join(tempDir, "unix-password");
    writeFileSync(file, "secret", { mode: 0o644 });

    expect(await restrictToCurrentUser(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("replaces inherited ACEs with a grant for the current SID on Windows", async () => {
    const { calls, spawn } = recordingSpawn({
      whoami: { exitCode: 0, stdout: `"desktop-abc\\dev","${SID}"\r\n` },
      icacls: { exitCode: 0 },
    });

    const applied = await restrictToCurrentUser(
      "C:\\Users\\dev\\AppData\\Roaming\\relic\\password",
      {
        platform: "win32",
        spawn,
      },
    );

    expect(applied).toBe(true);
    expect(calls).toEqual([
      ["whoami", "/user", "/fo", "csv", "/nh"],
      [
        "icacls",
        "C:\\Users\\dev\\AppData\\Roaming\\relic\\password",
        "/inheritance:r",
        "/grant:r",
        `*${SID}:F`,
      ],
    ]);
  });

  test("does not touch the ACL when the SID cannot be resolved", async () => {
    const { calls, spawn } = recordingSpawn({ whoami: { exitCode: 1 } });

    expect(await restrictToCurrentUser("C:\\password", { platform: "win32", spawn })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("reports failure when icacls fails", async () => {
    const { spawn } = recordingSpawn({
      whoami: { exitCode: 0, stdout: `"dev","${SID}"` },
      icacls: { exitCode: 5 },
    });

    expect(await restrictToCurrentUser("C:\\password", { platform: "win32", spawn })).toBe(false);
  });

  test.skipIf(process.platform !== "win32")(
    "removes inherited access from a real file on Windows",
    async () => {
      const file = join(tempDir, "windows-password");
      writeFileSync(file, "secret");

      expect(await restrictToCurrentUser(file)).toBe(true);

      const acl = Bun.spawnSync(["icacls", file], { stdout: "pipe" }).stdout.toString();
      expect(acl).not.toContain("(I)");
      expect(acl).not.toMatch(/BUILTIN\\Users/i);
    },
  );
});
