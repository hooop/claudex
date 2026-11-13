/**
 * Colours one physical line at a time, with no way to revise the last one.
 *
 * The old renderer re-parsed the whole entry on every token, so a `**` could
 * start out literal and become bold once its partner arrived. Incremental line
 * formatting deliberately does not revise completed lines. A construct is
 * styled only when it is complete *within the line being committed*, and anything
 * that straddles a line boundary stays literal — permanently, and identically for
 * every reader.
 *
 * Styling is applied after the line buffer has decided where the line ends. The
 * rendered line may be shorter because source delimiters are presentation syntax,
 * not content: the terminal shows hierarchy instead of printing `##` or `**`.
 */

import chalk from "chalk";
import { classifyLine, parseInline } from "../markdown.js";
import { BRAND_COLOR, CODE_COLOR } from "../theme.js";
import type { PhysicalLine } from "./lineBuffer.js";

type BlockStyle = "fence" | "code" | "heading" | "subheading" | "rule" | "quote" | "list" | "table" | "plain";

const code = chalk.hex(CODE_COLOR);
const heading = chalk.bold.hex(BRAND_COLOR);

type Accent = (text: string) => string;

/** `accentFirst`: a bold span opening the line is a label (`**Risk.**`), not emphasis. */
function styleInline(text: string, accent?: Accent, accentFirst = false): string {
  const spans = parseInline(text);
  // Fast path: the overwhelmingly common case is a line with no markup at all.
  if (spans.length === 1 && spans[0]!.type === "text") return text;

  let out = "";
  for (const [index, span] of spans.entries()) {
    switch (span.type) {
      case "bold":
        out += accent && accentFirst && index === 0 ? chalk.bold(accent(span.value)) : chalk.bold(span.value);
        break;
      case "italic":
        out += chalk.italic(span.value);
        break;
      case "code":
        out += code(span.value);
        break;
      case "link":
        out += chalk.underline(span.value) + chalk.dim(` (${span.url})`);
        break;
      default:
        out += span.value;
    }
  }
  return out;
}

export interface MarkdownStreamerOptions {
  /** Colours headings and line-opening bold labels, so they carry the author's colour. */
  accent?: Accent;
}

export class MarkdownStreamer {
  private readonly accent: Accent | undefined;
  private inFence = false;
  private block: BlockStyle = "plain";

  constructor(options: MarkdownStreamerOptions = {}) {
    this.accent = options.accent;
  }

  style(line: Pick<PhysicalLine, "text" | "continuation">): string {
    if (!line.continuation) this.block = this.classify(line.text);

    switch (this.block) {
      case "fence":
        return "";
      case "code":
        return code(line.text);
      case "heading":
        return this.accent
          ? chalk.bold(this.accent(styleInline(stripHeading(line.text, line.continuation))))
          : heading(styleInline(stripHeading(line.text, line.continuation)));
      case "subheading":
        return this.accent
          ? chalk.bold(this.accent(styleInline(stripHeading(line.text, line.continuation))))
          : chalk.bold(styleInline(stripHeading(line.text, line.continuation)));
      case "rule":
        return chalk.dim(line.text);
      case "quote": {
        if (line.continuation) return chalk.dim.italic(styleInline(line.text));
        // The bar replaces the marker, it does not get added to it: LineBuffer
        // already wrapped this line at the source width, so a `>text` written
        // without its space would render one column wider than the terminal was
        // measured for and soft-wrap underneath the rail.
        const body = line.text.replace(/^\s{0,3}>\s?/u, "");
        const gap = /^\s{0,3}>\s/u.test(line.text) ? " " : "";
        return chalk.dim.italic(styleInline(`|${gap}${body}`));
      }
      case "list": {
        if (line.continuation) return styleInline(line.text);
        const item = classifyLine(line.text);
        return chalk.dim(item.marker ?? "") + styleInline(item.body ?? "", this.accent, true);
      }
      default:
        return styleInline(line.text, this.accent, !line.continuation);
    }
  }

  private classify(text: string): BlockStyle {
    const info = classifyLine(text);

    if (info.kind === "fence") {
      this.inFence = !this.inFence;
      return "fence";
    }
    if (this.inFence) return "code";

    switch (info.kind) {
      case "heading":
        return (info.level ?? 1) <= 2 ? "heading" : "subheading";
      case "rule":
        return "rule";
      case "quote":
        return "quote";
      case "list":
        return "list";
      case "table":
        return "table";
      default:
        return "plain";
    }
  }
}

function stripHeading(text: string, continuation: boolean): string {
  return continuation ? text : text.replace(/^\s{0,3}#{1,6}\s+/u, "");
}
