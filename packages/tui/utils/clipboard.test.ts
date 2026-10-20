import { beforeEach, describe, expect, test } from "bun:test";
import type { ClipboardService } from "@opentui/core";
import { clearClipboardIfUnchanged, copyText } from "./clipboard";

type WriteResult = Awaited<ReturnType<ClipboardService["writeText"]>>;

let writeResult: WriteResult;
let clipboardText: string | null;
const writes: Array<{ text: string; destination: string }> = [];
let clears = 0;

const fakeService: ClipboardService = {
  writeText: async (text, options) => {
    writes.push({ text, destination: options.destination });
    return writeResult;
  },
  read: async () =>
    clipboardText === null
      ? { status: "unsupported" }
      : {
          status: "read",
          representation: {
            mimeType: "text/plain",
            bytes: new TextEncoder().encode(clipboardText),
          },
        },
  clear: async () => {
    clears++;
    return {
      host: { status: "cleared" },
      terminal: { status: "not-attempted", capability: "unknown" },
    };
  },
  dispose: async () => {},
};

const NOT_ATTEMPTED = { status: "not-attempted", capability: "unknown" } as const;

beforeEach(() => {
  writes.length = 0;
  clears = 0;
  clipboardText = null;
});

describe("copyText", () => {
  test("prefers the host clipboard and falls back to the terminal", async () => {
    writeResult = { host: { status: "written" }, terminal: NOT_ATTEMPTED };
    expect(await copyText(fakeService, "secret")).toBe(true);
    expect(writes).toEqual([{ text: "secret", destination: "best-available" }]);
  });

  test("reports success when only OSC52 was attempted", async () => {
    writeResult = {
      host: { status: "unsupported" },
      terminal: { status: "attempted", capability: "supported" },
    };
    expect(await copyText(fakeService, "secret")).toBe(true);
  });

  test("reports failure when nothing reached a clipboard", async () => {
    writeResult = { host: { status: "unsupported" }, terminal: NOT_ATTEMPTED };
    expect(await copyText(fakeService, "secret")).toBe(false);
  });
});

describe("clearClipboardIfUnchanged", () => {
  test("clears a value that is still on the clipboard", async () => {
    clipboardText = "secret";
    await clearClipboardIfUnchanged(fakeService, "secret");
    expect(clears).toBe(1);
  });

  test("keeps something the user copied afterwards", async () => {
    clipboardText = "something else";
    await clearClipboardIfUnchanged(fakeService, "secret");
    expect(clears).toBe(0);
  });

  test("does nothing when the clipboard cannot be read", async () => {
    await clearClipboardIfUnchanged(fakeService, "secret");
    expect(clears).toBe(0);
  });
});
