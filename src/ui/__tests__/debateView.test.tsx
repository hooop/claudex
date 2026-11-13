/**
 * End-to-end acceptance test for the full-screen debate renderer.
 *
 * It mounts the real debate view on a fake terminal, drives a real scheduler with
 * fake agents, and inspects the bytes that reach stdout. It verifies that long
 * output stays inside the transcript viewport and that navigation does not move
 * the fixed header or footer.
 */

import chalk from "chalk";
import { Box, Text, render } from "ink";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AgentSendOptions, CodingAgent } from "../../agents/types.js";
import { DebateSession } from "../../orchestrator/session.js";
import type { AgentResult } from "../../orchestrator/types.js";
import type { AgentId } from "../../types.js";
import { MouseProvider } from "../mouse/MouseContext.js";
import type { MouseEvent } from "../mouse/mouseInput.js";
import { MOUSE_OFF, MOUSE_ON } from "../terminal.js";
import { contentWidthFor } from "../theme.js";
import {
  DebateView,
  transcriptBlockLines,
  transcriptWindow,
} from "../DebateView.js";

// Selections release into the clipboard: never let a test reach a real command.
const clipboard = vi.hoisted(() => ({
  copyToClipboard: vi.fn(() => Promise.resolve({ kind: "copied" as const })),
}));
vi.mock("../mouse/clipboard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mouse/clipboard.js")>()),
  copyToClipboard: clipboard.copyToClipboard,
}));

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

  note(text: string): void {
    this.options?.onNote?.(text, true);
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
    // Ink 7 only draws when the output is a real terminal.
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

function fakeMouseSource() {
  const listeners = new Set<(event: MouseEvent) => void>();
  return {
    on(listener: (event: MouseEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: MouseEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function mount(
  options: {
    fromFullScreen?: boolean;
    topic?: string;
    rows?: number;
    onCopy?: (text: string) => void;
  } = {},
) {
  const terminal = fakeTerminal(100, options.rows);
  const mouse = fakeMouseSource();
  const agents = { claude: new FakeAgent("claude"), codex: new FakeAgent("codex") };
  const session = new DebateSession(agents, {
    cwd: "/tmp",
    starter: "claude",
    autonomyBudget: { kind: "unbounded" },
  });
  const debate = (
    <DebateView
      session={session}
      topic={options.topic ?? "Test topic"}
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
      onCopy={options.onCopy}
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
      <MouseProvider source={mouse}>{debate}</MouseProvider>
    ),
    {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    },
  );

  return {
    ...terminal,
    agents,
    session,
    app,
    mouse,
    startDebate: () => app.rerender(<MouseProvider source={mouse}>{debate}</MouseProvider>),
  };
}

describe("DebateView — full-screen viewport", () => {
  it("opens the palette without triggering the emergency pause on Escape", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    const pause = vi.spyOn(t.session, "pause");
    t.agents.claude.emit(Array.from({ length: 35 }, (_, i) => `settling ${i}\n`).join(""));
    await tick();
    t.agents.claude.emit("TRANSIENT_STATE_TO_RESTORE");
    await tick();
    t.chunks.length = 0;

    await press(t, "/");
    await vi.waitFor(() => expect(t.chunks.join("")).toContain("/claude <text>"));

    t.chunks.length = 0;
    await press(t, "\u001b");
    expect(pause).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.chunks.join("")).toContain("TRANSIENT_STATE_TO_RESTORE"));

    await press(t, "\u001b");
    expect(pause).toHaveBeenCalledOnce();
    for (const chunk of t.chunks) {
      expect((chunk.match(CURSOR_UP) ?? []).length).toBeLessThan(t.stdout.rows);
    }

    t.app.unmount();
  });

  it("opens the models like the commands, above the prompt, and selects with Tab", async () => {
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
    expect(frame).toContain("↑↓ 1/2 · Tab or Enter to choose · Esc close");
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

  it("never clears the screen, even on an answer taller than the terminal", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    // Twice the terminal height, in small pieces like a real stream.
    for (let i = 0; i < 60; i++) {
      t.agents.claude.emit(`answer line number ${i}\n`);
      await tick(2);
    }
    t.agents.claude.complete("end");
    await tick();

    const output = t.chunks.join("");
    expect(output).not.toMatch(CLEAR_SCREEN);
    expect(output).toContain("answer line number 59");

    t.app.unmount();
  });

  it("keeps the dynamic frame strictly below the terminal height", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    // First fill the space that keeps the prompt at the bottom.
    for (let i = 0; i < 30; i++) {
      t.agents.claude.emit(`some text long enough to wrap once or twice — turn ${i}\n`);
      await tick(2);
    }
    await tick();
    t.chunks.length = 0;

    // In steady state, the full-screen frame keeps the header pinned at the top.
    for (let i = 30; i < 70; i++) {
      t.agents.claude.emit(`steady line ${i}\n`);
      await tick(2);
    }
    await tick();

    for (const chunk of t.chunks) {
      const erased = (chunk.match(CURSOR_UP) ?? []).length;
      expect(erased).toBeLessThan(t.stdout.rows);
    }

    t.app.unmount();
  });

  it("puts the first line at the top of the free space and keeps the prompt at the bottom", async () => {
    const t = mount({ fromFullScreen: true });
    await tick();
    t.chunks.length = 0;
    t.startDebate();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit("FIRST INTERVENTION");
    await tick();

    const frame = [...t.chunks].reverse().find((chunk) => chunk.includes("FIRST INTERVENTION"));
    expect(frame).toBeDefined();
    const lines = frame!.replace(ANSI_SEQUENCE, "").split("\n");
    const interventionRow = lines.findIndex((line) => line.includes("FIRST INTERVENTION"));
    const promptRow = lines.findIndex((line) => line.includes("‣"));

    expect(interventionRow).toBeGreaterThanOrEqual(0);
    expect(promptRow).toBeGreaterThan(interventionRow);
    expect(frame).not.toMatch(CLEAR_SCREEN);
    expect(t.chunks.join("")).not.toContain("ANCIEN PROMPT");

    t.app.unmount();
  });

  it("bounds the bootstrap below the terminal height without clear-screen", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.emit("short start");
    await tick();

    expect(t.chunks.join("")).not.toMatch(CLEAR_SCREEN);
    for (const chunk of t.chunks) {
      expect((chunk.match(CURSOR_UP) ?? []).length).toBeLessThan(t.stdout.rows);
    }

    t.app.unmount();
  });

  /**
   * Accepted limit since Ink 7: shrinking the window during bootstrap clears
   * the screen and rewrites the static buffer, so lines already shown may
   * appear twice. Ink clears as soon as a previous frame exceeded the current
   * window (`shouldClearTerminalForFrame`, `wasOverflowing`), and the
   * bootstrap deliberately draws a full-height frame to keep the input at the
   * bottom of the screen.
   *
   * This is purely cosmetic: the archived transcript is built from the
   * scheduler state, never from the terminal. This test therefore locks what
   * matters — no content loss. See limits.md.
   */
  it("loses no content if the terminal shrinks during bootstrap", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.emit("a few words");
    await tick();

    t.stdout.rows = 12;
    t.stdout.emit("resize");
    await tick();

    const output = t.chunks.join("");
    expect(output).toContain("Topic  Test topic");
    expect(output).toContain("a few words");

    t.app.unmount();
  });

  it("allows scrolling up a long transcript without moving the footer", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit(Array.from({ length: 50 }, (_, i) => `history line ${i}\n`).join(""));
    await tick();
    t.chunks.length = 0;

    await press(t, "\u001b[5~");
    await tick();

    const output = t.chunks.join("");
    expect(output).toContain("history line");
    expect(output).toContain("‣");

    t.app.unmount();
  });

  it("keeps the header pinned after the terminal grows", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.emit(Array.from({ length: 35 }, (_, i) => `line ${i}\n`).join(""));
    await tick();
    t.chunks.length = 0;

    t.stdout.rows = 50;
    t.stdout.emit("resize");
    await tick();
    t.agents.claude.emit("after growth\n");
    await tick();

    for (const chunk of t.chunks) {
      expect((chunk.match(CURSOR_UP) ?? []).length).toBeLessThan(t.stdout.rows);
    }

    t.app.unmount();
  });

  it("keeps every transcript line visible in the frame", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit("a perfectly recognizable sentence\n");
    await tick();
    t.agents.claude.emit("and a second one\n");
    t.agents.claude.complete("end");
    await tick();

    const output = t.chunks.join("");
    expect(output).toContain("a perfectly recognizable sentence");

    t.app.unmount();
  });

  it("keeps the line in progress out of the permanent flow until it is complete", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit("incomplete sentence with no line end");
    await tick();

    // It is visible (in the redrawable footer) but not committed yet: the proof
    // is that it appears only once and disappears from the next frame rather
    // than staying in the scrollback.
    const beforeCommit = t.chunks.join("");
    expect(beforeCommit).toContain("incomplete sentence with no line end");

    t.chunks.length = 0;
    t.agents.claude.emit(" — now complete\n");
    await tick();

    const committed = t.chunks.join("");
    expect(committed).toContain("incomplete sentence with no line end — now complete");

    t.app.unmount();
  });

  it("drops a removed note from the viewport", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit("Looking.\n");
    await tick();
    expect(t.chunks.join("")).toContain("Looking.");

    t.chunks.length = 0;
    t.agents.claude.note("Looking.\n");
    t.agents.claude.emit("Answer.\n");
    t.agents.claude.complete("Answer.\n");
    await tick();

    const frame = t.chunks.join("");
    expect(frame).toContain("Answer.");
    expect(frame).not.toContain("Looking.");

    t.app.unmount();
  });

  it("writes only the topic under the header, once at startup", async () => {
    const t = mount();
    await tick();
    const output = t.chunks.join("");
    expect(output.split("\u25b2 Claudex").length - 1).toBe(0);
    expect(output).toContain("Topic  Test topic");
    expect(output).not.toContain("· Topic: Test topic");

    const footerFrame = [...t.chunks]
      .reverse()
      .find(
        (chunk) =>
          chunk.includes("/help") && chunk.includes("‣"),
      );
    expect(footerFrame).toBeDefined();
    const footer = footerFrame!.replace(ANSI_SEQUENCE, "");
    expect(footer.lastIndexOf("/help")).toBeGreaterThan(footer.indexOf("‣"));
    t.app.unmount();
  });

  it("keeps the transcript visible when the pasted topic is very long", async () => {
    const t = mount({ topic: "a very long pasted topic ".repeat(400) });
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emit("FIRST INTERVENTION\n");
    await tick();

    const frame = [...t.chunks].reverse().find((chunk) => chunk.includes("FIRST INTERVENTION"));
    expect(frame).toBeDefined();
    expect(frame!.replace(ANSI_SEQUENCE, "")).toContain("… /topic");
    for (const chunk of t.chunks) {
      expect((chunk.match(CURSOR_UP) ?? []).length).toBeLessThan(t.stdout.rows);
    }
    t.app.unmount();
  });

  it("the debate screen has no animated header", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    await tick(400);

    const output = t.chunks.join("");
    expect(output).toContain("CLAUDEX");
    // The status row below the transcript animates while an agent thinks; the
    // header (its four rows, from the title down) must stay still.
    const lines = output.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.includes("CLAUDEX")) continue;
      expect(lines.slice(index, index + 4).join("\n")).not.toMatch(/[\u2591-\u2593\u2588]/u);
    }
    t.app.unmount();
  });

  it("a Claude turn header shows Round 1 then Round 2", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.complete("First view.\n<<CONTINUE>>");
    await vi.waitFor(() => expect(t.agents.codex.pending).toBe(true));
    t.agents.codex.complete("Reply.\n<<CONTINUE>>");
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    await tick();

    const output = t.chunks.join("").replace(ANSI_SEQUENCE, "");
    expect(output).toMatch(/CLAUDE[^\n]*Round 1/u);
    expect(output).toMatch(/CLAUDE[^\n]*Round 2/u);
    expect(output).toMatch(/CODEX[^\n]*Round 1/u);
    t.app.unmount();
  });

  it("forwards to the agents a paste that starts with a slash", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.chunks.length = 0;

    await press(t, "\u001b[200~// pasted remark\nrest of the code\u001b[201~");
    await press(t, "\r");

    await vi.waitFor(() => {
      expect(t.chunks.join("").replace(ANSI_SEQUENCE, "")).toContain("// pasted remark");
    });
    t.app.unmount();
  });

  it("shows the full topic again with /topic", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.chunks.length = 0;

    await press(t, "/topic");
    await press(t, "\r");

    await vi.waitFor(() => {
      const output = t.chunks.join("").replace(ANSI_SEQUENCE, "");
      expect(output).toContain("Full topic");
      expect(output).toContain("Test topic");
    });
    t.app.unmount();
  });

  it("hides the model line during the debate while contexts have room", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));

    t.agents.claude.emitContext(50_000, 200_000);
    t.agents.codex.emitContext(50_000, 200_000);
    await tick(20);

    const output = t.chunks.join("").replace(ANSI_SEQUENCE, "");
    expect(output).toContain("/help");
    expect(output).not.toContain("fake-model");
    t.app.unmount();
  });

  it("shows the context usage of the two agents separately once one runs low", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.chunks.length = 0;

    t.agents.claude.emitContext(180_000, 200_000);

    await vi.waitFor(() => {
      const output = t.chunks.join("").replace(ANSI_SEQUENCE, "");
      expect(output).toContain("fake-model · ctx 10% free + fake-model · ctx —");
    });
    t.app.unmount();
  });

  it("shows the model line when only Codex runs low", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.complete("First view.\n<<CONTINUE>>");
    await vi.waitFor(() => expect(t.agents.codex.pending).toBe(true));
    t.chunks.length = 0;

    t.agents.codex.emitContext(180_000, 200_000);

    await vi.waitFor(() => {
      const output = t.chunks.join("").replace(ANSI_SEQUENCE, "");
      expect(output).toContain("fake-model · ctx — + fake-model · ctx 10% free");
    });
    t.app.unmount();
  });
});

