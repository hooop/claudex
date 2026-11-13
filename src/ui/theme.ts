import type { AgentId } from "../types.js";

/**
 * claude/codex colors are reserved for telling the two agents apart
 * (transcript badges, permission requests, model labels) — not for general
 * app chrome. Everything else (headers, borders, hints) uses BRAND_COLOR,
 * a neutral tone that doesn't imply "this belongs to one agent or the other".
 */
export const AGENT_STYLE: Record<AgentId, { color: string; badge: string }> = {
  claude: { color: "ansi256(210)", badge: "Claude" },
  codex: { color: "ansi256(159)", badge: "Codex" },
};

export const BRAND_COLOR = "#a78bfa";

/**
 * Markdown rendering tones. Deliberately quiet: hierarchy in the transcript
 * comes from whitespace and weight, not from color. Body text keeps the
 * terminal's own foreground (never an explicit white — that breaks on light
 * themes), and no block ever paints a background for the same reason.
 */
export const CODE_COLOR = "#a3be8c";

/** Reading measure, in columns. Long lines are the main thing that hurts legibility. */
export const MAX_CONTENT_WIDTH = 84;

/** Columns eaten by the author's coloured rail and the space after it. */
export const RAIL_WIDTH = 2;

/**
 * Ceiling for the controls below the transcript viewport.
 */
export const MAX_STANDARD_DYNAMIC_ROWS = 7;

/**
 * A user-opened selection palette may borrow one extra row for visual separation.
 */
export const MAX_DYNAMIC_ROWS = MAX_STANDARD_DYNAMIC_ROWS + 1;
/** Rows the fixed debate header occupies: title, topic, memory, rule. */
export const DEBATE_HEADER_ROWS = 4;
/** The transcript must keep at least one visible row, or the debate is unreadable. */
export const MIN_TRANSCRIPT_ROWS = 1;
/** The thin rule between the transcript and the footer. */
export const RULE_ROWS = 1;
/** Ink never draws the last terminal row, so writing it cannot scroll the screen. */
export const INK_SPARE_ROWS = 1;

/**
 * Below this size the debate frame cannot hold its fixed rows, and Yoga would
 * squeeze the header instead. Derived rather than written by hand so a new
 * footer row cannot silently make the minimum a lie again.
 */
export const MIN_ROWS =
  DEBATE_HEADER_ROWS + MIN_TRANSCRIPT_ROWS + RULE_ROWS + MAX_DYNAMIC_ROWS + INK_SPARE_ROWS;
export const MIN_COLS = 40;

/** The only test of the minimum, shared by every screen. */
export function isTooSmall(columns: number, rows: number): boolean {
  return rows < MIN_ROWS || columns < MIN_COLS;
}

export function tooSmallMessage(): string {
  return `Terminal too small: enlarge it to at least ${MIN_COLS} × ${MIN_ROWS}`;
}

/** Reading measure for a transcript line, given the terminal's width. */
export function contentWidthFor(columns: number): number {
  return Math.max(24, Math.min(columns - 2, MAX_CONTENT_WIDTH));
}

/** Consensus reached: the green of the closing frame and the status line. */
export const CONSENSUS_COLOR = "#57d68d";

/** Claudex's own interface glyphs, defined once. Agent prose never uses them. */
export const GLYPH = {
  mark: "◆",
  rail: "│",
  ruleHeavy: "━",
  rule: "─",
  ok: "✓",
  next: "→",
  ask: "?",
  warn: "!",
  dot: "·",
} as const;

/** Below this width the debate header's status and the mini animation are hidden. */
export const NARROW_COLUMNS = 60;

export const HUMAN_STYLE = { color: "#f5c542", badge: "YOU" };
export const SYSTEM_STYLE = { color: "#8b949e", badge: GLYPH.dot };
export const ERROR_STYLE = { color: "#ff5c5c", badge: GLYPH.warn };
export const SUMMARY_STYLE = { color: CONSENSUS_COLOR, badge: "CONSENSUS" };
