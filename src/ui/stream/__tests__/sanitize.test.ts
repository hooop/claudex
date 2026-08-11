import { describe, expect, it } from "vitest";
import { AnsiSanitizer, sanitizeForDisplay, TAB_WIDTH } from "../sanitize.js";

const ESC = "\u001b";

describe("sanitizeForDisplay", () => {
  it("retire les séquences de couleur CSI", () => {
    expect(sanitizeForDisplay(`${ESC}[31mrouge${ESC}[0m`)).toBe("rouge");
  });

  it("retire un effacement d'écran", () => {
    expect(sanitizeForDisplay(`avant${ESC}[2J${ESC}[3J${ESC}[Haprès`)).toBe("avantaprès");
  });

  it("retire les séquences OSC et le BEL", () => {
    expect(sanitizeForDisplay(`${ESC}]0;titre\u0007texte`)).toBe("texte");
    expect(sanitizeForDisplay("bip\u0007")).toBe("bip");
  });

  it("retire backspace et retour chariot isolé", () => {
    expect(sanitizeForDisplay("abc\bd")).toBe("abcd");
    expect(sanitizeForDisplay("efface\rtout")).toBe("effacetout");
  });

  it("normalise CRLF en LF", () => {
    expect(sanitizeForDisplay("une\r\ndeux")).toBe("une\ndeux");
  });

  it("développe les tabulations", () => {
    expect(sanitizeForDisplay("a\tb")).toBe("a" + " ".repeat(TAB_WIDTH) + "b");
  });

  it("préserve l'Unicode imprimable et le markdown", () => {
    const text = "**gras** — café 日本語 🚀 `code`";
    expect(sanitizeForDisplay(text)).toBe(text);
  });

  it("préserve les fins de ligne", () => {
    expect(sanitizeForDisplay("une\ndeux\n")).toBe("une\ndeux\n");
  });
});

describe("AnsiSanitizer", () => {
  it("recolle une séquence coupée entre deux chunks", () => {
    const s = new AnsiSanitizer();
    expect(s.push(`texte${ESC}[3`)).toBe("texte");
    expect(s.push("1msuite")).toBe("suite");
    expect(s.flush()).toBe("");
  });

  it("recolle un ESC isolé en fin de chunk", () => {
    const s = new AnsiSanitizer();
    expect(s.push(`a${ESC}`)).toBe("a");
    expect(s.push("[0mb")).toBe("b");
  });

  it("ne retient pas indéfiniment un ESC sans suite", () => {
    const s = new AnsiSanitizer();
    s.push(`a${ESC}`);
    expect(s.flush()).toBe("");
  });
});
