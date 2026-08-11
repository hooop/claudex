import { EventEmitter } from "node:events";
import { render } from "ink";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { WELCOME_COMMANDS, type CommandSuggestion } from "../CommandPalette.js";
import {
  INPUT_BACKGROUND_COLOR,
  INPUT_BAR_MIN_ROWS,
  INPUT_BAR_RIGHT_PADDING,
  INPUT_CURSOR_BLINK_MS,
  INPUT_CURSOR_COLOR,
  INPUT_PLACEHOLDER_COLOR,
  INPUT_PROMPT_COLOR,
  INPUT_TEXT_COLOR,
  InputBar,
} from "../InputBar.js";

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function fakeTerminal() {
  const inputQueue: string[] = [];
  const output: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    write: (chunk: string) => {
      output.push(chunk);
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
    output,
    pushInput(input: string) {
      inputQueue.push(input);
      stdin.emit("readable");
    },
  };
}

function mount(
  onNavigate?: (direction: -1 | 1) => void,
  onRowsChange?: (rows: number) => void,
  commands?: readonly CommandSuggestion[],
  onCommandPaletteChange?: (open: boolean) => void,
) {
  const terminal = fakeTerminal();
  const onSubmit = vi.fn();
  const app = render(
    <InputBar
      disabled={false}
      placeholder="sujet"
      width={60}
      commands={commands}
      onNavigate={onNavigate}
      onCommandPaletteChange={onCommandPaletteChange}
      onRowsChange={onRowsChange}
      onSubmit={onSubmit}
    />,
    {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  return { ...terminal, app, onSubmit };
}

async function press(terminal: ReturnType<typeof fakeTerminal>, input: string): Promise<void> {
  await act(async () => {
    terminal.pushInput(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function ready(terminal: ReturnType<typeof fakeTerminal>): Promise<void> {
  await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("InputBar — navigation contextuelle", () => {
  it("ouvre et filtre la palette dès que la saisie commence par une barre oblique", async () => {
    const onPaletteChange = vi.fn();
    const terminal = mount(undefined, undefined, WELCOME_COMMANDS, onPaletteChange);
    await ready(terminal);

    terminal.output.length = 0;
    await press(terminal, "/mo");

    const output = terminal.output.join("").replace(ANSI_SEQUENCE, "");
    expect(output).toContain("/model claude <nom>");
    expect(output).toContain("/model codex <nom>");
    expect(output).not.toContain("/help —");
    expect(onPaletteChange).toHaveBeenLastCalledWith(true);
    terminal.app.unmount();
  });

  it("sélectionne avec les flèches et complète avec Tab", async () => {
    const onPaletteChange = vi.fn();
    const terminal = mount(undefined, undefined, WELCOME_COMMANDS, onPaletteChange);
    await ready(terminal);

    await press(terminal, "/mo");
    await press(terminal, "\u001b[B");
    await press(terminal, "\t");
    await press(terminal, "\r");

    expect(terminal.onSubmit).toHaveBeenCalledWith("/model codex ");
    expect(onPaletteChange).toHaveBeenLastCalledWith(false);
    terminal.app.unmount();
  });

  it("ferme la palette avec Échap sans effacer la commande commencée", async () => {
    const onPaletteChange = vi.fn();
    const terminal = mount(undefined, undefined, WELCOME_COMMANDS, onPaletteChange);
    await ready(terminal);

    await press(terminal, "/");
    await press(terminal, "\u001b");
    expect(onPaletteChange).toHaveBeenLastCalledWith(false);

    await press(terminal, "help");
    await press(terminal, "\r");
    expect(terminal.onSubmit).toHaveBeenCalledWith("/help");
    terminal.app.unmount();
  });

  it("utilise l'index ANSI 233 pour le fond actif", () => {
    expect(INPUT_BACKGROUND_COLOR).toBe("ansi256(233)");
  });

  it("utilise l'index ANSI 195 pour le texte et 237 pour le placeholder", () => {
    expect(INPUT_TEXT_COLOR).toBe("ansi256(195)");
    expect(INPUT_PLACEHOLDER_COLOR).toBe("ansi256(237)");
  });

  it("revient à la ligne deux colonnes avant le bord droit", async () => {
    const onRowsChange = vi.fn();
    const terminal = mount(undefined, onRowsChange);
    await ready(terminal);

    expect(INPUT_BAR_RIGHT_PADDING).toBe(2);
    await press(terminal, "x".repeat(54));
    await vi.waitFor(() => expect(onRowsChange).toHaveBeenLastCalledWith(4));
    terminal.app.unmount();
  });

  it("utilise les index ANSI 220 pour l'invite et 236 pour le curseur", async () => {
    const terminal = mount();
    await ready(terminal);

    const frame = terminal.output.join("").replace(ANSI_SEQUENCE, "");
    expect(INPUT_PROMPT_COLOR).toBe("ansi256(220)");
    expect(INPUT_CURSOR_COLOR).toBe("ansi256(236)");
    expect(frame).toMatch(/‣ {3}sujet/);
    terminal.app.unmount();
  });

  it("fait clignoter le curseur avec un intervalle borné", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const terminal = mount();
    await ready(terminal);

    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), INPUT_CURSOR_BLINK_MS);
    terminal.app.unmount();
    intervalSpy.mockRestore();
  });

  it("dessine trois lignes et place l'invite sur celle du milieu", async () => {
    const terminal = mount();
    await ready(terminal);

    const frame = terminal.output.join("").replace(/\n$/, "");
    const lines = frame.split("\n");
    expect(lines).toHaveLength(INPUT_BAR_MIN_ROWS);
    expect(lines[0]).not.toContain("‣");
    expect(lines[1]).toContain("‣");
    expect(lines[2]).not.toContain("‣");
    terminal.app.unmount();
  });

  it("ajoute des lignes quand le texte dépasse la largeur disponible", async () => {
    const onRowsChange = vi.fn();
    const terminal = mount(undefined, onRowsChange);
    await ready(terminal);

    expect(onRowsChange).toHaveBeenLastCalledWith(INPUT_BAR_MIN_ROWS);
    const longText = "x".repeat(70);
    terminal.output.length = 0;
    await press(terminal, longText);

    await vi.waitFor(() => expect(onRowsChange).toHaveBeenLastCalledWith(4));
    const frame = terminal.output.join("").replace(ANSI_SEQUENCE, "").replace(/\n$/, "");
    const lines = frame.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("x");
    expect(lines[2]).toContain("x");
    await press(terminal, "\r");
    expect(terminal.onSubmit).toHaveBeenCalledWith(longText);
    terminal.app.unmount();
  });

  it("réserve gauche/droite à la galerie lorsque le champ est vide", async () => {
    const onNavigate = vi.fn();
    const terminal = mount(onNavigate);
    await ready(terminal);

    await press(terminal, "\u001b[D");
    await press(terminal, "\u001b[C");

    expect(onNavigate.mock.calls).toEqual([[-1], [1]]);
    expect(terminal.onSubmit).not.toHaveBeenCalled();
    terminal.app.unmount();
  });

  it("rend les flèches au curseur dès que le champ contient du texte", async () => {
    const onNavigate = vi.fn();
    const terminal = mount(onNavigate);
    await ready(terminal);

    await press(terminal, "b");
    await press(terminal, "\u001b[D");
    await press(terminal, "X");
    await press(terminal, "\r");

    expect(onNavigate).not.toHaveBeenCalled();
    expect(terminal.onSubmit).toHaveBeenCalledWith("Xb");
    terminal.app.unmount();
  });

  it("conserve le comportement d'édition historique sans callback de galerie", async () => {
    const terminal = mount();
    await ready(terminal);

    await press(terminal, "\u001b[D");
    await press(terminal, "a");
    await press(terminal, "\u001b[D");
    await press(terminal, "b");
    await press(terminal, "\r");

    expect(terminal.onSubmit).toHaveBeenCalledWith("ba");
    terminal.app.unmount();
  });
});
