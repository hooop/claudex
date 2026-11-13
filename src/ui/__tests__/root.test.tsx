import { EventEmitter } from "node:events";
import { render } from "ink";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let autoComplete = true;
  let autoResponse = "Qualified topic\n\n<<CONTINUE>>";
  // Mutable: the project memory changes under Claudex's feet as soon as a
  // session writes a decision, and the welcome screen must reflect the disk,
  // not the launch state.
  const projectStatus = {
    decisionsCount: 0,
    decisionsText: "# Decisions\n\nNo settled decision.",
    lastSession: null as string | null,
    claudeDefaultModel: null as string | null,
    codexDefaultModel: null as string | null,
    codexDefaultEffort: null as string | null,
    // These fakes always answer <<CONTINUE>> from a microtask, so a real debate
    // between them never ends and would starve the event loop. Nothing here
    // asserts on how many turns happen, so one automatic start is enough to
    // exercise the chain and let every test settle. Do not set this back to
    // null: the bound belongs to the fixture, not to the product's default.
    autonomyBudget: { kind: "automatic-starts", maximum: 1 } as const,
  };
  class FakeAgent {
    readonly label: string;
    private resolve:
      | ((result: { kind: "cancelled" } | { kind: "success"; text: string }) => void)
      | null = null;

    constructor(readonly id: "claude" | "codex") {
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
    send() {
      return new Promise<{ kind: "cancelled" } | { kind: "success"; text: string }>((resolve) => {
        this.resolve = resolve;
        if (autoComplete) {
          queueMicrotask(() => {
            this.resolve?.({ kind: "success", text: autoResponse });
            this.resolve = null;
          });
        }
      });
    }
    async stop() {
      this.resolve?.({ kind: "cancelled" });
      this.resolve = null;
    }
  }

  return {
    FakeAgent,
    appendDevlog: vi.fn(async () => {}),
    animatedHeader: vi.fn((props: { animation: string }) => {
      void props;
      return null;
    }),
    saveTranscript: vi.fn(async () => "transcript.md"),
    saveTrace: vi.fn(async () => null as string | null),
    setAutoComplete(value: boolean) {
      autoComplete = value;
    },
    setAutoResponse(value: string) {
      autoResponse = value;
    },
    projectStatus,
    getProjectStatus: vi.fn(() => ({ ...projectStatus })),
  };
});

vi.mock("../../agents/claudeAgent.js", () => ({
  ClaudeAgent: class extends mocks.FakeAgent {
    constructor() {
      super("claude");
    }
  },
}));

vi.mock("../../agents/codexAgent.js", () => ({
  CodexAgent: class extends mocks.FakeAgent {
    constructor() {
      super("codex");
    }
  },
}));

vi.mock("../../memory/store.js", () => ({
  appendDecision: vi.fn(async () => {}),
  appendDevlog: mocks.appendDevlog,
  appendLimit: vi.fn(async () => {}),
  readDecisions: vi.fn(async () => "# Decisions\n\nNo settled decision."),
  rememberAutonomyBudget: vi.fn(async () => {}),
  saveHandoff: vi.fn(async () => "handoff.md"),
  saveTranscript: mocks.saveTranscript,
  saveTrace: mocks.saveTrace,
  sessionTitle: (topic: string) => topic,
}));

vi.mock("../../util/projectStatus.js", () => ({
  getProjectStatus: mocks.getProjectStatus,
}));

vi.mock("../components/AnimatedHeader.js", () => ({
  AnimatedHeader: mocks.animatedHeader,
}));

import { Root } from "../Root.js";
import { displayWidth } from "../stream/lineBuffer.js";
import {
  formatLastSession,
  welcomeDivider,
  welcomeMemoryLine,
  WELCOME_MEMORY_COLOR,
  WELCOME_MODELS_COLOR,
  WELCOME_TAGLINE,
  WELCOME_TAGLINE_COLOR,
} from "../components/WelcomeScreen.js";

