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
  it("says the settings apply during sessions, not only at startup", () => {
    const text = formatConsentText([
      { file: ".claude/settings.json", kind: "entries", entries: [{ key: "env.FOO", value: "1" }] },
    ]);
    expect(text.split("\n")[0]).toBe(
      "This project's Claude Code settings ask Claude Code to run these commands or apply these settings during Claude sessions. Claudex cannot disable them.",
    );
  });

  it("shows the file, the key and the whole value of a long command, in one piece", () => {
    const longCommand = `echo-${"x".repeat(295)}`;
    const text = formatConsentText([
      { file: ".claude/settings.json", kind: "entries", entries: [{ key: "apiKeyHelper", value: longCommand }] },
    ]);
    expect(text).toContain(".claude/settings.json");
    expect(text).toContain(`  apiKeyHelper = "${longCommand}"`);
  });

  it("shows control characters escaped, never raw", () => {
    const text = formatConsentText([
      { file: ".claude/settings.json", kind: "entries", entries: [{ key: "env.FOO", value: "a\u001b[2Jb" }] },
    ]);
    expect(text).toContain('env.FOO = "a\\u001b[2Jb"');
    expect(text).not.toContain("\u001b");
  });

  it("shows the reason for an unreadable file and asks to fix it", () => {
    const text = formatConsentText(UNREADABLE);
    expect(text).toContain(".claude/settings.json");
    expect(text).toContain("invalid JSON");
    expect(text).toContain("fix .claude/settings.json");
  });

  it("contains each of the 200 entries in full and a numeric summary", () => {
    const text = formatConsentText(MANY);
    for (let i = 0; i < 200; i++) expect(text).toContain(`  env.VAR_${i} = "value-${i}"`);
    expect(text).toContain("200 settings in 1 file — scroll up to reread everything if needed.");
  });
});

describe("SettingsConsent", () => {
  it("renders outside the alternate screen, so the text stays in the scrollback", () => {
    expect(CONSENT_RENDER_OPTIONS.alternateScreen).toBe(false);
    expect(CONSENT_RENDER_OPTIONS.exitOnCtrlC).toBe(false);
  });

  it("stays short whatever the size of the list", async () => {
    const terminal = mount(MANY);
    await ready(terminal);
    const lines = terminal.frame().trimEnd().split("\n");
    expect(lines.length).toBeLessThan(6);
    expect(terminal.frame()).toContain("200 settings in 1 file");
    expect(terminal.frame()).toContain("[y] continue with these settings · [n] quit");
    terminal.app.unmount();
  });

  it("continues with y", async () => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, "y");
    expect(terminal.onDecide).toHaveBeenCalledTimes(1);
    expect(terminal.onDecide).toHaveBeenCalledWith(true);
    terminal.app.unmount();
  });

  it("also continues with Y", async () => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, "Y");
    expect(terminal.onDecide).toHaveBeenCalledWith(true);
    terminal.app.unmount();
  });

  it.each([
    ["n", "n"],
    ["q", "q"],
    ["Enter", "\r"],
    ["Escape", "\u001b"],
    ["Ctrl+C", "\u0003"],
  ])("quits with %s", async (_name, input) => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, input);
    expect(terminal.onDecide).toHaveBeenCalledTimes(1);
    expect(terminal.onDecide).toHaveBeenCalledWith(false);
    terminal.app.unmount();
  });

  it("ignores other keys", async () => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, "x");
    expect(terminal.onDecide).not.toHaveBeenCalled();
    terminal.app.unmount();
  });

  it("ignores y with Alt (Escape then y)", async () => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, "\u001by");
    expect(terminal.onDecide).not.toHaveBeenCalledWith(true);
    terminal.app.unmount();
  });

  it("ignores a pasted y", async () => {
    const terminal = mount(HELPER);
    await ready(terminal);
    await press(terminal, "\u001b[200~y\u001b[201~");
    expect(terminal.onDecide).not.toHaveBeenCalled();
    terminal.app.unmount();
  });

  it("ignores a keystroke that arrived before 250 ms, accepts the one after", async () => {
    const terminal = mount(HELPER);
    await ready(terminal, 249);
    await press(terminal, "y");
    expect(terminal.onDecide).not.toHaveBeenCalled();
    terminal.clock.now = 250;
    await press(terminal, "y");
    expect(terminal.onDecide).toHaveBeenCalledWith(true);
    terminal.app.unmount();
  });

  describe("when a file is unreadable", () => {
    it("does not offer to continue", async () => {
      const terminal = mount(UNREADABLE);
      await ready(terminal);
      // Normalised because the explanation wraps at the terminal's width.
      const frame = terminal.frame().replace(/\s+/g, " ");
      expect(frame).not.toContain("[y]");
      expect(frame).toContain("[n] quit");
      expect(frame).toContain("fix .claude/settings.json");
      expect(frame).toContain("1 unreadable file");
      terminal.app.unmount();
    });

    it("ignores y", async () => {
      const terminal = mount(UNREADABLE);
      await ready(terminal);
      await press(terminal, "y");
      expect(terminal.onDecide).not.toHaveBeenCalled();
      terminal.app.unmount();
    });

    it("quits with n", async () => {
      const terminal = mount(UNREADABLE);
      await ready(terminal);
      await press(terminal, "n");
      expect(terminal.onDecide).toHaveBeenCalledWith(false);
      terminal.app.unmount();
    });
  });
});
