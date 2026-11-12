import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { CodexAgent } from "../codexAgent.js";

type Scenario = "scripted" | "success" | "limit" | "invalid-completion" | "mismatched-completion" | "silent";

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private input = "";

  constructor(
    private readonly scenario: Scenario,
    private readonly script: unknown[] = [],
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.input += chunk.toString();
      let newline = this.input.indexOf("\n");
      while (newline !== -1) {
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (line) this.handle(JSON.parse(line) as Record<string, unknown>);
        newline = this.input.indexOf("\n");
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }

  private handle(message: Record<string, unknown>): void {
    this.requests.push(message);
    const method = message.method;
    const id = message.id;
    if (typeof id !== "number") return;

    if (method === "initialize") {
      this.write({ id, result: {} });
      return;
    }
    if (method === "thread/start" || method === "thread/resume") {
      this.write({ id, result: { thread: { id: "thread-1" }, model: "codex-test" } });
      return;
    }
    if (method === "turn/start") {
      this.write({ id, result: { turn: { id: "turn-1", status: "inProgress" } } });
      queueMicrotask(() => this.finishTurn());
    }
  }

  private finishTurn(): void {
    if (this.scenario === "silent") return;
    if (this.scenario === "scripted") {
      for (const message of this.script) this.write(message);
      this.write({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
      });
      return;
    }
    if (this.scenario === "invalid-completion") {
      this.write({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { status: "completed" } },
      });
      return;
    }
    if (this.scenario === "mismatched-completion") {
      this.write({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-other", status: "completed" } },
      });
      return;
    }
    if (this.scenario === "limit") {
      this.write({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" },
          },
        },
      });
      return;
    }

    this.write({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 100,
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "npm test\n--run",
          status: "inProgress",
        },
      },
    });
    this.write({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "Hel" },
    });
    this.write({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: { totalTokens: 99_000 },
          last: { totalTokens: 12_500, reasoningOutputTokens: 2_500 },
          modelContextWindow: 250_000,
        },
      },
    });
    this.write({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "lo" },
    });
    this.write({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 8_300,
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "npm test\n--run",
          status: "completed",
          exitCode: 0,
          durationMs: 8_200,
        },
      },
    });
    this.write({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 8_400,
        item: { id: "message-1", type: "agentMessage", text: "Hello", phase: "final_answer" },
      },
    });
    this.write({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
    });
  }

  private write(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

describe("CodexAgent app-server streaming", () => {
  beforeEach(() => spawnMock.mockReset());

  it("consumes the deltas without duplicating the final message and exposes the command as activity", async () => {
    const server = new FakeAppServer("success");
    spawnMock.mockReturnValue(server);
    const deltas: string[] = [];
    const activities: unknown[] = [];
    const contexts: unknown[] = [];

    const agent = new CodexAgent(undefined, "gpt-configured, max effort");
    expect(agent.currentModel()).toBe("gpt-configured, max effort");
    expect(agent.hasExplicitModel()).toBe(false);

    const result = await agent.send("Topic", {
      cwd: "/tmp",
      writeAccess: false,
      onTextDelta: (delta) => deltas.push(delta),
      onActivity: (activity) => activities.push(activity),
      onContextUsage: (usage) => contexts.push(usage),
    });

    expect(result).toMatchObject({ kind: "success", text: "Hello" });
    expect(agent.currentModel()).toBe("codex-test");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(contexts).toEqual([{ usedTokens: 10_000, contextWindow: 250_000 }]);
    expect(activities).toContainEqual({
      kind: "command",
      status: "running",
      label: "npm test\n--run",
      activeCount: 1,
    });
    expect(activities).toContainEqual({
      kind: "command",
      status: "success",
      label: "npm test\n--run",
      durationMs: 8_200,
      exitCode: 0,
    });

    const turnStart = server.requests.find((request) => request.method === "turn/start");
    expect(turnStart).toMatchObject({
      params: {
        input: [{ type: "text", text: "Topic" }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    });
    const threadStart = server.requests.find((request) => request.method === "thread/start");
    expect(threadStart).not.toHaveProperty("params.model");

    agent.resetSession();
    expect(agent.currentModel()).toBe("gpt-configured, max effort");
  });

  it("says so clearly when the automatic choice is not yet resolved", () => {
    expect(new CodexAgent().currentModel()).toBe("auto (detected on the 1st turn)");
  });

  it("makes a Codex limit explicit and resumable", async () => {
    spawnMock.mockReturnValue(new FakeAppServer("limit"));

    const result = await new CodexAgent().send("Topic", { cwd: "/tmp", writeAccess: false });

    expect(result).toMatchObject({ kind: "error" });
    if (result.kind === "error") {
      expect(result.message).toContain("Codex limit reached");
      expect(result.message).toContain("/resume");
    }
  });

  it("resumes the same app-server thread on the next turn", async () => {
    const firstServer = new FakeAppServer("success");
    const secondServer = new FakeAppServer("success");
    spawnMock.mockReturnValueOnce(firstServer).mockReturnValueOnce(secondServer);
    const agent = new CodexAgent();

    await agent.send("First", { cwd: "/tmp", writeAccess: false });
    await agent.send("Second", { cwd: "/tmp", writeAccess: false });

    expect(firstServer.requests.some((request) => request.method === "thread/start")).toBe(true);
    expect(secondServer.requests).toContainEqual(
      expect.objectContaining({
        method: "thread/resume",
        params: expect.objectContaining({ threadId: "thread-1" }),
      }),
    );
  });

  it.each(["invalid-completion", "mismatched-completion"] as const)(
    "immediately turns a critical turn/completed %s into a recoverable error",
    async (scenario) => {
      spawnMock.mockReturnValue(new FakeAppServer(scenario));

      const result = await new CodexAgent().send("Topic", { cwd: "/tmp", writeAccess: false });

      expect(result.kind).toBe("error");
      if (result.kind === "error") expect(result.message).toContain("Invalid Codex protocol");
    },
  );

  it("does not invent a timeout for a silent server and stays cancellable", async () => {
    const server = new FakeAppServer("silent");
    spawnMock.mockReturnValue(server);
    const controller = new AbortController();
    const resultPromise = new CodexAgent().send("Topic", {
      cwd: "/tmp",
      writeAccess: false,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(server.requests.some((request) => request.method === "turn/start")).toBe(true));
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({ kind: "cancelled" });
  });
});

const note = (method: string, params: Record<string, unknown>) => ({
  method,
  params: { threadId: "thread-1", turnId: "turn-1", ...params },
});
const delta = (itemId: string, text: string) => note("item/agentMessage/delta", { itemId, delta: text });
const started = (item: Record<string, unknown>) => note("item/started", { item });
const completed = (item: Record<string, unknown>) => note("item/completed", { item });
const message = (id: string, text: string, phase?: string | null) => ({
  id,
  type: "agentMessage",
  text,
  ...(phase === undefined ? {} : { phase }),
});

async function runScript(script: unknown[], withNotes: boolean) {
  spawnMock.mockReturnValue(new FakeAppServer("scripted", script));
  const deltas: string[] = [];
  const notes: Array<[string, boolean]> = [];
  const result = await new CodexAgent().send("Topic", {
    cwd: "/tmp",
    writeAccess: false,
    onTextDelta: (d) => deltas.push(d),
    ...(withNotes ? { onNote: (text: string, streamed: boolean) => notes.push([text, streamed]) } : {}),
  });
  return { result, deltas, notes };
}

describe("CodexAgent notes and trace", () => {
  beforeEach(() => spawnMock.mockReset());

  it("moves a commentary item out of the answer", async () => {
    const { result, notes } = await runScript(
      [
        delta("c1", "Reading memory."),
        completed(message("c1", "Reading memory.", "commentary")),
        delta("a1", "Use X.\n\n<<CONTINUE>>"),
        completed(message("a1", "Use X.\n\n<<CONTINUE>>", "final_answer")),
      ],
      true,
    );

    expect(result).toEqual({ kind: "success", text: "Use X.\n\n<<CONTINUE>>" });
    expect(notes).toEqual([["Reading memory.", true]]);
  });

  it("reports a streamed note as the exact suffix streamed, blank line included", async () => {
    const { result, deltas, notes } = await runScript(
      [
        delta("a1", "A"),
        completed(message("a1", "A", "final_answer")),
        delta("c1", "Checking."),
        completed(message("c1", "Checking.", "commentary")),
        delta("a2", "B"),
        completed(message("a2", "B", "final_answer")),
      ],
      true,
    );

    expect(deltas).toEqual(["A", "\n\n", "Checking.", "\n\n", "B"]);
    expect(notes).toEqual([["\n\nChecking.", true]]);
    expect(result).toEqual({ kind: "success", text: "A\n\nB" });
  });

  it("keeps a streamed commentary item in partialText when the turn fails", async () => {
    const { result } = await runScript(
      [
        delta("c1", "Working."),
        note("turn/completed", {
          turn: { id: "turn-1", status: "failed", error: { message: "boom" } },
        }),
      ],
      true,
    );

    expect(result).toMatchObject({ kind: "error", partialText: "Working." });
  });

  it("holds back deltas of an item started as commentary", async () => {
    const { result, deltas, notes } = await runScript(
      [
        started(message("c1", "", "commentary")),
        delta("c1", "Checking "),
        delta("c1", "files."),
        completed(message("c1", "Checking files.", "commentary")),
        completed(message("a1", "Answer.", "final_answer")),
      ],
      true,
    );

    expect(deltas.join("")).toBe("Answer.");
    expect(notes).toEqual([["Checking files.", false]]);
    expect(result).toEqual({ kind: "success", text: "Answer." });
  });

  it.each([null, undefined])("keeps an item with phase %s as answer", async (phase) => {
    const { result, notes } = await runScript(
      [delta("a1", "Hello"), completed(message("a1", "Hello", phase))],
      true,
    );

    expect(result).toEqual({ kind: "success", text: "Hello" });
    expect(notes).toEqual([]);
  });

  it("separates two answer items with a blank line", async () => {
    const { result, deltas } = await runScript(
      [
        delta("a1", "First."),
        completed(message("a1", "First.", "final_answer")),
        delta("a2", "Second."),
        completed(message("a2", "Second.", "final_answer")),
      ],
      false,
    );

    expect(result).toEqual({ kind: "success", text: "First.\n\nSecond." });
    expect(deltas).toEqual(["First.", "\n\n", "Second."]);
  });

  it("separates whole answer items that were never streamed", async () => {
    const { result, deltas } = await runScript(
      [completed(message("a1", "First.")), completed(message("a2", "Second."))],
      false,
    );

    expect(result).toEqual({ kind: "success", text: "First.\n\nSecond." });
    expect(deltas.join("")).toBe("First.\n\nSecond.");
  });

  it("only-commentary turn keeps its marker", async () => {
    const { result, notes } = await runScript(
      [
        delta("c1", "Checked.\n\n<<CONSENSUS>>"),
        completed(message("c1", "Checked.\n\n<<CONSENSUS>>", "commentary")),
      ],
      true,
    );

    expect(result).toEqual({ kind: "success", text: "Checked.\n\n<<CONSENSUS>>" });
    expect(notes).toHaveLength(1);
  });

  it("keeps notes in the text without onNote", async () => {
    const { result } = await runScript(
      [
        delta("c1", "Reading."),
        completed(message("c1", "Reading.", "commentary")),
        delta("a1", "Answer."),
        completed(message("a1", "Answer.", "final_answer")),
      ],
      false,
    );

    expect(result).toEqual({ kind: "success", text: "Reading.\n\nAnswer." });
  });

  it("reports a finished command with its full output", async () => {
    spawnMock.mockReturnValue(
      new FakeAppServer("scripted", [
        completed({
          id: "cmd-1",
          type: "commandExecution",
          command: "ls",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: "ok\n",
        }),
        completed({ id: "fc-1", type: "fileChange", status: "failed", changes: [{ path: "a.ts", kind: "update" }] }),
      ]),
    );
    const traces: unknown[] = [];

    await new CodexAgent().send("Topic", { cwd: "/tmp", writeAccess: false, onTrace: (e) => traces.push(e) });

    expect(traces).toEqual([
      { kind: "tool", label: "ls", status: "success", exitCode: 0, output: "ok\n" },
      { kind: "tool", label: "edits a.ts", status: "failure" },
    ]);
  });
});
