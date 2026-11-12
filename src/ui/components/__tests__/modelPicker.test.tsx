import { EventEmitter } from "node:events";
import { render } from "ink";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { MODEL_PICKER_ROWS, ModelPicker } from "../ModelPicker.js";

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function mount(agent: "claude" | "codex") {
  const inputQueue: string[] = [];
  const output: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
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
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const app = render(
    <ModelPicker
      agent={agent}
      width={60}
      onSelect={onSelect}
      onCancel={onCancel}
    />,
    {
      stdout: stdout as never,
      stdin: stdin as never,
      stderr: stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    },
  );
  return {
    app,
    inputQueue,
    output,
    stdin,
    onSelect,
    onCancel,
    pushInput(input: string) {
      inputQueue.push(input);
      stdin.emit("readable");
    },
  };
}

async function ready(terminal: ReturnType<typeof mount>): Promise<void> {
  await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function press(terminal: ReturnType<typeof mount>, input: string): Promise<void> {
  await act(async () => {
    terminal.pushInput(input);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

describe("ModelPicker", () => {
  it("reuses the command palette window and controls", async () => {
    const terminal = mount("claude");
    await ready(terminal);

    const frame = terminal.output.join("").replace(ANSI_SEQUENCE, "").replace(/\n$/, "");
    const lines = frame.split("\n");
    expect(lines).toHaveLength(MODEL_PICKER_ROWS);
    expect(frame).toContain("› Opus 5");
    expect(frame).toContain("— most capable, slower");
    expect(frame).toContain("Sonnet 5");
    expect(frame).toContain("— balanced (recommended)");
    expect(frame).not.toContain("Fable 5");
    expect(frame).toContain("↑↓ 1/4 · Tab or Enter to choose · Esc close");

    const describedLines = lines.filter((line) => line.includes(" — "));
    expect(describedLines).toHaveLength(3);
    expect(new Set(describedLines.map((line) => line.indexOf(" — "))).size).toBe(1);
    const navigationRow = lines.findIndex((line) => line.includes("↑↓ 1/4"));
    expect(lines[navigationRow - 1]?.trim()).toBe("");
    terminal.app.unmount();
  });

  it("scrolls Claude and selects with Tab", async () => {
    const terminal = mount("claude");
    await ready(terminal);

    terminal.output.length = 0;
    await press(terminal, "\u001b[B");
    await press(terminal, "\u001b[B");
    expect(terminal.output.join("").replace(ANSI_SEQUENCE, "")).toContain("Fable 5");
    await press(terminal, "\t");
    expect(terminal.onSelect).toHaveBeenCalledWith("haiku");
    terminal.app.unmount();
  });

  it("shows Codex in the same palette and selects with Tab", async () => {
    const terminal = mount("codex");
    await ready(terminal);

    const frame = terminal.output.join("").replace(ANSI_SEQUENCE, "");
    expect(frame).toContain("› gpt-5.6-sol, effort max — configured default");
    expect(frame).toContain("↑↓ 1/2 · Tab or Enter to choose · Esc close");
    await press(terminal, "\u001b[B");
    await press(terminal, "\t");
    expect(terminal.onSelect).toHaveBeenCalledWith("gpt-5.5");
    terminal.app.unmount();
  });

  // The input bar is inactive while the menu is open: without this,
  // Enter on a highlighted choice would trigger nothing at all.
  it("also selects with Enter", async () => {
    const terminal = mount("claude");
    await ready(terminal);

    await press(terminal, "\u001b[B");
    await press(terminal, "\r");
    expect(terminal.onSelect).toHaveBeenCalledWith("sonnet");
    terminal.app.unmount();
  });

  it("closes the menu with Escape", async () => {
    const terminal = mount("codex");
    await ready(terminal);

    await press(terminal, "\u001b");
    expect(terminal.onCancel).toHaveBeenCalledOnce();
    expect(terminal.onSelect).not.toHaveBeenCalled();
    terminal.app.unmount();
  });
});
