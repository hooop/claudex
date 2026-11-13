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

/** The selected display columns of `line`, end exclusive, or null when none are. */
export function selectedColumns(selection: Selection, line: number, width: number): [number, number] | null {
  const { start, end } = orderedRange(selection);
  if (line < start.line || line > end.line) return null;
  const from = line === start.line ? start.col : 0;
  const to = line === end.line ? Math.min(end.col, width) : width;
  return from < to ? [from, to] : null;
}

function stripChrome(text: string): string {
  let rest = text;
  if (rest.startsWith(`${GLYPH.rail} `)) rest = rest.slice(GLYPH.rail.length + 1);
  else if (rest.startsWith(GLYPH.rail)) rest = rest.slice(GLYPH.rail.length);
  if (rest.startsWith(`${GLYPH.mark} `)) rest = rest.slice(GLYPH.mark.length + 1);
  return rest;
}

/**
 * The plain text a selection copies. A soft-wrapped line is joined to the one
 * before with a space because `LineBuffer` drops the space it broke at, so a
 * wrapped paragraph comes back as the sentence that was written.
 */
export function selectedText(lines: readonly TranscriptLine[], selection: Selection): string {
  const { start, end } = orderedRange(selection);
  let text = "";
  let first = true;
  for (let index = start.line; index <= end.line && index < lines.length; index++) {
    const line = lines[index];
    const columns = selectedColumns(selection, index, Number.POSITIVE_INFINITY);
    if (!line || !columns) continue;
    let piece = sliceColumns(plainOf(line.styled), columns[0], columns[1]);
    if (columns[0] === 0) piece = stripChrome(piece);
    piece = piece.trimEnd();
    if (!first) text += line.softWrap ? " " : "\n";
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
