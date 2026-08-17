import { describe, expect, it } from "vitest";
import { contextRemainingPercent } from "../ModelFooter.js";

describe("contextRemainingPercent", () => {
  it("arrondit le contexte restant au pourcent entier", () => {
    expect(contextRemainingPercent({ usedTokens: 51_000, contextWindow: 200_000 })).toBe(
      "75%",
    );
  });

  it("borne les valeurs aberrantes", () => {
    expect(
      contextRemainingPercent({ usedTokens: 300_000, contextWindow: 200_000 }),
    ).toBe("0%");
  });

  // Un changement de modèle efface la mesure sans réinitialiser la session :
  // annoncer « 100% libre » retirerait l'alerte de saturation au moment précis
  // où l'utilisateur y réagit.
  it("distingue l'absence de mesure d'un contexte vide", () => {
    expect(contextRemainingPercent(undefined)).toBeNull();
    expect(contextRemainingPercent(null)).toBeNull();
    expect(contextRemainingPercent({ usedTokens: 0, contextWindow: 0 })).toBeNull();
  });
});
