/**
 * The protocol markers and the single, bounded
 * grammar that recognises them.
 *
 * There is exactly one parser here, deliberately: the scheduler uses it to decide
 * whether a turn signalled consensus (`extractSignal`), and the renderer uses it
 * to decide whether a line may be printed (`scanMarkerLine`, via MarkerFilter).
 * If those two disagreed, either a marker would leak into the visible transcript
 * or a real sentence would be swallowed — so they share the same function.
 *
 * The grammar is bounded on purpose. Models sometimes wrap the marker in markdown
 * emphasis or pad it with spaces, so a little decoration is tolerated, but every
 * repetition has an explicit maximum: an unbounded `[*_\s]*` prefix would make the
 * "could this still become a marker?" test used during streaming meaningless.
 */

import {
  CONSENSUS_MARKER,
  CONTINUE_MARKER,
  NO_TOPIC_MARKER,
  WAIT_HUMAN_MARKER,
} from "../types.js";
import type { Signal } from "./types.js";

/** Spaces or tabs tolerated in one padding run (there are three such runs). */
export const MAX_MARKER_PAD = 8;
/** `*` or `_` characters tolerated in one decoration run (there are two). */
export const MAX_MARKER_DECORATION = 4;
/** Anything longer than this can't be a decorated marker line, whatever it holds. */
export const MAX_MARKER_LINE = 64;

const MARKERS = [CONSENSUS_MARKER, CONTINUE_MARKER, NO_TOPIC_MARKER, WAIT_HUMAN_MARKER] as const;

export type MarkerScan =
  /** Not a marker line, and no amount of extra text can make it one. */
  | { kind: "no" }
  /** Not a marker line *yet* — more characters could still complete one. */
  | { kind: "partial" }
  /** The line holds nothing but a (possibly decorated) marker. */
  | { kind: "match"; marker: string };

const NO: MarkerScan = { kind: "no" };
const PARTIAL: MarkerScan = { kind: "partial" };

/** Consume up to `max` characters from `chars`, starting at `i`. */
function take(line: string, i: number, chars: string, max: number): number {
  let taken = 0;
  while (i < line.length && taken < max && chars.includes(line[i]!)) {
    i++;
    taken++;
  }
  return i;
}

function scanTrailing(line: string, from: number, marker: string): MarkerScan {
  let i = take(line, from, " \t", MAX_MARKER_PAD);
  i = take(line, i, "*_", MAX_MARKER_DECORATION);
  i = take(line, i, " \t", MAX_MARKER_PAD);
  return i === line.length ? { kind: "match", marker } : NO;
}

/**
 * Classify a single line (no newline inside) against the marker grammar.
 *
 * `partial` is what makes streaming safe: a chunk boundary can land in the middle
 * of `<<CONSE`, and the renderer must hold that back rather than print it and then
 * discover it was a marker.
 */
export function scanMarkerLine(line: string): MarkerScan {
  if (line.length > MAX_MARKER_LINE) return NO;

  let i = take(line, 0, " \t", MAX_MARKER_PAD);
  i = take(line, i, "*_", MAX_MARKER_DECORATION);
  i = take(line, i, " \t", MAX_MARKER_PAD);

  const rest = line.slice(i);
  if (rest === "") return PARTIAL;

  for (const marker of MARKERS) {
    if (rest.startsWith(marker)) return scanTrailing(line, i + marker.length, marker);
    if (marker.startsWith(rest)) return PARTIAL;
  }
  return NO;
}

/**
 * Split a finished turn into the text to keep and the signal it carried.
 *
 * The marker must be alone on the last non-blank line — that is exactly what the
 * agents are instructed to produce, and it is the only shape `scanMarkerLine` can
 * hold back during streaming without guessing.
 */
export function extractSignal(text: string): { cleanText: string; signal: Signal } {
  const trimmed = text.replace(/\s+$/u, "");
  const lastBreak = trimmed.lastIndexOf("\n");
  const lastLine = lastBreak === -1 ? trimmed : trimmed.slice(lastBreak + 1);

  const scan = scanMarkerLine(lastLine);
  if (scan.kind !== "match") return { cleanText: trimmed, signal: null };

  const body = lastBreak === -1 ? "" : trimmed.slice(0, lastBreak);
  return {
    cleanText: body.replace(/\s+$/u, ""),
    signal:
      scan.marker === CONSENSUS_MARKER
        ? "consensus"
        : scan.marker === CONTINUE_MARKER
          ? "continue"
          : scan.marker === NO_TOPIC_MARKER
            ? "no-topic"
            : "wait-human",
  };
}
