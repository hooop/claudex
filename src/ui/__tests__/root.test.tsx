import { EventEmitter } from "node:events";
import { render } from "ink";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let autoComplete = true;
  let autoResponse = "Sujet qualifié\n\n<<CONTINUE>>";
  // Mutable : la mémoire du projet change sous les pieds de Claudex dès qu'une
  // session écrit une décision, et l'accueil doit refléter le disque, pas
  // l'état du lancement.
  const projectStatus = {
    decisionsCount: 0,
    decisionsText: "# Décisions\n\nAucune décision actée.",
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
    saveTranscript: vi.fn(async () => "trace.md"),
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
  readDecisions: vi.fn(async () => "# Décisions\n\nAucune décision actée."),
  rememberModel: vi.fn(async () => {}),
  rememberAutonomyBudget: vi.fn(async () => {}),
  saveHandoff: vi.fn(async () => "handoff.md"),
  saveTranscript: mocks.saveTranscript,
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
    // Ink 7 régule ses rendus : une frappe n'est plus reflétée dans le même
    // tour de boucle.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

describe("Root — cycle de vie du header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setAutoComplete(true);
    mocks.setAutoResponse("Sujet qualifié\n\n<<CONTINUE>>");
    mocks.projectStatus.decisionsCount = 0;
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
    const memory = welcomeMemoryLine(
      { decisionsCount: 3, lastSession: "2026-08-10T11:42:17.288Z" },
      80,
    );
    expect(displayWidth(memory)).toBe(80);
    expect(memory).toMatch(/^Mémoire : 3 décisions actées/);
    expect(memory).toMatch(/dernière session : .*10 août 2026.*\d{2}:\d{2}$/);
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

  it("ouvre les décisions actées depuis l'accueil et les rend sans marqueurs Markdown", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    terminal.chunks.length = 0;
    await press(terminal, "/decisions");
    await press(terminal, "\r");

    await vi.waitFor(() => {
      const output = terminal.chunks.join("").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
      expect(output).toContain("Décisions actées");
      expect(output).toContain("Aucune décision actée.");
      expect(output).not.toContain("# Décisions");
      expect(output).toContain("PgUp/PgDn");
    });

    app.unmount();
  });

  it("ouvre les modèles au-dessus du prompt d'accueil et choisit avec Tab", async () => {
    const setModel = vi.spyOn(mocks.FakeAgent.prototype, "setModel");
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    await vi.waitFor(() => expect(terminal.stdin.listenerCount("readable")).toBeGreaterThan(0));
    await press(terminal, "/model claude");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(terminal.chunks.join("")).toContain("Opus 5"));

    const frameChunk = [...terminal.chunks]
      .reverse()
      .find((chunk) => chunk.includes("Opus 5") && chunk.includes("Décrivez la problématique"));
    expect(frameChunk).toBeDefined();
    const frame = frameChunk!.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(frame.indexOf("Opus 5")).toBeLessThan(frame.indexOf("Décrivez la problématique"));
    expect(frame).toContain("↑↓ 1/4 · Tab ou Entrée choisir · Échap fermer");

    await press(terminal, "\u001b[B");
    await press(terminal, "\t");
    expect(setModel).toHaveBeenCalledWith("sonnet");
    app.unmount();
    setModel.mockRestore();
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

  // Une session peut écrire dans .claudex/memory (/decide, /handoff). Sans
  // relecture au retour, l'accueil et son /decisions montrent le disque tel
  // qu'il était au lancement de Claudex.
  it("relit la mémoire du projet en revenant à l'accueil", async () => {
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

    // Le débat vient d'acter une décision sur le disque.
    mocks.projectStatus.decisionsCount = 3;

    terminal.chunks.length = 0;
    await press(terminal, "/new");
    await press(terminal, "\r");
    await vi.waitFor(() => expect(mocks.saveTranscript).toHaveBeenCalledOnce());

    await vi.waitFor(() => {
      expect(terminal.chunks.join("").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")).toContain(
        "3 décisions actées",
      );
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

  /**
   * A non-topic used to close the session and go back to the welcome screen,
   * which wiped the agent's answer before it could be read. The conversation
   * now stays open — only the writes to project memory are withheld until a
   * real subject is accepted.
   */
  it("garde la conversation ouverte, sans devlog ni archive, pour un vrai non-sujet", async () => {
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

    // Ce faux agent renvoie son texte d'un bloc, sans deltas, donc le rendu du
    // message n'est pas observable ici ; ce qui compte est que l'écran de débat
    // n'ait pas été démonté. Un retour à l'accueil réanimerait le header.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mocks.animatedHeader).toHaveBeenCalledTimes(1);
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
