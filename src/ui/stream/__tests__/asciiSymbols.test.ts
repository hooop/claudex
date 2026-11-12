import { describe, expect, it } from "vitest";
import { AsciiSymbolSanitizer, asciiSymbolsForDisplay } from "../asciiSymbols.js";

describe("asciiSymbolsForDisplay", () => {
  it("replaces status pictograms with their ASCII notation", () => {
    expect(asciiSymbolsForDisplay("✅ good ⚠ warning ❌ no ⏸ pause")).toBe(
      "[ok] good [!] warning [x] no [pause] pause",
    );
  });

  it("removes other emoji, including composed sequences", () => {
    expect(asciiSymbolsForDisplay("Start 🚀 then test 👩‍💻 done")).toBe(
      "Start  then test  done",
    );
  });

  // Deliberate French input: accented characters must pass through untouched.
  it("preserves accented text and ordinary structural characters", () => {
    // Deliberate French input: the accented "café" is kept as is.
    expect(asciiSymbolsForDisplay("café — list | rail ↑↓")).toBe("café — list | rail ↑↓");
  });

  // These characters are Extended_Pictographic without being emoji: an agent
  // quoting a license header or a product name must keep them.
  it("preserves the typographic punctuation that agents quote verbatim", () => {
    expect(asciiSymbolsForDisplay("Copyright © 2024, Node™ and React®")).toBe(
      "Copyright © 2024, Node™ and React®",
    );
    expect(asciiSymbolsForDisplay("‼ urgent ▶ launch ☑ done ✂ cut")).toBe(
      "‼ urgent ▶ launch ☑ done ✂ cut",
    );
  });

  it("removes the same characters when U+FE0F asks for the emoji presentation", () => {
    expect(asciiSymbolsForDisplay("▶️ launch")).toBe(" launch");
  });

  it("removes default emoji, flags and keycaps", () => {
    expect(asciiSymbolsForDisplay("⚡ fast 🇫🇷 here 1️⃣ one")).toBe(
      " fast  here  one",
    );
  });
});

describe("AsciiSymbolSanitizer", () => {
  it("reassembles an emoji split across several fragments", () => {
    const sanitizer = new AsciiSymbolSanitizer();
    expect(sanitizer.push("before \uD83D")).toBe("before ");
    expect(sanitizer.push("\uDE80 after")).toBe(" after");
    expect(sanitizer.flush()).toBe("");
  });

  it("waits for a symbol's possible variant before replacing it", () => {
    const sanitizer = new AsciiSymbolSanitizer();
    expect(sanitizer.push("✓")).toBe("");
    expect(sanitizer.push("️ done")).toBe("[ok] done");
  });
});