describe("DebateView — mouse reporting", () => {
  it("turns mouse reporting on while mounted and off when it unmounts", async () => {
    const t = mount({ fromFullScreen: true });
    await tick(20);
    expect(t.chunks.join("")).not.toContain(MOUSE_ON);

    t.startDebate();
    await vi.waitFor(() => expect(t.chunks.filter((chunk) => chunk === MOUSE_ON)).toHaveLength(1));
    expect(t.chunks.join("")).not.toContain(MOUSE_OFF);

    t.app.unmount();
    expect(t.chunks.filter((chunk) => chunk === MOUSE_OFF)).toHaveLength(1);
    expect(t.chunks.lastIndexOf(MOUSE_OFF)).toBeGreaterThan(t.chunks.lastIndexOf(MOUSE_ON));
  });
});

/** The last full frame drawn, raw, and as plain rows indexed by screen row. */
function lastFrame(t: ReturnType<typeof mount>): { raw: string; rows: string[] } {
  const raw = t.chunks.filter((chunk) => chunk.replace(ANSI_SEQUENCE, "").includes("CLAUDEX ")).at(-1) ?? "";
  return { raw, rows: raw.replace(ANSI_SEQUENCE, "").split("\n") };
}

/** The text drawn inverted in the last frame, one entry per highlighted run. */
function inverted(t: ReturnType<typeof mount>): string[] {
  return [...lastFrame(t).raw.matchAll(/\u001b\[7m(.*?)\u001b\[27m/g)].map((match) =>
    match[1]!.replace(ANSI_SEQUENCE, ""),
  );
}

function lastHistoryLine(t: ReturnType<typeof mount>): number {
  const numbers = lastFrame(t)
    .rows.map((row) => /history line (\d+)/.exec(row)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  return Math.max(...numbers);
}

/** Drags from "beta" onto the last character of "delta" over two transcript lines, without releasing. */
async function selectWords(t: ReturnType<typeof mount>) {
  t.agents.claude.emit("alpha beta gamma\ndelta epsilon\n");
  await tick();
  const { rows } = lastFrame(t);
  const first = rows.findIndex((row) => row.includes("alpha beta gamma"));
  const second = rows.findIndex((row) => row.includes("delta epsilon"));
  expect(second).toBe(first + 1);
  const end = rows[second]!.indexOf("delta") + "delta".length - 1;

  t.mouse.emit({ kind: "press", x: rows[first]!.indexOf("beta"), y: first });
  t.mouse.emit({ kind: "drag", x: end - 3, y: second });
  t.mouse.emit({ kind: "drag", x: end, y: second });
  await vi.waitFor(() => expect(inverted(t)).toEqual(["beta gamma", "│ delta"]));
  return { end, second };
}

/** Runs a test with colours on, so the inverse is visible in the output. */
function withColor(test: () => Promise<void>): () => Promise<void> {
  return async () => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      await test();
    } finally {
      chalk.level = level;
    }
  };
}

describe("DebateView — mouse", () => {
  it("wheel down then up scrolls the transcript by three lines", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.emit(Array.from({ length: 50 }, (_, i) => `history line ${i}\n`).join(""));
    await vi.waitFor(() => expect(lastHistoryLine(t)).toBe(49));

    // Already at the bottom: the wheel stays within the arrow keys' bounds.
    t.mouse.emit({ kind: "wheel", direction: "down", x: 10, y: 8 });
    await tick();
    expect(lastHistoryLine(t)).toBe(49);

    t.mouse.emit({ kind: "wheel", direction: "up", x: 10, y: 8 });
    await vi.waitFor(() => expect(lastHistoryLine(t)).toBe(46));

    t.mouse.emit({ kind: "wheel", direction: "up", x: 10, y: 8 });
    await vi.waitFor(() => expect(lastHistoryLine(t)).toBe(43));

    t.mouse.emit({ kind: "wheel", direction: "down", x: 10, y: 8 });
    await vi.waitFor(() => expect(lastHistoryLine(t)).toBe(46));

    t.app.unmount();
  });

  it(
    "drag selects and highlights, release reports the text",
    withColor(async () => {
      const copies: string[] = [];
      const t = mount({ onCopy: (text) => copies.push(text) });
      await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
      const { end, second } = await selectWords(t);
      expect(copies).toEqual([]);

      t.mouse.emit({ kind: "release", x: end, y: second });
      await vi.waitFor(() => expect(copies).toEqual(["beta gamma\ndelta"]));

      // New output appended below does not move the highlight.
      t.agents.claude.emit("zeta\n");
      await vi.waitFor(() => expect(lastFrame(t).rows.join("\n")).toContain("zeta"));
      expect(inverted(t)).toEqual(["beta gamma", "│ delta"]);

      // A press outside the transcript clears it and copies nothing.
      t.mouse.emit({ kind: "press", x: 0, y: 0 });
      t.mouse.emit({ kind: "release", x: 0, y: 0 });
      await vi.waitFor(() => expect(inverted(t)).toEqual([]));
      expect(copies).toEqual(["beta gamma\ndelta"]);

      t.app.unmount();
    }),
  );

  it(
    "a backward drag ending on the first character copies the full words",
    withColor(async () => {
      const copies: string[] = [];
      const t = mount({ onCopy: (text) => copies.push(text) });
      await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
      t.agents.claude.emit("alpha beta gamma\n");
      await tick();
      const { rows } = lastFrame(t);
      const row = rows.findIndex((text) => text.includes("alpha beta gamma"));
      const start = rows[row]!.indexOf("beta");
      const last = rows[row]!.indexOf("gamma") + "gamma".length - 1;

      t.mouse.emit({ kind: "press", x: last, y: row });
      t.mouse.emit({ kind: "drag", x: start, y: row });
      t.mouse.emit({ kind: "release", x: start, y: row });
      await vi.waitFor(() => expect(copies).toEqual(["beta gamma"]));
      await vi.waitFor(() => expect(inverted(t)).toEqual(["beta gamma"]));

      // A click without a drag clears the selection and copies nothing.
      t.mouse.emit({ kind: "press", x: start, y: row });
      t.mouse.emit({ kind: "release", x: start, y: row });
      await vi.waitFor(() => expect(inverted(t)).toEqual([]));
      expect(copies).toEqual(["beta gamma"]);

      t.app.unmount();
    }),
  );

  it(
    "copies the released selection and flashes the result",
    withColor(async () => {
      const t = mount();
      await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
      const { end, second } = await selectWords(t);
      clipboard.copyToClipboard.mockClear();

      t.mouse.emit({ kind: "release", x: end, y: second });
      await vi.waitFor(() => expect(lastFrame(t).rows.join("\n")).toContain("Copied 16 characters"));
      expect(clipboard.copyToClipboard).toHaveBeenCalledTimes(1);
      expect(clipboard.copyToClipboard.mock.calls[0]).toEqual([
        "beta gamma\ndelta",
        expect.objectContaining({ platform: process.platform, env: process.env }),
      ]);

      t.app.unmount();
    }),
  );

  it(
    "selects the lines shown while scrolled up",
    withColor(async () => {
      const copies: string[] = [];
      const t = mount({ onCopy: (text) => copies.push(text) });
      await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
      t.agents.claude.emit(Array.from({ length: 50 }, (_, i) => `history line ${i}\n`).join(""));
      await vi.waitFor(() => expect(lastHistoryLine(t)).toBe(49));
      t.mouse.emit({ kind: "wheel", direction: "up", x: 10, y: 8 });
      t.mouse.emit({ kind: "wheel", direction: "up", x: 10, y: 8 });
      await vi.waitFor(() => expect(lastHistoryLine(t)).toBe(43));

      const rows = lastFrame(t).rows;
      const row = rows.findIndex((text) => text.endsWith("history line 40"));
      const x = rows[row]!.indexOf("history");
      const last = x + "history line 40".length - 1;
      t.mouse.emit({ kind: "press", x, y: row });
      t.mouse.emit({ kind: "drag", x: last, y: row });
      t.mouse.emit({ kind: "release", x: last, y: row });

      await vi.waitFor(() => expect(copies).toEqual(["history line 40"]));
      await vi.waitFor(() => expect(inverted(t)).toEqual(["history line 40"]));

      t.app.unmount();
    }),
  );

  it(
    "ignores the mouse while the command palette is open",
    withColor(async () => {
      const copies: string[] = [];
      const t = mount({ onCopy: (text) => copies.push(text) });
      await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
      t.agents.claude.emit(Array.from({ length: 50 }, (_, i) => `history line ${i}\n`).join(""));
      await vi.waitFor(() => expect(lastHistoryLine(t)).toBe(49));

      await press(t, "/");
      await vi.waitFor(() => expect(t.chunks.join("")).toContain("/claude <text>"));
      const rows = lastFrame(t).rows;
      const row = rows.findIndex((text) => text.includes("history line"));

      t.mouse.emit({ kind: "wheel", direction: "up", x: 10, y: row });
      t.mouse.emit({ kind: "press", x: 0, y: row });
      t.mouse.emit({ kind: "drag", x: 20, y: row });
      t.mouse.emit({ kind: "release", x: 20, y: row });
      await tick();

      expect(lastHistoryLine(t)).toBe(49);
      expect(inverted(t)).toEqual([]);
      expect(copies).toEqual([]);

      t.app.unmount();
    }),
  );

  it(
    "a rewind clears the selection",
    withColor(async () => {
      const t = mount();
      await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
      t.agents.claude.emit("Looking.\n");
      await tick();
      const row = lastFrame(t).rows.findIndex((text) => text.includes("Looking."));
      t.mouse.emit({ kind: "press", x: 2, y: row });
      t.mouse.emit({ kind: "drag", x: 10, y: row });
      t.mouse.emit({ kind: "release", x: 10, y: row });
      await vi.waitFor(() => expect(inverted(t)).toEqual(["Looking."]));

      t.agents.claude.note("Looking.\n");
      t.agents.claude.emit("Answer.\n");
      await vi.waitFor(() => expect(lastFrame(t).rows.join("\n")).toContain("Answer."));
      expect(inverted(t)).toEqual([]);

      t.app.unmount();
    }),
  );

  it(
    "a resize clears the selection",
    withColor(async () => {
      const t = mount();
      await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
      await selectWords(t);

      t.stdout.columns = 70;
      t.stdout.emit("resize");
      await vi.waitFor(() => expect(lastFrame(t).rows[3]).toBe("━".repeat(contentWidthFor(70))));
      expect(inverted(t)).toEqual([]);

      t.app.unmount();
    }),
  );

  it(
    "a keypress clears the selection",
    withColor(async () => {
      const t = mount();
      await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
      await selectWords(t);

      await press(t, "q");
      await vi.waitFor(() => expect(inverted(t)).toEqual([]));
      // The key still reaches the input bar.
      expect(lastFrame(t).rows.some((row) => /‣ ?q\b/.test(row))).toBe(true);

      t.app.unmount();
    }),
  );
});

