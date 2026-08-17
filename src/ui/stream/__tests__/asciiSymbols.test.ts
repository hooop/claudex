import { describe, expect, it } from "vitest";
import { AsciiSymbolSanitizer, asciiSymbolsForDisplay } from "../asciiSymbols.js";

describe("asciiSymbolsForDisplay", () => {
  it("remplace les pictogrammes de statut par leur notation ASCII", () => {
    expect(asciiSymbolsForDisplay("✅ bon ⚠ attention ❌ non ⏸ pause")).toBe(
      "[ok] bon [!] attention [x] non [pause] pause",
    );
  });

  it("retire les autres emoji, y compris les séquences composées", () => {
    expect(asciiSymbolsForDisplay("Départ 🚀 puis test 👩‍💻 terminé")).toBe(
      "Départ  puis test  terminé",
    );
  });

  it("préserve le français et les caractères structurels ordinaires", () => {
    expect(asciiSymbolsForDisplay("café — liste | rail ↑↓")).toBe("café — liste | rail ↑↓");
  });

  // Ces caractères sont Extended_Pictographic sans être des emoji : un agent
  // qui cite un en-tête de licence ou un nom de produit doit les garder.
  it("préserve la ponctuation typographique que les agents citent verbatim", () => {
    expect(asciiSymbolsForDisplay("Copyright © 2024, Node™ et React®")).toBe(
      "Copyright © 2024, Node™ et React®",
    );
    expect(asciiSymbolsForDisplay("‼ urgent ▶ lancer ☑ fait ✂ couper")).toBe(
      "‼ urgent ▶ lancer ☑ fait ✂ couper",
    );
  });

  it("retire les mêmes caractères quand U+FE0F en demande la présentation emoji", () => {
    expect(asciiSymbolsForDisplay("▶️ lancer")).toBe(" lancer");
  });

  it("retire les emoji par défaut, drapeaux et keycaps", () => {
    expect(asciiSymbolsForDisplay("⚡ vite 🇫🇷 ici 1️⃣ un")).toBe(
      " vite  ici  un",
    );
  });
});

describe("AsciiSymbolSanitizer", () => {
  it("recompose un emoji découpé entre plusieurs fragments", () => {
    const sanitizer = new AsciiSymbolSanitizer();
    expect(sanitizer.push("avant \uD83D")).toBe("avant ");
    expect(sanitizer.push("\uDE80 après")).toBe(" après");
    expect(sanitizer.flush()).toBe("");
  });

  it("attend la variante éventuelle d'un symbole avant de le remplacer", () => {
    const sanitizer = new AsciiSymbolSanitizer();
    expect(sanitizer.push("✓")).toBe("");
    expect(sanitizer.push("️ terminé")).toBe("[ok] terminé");
  });
});
