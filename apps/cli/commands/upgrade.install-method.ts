import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type InstallMethod = "homebrew" | "npm" | "bun" | "scoop" | "script" | "unknown";

export const POWERSHELL_INSTALL_COMMAND =
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://withrelic.com/install.ps1 | iex"';
export const SHELL_INSTALL_COMMAND = "curl -fsSL https://withrelic.com/install | bash";

function isScriptInstallPath(normalized: string, env: Record<string, string | undefined>): boolean {
  if (/\/\.relic\/bin\/relic(\.exe)?$/i.test(normalized)) return true;
  if (!env.RELIC_INSTALL_DIR) return false;
  const binDir = `${resolve(env.RELIC_INSTALL_DIR).replace(/\\/g, "/").replace(/\/$/, "")}/bin/`;
  return normalized.toLowerCase().startsWith(binDir.toLowerCase());
}

export function resolveExecutablePath(): string | null {
  try {
    const candidate = process.argv[0];
    if (!candidate) return null;
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

/** Infer package manager from the running relic binary (not from what else is installed). */
export function detectInstallMethodFromExecutablePath(
  exePath: string,
  env: Record<string, string | undefined> = process.env,
): InstallMethod | null {
  const normalized = exePath.replace(/\\/g, "/");

  if (isScriptInstallPath(normalized, env)) {
    return "script";
  }

  if (normalized.includes("/.bun/install/global/")) {
    return "bun";
  }

  if (/\/Cellar\/relic\//i.test(normalized)) {
    return "homebrew";
  }

  if (/\/scoop\/apps\/relic\//i.test(normalized)) {
    return "scoop";
  }

  if (normalized.includes("/node_modules/")) {
    return "npm";
  }

  return null;
}

export function getUpgradeCommand(
  method: Exclude<InstallMethod, "unknown">,
  platform: NodeJS.Platform = process.platform,
): string {
  switch (method) {
    case "homebrew":
      return "brew upgrade relic";
    case "npm":
      return "npm install -g relic@latest";
    case "bun":
      return "bun install -g relic@latest";
    case "scoop":
      return "scoop update relic";
    case "script":
      return platform === "win32" ? POWERSHELL_INSTALL_COMMAND : SHELL_INSTALL_COMMAND;
  }
}

/**
 * Windows locks the image of a running `.exe`, so package managers cannot
 * replace `relic.exe` while `relic upgrade` is executing it. The PowerShell
 * installer works around this by renaming the running binary first.
 */
export function canUpgradeInPlace(
  method: Exclude<InstallMethod, "unknown">,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" || method === "script";
}

export function getLocateCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "where relic" : "which -a relic";
}

export function parseLocateOutput(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
