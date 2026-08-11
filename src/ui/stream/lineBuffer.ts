/**
 * Turns a stream of text deltas into whole physical lines.
 *
 * Two constraints shape this. First, the append-only writer must only ever hand
 * the terminal blocks that end in a newline: a fragment without one would leave
 * the dynamic footer starting mid-line, and the next footer redraw would erase
 * the fragment along with it. Second, wrapping has to be Claudex's own, because
 * every committed line carries the author's coloured rail in its first columns —
 * letting the emulator wrap would put continuation text under the rail.
 *
 * So the incomplete remainder is never written: it lives in `tail`, shown in the
 * (redrawable) footer, and is committed only once it is known to be complete.
 *
 * Widths are display widths, not code-unit counts: emoji, CJK and combining
 * marks are measured as the terminal will actually render them.
 */

import stringWidth from "string-width";

export interface PhysicalLine {
  text: string;
  /** True when this line continues a logical line that was wrapped. */
  continuation: boolean;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function displayWidth(text: string): number {
  return stringWidth(text, { countAnsiEscapeCodes: false });
}

function sliceToDisplayWidth(text: string, maxWidth: number): string {
  let result = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const width = displayWidth(segment);
    if (used + width > maxWidth) break;
    result += segment;
    used += width;
  }
  return result;
}

/** Keep text on one terminal row and mark a shortened value with an ASCII ellipsis. */
export function truncateEnd(text: string, maxWidth: number, suffix = "..."): string {
  const width = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0;
  if (displayWidth(text) <= width) return text;

  const visibleSuffix = sliceToDisplayWidth(suffix, width);
  const suffixWidth = displayWidth(visibleSuffix);
  if (suffixWidth >= width) return visibleSuffix;

  return sliceToDisplayWidth(text, width - suffixWidth).trimEnd() + visibleSuffix;
}

/**
 * Break `text` into pieces no wider than `width`.
 *
 * Breaking prefers the last space in the piece so prose doesn't get chopped
 * mid-word, but only in the right-hand part of the line: a break near the start
 * would leave a nearly empty line, and code or a long URL has no space at all,
 * so those fall back to a hard cut. One pass over the graphemes, whatever the
 * length of the input.
 */
function wrap(text: string, width: number): { lines: string[]; rest: string } {
  const lines: string[] = [];
  const minBreak = Math.floor(width * 0.6);

  let start = 0; // index into `text` where the current piece begins
  let used = 0; // display width of the current piece
  let lastSpace = -1; // index of the last space seen in the current piece
  let widthAtLastSpace = 0;

  for (const { segment, index } of segmenter.segment(text)) {
    const w = displayWidth(segment);

    if (used + w > width && index > start) {
      let cut = index;
      let keep = index;
      if (lastSpace !== -1 && widthAtLastSpace >= minBreak) {
        cut = lastSpace;
        keep = lastSpace + 1;
      }
      lines.push(text.slice(start, cut));
      start = keep;
      used = displayWidth(text.slice(start, index)) + w;
      lastSpace = -1;
      widthAtLastSpace = 0;
    } else {
      used += w;
    }

    if (segment === " ") {
      lastSpace = index;
      widthAtLastSpace = used;
    }
  }

  return { lines, rest: text.slice(start) };
}

/** Break a complete logical line into every physical line it occupies. */
export function wrapAll(text: string, width: number): string[] {
  if (text === "") return [""];
  const { lines, rest } = wrap(text, width);
  lines.push(rest);
  return lines;
}

export class LineBuffer {
  private pending = "";
  /** Whether `pending` continues a logical line that has already been wrapped. */
  private continued = false;
  private width: number;

  constructor(width: number) {
    this.width = Math.max(8, width);
  }

  /** Applies to lines produced from now on; already-committed lines never move. */
  setWidth(width: number): void {
    this.width = Math.max(8, width);
  }

  push(text: string): PhysicalLine[] {
    const out: PhysicalLine[] = [];
    let buf = this.pending + text;
    this.pending = "";

    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;

      const logical = buf.slice(0, nl);
      buf = buf.slice(nl + 1);

      let continuation = this.continued;
      for (const piece of wrapAll(logical, this.width)) {
        out.push({ text: piece, continuation });
        continuation = true;
      }
      this.continued = false;
    }

    // What's left has no newline yet: emit the physical lines that are already
    // full, keep the rest as the tail.
    if (displayWidth(buf) > this.width) {
      const { lines, rest } = wrap(buf, this.width);
      for (const piece of lines) {
        out.push({ text: piece, continuation: this.continued });
        this.continued = true;
      }
      buf = rest;
    }

    this.pending = buf;
    return out;
  }

  /** The incomplete remainder, for display in the footer. Never written to stdout. */
  get tail(): PhysicalLine {
    return { text: this.pending, continuation: this.continued };
  }

  /** Commit whatever is left — end of message, error, cancellation, shutdown. */
  flush(): PhysicalLine[] {
    if (this.pending === "") {
      this.continued = false;
      return [];
    }
    const line: PhysicalLine = { text: this.pending, continuation: this.continued };
    this.pending = "";
    this.continued = false;
    return [line];
  }
}
