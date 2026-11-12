import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { displayWidth } from "../lineBuffer.js";
import { MarkdownStreamer } from "../markdownStream.js";

// The runner is not a TTY: without this chalk disables itself and there is
// nothing left to check. The real terminal always has colors (cli.tsx
// refuses to start outside a TTY).
chalk.level = 3;

const line = (text: string, continuation = false) => ({ text, continuation });

/** Strip the styling to check what was actually printed. */
const plain = (styled: string) => styled.replace(/\u001b\[[0-9;]*m/g, "");

describe("MarkdownStreamer", () => {
  it("never exceeds the width measured before the markers are removed", () => {
    const s = new MarkdownStreamer();
    for (const text of ["## Title", "- a key **point**", "> quote", ">quote", "some inline `code`", "| a | b |"]) {
      expect(displayWidth(s.style(line(text)))).toBeLessThanOrEqual(displayWidth(text));
    }
  });

  it("styles a balanced emphasis on the line", () => {
    const s = new MarkdownStreamer();
    const out = s.style(line("a **bold** here"));
    expect(plain(out)).toBe("a bold here");
    expect(out).not.toBe("a **bold** here");
  });

  it("replaces the heading syntax with a visual hierarchy", () => {
    const s = new MarkdownStreamer();
    expect(plain(s.style(line("## Title")))).toBe("Title");
  });

  it("also removes the emphasis inside a quote", () => {
    const s = new MarkdownStreamer();
    expect(plain(s.style(line("> an **idea**")))).toBe("| an idea");
  });

  // The bar replaces the chevron, it is not added to it: LineBuffer has already
  // split the line at the source width.
  it("does not gain a column on a quote written without a space", () => {
    const s = new MarkdownStreamer();
    expect(plain(s.style(line(">tight")))).toBe("|tight");
  });

  it("hides code block fences", () => {
    const s = new MarkdownStreamer();
    expect(s.style(line("```ts"))).toBe("");
    expect(plain(s.style(line("const answer = 42;")))).toBe("const answer = 42;");
    expect(s.style(line("```"))).toBe("");
  });

  it("leaves an unclosed delimiter literal", () => {
    const s = new MarkdownStreamer();
    expect(s.style(line("a **bold never closed"))).toBe("a **bold never closed");
  });

  it("leaves literal a construct that crosses a line boundary", () => {
    const s = new MarkdownStreamer();
    // The first line has already been written when the second arrives: neither
    // can be restyled afterwards.
    expect(s.style(line("opening **of bold"))).toBe("opening **of bold");
    expect(s.style(line("and its closing** here", true))).toBe("and its closing** here");
  });

  it("colors every line of a code block without waiting for its closing", () => {
    const s = new MarkdownStreamer();
    const fence = s.style(line("```ts"));
    const body = s.style(line("const a = **1**;"));
    expect(plain(body)).toBe("const a = **1**;");
    // In a code block, the content is colored as a block, not interpreted.
    expect(body).not.toBe(fence);
    expect(body.startsWith("\u001b")).toBe(true);
  });

  it("leaves the code block at the closing fence", () => {
    const s = new MarkdownStreamer();
    s.style(line("```"));
    const inside = s.style(line("code"));
    s.style(line("```"));
    const after = s.style(line("text"));
    expect(after).toBe("text");
    expect(inside).not.toBe("code");
  });

  it("treats a never-closed block as code until the end", () => {
    const s = new MarkdownStreamer();
    s.style(line("```"));
    expect(plain(s.style(line("a line")))).toBe("a line");
    expect(s.style(line("a line"))).not.toBe("a line");
  });

  it("renders tables as plain text, without retroactive alignment", () => {
    const s = new MarkdownStreamer();
    expect(plain(s.style(line("| a | b |")))).toBe("| a | b |");
    expect(plain(s.style(line("|---|---|")))).toBe("|---|---|");
  });

  it("keeps the list marker with its content", () => {
    const s = new MarkdownStreamer();
    expect(plain(s.style(line("  - a point")))).toBe("  - a point");
  });

  describe("accent", () => {
    const accent = (text: string) => `<${text}>`;

    it("accents a bold label opening a line", () => {
      const s = new MarkdownStreamer({ accent });
      expect(plain(s.style(line("**Risk.** the cache can go stale")))).toBe("<Risk.> the cache can go stale");
      expect(plain(s.style(line("- **Proposal:** split it")))).toBe("- <Proposal:> split it");
    });

    it("does not accent a bold span mid-line", () => {
      const s = new MarkdownStreamer({ accent });
      expect(plain(s.style(line("the **cache** can go stale")))).toBe("the cache can go stale");
    });

    it("does not accent a bold span opening a wrapped continuation", () => {
      const s = new MarkdownStreamer({ accent });
      s.style(line("a long sentence"));
      expect(plain(s.style(line("**bold** rest", true)))).toBe("bold rest");
    });

    it("accents a heading, replacing the brand colour", () => {
      const s = new MarkdownStreamer({ accent });
      expect(plain(s.style(line("## Title")))).toBe("<Title>");
    });
  });
});
