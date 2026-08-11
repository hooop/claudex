import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { CodexAgent } from "../codexAgent.js";

type Scenario = "success" | "limit" | "invalid-completion" | "mismatched-completion" | "silent";

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private input = "";

  constructor(private readonly scenario: Scenario) {
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
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "Bon" },
    });
    this.write({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "jour" },
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
        item: { id: "message-1", type: "agentMessage", text: "Bonjour", phase: "final_answer" },
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

  it("consomme les deltas sans dupliquer le message final et expose la commande comme activité", async () => {
    const server = new FakeAppServer("success");
    spawnMock.mockReturnValue(server);
    const deltas: string[] = [];
    const activities: unknown[] = [];

    const result = await new CodexAgent().send("Sujet", {
      cwd: "/tmp",
      writeAccess: false,
      onTextDelta: (delta) => deltas.push(delta),
      onActivity: (activity) => activities.push(activity),
    });

    expect(result).toMatchObject({ kind: "success", text: "Bonjour", resolvedModel: "codex-test" });
    expect(deltas).toEqual(["Bon", "jour"]);
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
        input: [{ type: "text", text: "Sujet" }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    });
  });

  it("rend une limite Codex explicite et reprenable", async () => {
    spawnMock.mockReturnValue(new FakeAppServer("limit"));

    const result = await new CodexAgent().send("Sujet", { cwd: "/tmp", writeAccess: false });

    expect(result).toMatchObject({ kind: "error" });
    if (result.kind === "error") {
      expect(result.message).toContain("Limite Codex atteinte");
      expect(result.message).toContain("/resume");
    }
  });

  it("reprend le même thread app-server au tour suivant", async () => {
    const firstServer = new FakeAppServer("success");
    const secondServer = new FakeAppServer("success");
    spawnMock.mockReturnValueOnce(firstServer).mockReturnValueOnce(secondServer);
    const agent = new CodexAgent();

    await agent.send("Premier", { cwd: "/tmp", writeAccess: false });
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
    "transforme immédiatement un turn/completed critique %s en erreur récupérable",
    async (scenario) => {
      spawnMock.mockReturnValue(new FakeAppServer(scenario));

      const result = await new CodexAgent().send("Sujet", { cwd: "/tmp", writeAccess: false });

      expect(result.kind).toBe("error");
      if (result.kind === "error") expect(result.message).toContain("Protocole Codex invalide");
    },
  );

  it("n'invente pas de timeout pour un serveur silencieux et reste annulable", async () => {
    const server = new FakeAppServer("silent");
    spawnMock.mockReturnValue(server);
    const controller = new AbortController();
    const resultPromise = new CodexAgent().send("Sujet", {
      cwd: "/tmp",
      writeAccess: false,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(server.requests.some((request) => request.method === "turn/start")).toBe(true));
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({ kind: "cancelled" });
  });
});
