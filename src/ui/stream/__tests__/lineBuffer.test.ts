import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { displayWidth, LineBuffer, plainOf, sliceColumns, truncateEnd, wrapAll } from "../lineBuffer.js";

const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

describe("wrapAll", () => {
  it("respects the display width", () => {
    for (const piece of wrapAll("the little cat sleeps on the red rug", 12)) {
      expect(displayWidth(piece)).toBeLessThanOrEqual(12);
    }
  });

  it("breaks a string without spaces rather than overflowing", () => {
    const pieces = wrapAll("a".repeat(25), 10);
    expect(pieces).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });

  it("counts wide characters for the space they take", () => {
    // Each ideogram takes two columns: six fit in twelve.
    const pieces = wrapAll("日本語日本語日本語", 12);
    expect(pieces[0]).toBe("日本語日本語");
    for (const piece of pieces) expect(displayWidth(piece)).toBeLessThanOrEqual(12);
  });

  it("never splits an emoji in two", () => {
    const pieces = wrapAll("🚀🚀🚀🚀🚀🚀", 5);
    for (const piece of pieces) {
      expect(displayWidth(piece)).toBeLessThanOrEqual(5);
      expect([...piece].every((c) => c !== "\uD83D")).toBe(true);
    }
  });

  it("preserves an empty line", () => {
    expect(wrapAll("", 10)).toEqual([""]);
  });
});

describe("truncateEnd", () => {
  it("adds three dots without exceeding the display width", () => {
    expect(truncateEnd("123456789", 8)).toBe("12345...");
    expect(displayWidth(truncateEnd("Topic 🚀 very long", 12))).toBeLessThanOrEqual(12);
  });

  it("leaves untouched a text that already fits", () => {
    expect(truncateEnd("Short topic", 20)).toBe("Short topic");
  });
});

describe("LineBuffer", () => {
  it("returns nothing until a line is finished", () => {
    const buf = new LineBuffer(40);
    expect(buf.push("a sentence")).toEqual([]);
    expect(buf.tail.text).toBe("a sentence");
  });

  it("returns a line as soon as it is finished", () => {
    const buf = new LineBuffer(40);
    buf.push("a sentence");
    expect(texts(buf.push(" complete\n"))).toEqual(["a sentence complete"]);
    expect(buf.tail.text).toBe("");
  });

  it("returns several lines contained in a single chunk", () => {
    const buf = new LineBuffer(40);
    expect(texts(buf.push("one\ntwo\nthree"))).toEqual(["one", "two"]);
    expect(buf.tail.text).toBe("three");
  });

  it("emits full physical lines before the end of the logical line", () => {
    const buf = new LineBuffer(10);
    const lines = buf.push("aaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(texts(lines)).toEqual(["aaaaaaaaaa", "aaaaaaaaaa"]);
    expect(buf.tail.text).toBe("aaaaa");
  });

  it("marks the continuation lines of a wrapped logical line", () => {
    const buf = new LineBuffer(10);
    const lines = buf.push("aaaaaaaaaaaaaaaaaaaaaaaaa\n");
    expect(lines.map((l) => l.continuation)).toEqual([false, true, true]);
  });

  it("starts over after a line end", () => {
    const buf = new LineBuffer(10);
    buf.push("aaaaaaaaaaaaa\n");
    expect(buf.push("bbb\n")[0]).toEqual({ text: "bbb", continuation: false });
  });

  it("applies a resize to the following lines only", () => {
    const buf = new LineBuffer(10);
    buf.push("aaaaaaaaaaaa");
    buf.setWidth(40);
    expect(texts(buf.push(" bbbb\n"))).toEqual(["aa bbbb"]);
  });

  it("delivers the remainder on flush", () => {
    const buf = new LineBuffer(40);
    buf.push("no line end");
    expect(texts(buf.flush())).toEqual(["no line end"]);
    expect(buf.flush()).toEqual([]);
  });

  it("loses nothing, whatever the chunk splitting", () => {
    const source = "first\nsecond long enough to be wrapped several times\n\nthird\n";
    const buf = new LineBuffer(16);
    const out: string[] = [];
    for (const ch of source) out.push(...texts(buf.push(ch)));
    out.push(...texts(buf.flush()));
    // The lines are glued back with the space that the wrapping consumed.
    expect(out.join(" ").replace(/\s+/g, " ").trim()).toBe(source.replace(/\s+/g, " ").trim());
  });
});

describe("plainOf", () => {
  it("strips styling", () => {
    expect(plainOf(`${chalk.hex("#ff0000")("│")} ${chalk.bold("hello")}`)).toBe("│ hello");
  });
});

describe("sliceColumns", () => {
  it("cuts by display width", () => {
    expect(sliceColumns("abcdef", 1, 4)).toBe("bcd");
  });

  it("never returns half a wide character", () => {
    expect(sliceColumns("a界b", 1, 3)).toBe("界");
    expect(sliceColumns("a界b", 2, 3)).toBe("");
  });

  it("returns an empty string for an empty or reversed range", () => {
    expect(sliceColumns("abc", 2, 2)).toBe("");
    expect(sliceColumns("abc", 3, 1)).toBe("");
  });
});
