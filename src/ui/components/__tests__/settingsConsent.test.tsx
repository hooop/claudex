import { EventEmitter } from "node:events";
import { render } from "ink";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SettingsFinding } from "../../../agents/projectSettings.js";
import { CONSENT_RENDER_OPTIONS, formatConsentText, SettingsConsent } from "../SettingsConsent.js";

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function mount(findings: SettingsFinding[]) {
  const inputQueue: string[] = [];
  const output: string[] = [];
  // The prompt ignores keys for its first 250 ms; tests drive that clock.
  const clock = { now: 0 };
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 40,
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
  const onDecide = vi.fn();
  const app = render(<SettingsConsent findings={findings} onDecide={onDecide} now={() => clock.now} />, {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: stderr as never,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  return {
    app,
    clock,
    output,
    stdin,
    onDecide,
    frame: () => output.join("").replace(ANSI_SEQUENCE, ""),
    pushInput(input: string) {
      inputQueue.push(input);
      stdin.emit("readable");
    },
  };
}

type Terminal = ReturnType<typeof mount>;

async function ready(terminal: Terminal, elapsedMs = 1000): Promise<void> {
  await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 10));
  terminal.clock.now = elapsedMs;
}

async function press(terminal: Terminal, input: string): Promise<void> {
  await act(async () => {
    terminal.pushInput(input);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

const HELPER: SettingsFinding[] = [
  { file: ".claude/settings.json", kind: "entries", entries: [{ key: "apiKeyHelper", value: "touch /tmp/marker" }] },
];

const UNREADABLE: SettingsFinding[] = [{ file: ".claude/settings.json", kind: "unreadable", reason: "invalid JSON" }];

const MANY: SettingsFinding[] = [
  {
    file: ".claude/settings.json",
    kind: "entries",
    entries: Array.from({ length: 200 }, (_, i) => ({ key: `env.VAR_${i}`, value: `value-${i}` })),
  },
];

describe("formatConsentText", () => {
  it("montre le fichier, la clé et la valeur entière d'une longue commande, d'un seul tenant", () => {
    const longCommand = `echo-${"x".repeat(295)}`;
    const text = formatConsentText([
      { file: ".claude/settings.json", kind: "entries", entries: [{ key: "apiKeyHelper", value: longCommand }] },
    ]);
    expect(text).toContain(".claude/settings.json");
    expect(text).toContain(`  apiKeyHelper = "${longCommand}"`);
  });

  it("affiche les caractères de contrôle échappés, jamais bruts", () => {
    const text = formatConsentText([
      { file: ".claude/settings.json", kind: "entries", entries: [{ key: "env.FOO", value: "a\u001b[2Jb" }] },
    ]);
    expect(text).toContain('env.FOO = "a\\u001b[2Jb"');
    expect(text).not.toContain("\u001b");
  });

  it("montre la raison d'un fichier illisible et demande de le corriger", () => {
    const text = formatConsentText(UNREADABLE);
    expect(text).toContain(".claude/settings.json");
    expect(text).toContain("invalid JSON");
    expect(text).toContain("corrigez .claude/settings.json");
  });

  it("contient chacune des 200 entrées en entier et un résumé chiffré", () => {
    const text = formatConsentText(MANY);
    for (let i = 0; i < 200; i++) expect(text).toContain(`  env.VAR_${i} = "value-${i}"`);
    expect(text).toContain("200 réglages dans 1 fichier — remontez pour tout relire si besoin.");
  });
});

describe("SettingsConsent", () => {
  it("s'affiche hors de l'écran alternatif, pour que le texte reste dans l'historique", () => {
    expect(CONSENT_RENDER_OPTIONS.alternateScreen).toBe(false);
    expect(CONSENT_RENDER_OPTIONS.exitOnCtrlC).toBe(false);
  });

  it("reste court quelle que soit la taille de la liste", async () => {
    const terminal = mount(MANY);
    await ready(terminal);
    const lines = terminal.frame().trimEnd().split("\n");
    expect(lines.length).toBeLessThan(6);
    expect(terminal.frame()).toContain("200 réglages dans 1 fichier");
    expect(terminal.frame()).toContain("[y] continuer avec ces réglages · [n] quitter");
    terminal.app.unmount();
  });

  it("continue avec y", async () => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, "y");
    expect(terminal.onDecide).toHaveBeenCalledTimes(1);
    expect(terminal.onDecide).toHaveBeenCalledWith(true);
    terminal.app.unmount();
  });

  it("continue aussi avec Y", async () => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, "Y");
    expect(terminal.onDecide).toHaveBeenCalledWith(true);
    terminal.app.unmount();
  });

  it.each([
    ["n", "n"],
    ["q", "q"],
    ["Entrée", "\r"],
    ["Échap", "\u001b"],
    ["Ctrl+C", "\u0003"],
  ])("quitte avec %s", async (_name, input) => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, input);
    expect(terminal.onDecide).toHaveBeenCalledTimes(1);
    expect(terminal.onDecide).toHaveBeenCalledWith(false);
    terminal.app.unmount();
  });

  it("ignore les autres touches", async () => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, "x");
    expect(terminal.onDecide).not.toHaveBeenCalled();
    terminal.app.unmount();
  });

  it("ignore y avec Alt (Échap puis y)", async () => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, "\u001by");
    expect(terminal.onDecide).not.toHaveBeenCalledWith(true);
    terminal.app.unmount();
  });

  it("ignore un y collé", async () => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, "\u001b[200~y\u001b[201~");
    expect(terminal.onDecide).not.toHaveBeenCalled();
    terminal.app.unmount();
  });

  it("ignore une frappe arrivée avant 250 ms, accepte celle d'après", async () => {
    const terminal = mount(HELPER);
    await ready(terminal, 249);
    await press(terminal, "y");
    expect(terminal.onDecide).not.toHaveBeenCalled();
    terminal.clock.now = 250;
    await press(terminal, "y");
    expect(terminal.onDecide).toHaveBeenCalledWith(true);
    terminal.app.unmount();
  });

  describe("quand un fichier est illisible", () => {
    it("ne propose pas de continuer", async () => {
      const terminal = mount(UNREADABLE);
      await ready(terminal);
      // Normalised because the explanation wraps at the terminal's width.
      const frame = terminal.frame().replace(/\s+/g, " ");
      expect(frame).not.toContain("[y]");
      expect(frame).toContain("[n] quitter");
      expect(frame).toContain("corrigez .claude/settings.json");
      expect(frame).toContain("1 fichier illisible");
      terminal.app.unmount();
    });

    it("ignore y", async () => {
      const terminal = mount(UNREADABLE);
      await ready(terminal);
      await press(terminal, "y");
      expect(terminal.onDecide).not.toHaveBeenCalled();
      terminal.app.unmount();
    });

    it("quitte avec n", async () => {
      const terminal = mount(UNREADABLE);
      await ready(terminal);
      await press(terminal, "n");
      expect(terminal.onDecide).toHaveBeenCalledWith(false);
      terminal.app.unmount();
    });
  });
});
