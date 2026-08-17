import { Box, Text } from "ink";
import type { ReactNode } from "react";
import {
  MAX_DYNAMIC_ROWS,
  MAX_STANDARD_DYNAMIC_ROWS,
  MIN_COLS,
  MIN_ROWS,
} from "../theme.js";
import { COMMAND_PALETTE_ROWS } from "./CommandPalette.js";
import { INPUT_BAR_MIN_ROWS } from "./InputBar.js";
import { MODEL_FOOTER_ROWS } from "./ModelFooter.js";

/** Rows the permission prompt occupies: the question, then the two keys. */
export const PERMISSION_ROWS = 2;
const STATUS_ROWS = 1;
const MAX_ACCESSORY_ROWS =
  MAX_STANDARD_DYNAMIC_ROWS - STATUS_ROWS - MODEL_FOOTER_ROWS - INPUT_BAR_MIN_ROWS;

export interface FooterSurfaces {
  tail: boolean;
  banner: boolean;
  notice: boolean;
  modal: "permission" | null;
  selectionPalette: boolean;
  /** Current rendered input height; ignored while a modal replaces the input. */
  inputRows?: number;
}

function accessoryRows(surfaces: FooterSurfaces): number {
  const requested =
    (surfaces.tail ? 1 : 0) + (surfaces.banner ? 1 : 0) + (surfaces.notice ? 1 : 0);
  return Math.min(MAX_ACCESSORY_ROWS, requested);
}

/** Space a growing input may occupy without breaking the bounded-footer invariant. */
export function inputBarMaxRows(surfaces: FooterSurfaces): number {
  if (surfaces.selectionPalette) return INPUT_BAR_MIN_ROWS;
  return Math.max(
    INPUT_BAR_MIN_ROWS,
    MAX_STANDARD_DYNAMIC_ROWS - accessoryRows(surfaces) - STATUS_ROWS - MODEL_FOOTER_ROWS,
  );
}

/**
 * Exactly how many rows the footer will draw.
 *
 * Kept as a function rather than measured after the fact because it is the thing
 * that has to stay under `MAX_DYNAMIC_ROWS`. A modal replaces the status and
 * prompt. The stable model footer remains except while a command/model palette
 * uses the one-row palette allowance and restores it on close.
 */
export function footerRows(surfaces: FooterSurfaces): number {
  const accessories = accessoryRows(surfaces);
  const body =
    surfaces.modal === "permission"
      ? PERMISSION_ROWS + MODEL_FOOTER_ROWS
      : surfaces.selectionPalette
        ? COMMAND_PALETTE_ROWS + INPUT_BAR_MIN_ROWS
        : STATUS_ROWS +
          Math.min(surfaces.inputRows ?? INPUT_BAR_MIN_ROWS, inputBarMaxRows(surfaces)) +
          MODEL_FOOTER_ROWS;

  return (surfaces.selectionPalette && surfaces.modal === null ? 0 : accessories) + body;
}

export type FooterMode =
  | { kind: "too-small" }
  | { kind: "hidden" }
  | { kind: "box"; height: number };

/**
 * Height of the live area while the beginning of the transcript still fits on
 * screen. The unused rows are intentional: they keep the prompt on the last
 * usable terminal row while permanent output fills the screen from the top.
 *
 * Once `permanentRows` has filled that gap, the result settles at the standard
 * seven-row ceiling. The eighth row only exists while a palette is open.
 */
export function pinnedFooterHeight(terminalRows: number, permanentRows: number): number {
  const usableRows = Math.max(1, terminalRows - 1);
  return Math.min(
    usableRows,
    Math.max(MAX_STANDARD_DYNAMIC_ROWS, usableRows - permanentRows),
  );
}

export function footerMode(
  columns: number,
  terminalRows: number,
  rows: number,
  preferredHeight?: number,
): FooterMode {
  if (terminalRows < MIN_ROWS || columns < MIN_COLS) return { kind: "too-small" };

  const minimumHeight = Math.min(rows, MAX_DYNAMIC_ROWS);
  const height = Math.min(
    Math.max(minimumHeight, preferredHeight ?? minimumHeight),
    terminalRows - 1,
  );
  // Nothing dynamic is better than a footer the terminal can't erase; the debate
  // keeps streaming into the scrollback either way.
  if (height >= terminalRows) return { kind: "hidden" };

  return { kind: "box", height };
}

/**
 * The envelope around everything Ink still draws during a debate.
 *
 * Ink erases its previous frame by walking back over the newlines it wrote, and
 * falls back to clearing the whole screen the moment its output is as tall as the
 * terminal. Both behaviours are fine when the output is a handful of lines and
 * ruinous when it is the entire transcript — which is why the transcript isn't
 * here at all. The sole exception is the empty spacer used while the first
 * screen fills from the top; it always remains shorter than the terminal, then
 * disappears for the rest of the debate.
 *
 * The clip is a backstop, not the mechanism: a child that wraps unexpectedly
 * gets cut off instead of desynchronising the erase.
 */
export function DynamicFooter(props: {
  columns: number;
  terminalRows: number;
  rows: number;
  preferredHeight?: number;
  children: ReactNode;
}) {
  const { columns, terminalRows, rows, preferredHeight, children } = props;
  const mode = footerMode(columns, terminalRows, rows, preferredHeight);

  if (mode.kind === "too-small") {
    return <Text wrap="truncate-end">Terminal trop petit — agrandissez la fenêtre</Text>;
  }
  if (mode.kind === "hidden") return null;

  return (
    <Box flexDirection="column" width={columns} height={mode.height} overflow="hidden">
      {children}
    </Box>
  );
}
