/**
 * End-to-end acceptance test for the full-screen debate renderer.
 *
 * It mounts the real debate view on a fake terminal, drives a real scheduler with
 * fake agents, and inspects the bytes that reach stdout. It verifies that long
 * output stays inside the transcript viewport and that navigation does not move
 * the fixed header or footer.
 */

import { Box, Text, render } from "ink";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AgentSendOptions, CodingAgent } from "../../agents/types.js";
import { DebateSession } from "../../orchestrator/session.js";
import type { AgentResult } from "../../orchestrator/types.js";
import type { AgentId } from "../../types.js";
import {
  bannerLines,
  DebateView,
  transcriptBlockLines,
  transcriptWindow,
} from "../DebateView.js";
import { getHeaderAnimation, headerFrame } from "../headerArt.js";

const CLEAR_SCREEN = /\u001b\[[23]J/;
const CURSOR_UP = /\u001b\[1A/g;
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

class FakeAgent implements CodingAgent {
  readonly label: string;
  private options: AgentSendOptions | null = null;
  private resolve: ((r: AgentResult) => void) | null = null;

  constructor(readonly id: AgentId) {
    this.label = `Fake ${id}`;
  }

  currentModel() {
    return "fake-model";
  }
  hasExplicitModel() {
    return true;
  }
  setModel() {}
  resetSession() {}
  async stop() {
    this.resolve?.({ kind: "cancelled" });
    this.resolve = null;
  }

  send(_message: string, options: AgentSendOptions): Promise<AgentResult> {
    this.options = options;
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  get pending(): boolean {
    return this.resolve !== null;
  }

  emit(delta: string): void {
    this.options?.onTextDelta?.(delta);
  }

  emitContext(usedTokens: number, contextWindow: number): void {
    this.options?.onContextUsage?.({ usedTokens, contextWindow });
  }

  complete(text: string): void {
    this.resolve?.({ kind: "success", text });
    this.resolve = null;
  }
}

function fakeTerminal(columns = 100, rows = 30) {
  const chunks: string[] = [];
  const inputQueue: string[] = [];

  const stdout = Object.assign(new EventEmitter(), {
    // Ink 7 ne dessine que si la sortie est un vrai terminal.
    isTTY: true,
    columns,
    rows,
    write: (data: string) => {
      chunks.push(data);
      return true;
    },
  });

  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    read: () => inputQueue.shift() ?? null,
    ref: () => stdin,
    unref: () => stdin,
  });

  const stderr = Object.assign(new EventEmitter(), { write: () => true });

  return {
    stdout,
    stdin,
    stderr,
    chunks,
    pushInput(input: string) {
      inputQueue.push(input);
      stdin.emit("readable");
    },
  };
}

async function tick(ms = 200) {
  await new Promise((r) => setTimeout(r, ms));
}

async function press(terminal: ReturnType<typeof fakeTerminal>, input: string) {
  terminal.pushInput(input);
  await tick(20);
}

function mount(options: { fromFullScreen?: boolean } = {}) {
  const terminal = fakeTerminal();
  const agents = { claude: new FakeAgent("claude"), codex: new FakeAgent("codex") };
  const session = new DebateSession(agents, {
    cwd: "/tmp",
    starter: "claude",
    autonomyBudget: { kind: "unbounded" },
  });
  const debate = (
    <DebateView
      session={session}
      topic="Sujet de test"
      cwd="/tmp"
      status={{
        decisionsCount: 2,
        decisionsText: null,
        lastSession: "2026-08-10T11:42:17.288Z",
        autonomyBudget: null,
        claudeConfiguredModel: null,
        claudeDefaultModel: null,
        codexDefaultModel: null,
        codexDefaultEffort: null,
      }}
      coordinatorState={{ kind: "idle" }}
      coordinatorNotice={null}
      onLifecycleRequest={async () => ({ ok: true, message: "ok" })}
      onAutonomySelected={async () => {}}
    />
  );

  const app = render(
    options.fromFullScreen ? (
      <Box flexDirection="column" height={terminal.stdout.rows - 1}>
        <Text>ACCUEIL</Text>
        <Box flexGrow={1} />
        <Text>ANCIEN PROMPT</Text>
      </Box>
    ) : (
      debate
    ),
    {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  return { ...terminal, agents, session, app, startDebate: () => app.rerender(debate) };
}

describe("DebateView — viewport plein écran", () => {
  it("ouvre la palette sans déclencher la pause d'urgence avec Échap", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    const pause = vi.spyOn(t.session, "pause");
    t.agents.claude.emit(Array.from({ length: 35 }, (_, i) => `stabilisation ${i}\n`).join(""));
    await tick();
    t.agents.claude.emit("ÉTAT_TRANSITOIRE_À_RESTAURER");
    await tick();
    t.chunks.length = 0;

    await press(t, "/");
    await vi.waitFor(() => expect(t.chunks.join("")).toContain("/claude <texte>"));

    t.chunks.length = 0;
    await press(t, "\u001b");
    expect(pause).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.chunks.join("")).toContain("ÉTAT_TRANSITOIRE_À_RESTAURER"));

    await press(t, "\u001b");
    expect(pause).toHaveBeenCalledOnce();
    for (const chunk of t.chunks) {
      expect((chunk.match(CURSOR_UP) ?? []).length).toBeLessThan(t.stdout.rows);
    }

    t.app.unmount();
  });

  it("ouvre les modèles comme les commandes, au-dessus du prompt, et choisit avec Tab", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    const pause = vi.spyOn(t.session, "pause");
    const setModel = vi.spyOn(t.session, "setModel");

    await press(t, "/model codex");
    await press(t, "\r");
    await vi.waitFor(() => expect(t.chunks.join("")).toContain("gpt-5.6-sol"));

    const frameChunk = [...t.chunks]
      .reverse()
      .find((chunk) => chunk.includes("gpt-5.6-sol") && chunk.includes("‣"));
    expect(frameChunk).toBeDefined();
    const frame = frameChunk!.replace(ANSI_SEQUENCE, "");
    expect(frame.indexOf("gpt-5.6-sol")).toBeLessThan(frame.indexOf("‣"));
    expect(frame).toContain("↑↓ 1/2 · Tab ou Entrée choisir · Échap fermer");
    expect(frame).not.toContain("fake-model + fake-model");

    await press(t, "\u001b[B");
    await press(t, "\t");
    expect(setModel).toHaveBeenCalledWith("codex", "gpt-5.5");

    await press(t, "/model claude");
    await press(t, "\r");
    await press(t, "\u001b");
    expect(pause).not.toHaveBeenCalled();
    t.app.unmount();
  });

  it("fige la phase canonique du preset reçu dans le scrollback", () => {
    const animation = "rule110";
    const expected = headerFrame(40, getHeaderAnimation(animation).staticT, animation)[0]!.map((band) =>
      band.chars,
    ).join("");
    const frozen = bannerLines(40, animation)
      .slice(0, 1)
      .map((line) => line.replace(ANSI_SEQUENCE, ""));

    expect(frozen).toEqual([expected]);
    expect(bannerLines(40, animation)).toHaveLength(2);
    expect(frozen).not.toEqual(
      bannerLines(40, "plasma")
        .slice(0, 1)
        .map((line) => line.replace(ANSI_SEQUENCE, "")),
    );
  });

  it("n'efface jamais l'écran, même sur une réponse plus haute que le terminal", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    // Deux fois la hauteur du terminal, en petits morceaux comme un vrai flux.
    for (let i = 0; i < 60; i++) {
      t.agents.claude.emit(`ligne de réponse numéro ${i}\n`);
      await tick(2);
    }
    t.agents.claude.complete("fin");
    await tick();

    const output = t.chunks.join("");
    expect(output).not.toMatch(CLEAR_SCREEN);
    expect(output).toContain("ligne de réponse numéro 59");

    t.app.unmount();
  });

  it("garde la trame dynamique strictement sous la hauteur du terminal", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    // Remplit d'abord l'espace qui maintient le prompt en bas.
    for (let i = 0; i < 30; i++) {
      t.agents.claude.emit(`du texte assez long pour être replié une fois ou deux — tour ${i}\n`);
      await tick(2);
    }
    await tick();
    t.chunks.length = 0;

    // En régime établi, la trame plein écran garde le header fixé en haut.
    for (let i = 30; i < 70; i++) {
      t.agents.claude.emit(`ligne établie ${i}\n`);
      await tick(2);
    }
    await tick();

    for (const chunk of t.chunks) {
      const erased = (chunk.match(CURSOR_UP) ?? []).length;
      expect(erased).toBeLessThan(t.stdout.rows);
    }

    t.app.unmount();
  });

  it("place la première ligne en haut de l'espace libre et garde le prompt en bas", async () => {
    const t = mount({ fromFullScreen: true });
    await tick();
    t.chunks.length = 0;
    t.startDebate();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit("PREMIÈRE INTERVENTION");
    await tick();

    const frame = [...t.chunks].reverse().find((chunk) => chunk.includes("PREMIÈRE INTERVENTION"));
    expect(frame).toBeDefined();
    const lines = frame!.replace(ANSI_SEQUENCE, "").split("\n");
    const interventionRow = lines.findIndex((line) => line.includes("PREMIÈRE INTERVENTION"));
    const promptRow = lines.findIndex((line) => line.includes("‣"));

    expect(interventionRow).toBeGreaterThanOrEqual(0);
    expect(promptRow).toBeGreaterThan(interventionRow);
    expect(frame).not.toMatch(CLEAR_SCREEN);
    expect(t.chunks.join("")).not.toContain("ANCIEN PROMPT");

    t.app.unmount();
  });

  it("borne l'amorçage sous la hauteur du terminal sans clear-screen", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.emit("début court");
    await tick();

    expect(t.chunks.join("")).not.toMatch(CLEAR_SCREEN);
    for (const chunk of t.chunks) {
      expect((chunk.match(CURSOR_UP) ?? []).length).toBeLessThan(t.stdout.rows);
    }

    t.app.unmount();
  });

  /**
   * Limite assumée depuis Ink 7 : rétrécir la fenêtre pendant l'amorçage efface
   * l'écran et réécrit le tampon statique, donc les lignes déjà affichées
   * peuvent apparaître en double. Ink efface dès qu'une trame précédente
   * dépassait la fenêtre courante (`shouldClearTerminalForFrame`,
   * `wasOverflowing`), et l'amorçage dessine délibérément une trame pleine
   * hauteur pour garder la saisie en bas de l'écran.
   *
   * C'est purement cosmétique : le transcript archivé est construit depuis
   * l'état de l'ordonnanceur, jamais depuis le terminal. Ce test verrouille
   * donc ce qui compte — aucune perte de contenu. Voir limits.md.
   */
  it("ne perd aucun contenu si le terminal rétrécit pendant l'amorçage", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.emit("quelques mots");
    await tick();

    t.stdout.rows = 12;
    t.stdout.emit("resize");
    await tick();

    const output = t.chunks.join("");
    expect(output).toContain("Sujet : Sujet de test");
    expect(output).toContain("quelques mots");

    t.app.unmount();
  });

  it("permet de remonter dans un long transcript sans déplacer le footer", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit(Array.from({ length: 50 }, (_, i) => `ligne historique ${i}\n`).join(""));
    await tick();
    t.chunks.length = 0;

    await press(t, "\u001b[5~");
    await tick();

    const output = t.chunks.join("");
    expect(output).toContain("ligne historique");
    expect(output).toContain("‣");

    t.app.unmount();
  });

  it("garde le header fixé après un agrandissement du terminal", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.emit(Array.from({ length: 35 }, (_, i) => `ligne ${i}\n`).join(""));
    await tick();
    t.chunks.length = 0;

    t.stdout.rows = 50;
    t.stdout.emit("resize");
    await tick();
    t.agents.claude.emit("après agrandissement\n");
    await tick();

    for (const chunk of t.chunks) {
      expect((chunk.match(CURSOR_UP) ?? []).length).toBeLessThan(t.stdout.rows);
    }

    t.app.unmount();
  });

  it("garde chaque ligne du transcript visible dans la trame", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit("une phrase parfaitement reconnaissable\n");
    await tick();
    t.agents.claude.emit("et une seconde\n");
    t.agents.claude.complete("fin");
    await tick();

    const output = t.chunks.join("");
    expect(output).toContain("une phrase parfaitement reconnaissable");

    t.app.unmount();
  });

  it("garde la ligne en cours hors du flux permanent jusqu'à ce qu'elle soit complète", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit("phrase incomplete sans fin de ligne");
    await tick();

    // Elle est visible (dans le pied de page redessinable), mais pas encore
    // committée : la preuve, elle n'apparaît qu'une fois et disparaît du frame
    // suivant plutôt que de rester dans le scrollback.
    const beforeCommit = t.chunks.join("");
    expect(beforeCommit).toContain("phrase incomplete sans fin de ligne");

    t.chunks.length = 0;
    t.agents.claude.emit(" — maintenant terminée\n");
    await tick();

    const committed = t.chunks.join("");
    expect(committed).toContain("phrase incomplete sans fin de ligne — maintenant terminée");

    t.app.unmount();
  });

  it("écrit uniquement le sujet sous le header, une seule fois au démarrage", async () => {
    const t = mount();
    await tick();
    const output = t.chunks.join("");
    expect(output.split("\u25b2 Claudex").length - 1).toBe(0);
    expect(output).toContain("Sujet : Sujet de test");
    expect(output).not.toContain(":: Sujet : Sujet de test");

    const footerFrame = [...t.chunks]
      .reverse()
      .find(
        (chunk) =>
          chunk.includes("fake-model · ctx — + fake-model · ctx —") &&
          chunk.includes("‣"),
      );
    expect(footerFrame).toBeDefined();
    const footer = footerFrame!.replace(ANSI_SEQUENCE, "");
    expect(footer).toContain("/help");
    expect(
      footer.indexOf("fake-model · ctx — + fake-model · ctx —"),
    ).toBeGreaterThan(footer.indexOf("‣"));
    t.app.unmount();
  });

  it("réaffiche le sujet complet avec /sujet", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.chunks.length = 0;

    await press(t, "/sujet");
    await press(t, "\r");

    await vi.waitFor(() => {
      const output = t.chunks.join("").replace(ANSI_SEQUENCE, "");
      expect(output).toContain("Sujet complet");
      expect(output).toContain("Sujet de test");
    });
    t.app.unmount();
  });

  it("affiche séparément l'occupation de contexte des deux agents", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.chunks.length = 0;

    t.agents.claude.emitContext(51_000, 200_000);

    await vi.waitFor(() => {
      const output = t.chunks.join("").replace(ANSI_SEQUENCE, "");
      expect(output).toContain("fake-model · ctx 75% libre + fake-model · ctx —");
    });
    t.app.unmount();
  });
});

describe("helpers d'amorçage", () => {
  it("découpe les blocs du renderer sans perdre les lignes vides", () => {
    expect(transcriptBlockLines("ligne 1\n\nligne 3\n")).toEqual(["ligne 1", "", "ligne 3"]);
  });

  it("sélectionne une fenêtre depuis le bas du transcript", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `ligne ${index}`);
    expect(transcriptWindow(lines, 3, 0)).toEqual(["ligne 7", "ligne 8", "ligne 9"]);
    expect(transcriptWindow(lines, 3, 2)).toEqual(["ligne 5", "ligne 6", "ligne 7"]);
    expect(transcriptWindow(lines, 3, 99)).toEqual(["ligne 0", "ligne 1", "ligne 2"]);
  });
});
