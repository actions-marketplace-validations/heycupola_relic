import { describe, expect, test } from "bun:test";
import { resolveConfigDir } from "./config";

describe("resolveConfigDir", () => {
  test("uses ~/.config on macOS and Linux", () => {
    expect(resolveConfigDir("relic", "linux", {}, "/home/dev")).toBe("/home/dev/.config/relic");
  });

  test("uses %APPDATA% on Windows and falls back to the Roaming folder", () => {
    expect(resolveConfigDir("relic", "win32", { APPDATA: "C:\\Roaming" }, "C:\\Users\\dev")).toBe(
      "C:\\Roaming\\relic",
    );
    expect(resolveConfigDir("relic", "win32", {}, "C:\\Users\\dev")).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\relic",
    );
  });
});
