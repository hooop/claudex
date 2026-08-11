import { describe, expect, it } from "vitest";
import { classifyLine, parseInline } from "../markdown.js";

describe("parseInline", () => {
  it("extrait gras, italique et code", () => {
    expect(parseInline("un **gras**, un *ital*, un `code`")).toEqual([
      { type: "text", value: "un " },
      { type: "bold", value: "gras" },
      { type: "text", value: ", un " },
      { type: "italic", value: "ital" },
      { type: "text", value: ", un " },
      { type: "code", value: "code" },
    ]);
  });

  it("laisse les identifiants snake_case intacts", () => {
    expect(parseInline("appelle drain_queue_now")).toEqual([{ type: "text", value: "appelle drain_queue_now" }]);
  });

  it("ne prend pas une multiplication pour de l'italique", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", value: "2 * 3 * 4" }]);
  });

  it("conserve l'URL des liens", () => {
    expect(parseInline("voir [la doc](https://x.dev)")).toEqual([
      { type: "text", value: "voir " },
      { type: "link", value: "la doc", url: "https://x.dev" },
    ]);
  });

  it("rend littéralement une emphase non terminée", () => {
    expect(parseInline("un **gras en cours")).toEqual([{ type: "text", value: "un **gras en cours" }]);
  });

  it("ne franchit jamais une frontière de ligne", () => {
    // Le rendu append-only livre une ligne physique à la fois : un délimiteur
    // dont le partenaire est sur la ligne suivante reste littéral pour toujours.
    expect(parseInline("ouverture **ici")).toEqual([{ type: "text", value: "ouverture **ici" }]);
    expect(parseInline("et fermeture** là")).toEqual([{ type: "text", value: "et fermeture** là" }]);
  });
});

describe("classifyLine", () => {
  it("reconnaît les titres avec leur niveau", () => {
    expect(classifyLine("## Points bloquants")).toEqual({ kind: "heading", level: 2 });
    expect(classifyLine("#### Détail")).toEqual({ kind: "heading", level: 4 });
    expect(classifyLine("#pas-un-titre")).toEqual({ kind: "plain" });
  });

  it("reconnaît les délimiteurs de bloc de code", () => {
    expect(classifyLine("```ts")).toEqual({ kind: "fence" });
    expect(classifyLine("~~~")).toEqual({ kind: "fence" });
  });

  it("sépare le marqueur de liste de son contenu", () => {
    expect(classifyLine("- point")).toEqual({ kind: "list", marker: "- ", body: "point" });
    expect(classifyLine("  1. premier")).toEqual({ kind: "list", marker: "  1. ", body: "premier" });
  });

  it("reconnaît règles, citations et lignes de tableau", () => {
    expect(classifyLine("---")).toEqual({ kind: "rule" });
    expect(classifyLine("> une citation")).toEqual({ kind: "quote" });
    expect(classifyLine("| a | b |")).toEqual({ kind: "table" });
  });

  it("traite tout le reste comme du texte", () => {
    expect(classifyLine("une phrase normale")).toEqual({ kind: "plain" });
    expect(classifyLine("")).toEqual({ kind: "plain" });
  });
});
