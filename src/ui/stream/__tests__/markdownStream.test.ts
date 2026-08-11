import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { displayWidth } from "../lineBuffer.js";
import { MarkdownStreamer } from "../markdownStream.js";

// Le runner n est pas un TTY : sans cela chalk se désactive et il n y a plus
// rien à vérifier. Le terminal réel, lui, a toujours des couleurs (cli.tsx
// refuse de démarrer hors TTY).
chalk.level = 3;

const line = (text: string, continuation = false) => ({ text, continuation });

/** Strip the styling to check what was actually printed. */
const plain = (styled: string) => styled.replace(/\u001b\[[0-9;]*m/g, "");

describe("MarkdownStreamer", () => {
  it("ne change jamais la largeur affichée d'une ligne", () => {
    const s = new MarkdownStreamer();
    for (const text of ["## Titre", "- un **point** clé", "> citation", "du `code` inline", "| a | b |"]) {
      expect(displayWidth(s.style(line(text)))).toBe(displayWidth(text));
    }
  });

  it("stylise une emphase équilibrée sur la ligne", () => {
    const s = new MarkdownStreamer();
    const out = s.style(line("un **gras** ici"));
    expect(plain(out)).toBe("un **gras** ici");
    expect(out).not.toBe("un **gras** ici");
  });

  it("laisse littéral un délimiteur non fermé", () => {
    const s = new MarkdownStreamer();
    expect(s.style(line("un **gras jamais fermé"))).toBe("un **gras jamais fermé");
  });

  it("laisse littérale une construction qui traverse une frontière de ligne", () => {
    const s = new MarkdownStreamer();
    // La première ligne a déjà été écrite quand la seconde arrive : ni l'une
    // ni l'autre ne peut être restylée après coup.
    expect(s.style(line("ouverture **du gras"))).toBe("ouverture **du gras");
    expect(s.style(line("et sa fermeture** ici", true))).toBe("et sa fermeture** ici");
  });

  it("colore chaque ligne d'un bloc de code sans attendre sa fermeture", () => {
    const s = new MarkdownStreamer();
    const fence = s.style(line("```ts"));
    const body = s.style(line("const a = **1**;"));
    expect(plain(body)).toBe("const a = **1**;");
    // Dans un bloc de code, le contenu est coloré en bloc, pas interprété.
    expect(body).not.toBe(fence);
    expect(body.startsWith("\u001b")).toBe(true);
  });

  it("sort du bloc de code à la fermeture", () => {
    const s = new MarkdownStreamer();
    s.style(line("```"));
    const inside = s.style(line("code"));
    s.style(line("```"));
    const after = s.style(line("texte"));
    expect(after).toBe("texte");
    expect(inside).not.toBe("code");
  });

  it("traite un bloc jamais fermé comme du code jusqu'au bout", () => {
    const s = new MarkdownStreamer();
    s.style(line("```"));
    expect(plain(s.style(line("une ligne")))).toBe("une ligne");
    expect(s.style(line("une ligne"))).not.toBe("une ligne");
  });

  it("rend les tableaux en texte brut, sans alignement rétroactif", () => {
    const s = new MarkdownStreamer();
    expect(plain(s.style(line("| a | b |")))).toBe("| a | b |");
    expect(plain(s.style(line("|---|---|")))).toBe("|---|---|");
  });

  it("garde le marqueur de liste avec son contenu", () => {
    const s = new MarkdownStreamer();
    expect(plain(s.style(line("  - un point")))).toBe("  - un point");
  });
});
