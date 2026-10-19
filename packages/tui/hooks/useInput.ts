import { useCallback, useRef, useState } from "react";
import type { Key } from "../types/keyboard";

function insertAt(
  str: string,
  pos: number,
  text: string,
  maxLength?: number,
): { value: string; cursor: number } {
  const before = str.slice(0, pos);
  const after = str.slice(pos);
  const newText = before + text + after;
  const limited = maxLength ? newText.slice(0, maxLength) : newText;
  return { value: limited, cursor: Math.min(pos + text.length, limited.length) };
}

function deleteAt(str: string, pos: number): { value: string; cursor: number } {
  if (pos === 0) return { value: str, cursor: 0 };
  return { value: str.slice(0, pos - 1) + str.slice(pos), cursor: pos - 1 };
}

function wordBoundaryBefore(str: string, pos: number): number {
  if (pos === 0) return 0;
  let p = pos - 1;
  while (p > 0 && /\s/.test(str[p] ?? "")) p--;
  while (p > 0 && !/\s/.test(str[p - 1] ?? "")) p--;
  return p;
}

function wordBoundaryAfter(str: string, pos: number): number {
  let p = pos;
  while (p < str.length && !/\s/.test(str[p] ?? "")) p++;
  while (p < str.length && /\s/.test(str[p] ?? "")) p++;
  return p;
}

interface SingleLineInputOptions {
  initialValue?: string;
  maxLength?: number;
  onSubmit?: (value: string) => void;
}

export function useSingleLineInput(options: SingleLineInputOptions = {}) {
  const { initialValue = "", maxLength = 1000, onSubmit } = options;
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);
  const stateRef = useRef({ value, cursor });
  stateRef.current = { value, cursor };

  const reset = useCallback(() => {
    setValue(initialValue);
    setCursor(initialValue.length);
  }, [initialValue]);

  const handlePaste = useCallback(
    (text: string) => {
      const current = stateRef.current;
      const result = insertAt(current.value, current.cursor, text, maxLength);
      setValue(result.value);
      setCursor(result.cursor);
      stateRef.current = result;
    },
    [maxLength],
  );

  const handleKey = useCallback(
    (key: Key): boolean => {
      if (key.name === "return" && onSubmit) {
        onSubmit(value);
        return true;
      }

      if (key.name === "escape") return false;
      if (key.name === "a" && key.ctrl) {
        setCursor(0);
        return true;
      }
      if (key.name === "e" && key.ctrl) {
        setCursor(value.length);
        return true;
      }
      if (key.name === "left") {
        if (key.meta) setCursor(0);
        else if (key.option) setCursor(wordBoundaryBefore(value, cursor));
        else setCursor((p) => Math.max(0, p - 1));
        return true;
      }
      if (key.name === "right") {
        if (key.meta) setCursor(value.length);
        else if (key.option) setCursor(wordBoundaryAfter(value, cursor));
        else setCursor((p) => Math.min(value.length, p + 1));
        return true;
      }

      // Deletion
      if (key.name === "u" && key.ctrl) {
        setValue("");
        setCursor(0);
        return true;
      }
      if (key.name === "backspace") {
        if (key.meta || key.option) {
          const newPos = wordBoundaryBefore(value, cursor);
          setValue(value.slice(0, newPos) + value.slice(cursor));
          setCursor(newPos);
        } else {
          const result = deleteAt(value, cursor);
          setValue(result.value);
          setCursor(result.cursor);
        }
        return true;
      }
      if (key.sequence && !key.ctrl && !key.meta && !key.option) {
        const charCode = key.sequence.charCodeAt(0);
        const isPrintable = key.sequence.length === 1 && charCode >= 32 && charCode !== 127;
        if (!isPrintable) return false;

        const result = insertAt(value, cursor, key.sequence, maxLength);
        setValue(result.value);
        setCursor(result.cursor);
        return true;
      }

      return false;
    },
    [value, cursor, maxLength, onSubmit],
  );

  return { value, cursor, setValue, setCursor, reset, handleKey, handlePaste };
}
