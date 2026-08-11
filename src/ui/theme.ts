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
export const RULE_COLOR = "#8b949e";

/** Reading measure, in columns. Long lines are the main thing that hurts legibility. */
export const MAX_CONTENT_WIDTH = 84;

/** Columns eaten by the author's coloured rail and the space after it. */
export const RAIL_WIDTH = 2;

/**
 * Ceiling on everything Ink draws during a debate, in rows.
 *
 * This is the load-bearing constant of the whole renderer. Ink erases and
 * rewrites its output on every update, and when that output is as tall as the
 * terminal it gives up on line-by-line erasure and clears the entire screen
 * instead — which, at streaming cadence, is the flicker. Keeping the dynamic
 * zone far below the terminal height keeps Ink on the cheap path forever,
 * whatever the transcript has grown to.
 */
export const MAX_DYNAMIC_ROWS = 7;
/** Below these, the footer can't be drawn honestly, so it isn't drawn at all. */
export const MIN_ROWS = 10;
export const MIN_COLS = 40;

/** Reading measure for a transcript line, given the terminal's width. */
export function contentWidthFor(columns: number): number {
  return Math.max(24, Math.min(columns - 2, MAX_CONTENT_WIDTH));
}

export const HUMAN_STYLE = { color: "#f5c542", badge: "TOI" };
export const SYSTEM_STYLE = { color: "#8b949e", badge: "•" };
export const ERROR_STYLE = { color: "#ff5c5c", badge: "!" };
export const SUMMARY_STYLE = { color: "#57d68d", badge: "✓ RÉSUMÉ DU DÉBAT (non attribué)" };
