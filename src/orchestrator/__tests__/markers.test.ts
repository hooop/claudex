import { describe, expect, it } from "vitest";
import { extractSignal, scanMarkerLine } from "../markers.js";
import { CONSENSUS_INSTRUCTIONS } from "../scheduler.js";

describe("scanMarkerLine", () => {
  it("reconnaît un marqueur seul sur sa ligne", () => {
    expect(scanMarkerLine("<<CONSENSUS>>")).toEqual({ kind: "match", marker: "<<CONSENSUS>>" });
    expect(scanMarkerLine("<<CONTINUE>>")).toEqual({ kind: "match", marker: "<<CONTINUE>>" });
    expect(scanMarkerLine("<<NO_TOPIC>>")).toEqual({ kind: "match", marker: "<<NO_TOPIC>>" });
    expect(scanMarkerLine("<<WAIT_HUMAN>>")).toEqual({ kind: "match", marker: "<<WAIT_HUMAN>>" });
  });

  it("tolère une décoration markdown bornée", () => {
    expect(scanMarkerLine("**<<CONSENSUS>>**").kind).toBe("match");
    expect(scanMarkerLine("  _ <<CONTINUE>> _  ").kind).toBe("match");
  });

  it("refuse une décoration au-delà de la borne", () => {
    // Deux runs de padding et un run de décoration au maximum, de chaque côté.
    expect(scanMarkerLine("*".repeat(5) + "<<CONSENSUS>>").kind).toBe("no");
    expect(scanMarkerLine(" ".repeat(17) + "<<CONSENSUS>>").kind).toBe("no");
    expect(scanMarkerLine("<<CONSENSUS>>" + " ".repeat(17)).kind).toBe("no");
  });

  it("signale un préfixe qui pourrait encore devenir un marqueur", () => {
    expect(scanMarkerLine("<<CONSE").kind).toBe("partial");
    expect(scanMarkerLine("<").kind).toBe("partial");
    expect(scanMarkerLine("").kind).toBe("partial");
    expect(scanMarkerLine("  **").kind).toBe("partial");
  });

  it("refuse une ligne qui contient autre chose que le marqueur", () => {
    expect(scanMarkerLine("nous sommes d'accord <<CONSENSUS>>").kind).toBe("no");
    expect(scanMarkerLine("<<CONSENSUS>> mais avec une réserve").kind).toBe("no");
    expect(scanMarkerLine("<<CONSENSUSX>>").kind).toBe("no");
    expect(scanMarkerLine("une phrase normale").kind).toBe("no");
  });
});

describe("extractSignal", () => {
  it("détache un marqueur terminal du corps du message", () => {
    expect(extractSignal("D'accord.\n\n<<CONSENSUS>>")).toEqual({
      cleanText: "D'accord.",
      signal: "consensus",
    });
    expect(extractSignal("Objection.\n<<CONTINUE>>")).toEqual({
      cleanText: "Objection.",
      signal: "continue",
    });
    expect(extractSignal("Il me faut le volume.\n<<WAIT_HUMAN>>").signal).toBe("wait-human");
    expect(extractSignal("Aucun sujet.\n<<NO_TOPIC>>").signal).toBe("no-topic");
  });

  it("ignore les blancs après le marqueur", () => {
    expect(extractSignal("Texte\n\n<<CONSENSUS>>\n\n   \n").signal).toBe("consensus");
  });

  it("ne signale rien quand le marqueur est suivi de contenu", () => {
    const text = "Texte\n<<CONSENSUS>>\nen fait non";
    expect(extractSignal(text)).toEqual({ cleanText: text, signal: null });
  });

  it("ne signale rien sans marqueur", () => {
    expect(extractSignal("Juste du texte.\n")).toEqual({ cleanText: "Juste du texte.", signal: null });
  });

  it("accepte un message réduit au seul marqueur", () => {
    expect(extractSignal("<<CONSENSUS>>")).toEqual({ cleanText: "", signal: "consensus" });
  });
});

/**
 * La consigne envoyée aux agents montre à quoi doit ressembler une fin de réponse.
 * Si quelqu'un retouche cet exemple sans regarder le parseur — ou l'inverse — le
 * débat ne s'arrêterait plus jamais sur un consensus, sans rien signaler. D'où ce
 * test, qui fait passer les exemples du prompt dans le vrai parseur.
 */
describe("CONSENSUS_INSTRUCTIONS", () => {
  const prompt = CONSENSUS_INSTRUCTIONS("Claude", "Codex");
  const INCORRECT = "Fin de réponse incorrecte";

  function exampleAfter(heading: string): string {
    const start = prompt.indexOf(heading);
    expect(start, `rubrique introuvable dans la consigne : ${heading}`).toBeGreaterThan(-1);
    const rest = prompt.slice(start + heading.length);
    const end = rest.indexOf(INCORRECT);
    return (end === -1 ? rest : rest.slice(0, end)).trim();
  }

  it("montre un exemple correct que le parseur reconnaît vraiment", () => {
    expect(extractSignal(exampleAfter("Fin de réponse correcte :")).signal).toBe("consensus");
  });

  it("montre un contre-exemple que le parseur rejette vraiment", () => {
    expect(extractSignal(exampleAfter(INCORRECT)).signal).toBeNull();
  });
});
