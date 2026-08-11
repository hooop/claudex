import chalk from "chalk";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../../../types.js";
import type { Signal } from "../../../orchestrator/types.js";
import { displayWidth } from "../lineBuffer.js";
import { TranscriptStream, type TailView } from "../transcriptStream.js";

chalk.level = 3;

let seq = 0;
function entry(partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, "from" | "kind">): TranscriptEntry {
  return { id: `e${++seq}`, text: "", timestamp: Date.parse("2026-08-09T14:30:00Z"), ...partial };
}

function harness(width = 60) {
  const writes: string[] = [];
  const tails: (TailView | null)[] = [];
  const stream = new TranscriptStream({
    write: (data) => writes.push(data),
    width: () => width,
    onTail: (tail) => tails.push(tail),
    intervalMs: 0,
  });
  const output = () => writes.join("");
  const plain = () => output().replace(/\u001b\[[0-9;]*m/g, "");
  return { stream, writes, tails, output, plain };
}

describe("TranscriptStream", () => {
  it("écrit un en-tête puis le corps du message", () => {
    const { stream, output, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Bonjour.\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });

    const lines = plain().split("\n");
    expect(lines[0]).toContain("Claude");
    expect(lines[0]).not.toContain("● Claude");
    expect(lines).toContain("│ Bonjour.");
    expect(output()).toContain("\u001b[38;5;210m");
  });

  it("termine chaque écriture par une fin de ligne", () => {
    const { stream, writes } = harness();
    const e = entry({ from: "codex", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "une ligne\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
    for (const write of writes) expect(write.endsWith("\n")).toBe(true);
  });

  it("tronque le sujet affiché sur une ligne sans modifier l'entrée canonique", () => {
    const { stream, plain } = harness(40);
    const e = entry({
      from: "system",
      kind: "system",
      text: `Sujet : ${"architecture distribuée ".repeat(5)}\navec reprise`,
    });
    const canonicalText = e.text;

    stream.entry(e);

    const rendered = plain().trimEnd();
    expect(rendered).toMatch(/^• Sujet : /);
    expect(rendered).toMatch(/\.\.\.$/);
    expect(displayWidth(rendered)).toBeLessThanOrEqual(40);
    expect(rendered).not.toContain("\n");
    expect(e.text).toBe(canonicalText);
  });

  it("n'émet jamais de séquence d'effacement", () => {
    const { stream, output } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    // Même si l'agent en produit une lui-même.
    stream.chunk(e.id, "avant\u001b[2J\u001b[3Japrès\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
    expect(output()).not.toMatch(/\u001b\[[0-9]*[JH]/);
    expect(output()).toContain("avantaprès");
  });

  it("ne commit jamais un marqueur confirmé", () => {
    const { stream, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "D'accord.\n\n");
    stream.chunk(e.id, "<<CONSENSUS>>");
    stream.entryCompleted(e.id, { status: "ok", signal: "consensus" });
    expect(plain()).not.toContain("CONSENSUS");
    expect(plain()).toContain("D'accord.");
  });

  it("garde le marqueur si le tour ne l'a pas confirmé", () => {
    const { stream, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Texte\n<<CONSENSUS>>\nen fait non\n");
    stream.entryCompleted(e.id, { status: "ok", signal: null });
    expect(plain()).toContain("<<CONSENSUS>>");
    expect(plain()).toContain("en fait non");
  });

  it("garde la ligne incomplète hors du terminal, dans le tail", () => {
    const { stream, plain, tails } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "une phrase sans fin");
    stream.flush();
    expect(plain()).not.toContain("une phrase sans fin");
    expect(tails.at(-1)?.text).toBe("une phrase sans fin");
  });

  it("intercale une note dans une réponse en cours, en fermant la ligne ouverte", () => {
    const { stream, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "je regarde le fichier");
    stream.entry(entry({ from: "claude", kind: "system", text: "Read src/cli.tsx" }));
    stream.chunk(e.id, " et je continue\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });

    const body = plain();
    expect(body.indexOf("je regarde le fichier")).toBeLessThan(body.indexOf("Read src/cli.tsx"));
    expect(body.indexOf("Read src/cli.tsx")).toBeLessThan(body.indexOf("et je continue"));
  });

  it("n'écrit rien pour une entrée qui n'est plus active", () => {
    const { stream, writes } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
    const before = writes.length;
    stream.chunk(e.id, "trop tard");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
    expect(writes.length).toBe(before);
  });

  describe("verdict de fin de tour", () => {
    // Le marqueur de protocole est filtré du transcript : sans cette ligne, on
    // lit une réponse sans savoir ce que l'agent a décidé, ni pourquoi le débat
    // s'arrête ou continue.
    const verdictOf = (from: "claude" | "codex", signal: Signal) => {
      const { stream, plain } = harness();
      const e = entry({ from, kind: "message" });
      stream.entryStarted(e);
      stream.chunk(e.id, "Mon analyse.\n");
      stream.entryCompleted(e.id, { status: "ok", signal });
      return plain();
    };

    it("nomme la décision et à qui la main passe", () => {
      expect(verdictOf("claude", "continue")).toContain("↳ poursuit · passe la main à Codex");
      expect(verdictOf("codex", "continue")).toContain("↳ poursuit · passe la main à Claude");
    });

    it("distingue un accord d'une attente humaine", () => {
      expect(verdictOf("claude", "consensus")).toContain("le débat se clôt quand les deux");
      expect(verdictOf("codex", "wait-human")).toContain("⏸ attend ta réponse");
    });

    it("dit explicitement qu'un tour n'a rien signalé", () => {
      expect(verdictOf("claude", null)).toContain("⚠ aucune décision signalée");
    });

    // Muet à l'origine, quand un non-sujet fermait la session : le retour à
    // l'accueil le disait. La conversation reste ouverte désormais, donc ce
    // tour doit annoncer sa décision et la suite comme tous les autres.
    it("annonce qu'il n'y a pas de sujet, et ce qui va se passer", () => {
      const verdict = verdictOf("claude", "no-topic");
      expect(verdict).toContain("✕ aucun sujet à débattre");
      expect(verdict).toContain("prochain message");
    });

    it("reste muet sur la synthèse, qui ne décide rien", () => {
      const { stream, plain } = harness();
      const e = entry({ from: "system", kind: "summary" });
      stream.entryStarted(e);
      stream.chunk(e.id, "Spécification finale.\n");
      stream.entryCompleted(e.id, { status: "ok", signal: null });
      expect(plain()).not.toContain("aucune décision signalée");
    });

    it("laisse une erreur remplacer le verdict", () => {
      const { stream, plain } = harness();
      const e = entry({ from: "claude", kind: "message" });
      stream.entryStarted(e);
      stream.entryCompleted(e.id, { status: "error", message: "réseau coupé" });
      expect(plain()).toContain("Erreur : réseau coupé");
      expect(plain()).not.toContain("poursuit");
    });
  });

  it("signale une erreur et une annulation en fin de tour", () => {
    const err = harness();
    const e1 = entry({ from: "codex", kind: "message" });
    err.stream.entryStarted(e1);
    err.stream.entryCompleted(e1.id, { status: "error", message: "réseau coupé" });
    expect(err.plain()).toContain("Erreur : réseau coupé");

    const cancelled = harness();
    const e2 = entry({ from: "codex", kind: "message" });
    cancelled.stream.entryStarted(e2);
    cancelled.stream.entryCompleted(e2.id, { status: "cancelled" });
    expect(cancelled.plain()).toContain("(Annulé)");
  });

  it("distingue visuellement Claude, Codex et l'humain", () => {
    const { stream, output, plain } = harness();
    for (const from of ["claude", "codex", "human"] as const) {
      const e = entry({ from, kind: from === "human" ? "intervention" : "message", text: "salut" });
      stream.entry(e);
    }
    // Une couleur distincte par auteur, sur le rail comme sur le badge.
    const colors = new Set(output().match(/\u001b\[38;(?:2;[0-9;]+|5;\d+)m/g) ?? []);
    expect(colors.size).toBeGreaterThanOrEqual(3);
    expect(output()).toContain("\u001b[38;5;210m");
    expect(output()).toContain("\u001b[38;5;159m");
    expect(plain()).toContain("│ Claude");
    expect(plain()).toContain("│ Codex");
    expect(plain()).not.toMatch(/● (?:Claude|Codex)|CLAUDE|CODEX/);
  });

  it("ne réécrit jamais ce qui est déjà écrit", () => {
    const { stream, writes } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "ligne un\n");
    const afterFirst = writes.join("");
    stream.chunk(e.id, "ligne deux\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
    expect(writes.join("").startsWith(afterFirst)).toBe(true);
  });

  it("garde un coût de mise à jour indépendant de la longueur de l'historique", () => {
    const { stream, writes } = harness();
    for (let i = 0; i < 200; i++) {
      const e = entry({ from: "claude", kind: "message" });
      stream.entryStarted(e);
      stream.chunk(e.id, `tour ${i}\n`);
      stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
    }
    // Chaque écriture ne porte que du texte neuf : la somme reste linéaire.
    const total = writes.join("").length;
    expect(total).toBeLessThan(200 * 400);
  });

  it("replie sur la largeur courante et applique un resize aux lignes suivantes", () => {
    const writes: string[] = [];
    let width = 30;
    const stream = new TranscriptStream({
      write: (d) => writes.push(d),
      width: () => width,
      onTail: () => {},
      intervalMs: 0,
    });
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "un texte assez long pour devoir être replié plusieurs fois\n");
    width = 80;
    stream.chunk(e.id, "et une seconde ligne tout aussi longue mais qui tient maintenant\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });

    const lines = writes.join("").replace(/\u001b\[[0-9;]*m/g, "").split("\n");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(lines.some((l) => l.includes("qui tient maintenant"))).toBe(true);
  });

  it("vide la ligne en attente à la fermeture", () => {
    const { stream, plain, tails } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "coupé net");
    stream.dispose();
    expect(plain()).toContain("coupé net");
    expect(tails.at(-1)).toBeNull();
  });
});

describe("TranscriptStream — cadence", () => {
  it("ne fait pas une écriture par token", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const stream = new TranscriptStream({
      write: (d) => writes.push(d),
      width: () => 60,
      onTail: () => {},
    });
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    for (let i = 0; i < 50; i++) stream.chunk(e.id, `mot ${i}\n`);
    // Rien n'est parti tant que la cadence n'est pas atteinte.
    const afterStart = writes.length;
    vi.advanceTimersByTime(32);
    expect(writes.length).toBe(afterStart + 1);
    vi.useRealTimers();
  });
});
