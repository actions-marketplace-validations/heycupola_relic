import { createLogger } from "@repo/logger";
import open from "open";
import { THEME_COLORS } from "./constants";

const logger = createLogger("tui");

export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  if (maxLength === 1) return "…";
  return `${text.slice(0, maxLength - 1)}…`;
}

export function openUrl(url: string): Promise<void> {
  return open(url).then(
    () => undefined,
    (error: unknown) => {
      logger.error("Failed to open URL in browser:", error);
    },
  );
}

interface HighlightedPart {
  text: string;
  color: string;
}

function highlightEnvLine(line: string): HighlightedPart[] {
  if (line.trimStart().startsWith("#")) {
    return [{ text: line, color: THEME_COLORS.textMuted }];
  }

  if (line.trim() === "") {
    return [{ text: line || " ", color: THEME_COLORS.text }];
  }

  const equalsIndex = line.indexOf("=");
  if (equalsIndex > 0) {
    return [
      { text: line.slice(0, equalsIndex), color: THEME_COLORS.primary },
      { text: "=", color: THEME_COLORS.textMuted },
      { text: line.slice(equalsIndex + 1), color: THEME_COLORS.secondary },
    ];
  }

  return [{ text: line, color: THEME_COLORS.text }];
}

function highlightJsonLine(line: string): HighlightedPart[] {
  const parts: HighlightedPart[] = [];
  let remaining = line;

  while (remaining.length > 0) {
    const wsMatch = remaining.match(/^(\s+)/);
    if (wsMatch?.[1]) {
      parts.push({ text: wsMatch[1], color: THEME_COLORS.text });
      remaining = remaining.slice(wsMatch[1].length);
      continue;
    }

    const firstChar = remaining[0];
    if (firstChar && /^[[\]{}:,]/.test(firstChar)) {
      parts.push({ text: firstChar, color: THEME_COLORS.textMuted });
      remaining = remaining.slice(1);
      continue;
    }

    const stringMatch = remaining.match(/^"([^"\\]|\\.)*"/);
    if (stringMatch) {
      const str = stringMatch[0];
      const afterStr = remaining.slice(str.length).trim();
      const color = afterStr.startsWith(":") ? THEME_COLORS.primary : THEME_COLORS.secondary;
      parts.push({ text: str, color });
      remaining = remaining.slice(str.length);
      continue;
    }

    const numMatch = remaining.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/);
    if (numMatch) {
      parts.push({ text: numMatch[0], color: THEME_COLORS.accent });
      remaining = remaining.slice(numMatch[0].length);
      continue;
    }

    const keywordMatch = remaining.match(/^(true|false|null)\b/);
    if (keywordMatch) {
      parts.push({ text: keywordMatch[0], color: THEME_COLORS.success });
      remaining = remaining.slice(keywordMatch[0].length);
      continue;
    }

    if (firstChar) {
      parts.push({ text: firstChar, color: THEME_COLORS.text });
      remaining = remaining.slice(1);
    }
  }

  return parts.length === 0 ? [{ text: " ", color: THEME_COLORS.text }] : parts;
}

function findQuote(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** The quote a line leaves open, so the following lines are colored as part of that value. */
function openQuoteAfter(line: string): string | null {
  if (line.trimStart().startsWith("#")) return null;
  const equalsIndex = line.indexOf("=");
  if (equalsIndex <= 0) return null;
  const value = line.slice(equalsIndex + 1).trimStart();
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return null;
  return findQuote(value, 1, quote) === -1 ? quote : null;
}

function highlightEnvContent(lines: string[]): HighlightedPart[][] {
  const result: HighlightedPart[][] = [];
  let openQuote: string | null = null;
  for (const line of lines) {
    if (openQuote) {
      const closing = findQuote(line, 0, openQuote);
      if (closing === -1) {
        result.push([{ text: line, color: THEME_COLORS.secondary }]);
        continue;
      }
      result.push([
        { text: line.slice(0, closing + 1), color: THEME_COLORS.secondary },
        { text: line.slice(closing + 1), color: THEME_COLORS.textMuted },
      ]);
      openQuote = null;
      continue;
    }
    result.push(highlightEnvLine(line));
    openQuote = openQuoteAfter(line);
  }
  return result;
}

/** Colored parts for every line of `content`; an empty line may yield a single padding space. */
export function highlightContent(content: string, format: "env" | "json"): HighlightedPart[][] {
  const lines = content.split("\n");
  return format === "env" ? highlightEnvContent(lines) : lines.map(highlightJsonLine);
}
