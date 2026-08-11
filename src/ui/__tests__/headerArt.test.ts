import { describe, expect, it } from "vitest";
import {
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

  it("fait évoluer le spectre saturé du plasma de façon pseudo-aléatoire et déterministe", () => {
    const first = headerFrame(80, 0, "plasma").map((row) => row.map(({ color }) => color));
    const later = headerFrame(80, 8, "plasma").map((row) => row.map(({ color }) => color));
    const dominantChannels = new Set(
      first.flat().map((color) => {
        const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
        return channels.indexOf(Math.max(...channels));
      }),
    );

    expect(new Set(first.flat()).size).toBeGreaterThan(20);
    expect(dominantChannels).toEqual(new Set([0, 1, 2]));
    expect(first[0]).not.toEqual(first[1]);
    expect(later).not.toEqual(first);
    expect(headerFrame(80, 8, "plasma").map((row) => row.map(({ color }) => color))).toEqual(later);
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
          expect(row[0]?.color).toBe("#6d5dfc");
          expect(row.at(-1)?.color).toBe("#f472b6");
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
