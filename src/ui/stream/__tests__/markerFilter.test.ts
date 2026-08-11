import { describe, expect, it } from "vitest";
import { extractSignal } from "../../../orchestrator/markers.js";
import { MarkerFilter } from "../markerFilter.js";

/** Feed a whole turn through the filter, one chunk at a time, as it streams. */
function run(chunks: string[], signalConfirmed?: boolean): string {
  const filter = new MarkerFilter();
  let out = "";
  for (const chunk of chunks) out += filter.push(chunk);
  const confirmed = signalConfirmed ?? extractSignal(chunks.join("")).signal !== null;
  return out + filter.finish(confirmed);
}

describe("MarkerFilter", () => {
  it("supprime un marqueur terminal", () => {
    expect(run(["D'accord.\n\n", "<<CONSENSUS>>"])).toBe("D'accord.\n\n");
  });

  it("supprime un marqueur terminal suivi d'une fin de ligne", () => {
    expect(run(["D'accord.\n\n<<CONSENSUS>>\n"])).toBe("D'accord.\n\n");
  });

  it("supprime les blancs retenus derrière le marqueur", () => {
    expect(run(["Texte\n<<CONSENSUS>>\n", "\n", "\n"])).toBe("Texte\n");
  });

  it("réunit un marqueur découpé entre plusieurs chunks", () => {
    expect(run(["Texte\n", "<<CON", "SEN", "SUS>>"])).toBe("Texte\n");
  });

  it("relâche le marqueur quand du contenu arrive derrière", () => {
    expect(run(["Texte\n", "<<CONSENSUS>>\n", "\n", "en fait non\n"])).toBe(
      "Texte\n<<CONSENSUS>>\n\nen fait non\n",
    );
  });

  it("ne retient pas une chaîne seulement ressemblante", () => {
    expect(run(["Texte\n", "<<CONSENSUSX>>\n"])).toBe("Texte\n<<CONSENSUSX>>\n");
    expect(run(["on vise le <<CONSENSUS>> ici\n"])).toBe("on vise le <<CONSENSUS>> ici\n");
  });

  it("relâche le marqueur si le signal n'est pas confirmé", () => {
    expect(run(["Texte\n<<CONSENSUS>>"], false)).toBe("Texte\n<<CONSENSUS>>\n");
  });

  it("ne laisse jamais fuiter un marqueur avant la décision", () => {
    const filter = new MarkerFilter();
    let out = filter.push("Texte\n");
    out += filter.push("<<CONSENSUS>>");
    expect(out).toBe("Texte\n");
    expect(filter.isHolding).toBe(true);
  });

  it("reste en parité avec extractSignal, quel que soit le découpage", () => {
    const turns = [
      "D'accord.\n\n<<CONSENSUS>>",
      "Objection.\n<<CONTINUE>>\n",
      "Texte\n<<CONSENSUS>>\nen fait non",
      "Aucun marqueur ici.",
      "**<<CONSENSUS>>**",
      "<<CONTINUE>>",
      "Question.\n<<WAIT_HUMAN>>",
      "Pas de sujet.\n<<NO_TOPIC>>",
    ];

    for (const turn of turns) {
      const { cleanText, signal } = extractSignal(turn);
      // Un caractère à la fois : le pire découpage possible.
      const streamed = run([...turn], signal !== null);
      expect(streamed.replace(/\s+$/u, "")).toBe(cleanText);
    }
  });
});
