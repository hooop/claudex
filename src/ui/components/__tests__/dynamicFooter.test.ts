import { describe, expect, it } from "vitest";
import {
  MAX_DYNAMIC_ROWS,
  MAX_STANDARD_DYNAMIC_ROWS,
  MIN_COLS,
  MIN_ROWS,
} from "../../theme.js";
import { COMMAND_PALETTE_ROWS } from "../CommandPalette.js";
import {
  footerMode,
  footerRows,
  inputBarMaxRows,
  type FooterSurfaces,
} from "../DynamicFooter.js";
import { INPUT_BAR_MAX_ROWS } from "../InputBar.js";
import { MODEL_FOOTER_ROWS } from "../ModelFooter.js";

const surfaces = (over: Partial<FooterSurfaces> = {}): FooterSurfaces => ({
  tail: false,
  banner: false,
  notice: false,
  modal: null,
  selectionPalette: false,
  ...over,
});

/** Every combination of surfaces the debate view can put up at once. */
function allCombinations(): FooterSurfaces[] {
  const out: FooterSurfaces[] = [];
  for (const tail of [false, true]) {
    for (const banner of [false, true]) {
      for (const notice of [false, true]) {
        for (const modal of [null, "permission"] as const) {
          // A modal hides the banner and the notice — this is the rule the view applies.
          if (modal !== null && (banner || notice)) continue;
          out.push({ tail, banner, notice, modal, selectionPalette: false });
        }
      }
    }
  }
  return out;
}

describe("footerRows", () => {
  it("never exceeds the dynamic area ceiling", () => {
    for (const combo of allCombinations()) {
      expect(footerRows(combo)).toBeLessThanOrEqual(MAX_STANDARD_DYNAMIC_ROWS);
      expect(footerRows({ ...combo, inputRows: INPUT_BAR_MAX_ROWS })).toBeLessThanOrEqual(
        MAX_STANDARD_DYNAMIC_ROWS,
      );
    }
  });

  it("counts the status, the input and the model footer without a modal", () => {
    expect(footerRows(surfaces())).toBe(5);
    expect(footerRows(surfaces({ tail: true, banner: true, notice: true }))).toBe(7);
  });

  it("lets the field grow without exceeding the dynamic ceiling", () => {
    expect(inputBarMaxRows(surfaces())).toBe(INPUT_BAR_MAX_ROWS - MODEL_FOOTER_ROWS);
    expect(footerRows(surfaces({ inputRows: INPUT_BAR_MAX_ROWS }))).toBe(
      MAX_STANDARD_DYNAMIC_ROWS,
    );

    const crowded = surfaces({ tail: true, banner: true, notice: true });
    expect(inputBarMaxRows(crowded)).toBe(3);
    expect(footerRows({ ...crowded, inputRows: INPUT_BAR_MAX_ROWS })).toBe(
      MAX_STANDARD_DYNAMIC_ROWS,
    );
  });

  it("reserves the dynamic area for the palette and the prompt when it is open", () => {
    const palette = surfaces({
      tail: true,
      banner: true,
      notice: true,
      selectionPalette: true,
      inputRows: INPUT_BAR_MAX_ROWS,
    });

    expect(inputBarMaxRows(palette)).toBe(3);
    expect(footerRows(palette)).toBe(COMMAND_PALETTE_ROWS + 3);
    expect(footerRows(palette)).toBe(MAX_DYNAMIC_ROWS);
  });

  it("lets the permission replace the status and the input while keeping the models below", () => {
    expect(footerRows(surfaces({ modal: "permission" }))).toBe(2 + MODEL_FOOTER_ROWS);
  });
});

describe("footerMode", () => {
  it("draws a box of the requested height on a normal terminal", () => {
    expect(footerMode(100, 40, 5)).toEqual({ kind: "box", height: 5 });
  });

  it("caps the height even if the caller asks for more", () => {
    expect(footerMode(100, 40, 99)).toEqual({ kind: "box", height: MAX_DYNAMIC_ROWS });
  });

  it("stays strictly below the terminal height", () => {
    for (let terminalRows = MIN_ROWS; terminalRows < 60; terminalRows++) {
      const mode = footerMode(100, terminalRows, MAX_DYNAMIC_ROWS);
      if (mode.kind === "box") expect(mode.height).toBeLessThan(terminalRows);
    }
  });

  it("falls back to a one-line message when the terminal is too small", () => {
    expect(footerMode(100, MIN_ROWS - 1, 3).kind).toBe("too-small");
    expect(footerMode(MIN_COLS - 1, 40, 3).kind).toBe("too-small");
  });

  it("allows an initial space without ever reaching the terminal height", () => {
    expect(footerMode(100, 30, 2, 29)).toEqual({ kind: "box", height: 29 });
    expect(footerMode(100, 30, 2, 99)).toEqual({ kind: "box", height: 29 });
  });
});
