import { describe, expect, test } from "bun:test";
import { resolveConfigDir } from "./paths";

describe("resolveConfigDir", () => {
  test("uses ~/.config on macOS and Linux", () => {
    expect(resolveConfigDir("relic", "darwin", {}, "/Users/dev")).toBe("/Users/dev/.config/relic");
    expect(resolveConfigDir("relic-dev", "linux", {}, "/home/dev")).toBe(
      "/home/dev/.config/relic-dev",
    );
  });

  test("uses %APPDATA% on Windows", () => {
    const env = { APPDATA: "D:\\Profiles\\dev\\AppData\\Roaming", HOME: "/c/Users/dev" };
    expect(resolveConfigDir("relic", "win32", env, "C:\\Users\\dev")).toBe(
      "D:\\Profiles\\dev\\AppData\\Roaming\\relic",
    );
  });

  test("falls back to the profile's Roaming folder when %APPDATA% is unset", () => {
    expect(resolveConfigDir("relic", "win32", {}, "C:\\Users\\dev")).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\relic",
    );
  });
});
