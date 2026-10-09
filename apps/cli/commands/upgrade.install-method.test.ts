import { describe, expect, test } from "bun:test";
import {
  canUpgradeInPlace,
  detectInstallMethodFromExecutablePath,
  getLocateCommand,
  getUpgradeCommand,
  parseLocateOutput,
  POWERSHELL_INSTALL_COMMAND,
  SHELL_INSTALL_COMMAND,
} from "./upgrade.install-method";

describe("detectInstallMethodFromExecutablePath", () => {
  test("detects bun global install from platform binary path", () => {
    const path = "/Users/dev/.bun/install/global/node_modules/relic-cli-darwin-arm64/bin/relic";
    expect(detectInstallMethodFromExecutablePath(path)).toBe("bun");
  });

  test("detects npm global install from platform binary path", () => {
    const path = "/opt/homebrew/lib/node_modules/relic-cli-darwin-arm64/bin/relic";
    expect(detectInstallMethodFromExecutablePath(path)).toBe("npm");
  });

  test("detects homebrew formula binary in Cellar", () => {
    const path = "/opt/homebrew/Cellar/relic/0.9.3/bin/relic";
    expect(detectInstallMethodFromExecutablePath(path)).toBe("homebrew");
  });

  test("detects the default install script location in ~/.relic/bin", () => {
    const path = "/Users/dev/.relic/bin/relic";
    expect(detectInstallMethodFromExecutablePath(path, {})).toBe("script");
  });

  test("detects an install script in a custom RELIC_INSTALL_DIR", () => {
    const path = "/opt/tools/relic/bin/relic";
    expect(
      detectInstallMethodFromExecutablePath(path, { RELIC_INSTALL_DIR: "/opt/tools/relic" }),
    ).toBe("script");
  });

  test("detects the install script location on Windows", () => {
    expect(
      detectInstallMethodFromExecutablePath("C:\\Users\\dev\\.relic\\bin\\relic.exe", {}),
    ).toBe("script");
  });

  test("returns null for unrecognized paths", () => {
    expect(detectInstallMethodFromExecutablePath("/usr/local/bin/relic")).toBe(null);
  });

  describe("on Windows", () => {
    test("detects npm global install", () => {
      const path =
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\relic\\node_modules\\relic-cli-windows-x64\\bin\\relic.exe";
      expect(detectInstallMethodFromExecutablePath(path)).toBe("npm");
    });

    test("detects bun global install", () => {
      const path =
        "C:\\Users\\dev\\.bun\\install\\global\\node_modules\\relic-cli-windows-x64\\bin\\relic.exe";
      expect(detectInstallMethodFromExecutablePath(path)).toBe("bun");
    });

    test("detects scoop install", () => {
      const path = "C:\\Users\\dev\\scoop\\apps\\relic\\0.9.4\\relic.exe";
      expect(detectInstallMethodFromExecutablePath(path)).toBe("scoop");
    });

    test("detects the PowerShell installer location", () => {
      const path = "C:\\Users\\dev\\.relic\\bin\\relic.exe";
      expect(detectInstallMethodFromExecutablePath(path)).toBe("script");
    });
  });
});

describe("getUpgradeCommand", () => {
  test("re-runs the matching installer for script installs", () => {
    expect(getUpgradeCommand("script", "darwin")).toBe(SHELL_INSTALL_COMMAND);
    expect(getUpgradeCommand("script", "win32")).toBe(POWERSHELL_INSTALL_COMMAND);
  });

  test("uses the package manager command otherwise", () => {
    expect(getUpgradeCommand("scoop", "win32")).toBe("scoop update relic");
    expect(getUpgradeCommand("npm", "win32")).toBe("npm install -g relic@latest");
  });
});

describe("canUpgradeInPlace", () => {
  test("allows every method on Unix", () => {
    expect(canUpgradeInPlace("npm", "linux")).toBe(true);
    expect(canUpgradeInPlace("homebrew", "darwin")).toBe(true);
  });

  test("only allows the PowerShell installer on Windows", () => {
    expect(canUpgradeInPlace("script", "win32")).toBe(true);
    expect(canUpgradeInPlace("npm", "win32")).toBe(false);
    expect(canUpgradeInPlace("bun", "win32")).toBe(false);
    expect(canUpgradeInPlace("scoop", "win32")).toBe(false);
  });
});

describe("locating other installs", () => {
  test("uses where on Windows and which elsewhere", () => {
    expect(getLocateCommand("win32")).toBe("where relic");
    expect(getLocateCommand("linux")).toBe("which -a relic");
  });

  test("parses CRLF output and removes duplicates", () => {
    const stdout =
      "C:\\Users\\dev\\.relic\\bin\\relic.exe\r\nC:\\Users\\dev\\AppData\\Roaming\\npm\\relic.cmd\r\nC:\\Users\\dev\\.relic\\bin\\relic.exe\r\n";
    expect(parseLocateOutput(stdout)).toEqual([
      "C:\\Users\\dev\\.relic\\bin\\relic.exe",
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\relic.cmd",
    ]);
  });
});
