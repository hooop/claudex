import { describe, expect, it } from "vitest";
import { classifyLine, markdownToPlainText, parseInline } from "../markdown.js";

describe("parseInline", () => {
  it("extracts bold, italic and code", () => {
    expect(parseInline("a **bold**, an *ital*, a `code`")).toEqual([
      { type: "text", value: "a " },
      { type: "bold", value: "bold" },
      { type: "text", value: ", an " },
      { type: "italic", value: "ital" },
      { type: "text", value: ", a " },
      { type: "code", value: "code" },
    ]);
  });

  it("leaves snake_case identifiers intact", () => {
    expect(parseInline("call drain_queue_now")).toEqual([{ type: "text", value: "call drain_queue_now" }]);
  });

  it("does not mistake a multiplication for italics", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", value: "2 * 3 * 4" }]);
  });

  it("keeps the URL of links", () => {
    expect(parseInline("see [the docs](https://x.dev)")).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: "the docs", url: "https://x.dev" },
    ]);
  });

  it("renders an unterminated emphasis literally", () => {
    expect(parseInline("an **bold in progress")).toEqual([{ type: "text", value: "an **bold in progress" }]);
  });

  it("never crosses a line boundary", () => {
    // The append-only rendering delivers one physical line at a time: a delimiter
    // whose partner is on the next line stays literal forever.
    expect(parseInline("opening **here")).toEqual([{ type: "text", value: "opening **here" }]);
    expect(parseInline("and closing** there")).toEqual([{ type: "text", value: "and closing** there" }]);
  });
});

describe("classifyLine", () => {
  it("recognizes headings with their level", () => {
    expect(classifyLine("## Blocking points")).toEqual({ kind: "heading", level: 2 });
    expect(classifyLine("#### Detail")).toEqual({ kind: "heading", level: 4 });
    expect(classifyLine("#not-a-heading")).toEqual({ kind: "plain" });
  });

  it("recognizes code block delimiters", () => {
    expect(classifyLine("```ts")).toEqual({ kind: "fence" });
    expect(classifyLine("~~~")).toEqual({ kind: "fence" });
  });

  it("separates the list marker from its content", () => {
    expect(classifyLine("- point")).toEqual({ kind: "list", marker: "- ", body: "point" });
    expect(classifyLine("  1. first")).toEqual({ kind: "list", marker: "  1. ", body: "first" });
  });

  it("recognizes rules, quotes and table rows", () => {
    expect(classifyLine("---")).toEqual({ kind: "rule" });
    expect(classifyLine("> a quote")).toEqual({ kind: "quote" });
    expect(classifyLine("| a | b |")).toEqual({ kind: "table" });
  });

  it("treats everything else as text", () => {
    expect(classifyLine("a normal sentence")).toEqual({ kind: "plain" });
    expect(classifyLine("")).toEqual({ kind: "plain" });
  });
});

describe("markdownToPlainText", () => {
  it("removes the markers while keeping a readable structure", () => {
    expect(
      markdownToPlainText(
        "## Decision\n\n- use **Architecture C**\n\n> see `decisions.md`\n\n```ts\nconst ok = true;\n```",
      ),
    ).toBe("Decision\n\n- use Architecture C\n\n| see decisions.md\n\nconst ok = true;");
  });
});
