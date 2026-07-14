import React from "react";
import { Text, useInput } from "ink";

export type PromptInputProps = {
  value: string;
  cursorOffset: number;
  focus?: boolean;
  onChange(value: string): void;
  onCursorChange(offset: number): void;
  onSubmit(value: string): void;
};

export function PromptInput({
  value,
  cursorOffset,
  focus = true,
  onChange,
  onCursorChange,
  onSubmit,
}: PromptInputProps): React.JSX.Element {
  const cursor = Math.max(0, Math.min(cursorOffset, value.length));

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab) || (key.ctrl && input === "c")) return;
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.leftArrow) {
      onCursorChange(Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      onCursorChange(Math.min(value.length, cursor + 1));
      return;
    }
    if (key.ctrl && input === "a") {
      onCursorChange(0);
      return;
    }
    if (key.ctrl && input === "e") {
      onCursorChange(value.length);
      return;
    }

    let nextValue = value;
    let nextCursor = cursor;
    if (key.backspace) {
      if (cursor > 0) {
        nextValue = value.slice(0, cursor - 1) + value.slice(cursor);
        nextCursor--;
      }
    } else if (key.delete) {
      if (cursor < value.length) nextValue = value.slice(0, cursor) + value.slice(cursor + 1);
    } else if (key.ctrl && input === "u") {
      nextValue = value.slice(cursor);
      nextCursor = 0;
    } else if (key.ctrl && input === "k") {
      nextValue = value.slice(0, cursor);
    } else if (input && !key.ctrl && !key.meta) {
      nextValue = value.slice(0, cursor) + input + value.slice(cursor);
      nextCursor += input.length;
    } else {
      return;
    }

    if (nextValue !== value) onChange(nextValue);
    onCursorChange(nextCursor);
  }, { isActive: focus });

  const before = value.slice(0, cursor);
  const current = value[cursor];
  const after = current === undefined ? "" : value.slice(cursor + 1);
  return (
    <Text>
      {before}<Text inverse>{current ?? " "}</Text>{after}
    </Text>
  );
}
