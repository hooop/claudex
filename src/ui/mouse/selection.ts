import chalk from "chalk";
import type { TranscriptLine } from "../stream/streamController.js";
import { displayWidth, plainOf, sliceColumns } from "../stream/lineBuffer.js";
import { GLYPH } from "../theme.js";

/** A transcript cell: absolute line index (appended lines never move it) and display column. */
export interface Cell {
  line: number;
  col: number;
}

/** Where the press started and where the pointer is now; the focus column is exclusive. */
export interface Selection {
  anchor: Cell;
  focus: Cell;
}

/**
 * A drag as the pointer made it. Once it has moved, both the press cell and
 * the cell under the pointer are selected; a click alone selects nothing.
 */
export interface Drag {
  anchor: Cell;
  focus: Cell;
  moved: boolean;
}

/** Lines scrolled per wheel notch. */
export const WHEEL_LINES = 3;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The cell under a screen position, or null outside the transcript viewport. */
export function screenToCell(
  y: number,
  x: number,
  viewport: { top: number; height: number; firstLine: number },
): Cell | null {
  if (y < viewport.top || y >= viewport.top + viewport.height) return null;
  return { line: viewport.firstLine + (y - viewport.top), col: Math.max(0, x) };
}

export function orderedRange(selection: Selection): { start: Cell; end: Cell } {
  const { anchor, focus } = selection;
  const anchorFirst = anchor.line < focus.line || (anchor.line === focus.line && anchor.col <= focus.col);
  return anchorFirst ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/** Display columns `[start, end)` of the grapheme under `col`; one column past the text. */
function graphemeColumns(styled: string | undefined, col: number): [number, number] {
  let column = 0;
  for (const { segment } of segmenter.segment(plainOf(styled ?? ""))) {
    const width = displayWidth(segment);
    if (col < column + width) return [column, column + width];
    column += width;
  }
  return [col, col + 1];
}

/**
 * The selection a drag covers: from the start of the grapheme under its first
 * cell to the end of the grapheme under its last, so the highlight and the copy
 * both include the characters at either end, wide ones whole.
 */
export function dragSelection(lines: readonly TranscriptLine[], drag: Drag): Selection | null {
  if (!drag.moved) return null;
  const { start, end } = orderedRange(drag);
  return {
    anchor: { line: start.line, col: graphemeColumns(lines[start.line]?.styled, start.col)[0] },
    focus: { line: end.line, col: graphemeColumns(lines[end.line]?.styled, end.col)[1] },
  };
}

/** The selected display columns of `line`, end exclusive, or null when none are. */
export function selectedColumns(selection: Selection, line: number, width: number): [number, number] | null {
  const { start, end } = orderedRange(selection);
  if (line < start.line || line > end.line) return null;
  const from = line === start.line ? start.col : 0;
  const to = line === end.line ? Math.min(end.col, width) : width;
  return from < to ? [from, to] : null;
}

/**
 * Display columns taken by Claudex's chrome at the start of a line: the rail and
 * its space, then the turn glyph and its space. Both glyphs are one column wide.
 */
function chromeWidth(plain: string): number {
  let width = 0;
  if (plain.startsWith(`${GLYPH.rail} `)) width = 2;
  else if (plain.startsWith(GLYPH.rail)) width = 1;
  if (plain.startsWith(`${GLYPH.mark} `, width)) width += 2;
  return width;
}

/**
 * The plain text a selection copies. A soft-wrapped line is joined to the one
 * before without a newline, and with the space `LineBuffer` dropped when it
 * broke at one, so a wrapped sentence or a hard-cut URL comes back as written.
 */
export function selectedText(lines: readonly TranscriptLine[], selection: Selection): string {
  const { start, end } = orderedRange(selection);
  let text = "";
  let first = true;
  for (let index = start.line; index <= end.line && index < lines.length; index++) {
    const line = lines[index];
    const columns = selectedColumns(selection, index, Number.POSITIVE_INFINITY);
    if (!line || !columns) continue;
    const plain = plainOf(line.styled);
    const piece = sliceColumns(plain, Math.max(columns[0], chromeWidth(plain)), columns[1]).trimEnd();
    if (!first) text += line.softWrap ? (line.droppedSpace ? " " : "") : "\n";
    text += piece;
    first = false;
  }
  return text;
}

/**
 * A line drawn for a selection: its plain text with the selected columns
 * inverted. A wide character straddling an edge is not copied (see
 * `sliceColumns`), so it is drawn outside the inverse, never dropped.
 */
export function highlightColumns(styled: string, columns: [number, number]): string {
  const [from, to] = columns;
  let before = "";
  let selected = "";
  let after = "";
  let column = 0;
  for (const { segment } of segmenter.segment(plainOf(styled))) {
    const width = displayWidth(segment);
    if (column < from) before += segment;
    else if (column + width <= to) selected += segment;
    else after += segment;
    column += width;
  }
  return before + (selected ? chalk.inverse(selected) : "") + after;
}
