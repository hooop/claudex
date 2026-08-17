import { Box, Text, useInput, useStdout } from "ink";
import chalk from "chalk";
import { useEffect, useRef, useState } from "react";
import { displayWidth } from "../stream/lineBuffer.js";
import {
  CommandPalette,
  isCommandPaletteEligible,
  matchingCommands,
  type CommandSuggestion,
} from "./CommandPalette.js";

export const INPUT_BACKGROUND_COLOR = "ansi256(233)";
const BG_DISABLED = "#1c1e22";
const PROMPT = " ‣ ";
const INPUT_CURSOR_COLOR_INDEX = 236;
export const INPUT_PROMPT_COLOR = "ansi256(220)";
export const INPUT_CURSOR_COLOR = `ansi256(${INPUT_CURSOR_COLOR_INDEX})`;
export const INPUT_PLACEHOLDER_COLOR = "ansi256(237)";
export const INPUT_TEXT_COLOR = "ansi256(195)";
export const INPUT_CURSOR_BLINK_MS = 500;

function renderCursor(text: string, visible: boolean): string {
  return visible ? chalk.bgAnsi256(INPUT_CURSOR_COLOR_INDEX)(text) : text;
}

/** Two breathing rows frame the editable content. */
export const INPUT_BAR_MIN_ROWS = 3;
/** Four wrapped text rows, plus the two breathing rows. */
export const INPUT_BAR_MAX_ROWS = 6;
/** Empty background columns kept between editable content and the right edge. */
export const INPUT_BAR_RIGHT_PADDING = 2;

export function inputBarWidth(availableWidth: number): number {
  const columns = Number.isFinite(availableWidth) ? Math.floor(availableWidth) : 80;
  return Math.max(20, columns - 1);
}

/** Longest prefix of `text` that fits in `maxWidth` display columns. */
function fitForward(text: string, maxWidth: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > maxWidth) break;
    out += ch;
    used += w;
  }
  return out;
}

function previousIndex(text: string, index: number): number {
  const previous = [...text.slice(0, index)].at(-1);
  return previous ? index - previous.length : 0;
}

function nextIndex(text: string, index: number): number {
  const next = [...text.slice(index)][0];
  return next ? index + next.length : text.length;
}

interface InputGlyph {
  text: string;
  width: number;
  cursor: boolean;
}

interface WrappedLine {
  body: string;
  width: number;
  cursor: boolean;
}

/** Wraps editable text before adding ANSI cursor styling. */
function wrapInput(
  value: string,
  cursor: number,
  width: number,
  cursorVisible: boolean,
): WrappedLine[] {
  const glyphs: InputGlyph[] = [];
  let index = 0;

  for (const text of value) {
    glyphs.push({ text, width: displayWidth(text), cursor: index === cursor });
    index += text.length;
  }
  if (cursor === value.length) glyphs.push({ text: " ", width: 1, cursor: true });

  const wrapped: InputGlyph[][] = [];
  let line: InputGlyph[] = [];
  let used = 0;

  for (const glyph of glyphs) {
    if (line.length > 0 && used + glyph.width > width) {
      wrapped.push(line);
      line = [];
      used = 0;
    }
    line.push(glyph);
    used += glyph.width;
  }
  if (line.length > 0) wrapped.push(line);

  return wrapped.map((glyphLine) => ({
    body: glyphLine
      .map((glyph) => (glyph.cursor ? renderCursor(glyph.text, cursorVisible) : glyph.text))
      .join(""),
    width: glyphLine.reduce((sum, glyph) => sum + glyph.width, 0),
    cursor: glyphLine.some((glyph) => glyph.cursor),
  }));
}

/**
 * A growing input surface. It starts with one editable row between two breathing
 * rows, then adds wrapped rows until its bounded viewport is full. Beyond that,
 * the viewport follows the cursor vertically, so the footer never grows without
 * limit and Ink can still erase every frame without flicker.
 *
 * Editing keys mirror what ink-text-input offered, plus the usual line controls.
 */
