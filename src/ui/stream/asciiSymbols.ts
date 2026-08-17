/**
 * Keep generated prose free of emoji and pictographic status glyphs. Structural
 * terminal characters owned by Claudex (rails, menu arrows) never pass through
 * this function and therefore remain available to the interface.
 */
export function asciiSymbolsForDisplay(text: string): string {
  const mapped = text
    .replace(/✅|✔️?|✓/gu, "[ok]")
    .replace(/❌|✖️?|✕/gu, "[x]")
    .replace(/⚠️?/gu, "[!]")
    .replace(/⏸️?/gu, "[pause]")
    .replace(/[➡➜→↳]/gu, "->")
    .replace(/•/gu, "-");

  return mapped.replace(EMOJI, "").replace(/[\uFE0E\uFE0F]/gu, "");
}

/**
 * Emoji, not every pictograph. `Extended_Pictographic` also covers copyright,
 * registered, trademark, double exclamation, ballot box and scissors \u2014 ordinary
 * punctuation in engineering prose \u2014 and deleting those corrupts anything an
 * agent quotes verbatim, a licence header being the obvious case. The line
 * between the two is the default presentation: `Emoji_Presentation` characters
 * render as emoji on their own, the rest only when U+FE0F asks them to.
 */
const PICTOGRAPH = String.raw`(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{Emoji_Modifier}*`;
const EMOJI = new RegExp(
  `(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|${PICTOGRAPH}(?:\\u200D${PICTOGRAPH})*)`,
  "gu",
);

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MAY_EXTEND_AS_EMOJI =
  /(?:[✔✓✖✕⚠⏸➡➜→↳]|\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]|[\uD800-\uDBFF]|\u200D)/u;

/** Streaming-safe form: retain only a trailing grapheme that a later chunk may extend. */
export class AsciiSymbolSanitizer {
  private pending = "";

  push(text: string): string {
    const segments = [...GRAPHEMES.segment(this.pending + text)].map((part) => part.segment);
    this.pending = "";
    const last = segments.at(-1);
    if (last && MAY_EXTEND_AS_EMOJI.test(last)) {
      this.pending = last;
      segments.pop();
    }
    return asciiSymbolsForDisplay(segments.join(""));
  }

  flush(): string {
    const output = asciiSymbolsForDisplay(this.pending);
    this.pending = "";
    return output;
  }
}
