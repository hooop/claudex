import { EventEmitter } from "node:events";
import { render } from "ink";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let autoComplete = true;
  let autoResponse = "Sujet qualifié\n\n<<CONTINUE>>";
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
    saveTranscript: vi.fn(async () => "trace.md"),
    setAutoComplete(value: boolean) {
      autoComplete = value;
    },
    setAutoResponse(value: string) {
      autoResponse = value;
    },
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
  rememberModel: vi.fn(async () => {}),
  rememberAutonomyBudget: vi.fn(async () => {}),
  saveHandoff: vi.fn(async () => "handoff.md"),
  saveTranscript: mocks.saveTranscript,
}));

vi.mock("../../util/projectStatus.js", () => ({
  getProjectStatus: () => ({
    decisionsCount: 0,
    lastSession: null,
    claudeDefaultModel: null,
    codexDefaultModel: null,
    codexDefaultEffort: null,
    // These fakes always answer <<CONTINUE>> from a microtask, so a real debate
    // between them never ends and would starve the event loop. Nothing here
    // asserts on how many turns happen, so one automatic start is enough to
    // exercise the chain and let every test settle. Do not set this back to
    // null: the bound belongs to the fixture, not to the product's default.
    autonomyBudget: { kind: "automatic-starts", maximum: 1 },
  }),
}));

vi.mock("../components/AnimatedHeader.js", () => ({
  AnimatedHeader: mocks.animatedHeader,
}));

import { Root } from "../Root.js";
import {
  formatLastSession,
  welcomeDivider,
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe("Root — cycle de vie du header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setAutoComplete(true);
    mocks.setAutoResponse("Sujet qualifié\n\n<<CONTINUE>>");
    mocks.saveTranscript.mockResolvedValue("trace.md");
  });

  it("place les modèles sous le prompt et ouvre l'aide depuis l'accueil", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const initialFrame = terminal.chunks.join("").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const lines = initialFrame.split("\n");
    const memoryLine = lines.findIndex((line) => line.includes("Mémoire :"));
    const taglineLine = lines.findIndex((line) => line.includes(WELCOME_TAGLINE));
    const promptLine = lines.findIndex((line) => line.includes("Décrivez la problématique technique"));
    const modelsLine = lines.findIndex((line) => line.includes("fake-model + fake-model"));
    expect(memoryLine).toBeGreaterThan(-1);
    expect(taglineLine).toBeGreaterThan(memoryLine);
    expect(modelsLine).toBeGreaterThan(promptLine);
    expect(lines[modelsLine]).not.toContain("Claude :");
    expect(lines[modelsLine]).not.toContain("Codex :");
    expect(lines[modelsLine]).toContain("/help");
    expect(WELCOME_MODELS_COLOR).toBe("ansi256(66)");
    expect(WELCOME_TAGLINE_COLOR).toBe("ansi256(138)");
    expect(WELCOME_MEMORY_COLOR).toBe("ansi256(59)");
    const formattedSession = formatLastSession("2026-08-10T11:42:17.288Z");
    expect(formattedSession).toContain("10 août 2026");
    expect(formattedSession).toMatch(/\d{2}:\d{2}$/);
    expect(formattedSession).not.toContain("T11:42:17.288Z");
    expect(welcomeDivider(80)).toBe("·".repeat(80));
    expect(welcomeDivider(200)).toBe("·".repeat(96));
    expect(initialFrame).not.toContain("Plasma psychédélique");
    expect(initialFrame).toContain(WELCOME_TAGLINE);
    expect(initialFrame).not.toContain("▲ Claudex");

    terminal.chunks.length = 0;
    await press(terminal, "/help");
    await press(terminal, "\r");
    await vi.waitFor(() => {
      const output = terminal.chunks.join("");
      expect(output).toContain("Commandes");
      expect(output).toContain("/handoff");
      expect(output).toContain("/decide");
    });
    expect(mocks.appendDevlog).not.toHaveBeenCalled();
    app.unmount();
  });

  it("conserve le preset choisi après un débat puis /new", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "\u001b[C");
    await vi.waitFor(() => {
      expect(
        mocks.animatedHeader.mock.calls.some(([props]) => props.animation === "interference"),
      ).toBe(true);
    });

    await press(terminal, "Sujet de test");
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

  it("n'écrit le devlog qu'après validation effective du sujet", async () => {
    mocks.setAutoComplete(false);
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Sujet encore provisoire");
    await press(terminal, "\r");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.appendDevlog).not.toHaveBeenCalled();
    app.unmount();
  });

  it("revient à l'accueil sans devlog ni archive pour un vrai non-sujet", async () => {
    mocks.setAutoResponse("Bonjour, indique un sujet technique.\n\n<<NO_TOPIC>>");
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Bonjour");
    await press(terminal, "\r");

    await vi.waitFor(() => expect(mocks.animatedHeader).toHaveBeenCalledTimes(2));
    expect(mocks.appendDevlog).not.toHaveBeenCalled();
    expect(mocks.saveTranscript).not.toHaveBeenCalled();
    app.unmount();
  });

  it("garde l'interface fermée visible après un échec d'archive et /retry reprend uniquement l'archive", async () => {
    mocks.saveTranscript.mockRejectedValueOnce(new Error("disque indisponible"));
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Sujet de test");
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

  it("marque /save comme instantané partiel sans fermer la session", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Sujet de test");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.appendDevlog).toHaveBeenCalledOnce());
    await press(terminal, "/save");
    await press(terminal, "\r");

    await vi.waitFor(() => expect(mocks.saveTranscript).toHaveBeenCalledOnce());
    expect(mocks.saveTranscript).toHaveBeenCalledWith(
      "/projet-test",
      "Sujet de test",
      expect.any(Array),
      { completeness: "partial" },
    );
    expect(mocks.animatedHeader).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it("sérialise /new derrière un /save déjà en cours", async () => {
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
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Sujet de test");
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

  it("refuse /save tant que /cancel n'est pas stabilisé", async () => {
    mocks.setAutoComplete(false);
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await press(terminal, "Sujet en cours");
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
