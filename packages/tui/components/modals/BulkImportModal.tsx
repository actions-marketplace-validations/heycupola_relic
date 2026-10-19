/** @jsxImportSource @opentui/react */
import { type KeyBinding, SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { type RefObject, useEffect, useMemo } from "react";
import { useTaskQueue } from "../../hooks/useTaskQueue";
import type {
  BulkImportSecret,
  CollisionAction,
  CollisionInfo,
  ValidationResult,
} from "../../utils/bulkImport";
import { THEME_COLORS } from "../../utils/constants";
import { highlightContent } from "../../utils/ui";
import { Modal } from "../shared/Modal";

interface BulkImportModalProps {
  visible: boolean;
  editorRef: RefObject<TextareaRenderable | null>;
  initialContent: string;
  content: string;
  format: "env" | "json";
  validation: ValidationResult;
  collisions: CollisionInfo[];
  onContentChange: () => void;
}

const MAX_EDITOR_ROWS = 18;
const MIN_EDITOR_ROWS = 5;
const MAX_EDITOR_COLUMNS = 76;
/** Rows the modal needs around the editor: title, format row, status, info, guide bar, padding. */
const MODAL_CHROME_HEIGHT = 15;

/** Merged over OpenTUI's defaults; Ctrl+A selects all like a GUI editor, so Home goes to line start. */
const EDITOR_KEY_BINDINGS: KeyBinding[] = [
  { name: "z", ctrl: true, action: "undo" },
  { name: "z", ctrl: true, shift: true, action: "redo" },
  { name: "y", ctrl: true, action: "redo" },
  { name: "a", ctrl: true, action: "select-all" },
  { name: "home", action: "line-home" },
  { name: "end", action: "line-end" },
  { name: "home", shift: true, action: "select-line-home" },
  { name: "end", shift: true, action: "select-line-end" },
];

function applyHighlights(
  editor: TextareaRenderable,
  style: SyntaxStyle,
  content: string,
  format: "env" | "json",
) {
  editor.clearAllHighlights();
  highlightContent(content, format).forEach((parts, lineIdx) => {
    const lineLength = content.split("\n")[lineIdx]?.length ?? 0;
    let start = 0;
    for (const part of parts) {
      const end = Math.min(start + part.text.length, lineLength);
      if (end > start) {
        const styleId =
          style.getStyleId(part.color) ?? style.registerStyle(part.color, { fg: part.color });
        editor.addHighlight(lineIdx, { start, end, styleId });
      }
      start = end;
    }
  });
}

export function BulkImportModal({
  visible,
  editorRef,
  initialContent,
  content,
  format,
  validation,
  collisions,
  onContentChange,
}: BulkImportModalProps) {
  const { isRunning } = useTaskQueue();
  const { width: termWidth, height: termHeight } = useTerminalDimensions();
  const editorHeight = Math.max(
    MIN_EDITOR_ROWS,
    Math.min(MAX_EDITOR_ROWS, termHeight - MODAL_CHROME_HEIGHT),
  );
  const editorWidth = Math.max(30, Math.min(MAX_EDITOR_COLUMNS, termWidth - 8));

  const syntaxStyle = useMemo(() => SyntaxStyle.create(), []);
  useEffect(() => () => syntaxStyle.destroy(), [syntaxStyle]);

  useEffect(() => {
    const editor = editorRef.current;
    if (visible && editor) applyHighlights(editor, syntaxStyle, content, format);
  }, [visible, content, format, editorRef, syntaxStyle]);

  const shortcuts = [
    { key: "^s", description: "save", disabled: isRunning },
    {
      key: "^t",
      description: format === "env" ? "switch to JSON" : "switch to .env",
      disabled: isRunning,
    },
    { key: "^z", description: "undo", disabled: isRunning },
    { key: "⇧+arrows", description: "select", disabled: isRunning },
    { key: "⌥c", description: "copy", disabled: isRunning },
    { key: "^x", description: "cut", disabled: isRunning },
    { key: "esc", description: "cancel", disabled: isRunning },
  ];

  return (
    <Modal
      visible={visible}
      title="Edit secrets"
      width={editorWidth + 4}
      height={editorHeight + MODAL_CHROME_HEIGHT - 2}
      shortcuts={shortcuts}
    >
      <box flexDirection="column" width={editorWidth}>
        <box flexDirection="row" justifyContent="space-between">
          <text>
            <span fg={THEME_COLORS.textMuted}>Format: </span>
            <span fg={THEME_COLORS.primary}>{format === "env" ? ".env" : "JSON"}</span>
          </text>
          {editorWidth >= 60 && (
            <text fg={THEME_COLORS.textMuted}>
              {format === "json" && "• Set type and scope per secret"}
              {format === "env" && "• Paste your .env file"}
            </text>
          )}
        </box>
        <box
          height={editorHeight}
          width={editorWidth}
          backgroundColor={THEME_COLORS.inputBg}
          marginTop={1}
          paddingLeft={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <line-number
            fg={THEME_COLORS.textDim}
            bg={THEME_COLORS.inputBg}
            minWidth={3}
            paddingRight={1}
            flexGrow={1}
          >
            <textarea
              ref={editorRef}
              initialValue={initialContent}
              focused={visible && !isRunning}
              keyBindings={EDITOR_KEY_BINDINGS}
              syntaxStyle={syntaxStyle}
              onContentChange={onContentChange}
              placeholder="Start typing or paste content..."
              placeholderColor={THEME_COLORS.textMuted}
              textColor={THEME_COLORS.text}
              focusedTextColor={THEME_COLORS.text}
              backgroundColor={THEME_COLORS.inputBg}
              focusedBackgroundColor={THEME_COLORS.inputBg}
              cursorColor={THEME_COLORS.primary}
              selectionBg={THEME_COLORS.statusBarActive}
              wrapMode="word"
              flexGrow={1}
            />
          </line-number>
        </box>
        <box height={2} marginTop={1} flexDirection="column">
          {validation.errors.length > 0 && (
            <text>
              <span fg={THEME_COLORS.error}>✗ </span>
              <span fg={THEME_COLORS.textMuted}>{validation.errors[0]?.message}</span>
            </text>
          )}
          {validation.valid && (
            <text>
              <span fg={THEME_COLORS.success}>✓ </span>
              <span fg={THEME_COLORS.textMuted}>{validation.secrets.length} secrets ready</span>
              {collisions.length > 0 && (
                <span fg={THEME_COLORS.warning}>
                  {" "}
                  · will overwrite {collisions.length} secret{collisions.length > 1 ? "s" : ""}{" "}
                  added elsewhere
                </span>
              )}
            </text>
          )}
          {!validation.valid && validation.errors.length === 0 && (
            <text fg={THEME_COLORS.textMuted}>Start typing or paste content...</text>
          )}
        </box>
        <box height={1} marginTop={1}>
          <text fg={THEME_COLORS.textMuted} wrapMode="none">
            ℹ Saved to the current path only. Removed lines are deleted.
          </text>
        </box>
      </box>
    </Modal>
  );
}

export type { BulkImportSecret, CollisionAction, CollisionInfo };
