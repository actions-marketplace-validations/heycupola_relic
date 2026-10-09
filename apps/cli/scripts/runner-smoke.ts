import { ptr } from "bun:ffi";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { RunnerBridge } from "../ffi/bridge";

// Exercises the runner through the same FFI path as `relic run`. Compile it
// with `bun build --compile` and place the runner library next to the binary
// to also cover standalone library resolution.

const PARENT_ONLY = "RELIC_SMOKE_PARENT_ONLY";

if (!process.env[PARENT_ONLY]) {
  console.error(`Set ${PARENT_ONLY} in the parent environment before running this script.`);
  process.exit(1);
}

const runner = await RunnerBridge.getInstance();

function run(command: string[], secrets: Record<string, string> = {}): number {
  const commandBuffer = Buffer.from(`${JSON.stringify(command)}\0`, "utf-8");
  const secretsBuffer = Buffer.from(`${JSON.stringify(secrets)}\0`, "utf-8");
  try {
    return runner.runWithSecrets(ptr(commandBuffer), ptr(secretsBuffer));
  } finally {
    commandBuffer.fill(0);
    secretsBuffer.fill(0);
  }
}

const isWindows = process.platform === "win32";
const tempDir = mkdtempSync(join(tmpdir(), "relic-runner-smoke-"));
const failures: string[] = [];

function check(name: string, actual: number, expected: number) {
  const ok = actual === expected;
  console.log(`${ok ? "ok" : "FAIL"} - ${name} (exit ${actual}, expected ${expected})`);
  if (!ok) failures.push(name);
}

try {
  check(
    "propagates exit code",
    run(isWindows ? ["cmd", "/C", "exit 7"] : ["sh", "-c", "exit 7"]),
    7,
  );

  if (isWindows) {
    writeFileSync(
      join(tempDir, "relic-smoke-check.cmd"),
      [
        "@echo off",
        'if not "%RELIC_SMOKE_SECRET%"=="injected" exit /b 2',
        `if defined ${PARENT_ONLY} exit /b 3`,
        "if not defined SystemRoot exit /b 4",
        "exit /b 0",
        "",
      ].join("\r\n"),
    );
    check(
      "resolves .cmd via PATHEXT, injects secrets, clears parent env",
      run(["relic-smoke-check"], {
        RELIC_SMOKE_SECRET: "injected",
        PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
      }),
      0,
    );
  } else {
    check(
      "injects secrets, clears parent env",
      run(["sh", "-c", `test "$RELIC_SMOKE_SECRET" = injected && test -z "$${PARENT_ONLY}"`], {
        RELIC_SMOKE_SECRET: "injected",
      }),
      0,
    );
  }

  check("reports a missing program", run(["relic-smoke-program-that-does-not-exist"]), -1);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`${failures.length} runner smoke check(s) failed`);
  process.exit(1);
}
