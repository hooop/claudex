/**
 * End-to-end acceptance test for the append-only renderer.
 *
 * It mounts the real debate view on a fake terminal, drives a real scheduler with
 * fake agents, and inspects the bytes that reach stdout. That is the only place
 * the properties that matter are actually observable: whether Ink ever clears the
 * screen, how many lines it erases per frame, and whether committed text is ever
 * written twice.
 */

import { Box, Text, render } from "ink";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AgentSendOptions, CodingAgent } from "../../agents/types.js";
import { DebateSession } from "../../orchestrator/session.js";
import type { AgentResult } from "../../orchestrator/types.js";
import type { AgentId } from "../../types.js";
import { MAX_DYNAMIC_ROWS } from "../theme.js";
import { bannerLines, DebateView, outputRows } from "../DebateView.js";
import { getHeaderAnimation, HEADER_ROWS, headerFrame } from "../headerArt.js";

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

  complete(text: string): void {
    this.resolve?.({ kind: "success", text });
    this.resolve = null;
  }
}

function fakeTerminal(columns = 100, rows = 30) {
  const chunks: string[] = [];
  const inputQueue: string[] = [];

  const stdout = Object.assign(new EventEmitter(), {
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

describe("DebateView — rendu append-only", () => {
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
      expect((chunk.match(CURSOR_UP) ?? []).length).toBeLessThanOrEqual(MAX_DYNAMIC_ROWS);
    }

    t.app.unmount();
  });

  it("fige la phase canonique du preset reçu dans le scrollback", () => {
    const animation = "rule110";
    const expected = headerFrame(40, getHeaderAnimation(animation).staticT, animation).map((row) =>
      row.map((band) => band.chars).join(""),
    );
    const frozen = bannerLines(40, animation)
      .slice(0, HEADER_ROWS)
      .map((line) => line.replace(ANSI_SEQUENCE, ""));

    expect(frozen).toEqual(expected);
    expect(frozen).not.toEqual(
      bannerLines(40, "plasma")
        .slice(0, HEADER_ROWS)
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

  it("revient à six lignes dynamiques au plus une fois le premier écran rempli", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    // Remplit d'abord l'espace qui maintient le prompt en bas.
    for (let i = 0; i < 30; i++) {
      t.agents.claude.emit(`du texte assez long pour être replié une fois ou deux — tour ${i}\n`);
      await tick(2);
    }
    await tick();
    t.chunks.length = 0;

    // En régime établi, l'invariant historique reste strictement inchangé.
    for (let i = 30; i < 70; i++) {
      t.agents.claude.emit(`ligne établie ${i}\n`);
      await tick(2);
    }
    await tick();

    for (const chunk of t.chunks) {
      const erased = (chunk.match(CURSOR_UP) ?? []).length;
      expect(erased).toBeLessThanOrEqual(MAX_DYNAMIC_ROWS);
    }

    t.app.unmount();
  });

  /**
   * Claudex dessinait une trame pleine hauteur au démarrage, pour poser la
   * saisie sur la dernière ligne. Ink efface tout le terminal — scrollback
   * compris — dès qu'une trame précédente était plus haute que la fenêtre
   * courante (`shouldClearTerminalForFrame`, `wasOverflowing`), donc rétrécir
   * la fenêtre pendant ces quelques secondes détruisait le transcript. La zone
   * vive est désormais bornée en permanence : c'est ce que ce test verrouille.
   */
  it("garde la zone vive bornée dès la première intervention", async () => {
    const t = mount({ fromFullScreen: true });
    await tick();
    t.chunks.length = 0;
    t.startDebate();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit("PREMIÈRE INTERVENTION");
    await tick();

    const frame = [...t.chunks].reverse().find((chunk) => chunk.includes("‣"));
    expect(frame).toBeDefined();
    const lines = frame!.replace(ANSI_SEQUENCE, "").replace(/\n$/, "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(MAX_DYNAMIC_ROWS);

    expect(t.chunks.join("")).toContain("PREMIÈRE INTERVENTION");
    expect(t.chunks.join("")).not.toMatch(CLEAR_SCREEN);
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

  it("ne détruit pas le scrollback si le terminal rétrécit pendant l'amorçage", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.emit("quelques mots");
    await tick();

    t.stdout.rows = 12;
    t.stdout.emit("resize");
    await tick();

    const output = t.chunks.join("");
    expect(output).not.toMatch(CLEAR_SCREEN);
    expect(output.split("▲ Claudex").length - 1).toBe(0);
    expect(output.split("Sujet : Sujet de test").length - 1).toBe(1);

    t.app.unmount();
  });

  it("écrit chaque bloc une seule fois, dans l'ordre, au fil du remplissage", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    // Le bandeau (7 lignes) et l'en-tête d'intervention (2 lignes) en
    // occupent déjà 9 ; 13 lignes placent le compteur juste avant le seuil 23.
    t.agents.claude.emit(Array.from({ length: 13 }, (_, i) => `remplissage ${i}\n`).join(""));
    await tick();
    t.chunks.length = 0;

    t.agents.claude.emit("JUSTE_AVANT_LE_SEUIL\n");
    await tick();
    t.agents.claude.emit("JUSTE_APRES_LE_SEUIL\n");
    await tick();

    const output = t.chunks.join("");
    expect(output.split("JUSTE_AVANT_LE_SEUIL").length - 1).toBe(1);
    expect(output.split("JUSTE_APRES_LE_SEUIL").length - 1).toBe(1);
    expect(output.indexOf("JUSTE_AVANT_LE_SEUIL")).toBeLessThan(
      output.indexOf("JUSTE_APRES_LE_SEUIL"),
    );

    t.app.unmount();
  });

  it("ne réépingle pas le footer après l'avoir stabilisé", async () => {
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
      expect((chunk.match(CURSOR_UP) ?? []).length).toBeLessThanOrEqual(MAX_DYNAMIC_ROWS);
    }

    t.app.unmount();
  });

  it("n'écrit chaque ligne du transcript qu'une seule fois", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit("une phrase parfaitement reconnaissable\n");
    await tick();
    t.agents.claude.emit("et une seconde\n");
    t.agents.claude.complete("fin");
    await tick();

    const output = t.chunks.join("");
    const occurrences = output.split("une phrase parfaitement reconnaissable").length - 1;
    expect(occurrences).toBe(1);

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
    expect(output.split("Sujet : Sujet de test").length - 1).toBe(1);

    const footerFrame = [...t.chunks]
      .reverse()
      .find((chunk) => chunk.includes("fake-model + fake-model") && chunk.includes("‣"));
    expect(footerFrame).toBeDefined();
    const footer = footerFrame!.replace(ANSI_SEQUENCE, "");
    expect(footer).toContain("/help");
    expect(footer.indexOf("fake-model + fake-model")).toBeGreaterThan(footer.indexOf("‣"));
    t.app.unmount();
  });
});

describe("helpers d'amorçage", () => {
  it("compte les replis physiques et les lignes vides", () => {
    expect(outputRows("123456\n", 5)).toBe(2);
    expect(outputRows("123456 123456 123456\n", 10)).toBe(3);
    expect(outputRows("\n", 80)).toBe(1);
    expect(outputRows("a\n\n", 80)).toBe(2);
    expect(outputRows("\u001b[31m123456\u001b[39m\n", 5)).toBe(2);
  });

});
