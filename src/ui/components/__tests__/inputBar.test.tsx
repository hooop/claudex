import { EventEmitter } from "node:events";
import { render } from "ink";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEBATE_COMMANDS, matchingCommands, WELCOME_COMMANDS, type CommandSuggestion } from "../CommandPalette.js";
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
    // Ink 7 only draws a frame when the output is a real terminal
    // (`interactive` = !CI && stdout.isTTY). Without this flag, it writes nothing.
    // isTTY is not enough under CI=true (GitHub Actions): render() therefore forces
    // also `interactive: true`.
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
  return {
    stdout,
    stdin,
    stderr,
    output,
    pushInput(input: string) {
      inputQueue.push(input);
      stdin.emit("readable");
    },
    /** Several stdin chunks read in one `readable` event, as a long raw paste arrives. */
    pushBurst(chunks: readonly string[]) {
      inputQueue.push(...chunks);
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
      placeholder="topic"
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
      interactive: true,
    },
  );
  return { ...terminal, app, onSubmit };
}

async function press(terminal: ReturnType<typeof fakeTerminal>, input: string): Promise<void> {
  await act(async () => {
    terminal.pushInput(input);
    // Ink 7 throttles its renders (`renderThrottleMs`, derived from maxFps): a frame
    // is no longer written in the same event-loop turn as the keystroke.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

/** A paste as a terminal in bracketed paste mode delivers it. */
async function paste(terminal: ReturnType<typeof fakeTerminal>, text: string): Promise<void> {
  await press(terminal, `\u001b[200~${text}\u001b[201~`);
}

async function ready(terminal: ReturnType<typeof fakeTerminal>): Promise<void> {
  await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("InputBar — contextual navigation", () => {
  it("opens and filters the palette as soon as the input starts with a slash", async () => {
    const onPaletteChange = vi.fn();
    const terminal = mount(undefined, undefined, WELCOME_COMMANDS, onPaletteChange);
    await ready(terminal);

    terminal.output.length = 0;
    await press(terminal, "/mo");

    const output = terminal.output.join("").replace(ANSI_SEQUENCE, "");
    expect(output).toContain("/model claude <name>");
    expect(output).toContain("/model codex <name>");
    expect(output).not.toContain("/help —");
    expect(onPaletteChange).toHaveBeenLastCalledWith(true);
    // The debate palette offers /topic under its new name.
    expect(matchingCommands(DEBATE_COMMANDS, "/to")).toEqual([
      { completion: "/topic", usage: "/topic", description: "show the full topic" },
    ]);
    terminal.app.unmount();
  });

  it("selects with the arrows and completes with Tab", async () => {
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

  it("closes the palette with Escape without erasing the started command", async () => {
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

  it("uses ANSI index 233 for the active background", () => {
    expect(INPUT_BACKGROUND_COLOR).toBe("ansi256(233)");
  });

  it("uses ANSI index 195 for the text and 237 for the placeholder", () => {
    expect(INPUT_TEXT_COLOR).toBe("ansi256(195)");
    expect(INPUT_PLACEHOLDER_COLOR).toBe("ansi256(240)");
  });

  it("wraps two columns before the right edge", async () => {
    const onRowsChange = vi.fn();
    const terminal = mount(undefined, onRowsChange);
    await ready(terminal);

    expect(INPUT_BAR_RIGHT_PADDING).toBe(2);
    await press(terminal, "x".repeat(54));
    await vi.waitFor(() => expect(onRowsChange).toHaveBeenLastCalledWith(4));
    terminal.app.unmount();
  });

  it("uses ANSI indexes 220 for the prompt and 236 for the cursor", async () => {
    const terminal = mount();
    await ready(terminal);

    const frame = terminal.output.join("").replace(ANSI_SEQUENCE, "");
    expect(INPUT_PROMPT_COLOR).toBe("ansi256(220)");
    expect(INPUT_CURSOR_COLOR).toBe("ansi256(236)");
    expect(frame).toMatch(/‣ {3}topic/);
    terminal.app.unmount();
  });

  it("blinks the cursor at a bounded interval", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const terminal = mount();
    await ready(terminal);

    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), INPUT_CURSOR_BLINK_MS);
    terminal.app.unmount();
    intervalSpy.mockRestore();
  });

  it("draws three rows and puts the prompt on the middle one", async () => {
    const terminal = mount();
    await ready(terminal);

    // Ink 7 opens each frame with a synchronized-update sequence:
    // strip the ANSI before counting, otherwise it counts as a row.
    const frame = terminal.output.join("").replace(ANSI_SEQUENCE, "").replace(/\n$/, "");
    const lines = frame.split("\n");
    expect(lines).toHaveLength(INPUT_BAR_MIN_ROWS);
    expect(lines[0]).not.toContain("‣");
    expect(lines[1]).toContain("‣");
    expect(lines[2]).not.toContain("‣");
    terminal.app.unmount();
  });

  it("adds rows when the text exceeds the available width", async () => {
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

  it("reserves left/right for the gallery when the field is empty", async () => {
    const onNavigate = vi.fn();
    const terminal = mount(onNavigate);
    await ready(terminal);

    await press(terminal, "\u001b[D");
    await press(terminal, "\u001b[C");

    expect(onNavigate.mock.calls).toEqual([[-1], [1]]);
    expect(terminal.onSubmit).not.toHaveBeenCalled();
    terminal.app.unmount();
  });

  it("gives the arrows back to the cursor as soon as the field contains text", async () => {
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

  it("keeps the historical editing behavior without a gallery callback", async () => {
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

describe("InputBar — paste", () => {
  it("keeps every chunk of a raw paste that arrived in one block", async () => {
    const terminal = mount();
    await ready(terminal);

    const chunks = ["a".repeat(4000), "b".repeat(4000), "c".repeat(4000)];
    await act(async () => {
      terminal.pushBurst(chunks);
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    await press(terminal, "\r");

    expect(terminal.onSubmit).toHaveBeenCalledWith(chunks.join(""));
    terminal.app.unmount();
  });

  it("replaces a long paste with a label and submits the full text", async () => {
    const terminal = mount();
    await ready(terminal);

    const pasted = "x".repeat(30000);
    terminal.output.length = 0;
    await paste(terminal, pasted);

    const frame = terminal.output.join("").replace(ANSI_SEQUENCE, "");
    expect(frame).toContain("[Pasted text · 30,000 characters]");
    expect(frame).not.toContain("xxx");
    await press(terminal, "\r");
    expect(terminal.onSubmit).toHaveBeenCalledWith(pasted, { literal: true });
    terminal.app.unmount();
  });

  it("keeps the line breaks of a multiline paste", async () => {
    const terminal = mount();
    await ready(terminal);

    terminal.output.length = 0;
    await paste(terminal, "a\r\nb\rc");

    expect(terminal.output.join("").replace(ANSI_SEQUENCE, "")).toContain(
      "[Pasted text · 5 characters]",
    );
    await press(terminal, "\r");
    expect(terminal.onSubmit).toHaveBeenCalledWith("a\nb\nc", { literal: true });
    terminal.app.unmount();
  });

  it("inserts a one-line 500-character paste as is", async () => {
    const terminal = mount();
    await ready(terminal);

    const pasted = "y".repeat(500);
    terminal.output.length = 0;
    await paste(terminal, pasted);

    const frame = terminal.output.join("").replace(ANSI_SEQUENCE, "");
    expect(frame).not.toContain("Pasted text");
    expect(frame).toContain("yyy");
    await press(terminal, "\r");
    expect(terminal.onSubmit).toHaveBeenCalledWith(pasted);
    terminal.app.unmount();
  });

  it("labels a one-line 501-character paste", async () => {
    const terminal = mount();
    await ready(terminal);

    terminal.output.length = 0;
    await paste(terminal, "y".repeat(501));

    expect(terminal.output.join("").replace(ANSI_SEQUENCE, "")).toContain(
      "[Pasted text · 501 characters]",
    );
    terminal.app.unmount();
  });

  it("keeps the text typed before and after a label", async () => {
    const terminal = mount();
    await ready(terminal);

    const pasted = "line one\nline two";
    await press(terminal, "before ");
    await paste(terminal, pasted);
    await press(terminal, " after");
    await press(terminal, "\r");

    expect(terminal.onSubmit).toHaveBeenCalledWith(`before ${pasted} after`);
    terminal.app.unmount();
  });

  it("erases a whole label with a single backspace", async () => {
    const terminal = mount();
    await ready(terminal);

    await press(terminal, "x");
    await paste(terminal, "z".repeat(600));
    await press(terminal, "\u007f");
    await press(terminal, "\r");

    expect(terminal.onSubmit).toHaveBeenCalledWith("x");
    terminal.app.unmount();
  });

  it("numbers the labels when the draft contains several", async () => {
    const terminal = mount();
    await ready(terminal);

    terminal.output.length = 0;
    await paste(terminal, "first\npaste");
    await paste(terminal, "second\npaste");

    const frame = terminal.output.join("").replace(ANSI_SEQUENCE, "");
    expect(frame).toContain("[Pasted text #1 · 11 characters]");
    expect(frame).toContain("[Pasted text #2 · 12 characters]");
    await press(terminal, "\r");
    expect(terminal.onSubmit).toHaveBeenCalledWith("first\npastesecond\npaste", { literal: true });
    terminal.app.unmount();
  });

  it("forgets the pastes erased by Ctrl+U", async () => {
    const terminal = mount();
    await ready(terminal);

    await paste(terminal, "old\npaste");
    await press(terminal, "\u0015");
    await press(terminal, "new");
    await press(terminal, "\r");

    expect(terminal.onSubmit).toHaveBeenCalledWith("new");
    terminal.app.unmount();
  });

  it("flags that a draft opened by a paste is not a command", async () => {
    const terminal = mount();
    await ready(terminal);

    await paste(terminal, "// helper\nconst x = 1;");
    await press(terminal, "\r");

    expect(terminal.onSubmit).toHaveBeenCalledWith("// helper\nconst x = 1;", { literal: true });
    terminal.app.unmount();
  });

  it("ignores an empty paste", async () => {
    const terminal = mount();
    await ready(terminal);

    await press(terminal, "a");
    await paste(terminal, "");
    await press(terminal, "\r");

    expect(terminal.onSubmit).toHaveBeenCalledWith("a");
    terminal.app.unmount();
  });

  it("does not let a typed character pass for a label", async () => {
    const terminal = mount();
    await ready(terminal);

    await paste(terminal, "real\npaste");
    await press(terminal, "\u{100000}z");
    await paste(terminal, "\u{100000}w");
    await press(terminal, "\r");

    expect(terminal.onSubmit).toHaveBeenCalledWith("real\npastezw", { literal: true });
    terminal.app.unmount();
  });
});
