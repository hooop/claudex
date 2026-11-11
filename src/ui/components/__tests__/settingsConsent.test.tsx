import { EventEmitter } from "node:events";
import { render } from "ink";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SettingsFinding } from "../../../agents/projectSettings.js";
import { SettingsConsent } from "../SettingsConsent.js";

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function mount(findings: SettingsFinding[]) {
  const inputQueue: string[] = [];
  const output: string[] = [];
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
  const app = render(<SettingsConsent findings={findings} onDecide={onDecide} />, {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: stderr as never,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  return {
    app,
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

async function ready(terminal: Terminal): Promise<void> {
  await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 10));
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

describe("SettingsConsent", () => {
  it("montre le fichier, la clé et la valeur entière d'une longue commande", async () => {
    const longCommand = `echo-${"x".repeat(295)}`;
    const terminal = mount([
      { file: ".claude/settings.json", kind: "entries", entries: [{ key: "apiKeyHelper", value: longCommand }] },
    ]);
    await ready(terminal);

    const frame = terminal.frame();
    expect(frame).toContain(".claude/settings.json");
    expect(frame).toContain("apiKeyHelper");
    expect(frame.replace(/\s/g, "")).toContain(longCommand);
    expect(frame).toContain("[y] continuer avec ces réglages · [n] quitter");
    terminal.app.unmount();
  });

  it("affiche les caractères de contrôle échappés, jamais bruts", async () => {
    const terminal = mount([
      { file: ".claude/settings.json", kind: "entries", entries: [{ key: "env.FOO", value: "a\u001b[2Jb" }] },
    ]);
    await ready(terminal);

    const frame = terminal.frame();
    expect(frame).toContain("env.FOO");
    expect(frame).toContain("a\\u001b[2Jb");
    expect(frame).not.toContain("\u001b");
    terminal.app.unmount();
  });

  it("montre la raison d'un fichier illisible", async () => {
    const terminal = mount([{ file: ".claude/settings.json", kind: "unreadable", reason: "invalid JSON" }]);
    await ready(terminal);

    const frame = terminal.frame();
    expect(frame).toContain(".claude/settings.json");
    expect(frame).toContain("invalid JSON");
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
});