export function InputBar(props: {
  disabled: boolean;
  placeholder: string;
  onSubmit: (value: string) => void | Promise<void>;
  onSubmitError?: (error: unknown) => void;
  width?: number;
  /** Total rows, including the empty row above and below the editable text. */
  maxRows?: number;
  onRowsChange?: (rows: number) => void;
  /** Welcome-only gallery navigation; DebateView deliberately never supplies it. */
  onNavigate?: (direction: -1 | 1) => void;
  commands?: readonly CommandSuggestion[];
  onCommandPaletteChange?: (open: boolean) => void;
  /** Route keyboard input elsewhere while preserving the active prompt surface. */
  inputActive?: boolean;
}) {
  const { onCommandPaletteChange, onRowsChange } = props;
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const latestSubmission = useRef<Promise<void> | null>(null);
  const { stdout } = useStdout();
  const width = inputBarWidth(props.width ?? stdout?.columns ?? 80);
  const inputActive = props.inputActive ?? !props.disabled;
  const promptWidth = displayWidth(PROMPT);
  const inner = Math.max(4, width - promptWidth - INPUT_BAR_RIGHT_PADDING);
  const maxRows = Math.max(
    INPUT_BAR_MIN_ROWS,
    Math.min(INPUT_BAR_MAX_ROWS, props.maxRows ?? INPUT_BAR_MAX_ROWS),
  );
  const commands = props.commands ?? [];
  const commandMatches = matchingCommands(commands, value);
  const paletteOpen =
    !props.disabled &&
    commands.length > 0 &&
    !paletteDismissed &&
    isCommandPaletteEligible(value, commandMatches);
  const safeSelectedCommand =
    commandMatches.length === 0 ? 0 : Math.min(selectedCommand, commandMatches.length - 1);

  useInput(
    (input, key) => {
      if (paletteOpen) {
        if (key.upArrow || key.downArrow) {
          if (commandMatches.length > 0) {
            const delta = key.upArrow ? -1 : 1;
            setSelectedCommand(
              (current) => (current + delta + commandMatches.length) % commandMatches.length,
            );
          }
          return;
        }
        if (key.tab) {
          const command = commandMatches[safeSelectedCommand];
          if (command) {
            setValue(command.completion);
            setCursor(command.completion.length);
            setPaletteDismissed(true);
          }
          return;
        }
        if (key.escape) {
          setPaletteDismissed(true);
          return;
        }
      }

      if (key.upArrow || key.downArrow || key.tab || key.escape || key.pageUp || key.pageDown) return;
      if (key.ctrl && (input === "c" || input === "d")) return;
      setCursorVisible(true);

      if (key.return) {
        const submitted = value;
        if (!submitted.trim()) return;
        setValue("");
        setCursor(0);
        setPaletteDismissed(false);
        onCommandPaletteChange?.(false);
        try {
          const result = props.onSubmit(submitted);
          if (result) {
            latestSubmission.current = result.catch((error: unknown) => {
              props.onSubmitError?.(error);
            });
          }
        } catch (error) {
          props.onSubmitError?.(error);
        }
        return;
      }

      if (key.leftArrow) {
        if (value === "" && props.onNavigate) {
          props.onNavigate(-1);
          return;
        }
        setCursor((c) => previousIndex(value, c));
        return;
      }
      if (key.rightArrow) {
        if (value === "" && props.onNavigate) {
          props.onNavigate(1);
          return;
        }
        setCursor((c) => nextIndex(value, c));
        return;
      }
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }
      if (key.ctrl && input === "u") {
        setValue("");
        setCursor(0);
        setPaletteDismissed(false);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        const previous = previousIndex(value, cursor);
        const nextValue = value.slice(0, previous) + value.slice(cursor);
        setValue(nextValue);
        setCursor(previous);
        if (!nextValue.startsWith("/")) setPaletteDismissed(false);
        return;
      }

      // Enter submits, so pasted control characters must not become explicit
      // line breaks; visual lines are produced solely by width-aware wrapping.
      const clean = input.replace(/[\u0000-\u001f\u007f]/g, "");
      if (clean === "") return;
      const nextValue = value.slice(0, cursor) + clean + value.slice(cursor);
      setValue(nextValue);
      setCursor(cursor + clean.length);
      if (!nextValue.startsWith("/")) setPaletteDismissed(false);
    },
    { isActive: inputActive },
  );

  useEffect(() => {
    setSelectedCommand(0);
  }, [value]);

  useEffect(() => {
    onCommandPaletteChange?.(paletteOpen);
  }, [onCommandPaletteChange, paletteOpen]);

  useEffect(() => {
    if (props.disabled) return;

    setCursorVisible(true);
    const interval = setInterval(() => {
      setCursorVisible((visible) => !visible);
    }, INPUT_CURSOR_BLINK_MS);

    return () => clearInterval(interval);
  }, [props.disabled, value, cursor]);

  const bg = props.disabled ? BG_DISABLED : INPUT_BACKGROUND_COLOR;
  const showPlaceholder = props.disabled || value === "";
  const inputColor = props.disabled
    ? "gray"
    : showPlaceholder
      ? INPUT_PLACEHOLDER_COLOR
      : INPUT_TEXT_COLOR;

  let lines: WrappedLine[];
  if (showPlaceholder) {
    const hint = fitForward(props.placeholder, inner - (props.disabled ? 1 : 2));
    const body = props.disabled ? hint : renderCursor(" ", cursorVisible) + " " + hint;
    lines = [{ body, width: displayWidth(body), cursor: true }];
  } else {
    lines = wrapInput(value, cursor, inner, cursorVisible);
  }

  const contentRows = maxRows - 2;
  const cursorLine = Math.max(0, lines.findIndex((line) => line.cursor));
  const firstVisibleLine = Math.max(0, cursorLine - contentRows + 1);
  const visibleLines = lines.slice(firstVisibleLine, firstVisibleLine + contentRows);
  const rows = Math.max(INPUT_BAR_MIN_ROWS, visibleLines.length + 2);
  const breathingRow = " ".repeat(width);
  const continuation = " ".repeat(promptWidth);

  useEffect(() => {
    onRowsChange?.(rows);
  }, [onRowsChange, rows]);

  return (
    <Box flexDirection="column" width={width}>
      {paletteOpen && (
        <CommandPalette
          commands={commandMatches}
          selectedIndex={safeSelectedCommand}
          width={width}
        />
      )}
      <Box flexDirection="column" width={width} height={rows}>
        <Text backgroundColor={bg}>{breathingRow}</Text>
        {visibleLines.map((line, index) => (
          <Text key={firstVisibleLine + index} backgroundColor={bg} wrap="truncate-end">
            {index === 0 ? (
              <Text color={props.disabled ? "gray" : INPUT_PROMPT_COLOR}>{PROMPT}</Text>
            ) : (
              continuation
            )}
            <Text color={inputColor}>{line.body}</Text>
            {" ".repeat(Math.max(0, inner - line.width) + INPUT_BAR_RIGHT_PADDING)}
          </Text>
        ))}
        <Text backgroundColor={bg}>{breathingRow}</Text>
      </Box>
    </Box>
  );
}
