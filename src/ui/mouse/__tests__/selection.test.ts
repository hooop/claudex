import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { line } from "../../stream/streamController.js";
import { LineBuffer } from "../../stream/lineBuffer.js";
import {
  WHEEL_LINES,
  dragSelection,
  highlightColumns,
  orderedRange,
  screenToCell,
  selectedColumns,
  selectedText,
  type Selection,
} from "../selection.js";

chalk.level = 3;

const viewport = { top: 4, height: 10, firstLine: 20 };

function sel(anchorLine: number, anchorCol: number, focusLine: number, focusCol: number): Selection {
  return { anchor: { line: anchorLine, col: anchorCol }, focus: { line: focusLine, col: focusCol } };
}

describe("screenToCell", () => {
  it("maps a viewport row and column to an absolute line and display column", () => {
    expect(screenToCell(4, 0, viewport)).toEqual({ line: 20, col: 0 });
    expect(screenToCell(13, 7, viewport)).toEqual({ line: 29, col: 7 });
  });

  it("returns null above, below or in an empty viewport", () => {
    expect(screenToCell(3, 0, viewport)).toBeNull();
    expect(screenToCell(14, 0, viewport)).toBeNull();
    expect(screenToCell(4, 0, { top: 4, height: 0, firstLine: 0 })).toBeNull();
  });
});

describe("orderedRange", () => {
  it("puts the earlier cell first whichever way the drag went", () => {
    const forward = sel(2, 5, 4, 1);
    const backward = sel(4, 1, 2, 5);
    const expected = { start: { line: 2, col: 5 }, end: { line: 4, col: 1 } };
    expect(orderedRange(forward)).toEqual(expected);
    expect(orderedRange(backward)).toEqual(expected);
  });

  it("orders by column on the same line", () => {
    expect(orderedRange(sel(3, 9, 3, 2))).toEqual({ start: { line: 3, col: 2 }, end: { line: 3, col: 9 } });
  });
});

describe("selectedColumns", () => {
  it("covers only the dragged columns on a single line, end exclusive", () => {
    expect(selectedColumns(sel(3, 2, 3, 6), 3, 40)).toEqual([2, 6]);
    expect(selectedColumns(sel(3, 6, 3, 2), 3, 40)).toEqual([2, 6]);
  });

  it("runs to the line end on the first line, whole middle lines, from 0 on the last", () => {
    const selection = sel(5, 3, 2, 4);
    expect(selectedColumns(selection, 2, 40)).toEqual([4, 40]);
    expect(selectedColumns(selection, 3, 40)).toEqual([0, 40]);
    expect(selectedColumns(selection, 5, 40)).toEqual([0, 3]);
  });

  it("is null outside the selection and for an empty one", () => {
    expect(selectedColumns(sel(2, 0, 4, 3), 1, 40)).toBeNull();
    expect(selectedColumns(sel(2, 0, 4, 3), 5, 40)).toBeNull();
    expect(selectedColumns(sel(3, 4, 3, 4), 3, 40)).toBeNull();
  });
});

describe("selectedText", () => {
  const rail = chalk.hex("#d97757")("│");
  const lines = [
    line(chalk.hex("#d97757").bold("◆ Claude") + chalk.dim("  Round 1")),
    line(`${rail} ${chalk.bold("first")} line   `),
    line(rail),
    line(`${rail} third line`),
  ];

  it("copies part of one line", () => {
    expect(selectedText(lines, sel(1, 2, 1, 7))).toBe("first");
  });

  it("copies several lines in either direction, rails and trailing spaces removed", () => {
    const expected = "first line\n\nthird line";
    expect(selectedText(lines, sel(1, 0, 3, 40))).toBe(expected);
    expect(selectedText(lines, sel(3, 40, 1, 0))).toBe(expected);
  });

  it("strips the turn header glyph", () => {
    expect(selectedText(lines, sel(0, 0, 0, 40))).toBe("Claude  Round 1");
  });

  it("keeps a rail glyph that is not at the start of the slice", () => {
    expect(selectedText([line("a │ b")], sel(0, 2, 0, 5))).toBe("│ b");
  });

  it("joins a soft-wrapped paragraph back into the original sentence", () => {
    const sentence = "The quick brown fox jumps over the lazy dog and keeps running far away";
    const buffer = new LineBuffer(20);
    const physical = buffer.push(`${sentence}\n`);
    expect(physical.length).toBeGreaterThan(2);
    const wrapped = physical.map((piece) => line(`${rail} ${piece.text}`, piece.continuation, piece.droppedSpace));

    expect(selectedText(wrapped, sel(0, 0, wrapped.length - 1, 80))).toBe(sentence);
  });

  it("joins a hard-wrapped URL back without inserting spaces", () => {
    const text = "see https://example.com/a/very/long/path/to/some/resource/file.ts";
    const physical = new LineBuffer(20).push(`${text}\n`);
    expect(physical.length).toBeGreaterThan(2);
    const wrapped = physical.map((piece) => line(`${rail} ${piece.text}`, piece.continuation, piece.droppedSpace));

    expect(selectedText(wrapped, sel(0, 0, wrapped.length - 1, 80))).toBe(text);
  });

  it("treats the space after the rail as chrome", () => {
    expect(selectedText(lines, sel(1, 1, 1, 7))).toBe("first");
    expect(selectedText(lines, sel(0, 1, 0, 40))).toBe("Claude  Round 1");
    expect(selectedText(lines, sel(1, 1, 1, 2))).toBe("");
  });

  it("never splits a wide character", () => {
    // "a界b": "界" covers columns 1 and 2.
    const wide = [line("a界b")];
    expect(selectedText(wide, sel(0, 0, 0, 2))).toBe("a");
    expect(selectedText(wide, sel(0, 2, 0, 4))).toBe("b");
    expect(selectedText(wide, sel(0, 1, 0, 3))).toBe("界");
  });

  it("is empty when anchor and focus are the same cell", () => {
    expect(selectedText(lines, sel(1, 4, 1, 4))).toBe("");
  });

  it("ignores lines past the end of the transcript", () => {
    expect(selectedText(lines, sel(3, 2, 9, 0))).toBe("third line");
  });
});

