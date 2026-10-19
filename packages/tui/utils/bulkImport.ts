import { type BulkImportSecret, detectType } from "@repo/bulk-import";

export {
  type BulkImportSecret,
  detectType,
  type ValidationError,
  type ValidationResult,
  validateBulkImportJson,
} from "@repo/bulk-import";

export type CollisionAction = "skip" | "overwrite" | "cancel";

export interface CollisionInfo {
  key: string;
  existingSecretId: string;
}

export type BulkImportFormat = "env" | "json";

export type SecretType = BulkImportSecret["type"];

/** Keeps a known type while the value still fits it; unknown keys fall back to detection. */
export function resolveType(value: string, knownType?: SecretType): SecretType {
  if (!knownType) return detectType(value);
  if (knownType === "string") return "string";
  return detectType(value) === knownType ? knownType : "string";
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", '"': '"', "\\": "\\" };

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([nr"\\])/g, (_, char: string) => ESCAPES[char] ?? char);
}

function escapeDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function findClosingQuote(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/** Multiline values (e.g. pretty-printed JSON) stay readable in single quotes, which take no escapes. */
export function formatEnvValue(value: string): string {
  if (value.includes("\n") && !/['\r]/.test(value)) return `'${value}'`;
  return /[\s#"']/.test(value) ? `"${escapeDoubleQuoted(value)}"` : value;
}

/** An unterminated quote returns null so it is read as a literal single-line value. */
function readSingleQuoted(
  lines: string[],
  startLine: number,
  rawValue: string,
): { value: string; endLine: number } | null {
  let quoted = rawValue.slice(1);
  let line = startLine;
  let closing = quoted.indexOf("'");
  while (closing === -1 && line + 1 < lines.length) {
    line++;
    quoted += `\n${lines[line] ?? ""}`;
    closing = quoted.indexOf("'");
  }
  return closing === -1 ? null : { value: quoted.slice(0, closing), endLine: line };
}

export function parseEnvContent(
  content: string,
  knownTypes?: ReadonlyMap<string, SecretType>,
): BulkImportSecret[] {
  const secrets: BulkImportSecret[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (key === "") continue;

    // NOTE: Only the start is trimmed so a quoted value keeps whitespace before its line break.
    const rawValue = (lines[i] ?? "").slice((lines[i] ?? "").indexOf("=") + 1).trimStart();
    let value: string;

    if (rawValue.startsWith('"')) {
      let quoted = rawValue;
      let closing = findClosingQuote(quoted, 1);
      while (closing === -1 && i + 1 < lines.length) {
        i++;
        quoted += `\n${lines[i] ?? ""}`;
        closing = findClosingQuote(quoted, 1);
      }
      value = unescapeDoubleQuoted(quoted.slice(1, closing === -1 ? undefined : closing));
    } else if (rawValue.startsWith("'")) {
      const singleQuoted = readSingleQuoted(lines, i, rawValue);
      if (singleQuoted) {
        value = singleQuoted.value;
        i = singleQuoted.endLine;
      } else {
        value = rawValue.trimEnd();
      }
    } else {
      value = rawValue.trimEnd();
    }

    secrets.push({ key, value, type: resolveType(value, knownTypes?.get(key)) });
  }

  return secrets;
}

/** A value holding a JSON object or array is shown as nested JSON instead of an escaped string. */
export function expandJsonValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * Turns a nested JSON value back into the stored string. An unchanged value keeps its original
 * text byte for byte; an edited one follows the original's layout (pretty when it was multi-line).
 */
export function stringifyJsonValue(value: object, original?: string): string {
  if (original !== undefined) {
    const previous = expandJsonValue(original);
    if (typeof previous === "object" && JSON.stringify(previous) === JSON.stringify(value)) {
      return original;
    }
    if (original.includes("\n")) return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(value);
}

/** Converts nested JSON values in editor items back to strings before validation. */
export function collapseJsonValues(
  data: unknown,
  originals?: ReadonlyMap<string, string>,
): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((item: unknown) => {
    if (typeof item !== "object" || item === null || !("value" in item)) return item;
    const { value } = item;
    if (typeof value !== "object" || value === null) return item;
    const key = "key" in item && typeof item.key === "string" ? item.key : undefined;
    return {
      ...item,
      value: stringifyJsonValue(value, key ? originals?.get(key) : undefined),
      type: "string",
    };
  });
}

export function envToJson(
  envContent: string,
  scopeMap?: ReadonlyMap<string, string>,
  knownTypes?: ReadonlyMap<string, SecretType>,
): string {
  const secrets = parseEnvContent(envContent, knownTypes).map((s) => ({
    key: s.key,
    value: typeof s.value === "string" ? expandJsonValue(s.value) : s.value,
    type: s.type,
    scope: scopeMap?.get(s.key) || "shared",
  }));
  return JSON.stringify(secrets, null, 2);
}

export function jsonToEnv(jsonContent: string, originals?: ReadonlyMap<string, string>): string {
  try {
    let parsed = JSON.parse(jsonContent);
    if (!Array.isArray(parsed)) {
      if (typeof parsed === "object" && parsed !== null && "key" in parsed) {
        parsed = [parsed];
      } else {
        return "";
      }
    }

    const lines: string[] = [];
    for (const item of parsed) {
      if (typeof item === "object" && item !== null) {
        const hasKey = "key" in item && typeof item.key === "string";
        const hasValue = "value" in item;

        if (hasKey && hasValue) {
          const key = String(item.key);
          const raw: unknown = item.value;
          const value =
            typeof raw === "object" && raw !== null
              ? stringifyJsonValue(raw, originals?.get(key))
              : raw !== undefined && raw !== null
                ? String(raw)
                : "";
          if (key === "" && value === "") continue;

          lines.push(`${key}=${formatEnvValue(value)}`);
        }
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** Secrets the editor would overwrite without the user having loaded them into the editor. */
export function findCollisions(
  editorKeys: string[],
  existingSecrets: ReadonlyArray<{ id: string; key: string }>,
  prefilledSecretIds: ReadonlySet<string>,
): CollisionInfo[] {
  const keys = new Set(editorKeys);
  return existingSecrets
    .filter((s) => keys.has(s.key) && !prefilledSecretIds.has(s.id))
    .map((s) => ({ key: s.key, existingSecretId: s.id }));
}

export function computeRemovedKeys(existingKeys: string[], editorKeys: string[]): string[] {
  const editorKeySet = new Set(editorKeys);
  return existingKeys.filter((key) => !editorKeySet.has(key));
}
