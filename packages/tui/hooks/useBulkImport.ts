import type { CliRenderer, KeyEvent, TextareaRenderable } from "@opentui/core";
import { createLogger, trackEvent } from "@repo/logger";
import { useMemo, useRef, useState } from "react";
import type { Key } from "../types/keyboard";
import type { Secret, SecretScope, SecretValueType } from "../types/models";
import {
  type BulkImportFormat,
  type CollisionInfo,
  collapseJsonValues,
  computeRemovedKeys,
  envToJson,
  findCollisions,
  jsonToEnv,
  parseEnvContent,
  type ValidationResult,
  validateBulkImportJson,
} from "../utils/bulkImport";
import { copyText, getClipboard } from "../utils/clipboard";
import { type ProjectLocation, secretsInView } from "../utils/projectItems";
import { useTaskQueue } from "./useTaskQueue";

const logger = createLogger("tui");

const EMPTY_TEMPLATE = "# Add your secrets here\nAPI_KEY=your_key_here";
const TAB_TEXT = "  ";
const EMPTY_VALIDATION: ValidationResult = {
  valid: false,
  secrets: [],
  errors: [],
  duplicateKeys: [],
};

interface OriginalSecret {
  secretId: string;
  value: string;
  type: SecretValueType;
  scope: SecretScope;
}

interface UseBulkImportOptions {
  visible: boolean;
  location: ProjectLocation;
  allSecrets: Secret[];
  renderer: CliRenderer;
  onClose: () => void;
  updateSecretBulk: (args: {
    environmentId: string;
    folderId?: string;
    secrets: Array<{
      secretId?: string;
      key: string;
      value: string;
      originalValue?: string;
      valueType: SecretValueType;
      scope?: SecretScope;
    }>;
    mode?: "skip" | "overwrite";
  }) => Promise<unknown>;
  deleteSecret: (secretId: string) => Promise<void>;
}

function parseContent(
  content: string,
  format: BulkImportFormat,
  knownTypes: ReadonlyMap<string, SecretValueType>,
  originalValues: ReadonlyMap<string, string>,
) {
  return validateBulkImportJson(
    format === "env"
      ? parseEnvContent(content, knownTypes)
      : collapseJsonValues(JSON.parse(content), originalValues),
  );
}

export function isSaveKey(key: Key): boolean {
  return (key.name === "s" && (key.ctrl || key.meta)) || (key.name === "return" && key.meta);
}

export function isToggleFormatKey(key: Key): boolean {
  return (key.name === "t" && key.ctrl) || (key.name === "j" && key.meta);
}

// NOTE: Ctrl+C quits the app, so copy takes ⌘C (kitty keyboard protocol), ⌥C, or Ctrl+Shift+C.
export function isCopyKey(key: KeyEvent): boolean {
  return key.name === "c" && (key.super || key.meta || (key.ctrl && key.shift));
}

export function isCutKey(key: KeyEvent): boolean {
  return key.name === "x" && (key.ctrl || key.super || key.meta);
}

