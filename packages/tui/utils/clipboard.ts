import {
  type CliRenderer,
  type ClipboardService,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
} from "@opentui/core";

export const CLIPBOARD_CLEAR_DELAY_MS = 30_000;

let service: ClipboardService | null = null;

export function getClipboard(renderer: CliRenderer): ClipboardService {
  service ??= createClipboard({
    host: createHostClipboard(),
    terminal: createRendererClipboardAdapter(renderer),
  });
  return service;
}

/** Writes to the native clipboard locally, falling back to OSC52 over SSH or when no host clipboard exists. */
export async function copyText(clipboard: ClipboardService, text: string): Promise<boolean> {
  try {
    const result = await clipboard.writeText(text, { destination: "best-available" });
    return result.host.status === "written" || result.terminal.status === "attempted";
  } catch {
    return false;
  }
}

/** Clears the clipboard only when it still holds `text`, so a newer copy by the user survives. */
export async function clearClipboardIfUnchanged(
  clipboard: ClipboardService,
  text: string,
): Promise<void> {
  try {
    const current = await clipboard.read({ preferredTypes: ["text/plain"] });
    if (current.status !== "read") return;
    if (new TextDecoder().decode(current.representation.bytes) !== text) return;
    await clipboard.clear({ destination: "best-available" });
  } catch {
    // Best effort: a failed clear leaves the value in place.
  }
}

/** Never blocks exit for long: a stuck native clipboard operation is abandoned after `timeoutMs`. */
export async function disposeClipboard(timeoutMs = 200): Promise<void> {
  const current = service;
  service = null;
  if (!current) return;
  await Promise.race([
    current.dispose().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
