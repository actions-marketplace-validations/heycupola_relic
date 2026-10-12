import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const IS_DEV = process.env.DEV === "true";

const DIR_NAME = IS_DEV ? "relic-dev" : "relic";

export function resolveConfigDir(
  dirName: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), dirName);
  }
  return posix.join(home, ".config", dirName);
}

export const CONFIG_DIR = resolveConfigDir(DIR_NAME);

export const KEYCHAIN_SERVICE = IS_DEV ? "com.relic.tui.dev" : "com.relic.tui";

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function isDev(): boolean {
  return IS_DEV;
}