function fakeTerminal() {
  const chunks: string[] = [];
  const inputQueue: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
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

async function press(terminal: ReturnType<typeof fakeTerminal>, input: string): Promise<void> {
  await act(async () => {
    terminal.pushInput(input);
    // Ink 7 throttles its renders: a keystroke is no longer reflected in the
    // same event-loop turn.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

describe("Root — header lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setAutoComplete(true);
    mocks.setAutoResponse("Qualified topic\n\n<<CONTINUE>>");
    mocks.projectStatus.decisionsCount = 0;
    mocks.saveTranscript.mockResolvedValue("transcript.md");
  });

  it("puts the models under the prompt and opens the help from the welcome screen", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const initialFrame = terminal.chunks.join("").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const lines = initialFrame.split("\n");
    const memoryLine = lines.findIndex((line) => line.includes("Memory:"));
    const taglineLine = lines.findIndex((line) => line.includes(WELCOME_TAGLINE));
    const promptLine = lines.findIndex((line) => line.includes("Describe the technical problem"));
    const modelsLine = lines.findIndex((line) => line.includes("fake-model + fake-model"));
    expect(memoryLine).toBeGreaterThan(-1);
    expect(taglineLine).toBeGreaterThan(memoryLine);
    expect(modelsLine).toBeGreaterThan(promptLine);
    expect(lines[modelsLine]).not.toContain("Claude:");
    expect(lines[modelsLine]).not.toContain("Codex:");
    expect(lines[modelsLine]).toContain("/help");
    expect(WELCOME_MODELS_COLOR).toBe("ansi256(66)");
    expect(WELCOME_TAGLINE_COLOR).toBe("ansi256(138)");
    expect(WELCOME_MEMORY_COLOR).toBe("ansi256(102)");
    const formattedSession = formatLastSession("2026-08-10T11:42:17.288Z");
    expect(formattedSession).toContain("August 10, 2026");
    expect(formattedSession).toMatch(/\d{1,2}:\d{2}\s[AP]M$/);
    expect(formattedSession).not.toContain("T11:42:17.288Z");
    expect(welcomeDivider(80)).toBe("-".repeat(80));
    expect(welcomeDivider(200)).toBe("-".repeat(96));
    const memory = welcomeMemoryLine(
      { decisionsCount: 3, lastSession: "2026-08-10T11:42:17.288Z" },
      80,
    );
    expect(displayWidth(memory)).toBe(80);
    expect(memory).toMatch(/^Memory: 3 settled decisions/);
    expect(memory).toMatch(/last session: .*August 10, 2026.*\d{1,2}:\d{2}\s[AP]M$/);
    expect(initialFrame).not.toContain("Psychedelic plasma");
    expect(initialFrame).toContain(WELCOME_TAGLINE);
    expect(initialFrame).not.toContain("▲ Claudex");

    terminal.chunks.length = 0;
    await press(terminal, "/help");
    await press(terminal, "\r");
    await vi.waitFor(() => {
      const output = terminal.chunks.join("");
      expect(output).toContain("Commands");
      expect(output).toContain("/handoff");
      expect(output).toContain("/decide");
    });
    expect(mocks.appendDevlog).not.toHaveBeenCalled();
    app.unmount();
  });

  it("opens the settled decisions from the welcome screen and renders them without Markdown markers", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    terminal.chunks.length = 0;
    await press(terminal, "/decisions");
    await press(terminal, "\r");

    await vi.waitFor(() => {
      const output = terminal.chunks.join("").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
      expect(output).toContain("Settled decisions");
      expect(output).toContain("No settled decision.");
      expect(output).not.toContain("# Decisions");
      expect(output).toContain("PgUp/PgDn");
    });

    app.unmount();
  });

  it("opens the models above the welcome prompt and selects with Tab", async () => {
    const setModel = vi.spyOn(mocks.FakeAgent.prototype, "setModel");
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await press(terminal, "/model claude");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(terminal.chunks.join("")).toContain("Opus 5"));

    const frameChunk = [...terminal.chunks]
      .reverse()
      .find((chunk) => chunk.includes("Opus 5") && chunk.includes("Describe the technical problem"));
    expect(frameChunk).toBeDefined();
    const frame = frameChunk!.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(frame.indexOf("Opus 5")).toBeLessThan(frame.indexOf("Describe the technical problem"));
    expect(frame).toContain("↑↓ 1/4 · Tab or Enter to choose · Esc close");

    await press(terminal, "\u001b[B");
    await press(terminal, "\t");
    expect(setModel).toHaveBeenCalledWith("sonnet");
    app.unmount();
    setModel.mockRestore();
  });

  it("keeps the chosen preset after a debate then /new", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "\u001b[C");
    await vi.waitFor(() => {
      expect(
        mocks.animatedHeader.mock.calls.some(([props]) => props.animation === "interference"),
      ).toBe(true);
    });

    await press(terminal, "Test topic");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.appendDevlog).toHaveBeenCalledOnce());

    // The next header call must come from the freshly mounted welcome screen.
    terminal.chunks.length = 0;
    mocks.animatedHeader.mockClear();
    await press(terminal, "/new");
    await press(terminal, "\r");

    await vi.waitFor(() => expect(mocks.saveTranscript).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(
        mocks.animatedHeader.mock.calls.some(([props]) => props.animation === "interference"),
      ).toBe(true);
    });

    app.unmount();
  });

  // A session may write to .claudex/memory (/decide, /handoff). Without a
  // reread on return, the welcome screen and its /decisions show the disk as
  // it was at Claudex's launch.
  it("rereads the project memory when returning to the welcome screen", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Test topic");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.appendDevlog).toHaveBeenCalledOnce());

    // The debate has just settled a decision on disk.
    mocks.projectStatus.decisionsCount = 3;

    terminal.chunks.length = 0;
    await press(terminal, "/new");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.saveTranscript).toHaveBeenCalledOnce());

    await vi.waitFor(() => {
      expect(terminal.chunks.join("").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")).toContain(
        "3 settled decisions",
      );
    });
    app.unmount();
  });

  it("saves the trace next to the archived transcript on /new", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Test topic");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.appendDevlog).toHaveBeenCalledOnce());

    await press(terminal, "/new");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.saveTrace).toHaveBeenCalledOnce());
    expect(mocks.saveTrace).toHaveBeenCalledWith("/test-project", "transcript.md", expect.any(Array));
    app.unmount();
  });

  it("starts a debate on a pasted topic that starts with a slash", async () => {
    mocks.setAutoComplete(false);
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "\u001b[200~/Users/me/app.ts:12 TypeError\nat main\u001b[201~");
    await press(terminal, "\r");

    await vi.waitFor(() => {
      const output = terminal.chunks.join("").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
      expect(output).toContain("Topic  /Users/me/app.ts:12 TypeError at main");
    });
    expect(terminal.chunks.join("")).not.toContain("No debate in progress");
    app.unmount();
  });

  it("writes the devlog only once the topic is actually accepted", async () => {
    mocks.setAutoComplete(false);
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Still provisional topic");
    await press(terminal, "\r");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.appendDevlog).not.toHaveBeenCalled();
    app.unmount();
  });

  /**
   * A non-topic used to close the session and go back to the welcome screen,
   * which wiped the agent's answer before it could be read. The conversation
   * now stays open — only the writes to project memory are withheld until a
   * real subject is accepted.
   */
  it("keeps the conversation open, without devlog or archive, for a real non-topic", async () => {
    mocks.setAutoResponse("Hello, please give a technical topic.\n\n<<NO_TOPIC>>");
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });
    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Hello");
    await press(terminal, "\r");

    // This fake agent returns its text in one block, without deltas, so the
    // message rendering is not observable here; what matters is that the debate
    // screen was not unmounted. A return to the welcome screen would re-animate
    // the header.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mocks.animatedHeader).toHaveBeenCalledTimes(1);
    expect(mocks.appendDevlog).not.toHaveBeenCalled();
    expect(mocks.saveTranscript).not.toHaveBeenCalled();
    app.unmount();
  });

  it("keeps the closed interface visible after an archive failure and /retry resumes only the archive", async () => {
    mocks.saveTranscript.mockRejectedValueOnce(new Error("disk unavailable"));
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Test topic");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.appendDevlog).toHaveBeenCalledOnce());
    await press(terminal, "/new");
    await press(terminal, "\r");

    await vi.waitFor(() => expect(mocks.saveTranscript).toHaveBeenCalledOnce());
    expect(mocks.animatedHeader).toHaveBeenCalledTimes(1);

    await press(terminal, "/retry");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.saveTranscript).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.animatedHeader).toHaveBeenCalledTimes(2));
    app.unmount();
  });

  it("marks /save as a partial snapshot without closing the session", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Test topic");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.appendDevlog).toHaveBeenCalledOnce());
    await press(terminal, "/save");
    await press(terminal, "\r");

    await vi.waitFor(() => expect(mocks.saveTranscript).toHaveBeenCalledOnce());
    expect(mocks.saveTranscript).toHaveBeenCalledWith(
      "/test-project",
      "Test topic",
      expect.any(Array),
      { completeness: "partial" },
    );
    expect(mocks.animatedHeader).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it("serializes /new behind a /save already in progress", async () => {
    let resolvePartial!: (path: string) => void;
    mocks.saveTranscript
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolvePartial = resolve;
          }),
      )
      .mockResolvedValue("stable.md");
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });
    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Test topic");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.appendDevlog).toHaveBeenCalledOnce());

    await press(terminal, "/save");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.saveTranscript).toHaveBeenCalledOnce());
    await press(terminal, "/new");
    await press(terminal, "\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.saveTranscript).toHaveBeenCalledOnce();
    expect(mocks.animatedHeader).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePartial("partial.md");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await vi.waitFor(() => expect(mocks.saveTranscript).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.animatedHeader).toHaveBeenCalledTimes(2));
    app.unmount();
  });

  it("refuses /save until /cancel has settled", async () => {
    mocks.setAutoComplete(false);
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });
    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Topic in progress");
    await press(terminal, "\r");
    await press(terminal, "/cancel");
    await press(terminal, "\r");
    await press(terminal, "/save");
    await press(terminal, "\r");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.saveTranscript).not.toHaveBeenCalled();
    app.unmount();
  });
});

describe("Root — resize", () => {
  it("erases the whole screen and repaints the frame after a resize", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/test-project" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });
    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    terminal.chunks.length = 0;

    terminal.stdout.rows = 40;
    terminal.stdout.emit("resize");

    await vi.waitFor(() => {
      const written = terminal.chunks.join("");
      const lastErase = written.lastIndexOf("\u001b[2J\u001b[H");
      expect(lastErase).toBeGreaterThan(-1);
      expect(written.slice(lastErase)).toContain(WELCOME_TAGLINE);
    });
    app.unmount();
  });
});
