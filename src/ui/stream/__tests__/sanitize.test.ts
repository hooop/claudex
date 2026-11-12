import { describe, expect, it } from "vitest";
import { AnsiSanitizer, sanitizeForDisplay, TAB_WIDTH } from "../sanitize.js";

const ESC = "\u001b";

describe("sanitizeForDisplay", () => {
  it("removes CSI color sequences", () => {
    expect(sanitizeForDisplay(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });

  it("removes a screen clear", () => {
    expect(sanitizeForDisplay(`before${ESC}[2J${ESC}[3J${ESC}[Hafter`)).toBe("beforeafter");
  });

  it("removes OSC sequences and BEL", () => {
    expect(sanitizeForDisplay(`${ESC}]0;title\u0007text`)).toBe("text");
    expect(sanitizeForDisplay("beep\u0007")).toBe("beep");
  });

  it("removes backspace and a lone carriage return", () => {
    expect(sanitizeForDisplay("abc\bd")).toBe("abcd");
    expect(sanitizeForDisplay("erase\rall")).toBe("eraseall");
  });

  it("normalizes CRLF to LF", () => {
    expect(sanitizeForDisplay("one\r\ntwo")).toBe("one\ntwo");
  });

  it("expands tabs", () => {
    expect(sanitizeForDisplay("a\tb")).toBe("a" + " ".repeat(TAB_WIDTH) + "b");
  });

  it("preserves printable Unicode and markdown", () => {
    // Deliberate French input: the accented "café" must pass through untouched.
    const text = "**bold** — café 日本語 🚀 `code`";
    expect(sanitizeForDisplay(text)).toBe(text);
  });

  it("preserves line ends", () => {
    expect(sanitizeForDisplay("one\ntwo\n")).toBe("one\ntwo\n");
  });
});

describe("AnsiSanitizer", () => {
  it("glues back a sequence split between two chunks", () => {
    const s = new AnsiSanitizer();
    expect(s.push(`text${ESC}[3`)).toBe("text");
    expect(s.push("1mrest")).toBe("rest");
    expect(s.flush()).toBe("");
  });

  it("glues back a lone ESC at the end of a chunk", () => {
    const s = new AnsiSanitizer();
    expect(s.push(`a${ESC}`)).toBe("a");
    expect(s.push("[0mb")).toBe("b");
  });

  it("does not hold a dangling ESC forever", () => {
    const s = new AnsiSanitizer();
    s.push(`a${ESC}`);
    expect(s.flush()).toBe("");
  });
});
