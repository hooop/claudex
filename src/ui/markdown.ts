/**
 * Minimal markdown recognition for the terminal.
 *
 * Deliberately not CommonMark: it covers what Claude and Codex actually emit in
 * a debate (titles, lists, emphasis, code, quotes, the occasional table) and
 * nothing else. Pure — no React, no ANSI — so the styling rules in
 * stream/markdownStream.ts stay separate from the recognition rules, and so this
 * file can be tested directly.
 *
 * It works one line at a time, on purpose. The transcript is written append-only
 * as lines complete, so nothing here may depend on text that hasn't arrived yet:
 * a construct is either recognisable from the line in front of us or it stays
 * literal text forever.
 */

export type InlineSpan =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; value: string; url: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+\S/;
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const BULLET = /^(\s*[-*+]\s+)(.*)$/;
const ORDERED = /^(\s*\d{1,3}[.)]\s+)(.*)$/;
const QUOTE = /^\s{0,3}>/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * `_underscore_` emphasis is intentionally unsupported: identifiers like
 * `some_var_name` are far more common than italics in this context, and
 * treating them as emphasis mangles them. `*` forms require a non-space
 * character on both sides for the same reason (`2 * 3 * 4` stays arithmetic).
 */
const INLINE_RE =
  /(`[^`\n]+`)|(\*\*(?=[^\s*])[^*\n]*?(?<=[^\s*])\*\*)|(\*(?=[^\s*])[^*\n]*?(?<=[^\s*])\*)|(\[[^\]\n]*\]\([^)\s]+\))/g;

const LINK = /^\[([^\]]*)\]\(([^)\s]+)\)$/;

/**
 * Split a single line into styled runs. Only balanced, same-line constructs are
 * recognised — an unterminated `**` degrades to literal text, which is exactly
 * what streaming needs: a delimiter whose partner never arrives (or arrives on
 * the next physical line, after this one was already committed) must stay
 * readable rather than swallow the rest of the message.
 */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE_RE)) {
    const token = match[0];
    const at = match.index;
    if (at > last) spans.push({ type: "text", value: text.slice(last, at) });
    last = at + token.length;

    if (token.startsWith("`")) {
      spans.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      spans.push({ type: "bold", value: token.slice(2, -2) });
    } else if (token.startsWith("*")) {
      spans.push({ type: "italic", value: token.slice(1, -1) });
    } else {
      const link = LINK.exec(token);
      if (link) spans.push({ type: "link", value: link[1] ?? "", url: link[2] ?? "" });
      else spans.push({ type: "text", value: token });
    }
  }

  if (last < text.length) spans.push({ type: "text", value: text.slice(last) });
  return spans;
}

export type LineKind = "fence" | "heading" | "rule" | "list" | "quote" | "table" | "plain";

export interface LineClass {
  kind: LineKind;
  /** Heading depth, 1–6. Only set for `heading`. */
  level?: number;
  /** The literal list marker, including its indentation and trailing space. */
  marker?: string;
  /** The text after the marker. Only set for `list`. */
  body?: string;
}

/** Classify one line. `fence` toggles code-block state; the caller tracks it. */
export function classifyLine(line: string): LineClass {
  if (FENCE.test(line)) return { kind: "fence" };

  const heading = HEADING.exec(line);
  if (heading) return { kind: "heading", level: (heading[1] ?? "#").length };

  if (RULE.test(line)) return { kind: "rule" };
  if (QUOTE.test(line)) return { kind: "quote" };
  if (TABLE_ROW.test(line)) return { kind: "table" };

  const item = ORDERED.exec(line) ?? BULLET.exec(line);
  if (item) return { kind: "list", marker: item[1] ?? "", body: item[2] ?? "" };

  return { kind: "plain" };
}