describe("highlightColumns", () => {
  it("inverts the selected columns of the plain text", () => {
    const styled = chalk.red("hello world");
    expect(highlightColumns(styled, [6, 11])).toBe(`hello ${chalk.inverse("world")}`);
  });

  it("keeps a wide character straddling an edge, outside the inverse, in place", () => {
    expect(highlightColumns("a界b", [2, 4])).toBe(`a界${chalk.inverse("b")}`);
    expect(highlightColumns("a界b", [0, 2])).toBe(`${chalk.inverse("a")}界b`);
  });
});

describe("dragSelection", () => {
  function drag(anchorLine: number, anchorCol: number, focusLine: number, focusCol: number, moved = true) {
    return { anchor: { line: anchorLine, col: anchorCol }, focus: { line: focusLine, col: focusCol }, moved };
  }

  /** What the viewport draws for line `index` and what a release copies. */
  function drawnAndCopied(lines: ReturnType<typeof line>[], selection: Selection | null, index = 0) {
    const columns = selection ? selectedColumns(selection, index, 80) : null;
    return {
      drawn: columns ? highlightColumns(lines[index]!.styled, columns) : lines[index]!.styled,
      copied: selection ? selectedText(lines, selection) : "",
    };
  }

  const words = [line("hello world")];

  it("copies and highlights the full word when a forward drag ends on its last character", () => {
    // "w" is column 6, "d" column 10.
    expect(drawnAndCopied(words, dragSelection(words, drag(0, 6, 0, 10)))).toEqual({
      drawn: `hello ${chalk.inverse("world")}`,
      copied: "world",
    });
  });

  it("includes the press cell when the drag goes backward", () => {
    expect(drawnAndCopied(words, dragSelection(words, drag(0, 10, 0, 6)))).toEqual({
      drawn: `hello ${chalk.inverse("world")}`,
      copied: "world",
    });
  });

  it("includes both end cells across lines", () => {
    const lines = [line("alpha beta"), line("gamma delta")];
    // From "b" of "beta" (column 6) to "a" ending "gamma" (column 4), both ways.
    expect(selectedText(lines, dragSelection(lines, drag(0, 6, 1, 4))!)).toBe("beta\ngamma");
    expect(selectedText(lines, dragSelection(lines, drag(1, 4, 0, 6))!)).toBe("beta\ngamma");
  });

  it("selects the one character under the pointer after a drag that came back to the press cell", () => {
    expect(drawnAndCopied(words, dragSelection(words, drag(0, 4, 0, 4)))).toEqual({
      drawn: `hell${chalk.inverse("o")} world`,
      copied: "o",
    });
  });

  it("selects nothing for a click without a drag", () => {
    expect(dragSelection(words, drag(0, 4, 0, 4, false))).toBeNull();
  });

  it("covers a whole wide character under either end, in the highlight and the copy alike", () => {
    // "a界b": "界" covers columns 1 and 2.
    const wide = [line("a界b")];
    // Ending on the second half of "界".
    expect(drawnAndCopied(wide, dragSelection(wide, drag(0, 0, 0, 2)))).toEqual({
      drawn: `${chalk.inverse("a界")}b`,
      copied: "a界",
    });
    // Starting on the second half of "界", backward.
    expect(drawnAndCopied(wide, dragSelection(wide, drag(0, 3, 0, 2)))).toEqual({
      drawn: `a${chalk.inverse("界b")}`,
      copied: "界b",
    });
  });

  it("extends one column past the end of a line", () => {
    expect(dragSelection(words, drag(0, 6, 0, 30))).toEqual({
      anchor: { line: 0, col: 6 },
      focus: { line: 0, col: 31 },
    });
  });
});

describe("WHEEL_LINES", () => {
  it("scrolls three lines per notch", () => {
    expect(WHEEL_LINES).toBe(3);
  });
});
