import { describe, expect, it } from "vitest";
import { displayWidth, LineBuffer, truncateEnd, wrapAll } from "../lineBuffer.js";

const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

describe("wrapAll", () => {
  it("respecte la largeur d'affichage", () => {
    for (const piece of wrapAll("le petit chat dort sur le tapis rouge", 12)) {
      expect(displayWidth(piece)).toBeLessThanOrEqual(12);
    }
  });

  it("coupe une chaîne sans espace plutôt que de déborder", () => {
    const pieces = wrapAll("a".repeat(25), 10);
    expect(pieces).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });

  it("compte les caractères larges pour ce qu'ils occupent", () => {
    // Chaque idéogramme occupe deux colonnes : six tiennent dans douze.
    const pieces = wrapAll("日本語日本語日本語", 12);
    expect(pieces[0]).toBe("日本語日本語");
    for (const piece of pieces) expect(displayWidth(piece)).toBeLessThanOrEqual(12);
  });

  it("ne coupe jamais un emoji en deux", () => {
    const pieces = wrapAll("🚀🚀🚀🚀🚀🚀", 5);
    for (const piece of pieces) {
      expect(displayWidth(piece)).toBeLessThanOrEqual(5);
      expect([...piece].every((c) => c !== "\uD83D")).toBe(true);
    }
  });

  it("préserve une ligne vide", () => {
    expect(wrapAll("", 10)).toEqual([""]);
  });
});

describe("truncateEnd", () => {
  it("ajoute trois points sans dépasser la largeur d'affichage", () => {
    expect(truncateEnd("123456789", 8)).toBe("12345...");
    expect(displayWidth(truncateEnd("Sujet 🚀 très long", 12))).toBeLessThanOrEqual(12);
  });

  it("laisse intact un texte qui tient déjà", () => {
    expect(truncateEnd("Sujet court", 20)).toBe("Sujet court");
  });
});

describe("LineBuffer", () => {
  it("ne rend rien tant qu'une ligne n'est pas terminée", () => {
    const buf = new LineBuffer(40);
    expect(buf.push("une phrase")).toEqual([]);
    expect(buf.tail.text).toBe("une phrase");
  });

  it("rend une ligne dès qu'elle est terminée", () => {
    const buf = new LineBuffer(40);
    buf.push("une phrase");
    expect(texts(buf.push(" complète\n"))).toEqual(["une phrase complète"]);
    expect(buf.tail.text).toBe("");
  });

  it("rend plusieurs lignes contenues dans un seul chunk", () => {
    const buf = new LineBuffer(40);
    expect(texts(buf.push("une\ndeux\ntrois"))).toEqual(["une", "deux"]);
    expect(buf.tail.text).toBe("trois");
  });

  it("émet les lignes physiques pleines avant la fin de la ligne logique", () => {
    const buf = new LineBuffer(10);
    const lines = buf.push("aaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(texts(lines)).toEqual(["aaaaaaaaaa", "aaaaaaaaaa"]);
    expect(buf.tail.text).toBe("aaaaa");
  });

  it("marque les lignes de continuation d'une ligne logique repliée", () => {
    const buf = new LineBuffer(10);
    const lines = buf.push("aaaaaaaaaaaaaaaaaaaaaaaaa\n");
    expect(lines.map((l) => l.continuation)).toEqual([false, true, true]);
  });

  it("repart à zéro après une fin de ligne", () => {
    const buf = new LineBuffer(10);
    buf.push("aaaaaaaaaaaaa\n");
    expect(buf.push("bbb\n")[0]).toEqual({ text: "bbb", continuation: false });
  });

  it("applique un resize aux lignes suivantes seulement", () => {
    const buf = new LineBuffer(10);
    buf.push("aaaaaaaaaaaa");
    buf.setWidth(40);
    expect(texts(buf.push(" bbbb\n"))).toEqual(["aa bbbb"]);
  });

  it("livre le reste au flush", () => {
    const buf = new LineBuffer(40);
    buf.push("sans fin de ligne");
    expect(texts(buf.flush())).toEqual(["sans fin de ligne"]);
    expect(buf.flush()).toEqual([]);
  });

  it("ne perd rien, quel que soit le découpage des chunks", () => {
    const source = "premier\ndeuxième assez long pour être replié plusieurs fois\n\ntroisième\n";
    const buf = new LineBuffer(16);
    const out: string[] = [];
    for (const ch of source) out.push(...texts(buf.push(ch)));
    out.push(...texts(buf.flush()));
    // Les lignes sont recollées avec l espace que le repli a consommé.
    expect(out.join(" ").replace(/\s+/g, " ").trim()).toBe(source.replace(/\s+/g, " ").trim());
  });
});
