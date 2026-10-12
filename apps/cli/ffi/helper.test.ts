import { describe, expect, test } from "bun:test";
import { isCompiledBinaryPath } from "./helper";

describe("isCompiledBinaryPath", () => {
  test("recognizes the macOS and Linux standalone root", () => {
    expect(isCompiledBinaryPath("/$bunfs/root")).toBe(true);
  });

  test("recognizes the Windows standalone root with either separator", () => {
    expect(isCompiledBinaryPath("B:\\~BUN\\root")).toBe(true);
    expect(isCompiledBinaryPath("B:/~BUN/root")).toBe(true);
  });

  test("ignores regular source directories", () => {
    expect(isCompiledBinaryPath("/Users/dev/relic/apps/cli/ffi")).toBe(false);
    expect(isCompiledBinaryPath("C:\\Users\\dev\\relic\\apps\\cli\\ffi")).toBe(false);
    expect(isCompiledBinaryPath("B:\\projects\\relic")).toBe(false);
  });
});