export function useBulkImport({
  visible,
  location,
  allSecrets,
  renderer,
  onClose,
  updateSecretBulk,
  deleteSecret,
}: UseBulkImportOptions) {
  const { attemptTask, showSuccess, showError } = useTaskQueue();
  const editorRef = useRef<TextareaRenderable | null>(null);
  const [content, setContent] = useState("");
  const [initialContent, setInitialContent] = useState("");
  const [format, setFormat] = useState<BulkImportFormat>("env");
  const [scopes, setScopes] = useState<Map<string, string>>(new Map());
  const [types, setTypes] = useState<Map<string, SecretValueType>>(new Map());
  const [originals, setOriginals] = useState<Map<string, OriginalSecret>>(new Map());
  const savingRef = useRef(false);

  const originalValues = useMemo(
    () => new Map([...originals].map(([key, o]) => [key, o.value])),
    [originals],
  );

  const validation = useMemo((): ValidationResult => {
    const trimmed = content.trim();
    if (!visible || !trimmed) return EMPTY_VALIDATION;
    try {
      return parseContent(trimmed, format, types, originalValues);
    } catch {
      return { ...EMPTY_VALIDATION, errors: [{ message: "Invalid JSON syntax" }] };
    }
  }, [visible, content, format, types, originalValues]);

  const collisions = useMemo<CollisionInfo[]>(() => {
    if (!validation.valid) return [];
    const prefilledIds = new Set([...originals.values()].map((o) => o.secretId));
    return findCollisions(
      validation.secrets.map((s) => s.key),
      secretsInView(allSecrets, location),
      prefilledIds,
    );
  }, [validation, originals, allSecrets, location]);

  /** Before the editor mounts the text becomes its initial value; afterwards it is an undoable edit. */
  const setEditorText = (text: string) => {
    setContent(text);
    const editor = editorRef.current;
    if (editor) editor.replaceText(text);
    else setInitialContent(text);
  };

  const readContent = () => editorRef.current?.plainText ?? content;
  const syncContent = () => setContent(editorRef.current?.plainText ?? "");

  const open = (secrets: Secret[], values: ReadonlyMap<string, string>) => {
    const loaded = new Map<string, OriginalSecret>();
    for (const s of secrets) {
      const value = values.get(s.id);
      if (value === undefined) continue;
      loaded.set(s.key, {
        secretId: s.id,
        value,
        type: s.type ?? "string",
        scope: s.scope ?? "shared",
      });
    }
    setOriginals(loaded);
    setScopes(new Map([...loaded].map(([key, o]) => [key, o.scope])));
    setTypes(new Map([...loaded].map(([key, o]) => [key, o.type])));

    if (loaded.size === 0) {
      setEditorText(EMPTY_TEMPLATE);
    } else {
      const secretsJson = JSON.stringify(
        [...loaded].map(([key, o]) => ({ key, value: o.value, type: o.type, scope: o.scope })),
      );
      setEditorText(jsonToEnv(secretsJson) || "");
    }
    setFormat("env");
  };

  const close = () => {
    onClose();
    setContent("");
    setInitialContent("");
    setOriginals(new Map());
    setScopes(new Map());
    setTypes(new Map());
  };

  const toggleFormat = () => {
    const current = readContent().trim();
    if (!current) return;

    if (format === "env") {
      const json = envToJson(current, scopes, types);
      if (json && json !== "[]") {
        setEditorText(json);
        setFormat("json");
      }
      return;
    }

    try {
      const parsed = JSON.parse(current);
      if (Array.isArray(parsed)) {
        const updatedScopes = new Map(scopes);
        const updatedTypes = new Map(types);
        for (const item of parsed) {
          if (item?.key && item?.scope) updatedScopes.set(item.key, item.scope);
          if (item?.key && ["string", "number", "boolean"].includes(item?.type)) {
            updatedTypes.set(item.key, item.type);
          }
        }
        setScopes(updatedScopes);
        setTypes(updatedTypes);
      }
    } catch {
      // Invalid JSON keeps the previous scopes and types
    }
    const env = jsonToEnv(current, originalValues);
    if (env) {
      setEditorText(env);
      setFormat("env");
    }
  };

  const copySelection = async (cut: boolean) => {
    const editor = editorRef.current;
    const text = editor?.hasSelection() ? editor.getSelectedText() : "";
    if (!editor || !text) return;
    if (!(await copyText(getClipboard(renderer), text))) {
      showError("Couldn't access the clipboard");
      return;
    }
    if (cut) {
      editor.deleteSelection();
      syncContent();
    }
    showSuccess(cut ? "Cut selection" : "Copied selection");
  };

  const save = async () => {
    if (savingRef.current) return;
    const trimmed = readContent().trim();
    const { environmentId } = location;
    if (!trimmed || !environmentId) return;

    let result: ReturnType<typeof parseContent>;
    try {
      result = parseContent(trimmed, format, types, originalValues);
    } catch (error) {
      logger.debug("Bulk import parse failed:", error);
      return;
    }
    if (!result.valid || result.secrets.length === 0) return;

    const { secrets } = result;
    const keyToSecretId = new Map(secretsInView(allSecrets, location).map((s) => [s.key, s.id]));
    const removedKeys = computeRemovedKeys(
      [...originals.keys()],
      secrets.map((s) => s.key),
    );

    savingRef.current = true;
    try {
      const saved = await attemptTask(`Saving ${secrets.length} secrets...`, async () => {
        await updateSecretBulk({
          environmentId,
          folderId: location.viewLevel === "folder" ? location.folderId || undefined : undefined,
          secrets: secrets.map((s) => {
            const original = originals.get(s.key);
            const secretId = s.secretId || original?.secretId || keyToSecretId.get(s.key);
            return {
              secretId,
              key: s.key,
              value: String(s.value),
              originalValue:
                original && original.secretId === secretId ? original.value : undefined,
              valueType: s.type,
              scope: (s.scope || scopes.get(s.key) || "shared") as SecretScope,
            };
          }),
          mode: "overwrite",
        });

        for (const key of removedKeys) {
          const secretId = originals.get(key)?.secretId;
          if (secretId) await deleteSecret(secretId);
        }
      });

      if (!saved) {
        trackEvent("bulk_import_completed", { success: false });
        return;
      }

      trackEvent("bulk_import_completed", {
        count: secrets.length,
        deleted: removedKeys.length,
        success: true,
      });
      showSuccess(
        removedKeys.length > 0
          ? `${secrets.length} secrets saved, ${removedKeys.length} removed`
          : `${secrets.length} secrets saved`,
      );
      close();
    } finally {
      savingRef.current = false;
    }
  };

  /** Returns true when the key was handled here; any other key is left to the editor. */
  const handleKey = (key: KeyEvent): boolean => {
    if (key.name === "escape") close();
    else if (isToggleFormatKey(key)) toggleFormat();
    else if (isSaveKey(key)) void save();
    else if (isCopyKey(key)) void copySelection(false);
    else if (isCutKey(key)) void copySelection(true);
    else if (key.name === "tab" && !key.ctrl && !key.meta) editorRef.current?.insertText(TAB_TEXT);
    else {
      // NOTE: The editor handles the key after this returns, and undo/redo emit no content change.
      queueMicrotask(syncContent);
      return false;
    }
    return true;
  };

  return {
    open,
    close,
    handleKey,
    editorRef,
    initialContent,
    content,
    syncContent,
    format,
    validation,
    collisions,
  };
}
