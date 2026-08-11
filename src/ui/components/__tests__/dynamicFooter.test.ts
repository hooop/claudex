import { describe, expect, it } from "vitest";
import { MAX_DYNAMIC_ROWS, MIN_COLS, MIN_ROWS } from "../../theme.js";
import { COMMAND_PALETTE_ROWS } from "../CommandPalette.js";
import {
  footerMode,
  footerRows,
  inputBarMaxRows,
  pinnedFooterHeight,
  type FooterSurfaces,
} from "../DynamicFooter.js";
import { INPUT_BAR_MAX_ROWS } from "../InputBar.js";
import { MODEL_FOOTER_ROWS } from "../ModelFooter.js";
import { MODEL_PICKER_ROWS } from "../ModelPicker.js";

const surfaces = (over: Partial<FooterSurfaces> = {}): FooterSurfaces => ({
  tail: false,
  banner: false,
  notice: false,
  modal: null,
  commandPalette: false,
  ...over,
});

/** Every combination of surfaces the debate view can put up at once. */
function allCombinations(): FooterSurfaces[] {
  const out: FooterSurfaces[] = [];
  for (const tail of [false, true]) {
    for (const banner of [false, true]) {
      for (const notice of [false, true]) {
        for (const modal of [null, "permission", "model"] as const) {
          // Un modal masque bannière et notice — c'est la règle appliquée par la vue.
          if (modal !== null && (banner || notice)) continue;
          out.push({ tail, banner, notice, modal, commandPalette: false });
        }
      }
    }
  }
  return out;
}

describe("footerRows", () => {
  it("ne dépasse jamais le plafond de la zone dynamique", () => {
    for (const combo of allCombinations()) {
      expect(footerRows(combo)).toBeLessThanOrEqual(MAX_DYNAMIC_ROWS);
      expect(footerRows({ ...combo, inputRows: INPUT_BAR_MAX_ROWS })).toBeLessThanOrEqual(
        MAX_DYNAMIC_ROWS,
      );
    }
  });

  it("compte le statut, la saisie et le footer des modèles sans modal", () => {
    expect(footerRows(surfaces())).toBe(5);
    expect(footerRows(surfaces({ tail: true, banner: true, notice: true }))).toBe(7);
  });

  it("laisse le champ grandir sans dépasser le plafond dynamique", () => {
    expect(inputBarMaxRows(surfaces())).toBe(INPUT_BAR_MAX_ROWS - MODEL_FOOTER_ROWS);
    expect(footerRows(surfaces({ inputRows: INPUT_BAR_MAX_ROWS }))).toBe(MAX_DYNAMIC_ROWS);

    const crowded = surfaces({ tail: true, banner: true, notice: true });
    expect(inputBarMaxRows(crowded)).toBe(3);
    expect(footerRows({ ...crowded, inputRows: INPUT_BAR_MAX_ROWS })).toBe(MAX_DYNAMIC_ROWS);
  });

  it("réserve la zone dynamique à la palette et au prompt lorsqu'elle est ouverte", () => {
    const palette = surfaces({
      tail: true,
      banner: true,
      notice: true,
      commandPalette: true,
      inputRows: INPUT_BAR_MAX_ROWS,
    });

    expect(inputBarMaxRows(palette)).toBe(3);
    expect(footerRows(palette)).toBe(COMMAND_PALETTE_ROWS + 3);
    expect(footerRows(palette)).toBe(MAX_DYNAMIC_ROWS);
  });

  it("laisse un modal remplacer le statut et la saisie tout en gardant les modèles dessous", () => {
    expect(footerRows(surfaces({ modal: "permission" }))).toBe(2 + MODEL_FOOTER_ROWS);
    expect(footerRows(surfaces({ tail: true, modal: "model" }))).toBe(
      MODEL_PICKER_ROWS + MODEL_FOOTER_ROWS + 1,
    );
  });
});

describe("footerMode", () => {
  it("dessine une boîte de la hauteur demandée sur un terminal normal", () => {
    expect(footerMode(100, 40, 5)).toEqual({ kind: "box", height: 5 });
  });

  it("plafonne la hauteur même si l'appelant demande plus", () => {
    expect(footerMode(100, 40, 99)).toEqual({ kind: "box", height: MAX_DYNAMIC_ROWS });
  });

  it("reste strictement sous la hauteur du terminal", () => {
    for (let terminalRows = MIN_ROWS; terminalRows < 60; terminalRows++) {
      const mode = footerMode(100, terminalRows, MAX_DYNAMIC_ROWS);
      if (mode.kind === "box") expect(mode.height).toBeLessThan(terminalRows);
    }
  });

  it("replie sur un message d'une ligne quand le terminal est trop petit", () => {
    expect(footerMode(100, MIN_ROWS - 1, 3).kind).toBe("too-small");
    expect(footerMode(MIN_COLS - 1, 40, 3).kind).toBe("too-small");
  });

  it("autorise un espace initial sans jamais atteindre la hauteur du terminal", () => {
    expect(footerMode(100, 30, 2, 29)).toEqual({ kind: "box", height: 29 });
    expect(footerMode(100, 30, 2, 99)).toEqual({ kind: "box", height: 29 });
  });
});

describe("pinnedFooterHeight", () => {
  it("se rétracte monotonement jusqu'à la zone dynamique bornée", () => {
    const heights = Array.from({ length: 40 }, (_, permanentRows) =>
      pinnedFooterHeight(30, permanentRows),
    );

    expect(heights[0]).toBe(29);
    expect(heights.at(-1)).toBe(MAX_DYNAMIC_ROWS);
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeLessThanOrEqual(heights[i - 1]!);
      expect(heights[i]).toBeGreaterThanOrEqual(MAX_DYNAMIC_ROWS);
      expect(heights[i]).toBeLessThan(30);
    }
  });
});