describe("bootstrap helpers", () => {
  it("splits the renderer blocks without losing blank lines", () => {
    expect(transcriptBlockLines("line 1\n\nline 3\n")).toEqual(["line 1", "", "line 3"]);
  });

  it("selects a window from the bottom of the transcript", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`);
    expect(transcriptWindow(lines, 3, 0)).toEqual(["line 7", "line 8", "line 9"]);
    expect(transcriptWindow(lines, 3, 2)).toEqual(["line 5", "line 6", "line 7"]);
    expect(transcriptWindow(lines, 3, 99)).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("draws the header, its rule, turn headers and the bottom rule at the transcript content width", async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
    t.agents.claude.emit("Hello.\n");
    await vi.waitFor(() => expect(lastFrame(t).rows.join("\n")).toContain("Hello."));

    const width = contentWidthFor(100);
    expect(width).toBeLessThan(100);
    const { rows } = lastFrame(t);
    expect(rows[3]).toBe("━".repeat(width));
    expect(rows.filter((row) => /^─+$/.test(row))).toEqual(["─".repeat(width)]);
    // Right-aligned rows end on the same column as the rules.
    expect(rows[0]!.trimEnd()).toHaveLength(width);
    expect(rows.find((row) => row.startsWith("◆ CLAUDE"))!.trimEnd()).toHaveLength(width);

    t.app.unmount();
  });

  it.each([24, 40])(
    "fills exactly the frame height with header, transcript, rule and footer at %i rows",
    async (rows) => {
      const t = mount({ rows });
      await vi.waitFor(() => expect(t.agents.claude.pending).toBe(true));
      t.agents.claude.emit(Array.from({ length: 80 }, (_, i) => `filler ${i}\n`).join(""));
      await tick();

      const full = t.chunks.filter((chunk) => chunk.includes("CLAUDEX ")).at(-1)!;
      const frame = full.replace(ANSI_SEQUENCE, "").replace(/\n$/, "").split("\n");
      expect(frame).toHaveLength(rows - 1);
      expect(frame[0]).toMatch(/^CLAUDEX /);
      expect(frame.filter((line) => /^─+$/.test(line))).toHaveLength(1);
      expect(frame[3]).toMatch(/^━+$/);
      expect(frame.findIndex((line) => /^─+$/.test(line))).toBeGreaterThan(3);

      t.app.unmount();
    },
  );
});
