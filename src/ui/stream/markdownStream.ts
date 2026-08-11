/**
 * Colours one physical line at a time, with no way to revise the last one.
 *
 * The old renderer re-parsed the whole entry on every token, so a `**` could
 * start out literal and become bold once its partner arrived. Append-only output
 * has no such luxury: by the time the closing delimiter shows up, the opening one
 * is already in the terminal's scrollback. So the rule here is that a construct is
 * styled only when it is complete *within the line being committed*, and anything
 * that straddles a line boundary stays literal — permanently, and identically for
 * every reader.
 *
 * Styling never changes a line's character count, so it can be applied after the
 * line buffer has already decided where the line ends.
 */

import chalk from "chalk";
import { classifyLine, parseInline } from "../markdown.js";
import { BRAND_COLOR, CODE_COLOR } from "../theme.js";
import type { PhysicalLine } from "./lineBuffer.js";

type BlockStyle = "fence" | "code" | "heading" | "subheading" | "rule" | "quote" | "list" | "table" | "plain";

const code = chalk.hex(CODE_COLOR);
const heading = chalk.bold.hex(BRAND_COLOR);

function styleInline(text: string): string {
  const spans = parseInline(text);
  // Fast path: the overwhelmingly common case is a line with no markup at all.
  if (spans.length === 1 && spans[0]!.type === "text") return text;

  let out = "";
  for (const span of spans) {
    switch (span.type) {
      case "bold":
        out += chalk.bold(`**${span.value}**`);
        break;
      case "italic":
        out += chalk.italic(`*${span.value}*`);
        break;
      case "code":
        out += code(`\`${span.value}\``);
        break;
      case "link":
        out += chalk.underline(`[${span.value}]`) + chalk.dim(`(${span.url})`);
        break;
      default:
        out += span.value;
    }
  }
  return out;
}

export class MarkdownStreamer {
  private inFence = false;
  private block: BlockStyle = "plain";

  /**
   * The markup delimiters are kept visible (`**bold**`, not `bold`) so the styled
   * line occupies exactly the columns the line buffer measured, and so a
   * selection copied out of the terminal is still the markdown the agent wrote.
   */
  style(line: PhysicalLine): string {
    if (!line.continuation) this.block = this.classify(line.text);

    switch (this.block) {
      case "fence":
        return chalk.dim(line.text);
      case "code":
        return code(line.text);
      case "heading":
        return heading(line.text);
      case "subheading":
        return chalk.bold(line.text);
      case "rule":
        return chalk.dim(line.text);
      case "quote":
        return chalk.dim.italic(line.text);
      case "list": {
        if (line.continuation) return styleInline(line.text);
        const item = classifyLine(line.text);
        return chalk.dim(item.marker ?? "") + styleInline(item.body ?? "");
      }
      default:
        return styleInline(line.text);
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
