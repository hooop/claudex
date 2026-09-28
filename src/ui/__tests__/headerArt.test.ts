import { describe, expect, it } from "vitest";
import {
  CLAUDE_FLASH_COLOR,
  CODEX_FLASH_COLOR,
  cycleHeaderAnimation,
  DEFAULT_HEADER_ANIMATION,
  getHeaderAnimation,
  HEADER_ANIMATIONS,
  HEADER_MAX_WIDTH,
  HEADER_ROWS,
  headerFrame,
  type HeaderAnimationId,
} from "../headerArt.js";
import { displayWidth } from "../stream/lineBuffer.js";

function rowText(row: ReturnType<typeof headerFrame>[number]): string {
  return row.map((band) => band.chars).join("");
}

function fingerprint(id: HeaderAnimationId, t: number, width = 80): string {
  return headerFrame(width, t, id).map(rowText).join("\n");
}

function isHeaderCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return " ░▒▓█#".includes(character) || (codePoint >= 0x2801 && codePoint <= 0x28ff);
}

describe("headerArt — galerie d'équations", () => {
  it("expose les neuf animations dans un ordre stable, avec le plasma par défaut", () => {
    expect(HEADER_ANIMATIONS).toHaveLength(9);
    expect(new Set(HEADER_ANIMATIONS.map(({ id }) => id))).toHaveLength(9);
    expect(HEADER_ANIMATIONS.every(({ label }) => label.trim().length > 0)).toBe(true);
    expect(DEFAULT_HEADER_ANIMATION).toBe("plasma");
    expect(getHeaderAnimation(DEFAULT_HEADER_ANIMATION).label).toBe("Plasma psychédélique");
  });

  it.each([20, 40, 80, 200])("produit cinq lignes de largeur réelle exacte à %i colonnes", (width) => {
    const expectedWidth = Math.min(width, HEADER_MAX_WIDTH);

    for (const { id, staticT } of HEADER_ANIMATIONS) {
      for (const t of [0, staticT, staticT + 8]) {
        const frame = headerFrame(width, t, id);
        expect(frame).toHaveLength(HEADER_ROWS);
        for (const row of frame) {
          expect(displayWidth(rowText(row))).toBe(expectedWidth);
        }
      }
    }
  });

  it("reste déterministe, temporellement animé et distinct à la phase canonique", () => {
    const staticFrames = new Set<string>();

    for (const { id, staticT } of HEADER_ANIMATIONS) {
      const first = headerFrame(80, staticT, id);
      expect(headerFrame(80, staticT, id)).toEqual(first);
      expect(fingerprint(id, staticT + 8)).not.toBe(fingerprint(id, staticT));
      staticFrames.add(fingerprint(id, staticT));
    }

    expect(staticFrames).toHaveLength(HEADER_ANIMATIONS.length);
  });

  it("dessine le plasma uniquement avec des caractères bloc", () => {
    for (const t of [0, 8, 24]) {
      const characters = [...fingerprint("plasma", t)].filter((character) => character !== "\n");
      expect(characters.every((character) => " ░▒▓█".includes(character))).toBe(true);
    }
  });

  it("fait évoluer le plasma monochrome de façon pseudo-aléatoire et déterministe", () => {
    const first = headerFrame(80, 0, "plasma").map((row) => row.map(({ color }) => color));
    const later = headerFrame(80, 8, "plasma").map((row) => row.map(({ color }) => color));
    const channels = first
      .flat()
      .map((color) => [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)));

    expect(new Set(first.flat()).size).toBeGreaterThan(20);
    expect(channels.every(([red, green, blue]) => red === green && green === blue)).toBe(true);
    expect(first[0]).not.toEqual(first[1]);
    expect(later).not.toEqual(first);
    expect(headerFrame(80, 8, "plasma").map((row) => row.map(({ color }) => color))).toEqual(later);
  });

  it("garde des impulsions colorées perceptibles même après une longue animation", () => {
    const flashColors = new Set(["#2b55f7", "#5dd7c3", "#fdbabf", "#ef3240"]);

    for (const start of [0, 800, 2400, 6400]) {
      const frames = Array.from({ length: 12 }, (_, index) =>
        headerFrame(80, start + index * 2, "plasma"),
      );
      const flashes = frames
        .flat(2)
        .filter((band) => flashColors.has(band.color));

      expect(flashes.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["claude", CLAUDE_FLASH_COLOR],
    ["codex", CODEX_FLASH_COLOR],
  ])("utilise uniquement la couleur de %s pendant sa réflexion", (_agent, flashColor) => {
    const colors = Array.from({ length: 16 }, (_, index) =>
      headerFrame(80, index * 2, "plasma", flashColor),
    ).flat(3) as unknown as Array<{ color: string }>;
    const values = colors.map(({ color }) => color);

    expect(values).toContain(flashColor);
    expect(
      values.every((color) => {
        if (color === flashColor) return true;
        const [red, green, blue] = [1, 3, 5].map((offset) =>
          Number.parseInt(color.slice(offset, offset + 2), 16),
        );
        return red === green && green === blue;
      }),
    ).toBe(true);
  });

  it("reste entièrement gris entre deux réflexions", () => {
    const colors = headerFrame(80, 24, "plasma", null).flat().map(({ color }) => color);
    expect(
      colors.every((color) => {
        const [red, green, blue] = [1, 3, 5].map((offset) =>
          Number.parseInt(color.slice(offset, offset + 2), 16),
        );
        return red === green && green === blue;
      }),
    ).toBe(true);
  });

  it("enchaîne une rafale au même endroit puis fait dériver les points chauds", () => {
    const counts = Array.from({ length: 10 }, () => 0);
    const currentRuns = Array.from({ length: 10 }, () => 0);
    const longestRuns = Array.from({ length: 10 }, () => 0);

    for (let frame = 1; frame <= 300; frame++) {
      const row = headerFrame(80, frame * 1.6, "plasma", CLAUDE_FLASH_COLOR)[0]!;
      row.forEach((band, index) => {
        if (band.color === CLAUDE_FLASH_COLOR) {
          counts[index] = counts[index]! + 1;
          currentRuns[index] = currentRuns[index]! + 1;
          longestRuns[index] = Math.max(longestRuns[index]!, currentRuns[index]!);
        } else {
          currentRuns[index] = 0;
        }
      });
    }

    expect(counts.every((count) => count > 0)).toBe(true);
    expect(longestRuns.every((run) => run >= 4)).toBe(true);
  });

  it("n'utilise que les glyphes prévus et garde les autres couleurs immobiles", () => {
    for (const { id, staticT } of HEADER_ANIMATIONS) {
      const first = headerFrame(80, staticT, id);
      const later = headerFrame(80, staticT + 8, id);

      if (id !== "plasma") {
        expect(first.map((row) => row.map(({ color }) => color))).toEqual(
          later.map((row) => row.map(({ color }) => color)),
        );
      }

      for (const row of first) {
        if (id !== "plasma") {
          expect(row[0]?.color).toBe("#787878");
          expect(row.at(-1)?.color).toBe("#f2f2f2");
        }
        for (const band of row) {
          expect(band.color).toMatch(/^#[0-9a-f]{6}$/);
          expect([...band.chars].every(isHeaderCharacter)).toBe(true);
        }
      }
    }
  });

  it("boucle dans les deux sens avec les flèches", () => {
    expect(cycleHeaderAnimation("plasma", -1)).toBe("heat");
    expect(cycleHeaderAnimation("heat", 1)).toBe("plasma");

    let current: HeaderAnimationId = DEFAULT_HEADER_ANIMATION;
    for (let step = 0; step < HEADER_ANIMATIONS.length; step++) {
      current = cycleHeaderAnimation(current, 1);
    }
    expect(current).toBe(DEFAULT_HEADER_ANIMATION);
  });
});
