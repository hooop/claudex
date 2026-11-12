import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { ClaudeAgent, DEBATE_SANDBOX_ERROR } from "../claudeAgent.js";
import { SETTINGS_CHANGED_MESSAGE } from "../projectSettings.js";

async function* messages(items: unknown[]) {
  for (const item of items) yield item;
}

function successResult() {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "session-1",
    modelUsage: { "claude-test": { contextWindow: 200_000 } },
  };
}

describe("ClaudeAgent streaming", () => {
  beforeEach(() => queryMock.mockReset());

  it("emits the real text_delta events without repeating the final assistant message", async () => {
    queryMock.mockReturnValue(
      messages([
        {
          type: "stream_event",
          session_id: "session-1",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hel" },
          },
        },
        {
          type: "stream_event",
          session_id: "session-1",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "lo" },
          },
        },
        {
          type: "assistant",
          session_id: "session-1",
          message: {
            model: "claude-test",
            usage: {
              input_tokens: 1_000,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 2_000,
              output_tokens: 300,
            },
            content: [{ type: "text", text: "Hello" }],
          },
        },
        successResult(),
      ]) as never,
    );

    const deltas: string[] = [];
    const contexts: unknown[] = [];
    const agent = new ClaudeAgent(undefined, "Opus 4.5");
    expect(agent.currentModel()).toBe("Opus 4.5");
    expect(agent.hasExplicitModel()).toBe(false);

    const result = await agent.send("Topic", {
      cwd: "/tmp",
      writeAccess: false,
      onTextDelta: (delta) => deltas.push(delta),
      onContextUsage: (usage) => contexts.push(usage),
    });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(contexts).toEqual([{ usedTokens: 3_500, contextWindow: 200_000 }]);
    expect(result).toMatchObject({ kind: "success", text: "Hello" });
    expect(agent.currentModel()).toBe("Test");
    expect(queryMock.mock.calls[0]?.[0]?.options.model).toBeUndefined();
    expect(queryMock.mock.calls[0]?.[0]?.options.includePartialMessages).toBe(true);
    // Measured: user settings cost 13,300 system-prompt tokens per call, in
    // plugin catalogues that an agent limited to Read/Grep/Glob cannot use.
    // The only useful field, the default model, is read by Claudex and passed
    // explicitly.
    expect(queryMock.mock.calls[0]?.[0]?.options.settingSources).toEqual(["project"]);

    agent.resetSession();
    expect(agent.currentModel()).toBe("Opus 4.5");
  });

  it("shows the model that answered, not the first model listed in modelUsage", async () => {
    // Measured on SDK 0.3.310: with model "opus", modelUsage lists the engine's
    // background Haiku first, then the model that actually answered.
    queryMock.mockReturnValue(
      messages([
        {
          type: "assistant",
          session_id: "session-1",
          message: {
            model: "claude-opus-5-5",
            usage: { input_tokens: 1_000, output_tokens: 100 },
            content: [{ type: "text", text: "Summary" }],
          },
        },
        {
          ...successResult(),
          modelUsage: {
            "claude-haiku-5-5": { contextWindow: 200_000 },
            "claude-opus-5-5": { contextWindow: 200_000 },
          },
        },
      ]) as never,
    );

    const agent = new ClaudeAgent("opus", "Opus 5");
    await agent.send("Topic", { cwd: "/tmp", writeAccess: false });

    expect(agent.currentModel()).toBe("Opus 5.5");
  });

  it("shows the selector label as soon as a model is chosen", () => {
    const agent = new ClaudeAgent();
    agent.setModel("sonnet");
    expect(agent.currentModel()).toBe("Sonnet 5");
    expect(agent.hasExplicitModel()).toBe(true);
  });

  it("says so clearly when the automatic choice is not yet resolved", () => {
    expect(new ClaudeAgent().currentModel()).toBe("auto (detected on the 1st turn)");
  });

  it("keeps the full assistant message as a fallback", async () => {
    queryMock.mockReturnValue(
      messages([
        {
          type: "assistant",
          session_id: "session-1",
          message: { content: [{ type: "text", text: "Full answer" }] },
        },
        successResult(),
      ]) as never,
    );

    const deltas: string[] = [];
    const result = await new ClaudeAgent().send("Topic", {
      cwd: "/tmp",
      writeAccess: false,
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["Full answer"]);
    expect(result).toMatchObject({ kind: "success", text: "Full answer" });
  });

  it("turns a session limit into an explicit, resumable error", async () => {
    queryMock.mockReturnValue(
      messages([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "session-1",
          modelUsage: {},
          errors: ["You've hit your session limit · resets 11:50pm"],
        },
      ]) as never,
    );

    const result = await new ClaudeAgent().send("Topic", { cwd: "/tmp", writeAccess: false });

    expect(result).toMatchObject({ kind: "error" });
    if (result.kind === "error") {
      expect(result.message).toContain("Claude Code limit reached");
      expect(result.message).toContain("/resume");
      expect(result.message).not.toContain("Unknown SDK error");
    }
  });
});

describe("ClaudeAgent — settings per phase", () => {
  beforeEach(() => queryMock.mockReset());

  /**
   * Dropping user settings lightens the debate, but the project instructions
   * (the user's CLAUDE.md) must stay in both phases, and implementation keeps
   * the global tooling.
   */
  it("loads user settings only during implementation", async () => {
    queryMock.mockReturnValue(messages([successResult()]));
    const agent = new ClaudeAgent();
    await agent.send("Apply the specification", { cwd: "/tmp", writeAccess: true });

    const options = queryMock.mock.calls[0]?.[0]?.options;
    expect(options.settingSources).toEqual(["project", "user"]);
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(options).not.toHaveProperty("strictMcpConfig");
    expect(options).not.toHaveProperty("settings");
  });

  it("passes the SDK the configured model that Claudex read itself", async () => {
    queryMock.mockReturnValue(messages([successResult()]));
    const agent = new ClaudeAgent("opus");
    await agent.send("Topic", { cwd: "/tmp", writeAccess: false });

    expect(queryMock.mock.calls[0]?.[0]?.options.model).toBe("opus");
  });

  /**
   * In a debate, read-only rests only on `tools` and `canUseTool`:
   * `permissionMode: "plan"` and `allowedTools` do not enforce it in the
   * installed SDK (limits.md, 2026-08-29). This test pins these settings so
   * that an SDK upgrade cannot loosen them silently.
   */
  it("restricts the debate to Read, Grep and Glob, under human arbitration", async () => {
    queryMock.mockReturnValue(messages([successResult()]));
    const agent = new ClaudeAgent();
    await agent.send("Topic", {
      cwd: "/tmp",
      writeAccess: false,
      onPermissionRequest: async () => ({ behavior: "deny" }),
    });

    const options = queryMock.mock.calls[0]?.[0]?.options;
    expect(options.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(options.permissionMode).toBe("default");
    expect(options.allowedTools).toEqual([]);
    expect(options.settingSources).toEqual(["project"]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings).toEqual({ disableAllHooks: true, disableClaudeAiConnectors: true, disableSkillShellExecution: true });
    expect(options).not.toHaveProperty("mcpServers");
    expect(typeof options.canUseTool).toBe("function");
  });

  it("relays every tool request to the human and applies the answer", async () => {
    queryMock.mockReturnValue(messages([successResult()]));
    const onPermissionRequest = vi
      .fn()
      .mockResolvedValueOnce({ behavior: "allow" })
      .mockResolvedValueOnce({ behavior: "deny", message: "no" })
      .mockResolvedValueOnce({ behavior: "deny" });
    const onActivity = vi.fn();
    const agent = new ClaudeAgent();
    await agent.send("Topic", { cwd: "/tmp", writeAccess: false, onPermissionRequest, onActivity });

    const canUseTool = queryMock.mock.calls[0]?.[0]?.options.canUseTool as (
      name: string,
      input: unknown,
      opts: { toolUseID: string },
    ) => Promise<unknown>;
    const input = { file_path: "/tmp/a" };
    const results = [
      await canUseTool("Read", input, { toolUseID: "tu-1" }),
      await canUseTool("Read", input, { toolUseID: "tu-2" }),
      await canUseTool("Read", input, { toolUseID: "tu-3" }),
    ];

    expect(onPermissionRequest.mock.calls[0]?.[0]).toEqual({
      id: "tu-1",
      agent: "claude",
      toolName: "Read",
      input,
    });
    expect(results).toEqual([
      { behavior: "allow", updatedInput: input },
      { behavior: "deny", message: "no" },
      { behavior: "deny", message: "Refused by user" },
    ]);
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tool", label: "reads /tmp/a", status: "running" }),
    );
  });
});

describe("ClaudeAgent settings guard", () => {
  beforeEach(() => queryMock.mockReset());

  it.each([false, true])("refuses the turn without calling query (writeAccess %s)", async (writeAccess) => {
    const guard = vi.fn(async () => SETTINGS_CHANGED_MESSAGE);
    const agent = new ClaudeAgent(undefined, undefined, guard);
    const result = await agent.send("Topic", { cwd: "/project", writeAccess });
    expect(result).toEqual({ kind: "error", message: SETTINGS_CHANGED_MESSAGE });
    expect(guard).toHaveBeenCalledWith("/project");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("fails closed when the guard itself rejects", async () => {
    const agent = new ClaudeAgent(undefined, undefined, async () => {
      throw new Error("boom");
    });
    const result = await agent.send("Topic", { cwd: "/project", writeAccess: false });
    expect(result).toEqual({ kind: "error", message: SETTINGS_CHANGED_MESSAGE });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns cancelled before consulting the guard when already aborted", async () => {
    const guard = vi.fn(async () => SETTINGS_CHANGED_MESSAGE);
    const controller = new AbortController();
    controller.abort();
    const agent = new ClaudeAgent(undefined, undefined, guard);
    const result = await agent.send("Topic", { cwd: "/project", writeAccess: false, signal: controller.signal });
    expect(result).toEqual({ kind: "cancelled" });
    expect(guard).not.toHaveBeenCalled();
  });

  it("sends the turn when the guard returns null, with the same options as without a guard", async () => {
    queryMock.mockReturnValue(messages([successResult()]) as never);
    await new ClaudeAgent().send("Topic", { cwd: "/project", writeAccess: false });
    const unguarded = queryMock.mock.calls[0]?.[0];

    queryMock.mockReset();
    queryMock.mockReturnValue(messages([successResult()]) as never);
    const guard = vi.fn(async () => null);
    const result = await new ClaudeAgent(undefined, undefined, guard).send("Topic", {
      cwd: "/project",
      writeAccess: false,
    });
    expect(result).toMatchObject({ kind: "success" });
    expect(guard).toHaveBeenCalledWith("/project");
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(queryMock.mock.calls[0]?.[0])).toBe(JSON.stringify(unguarded));
  });
});

describe("ClaudeAgent debate sandbox", () => {
  beforeEach(() => queryMock.mockReset());

  const sandbox = { cwd: "/r", home: "/h", extraDenyRead: [], secretEnvNames: [] };

  it("passes the resolved sandbox to query and adds Bash to the tools", async () => {
    queryMock.mockReturnValue(messages([successResult()]) as never);
    const resolver = vi.fn(async () => sandbox);
    const result = await new ClaudeAgent(undefined, undefined, undefined, resolver).send("Topic", {
      cwd: "/project",
      writeAccess: false,
    });
    expect(result).toMatchObject({ kind: "success" });
    expect(resolver).toHaveBeenCalledWith("/project");
    const options = queryMock.mock.calls[0]?.[0].options;
    expect(options.sandbox.filesystem.denyWrite).toEqual(["/r"]);
    expect(options.tools).toContain("Bash");
  });

  it("without a resolver, adds neither sandbox nor Bash", async () => {
    queryMock.mockReturnValue(messages([successResult()]) as never);
    await new ClaudeAgent().send("Topic", { cwd: "/project", writeAccess: false });
    const options = queryMock.mock.calls[0]?.[0].options;
    expect("sandbox" in options).toBe(false);
    expect(options.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("refuses the turn if the resolver rejects", async () => {
    const resolver = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await new ClaudeAgent(undefined, undefined, undefined, resolver).send("Topic", {
      cwd: "/project",
      writeAccess: false,
    });
    expect(result).toEqual({ kind: "error", message: DEBATE_SANDBOX_ERROR });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("refuses the turn if the resolver throws synchronously", async () => {
    const resolver = vi.fn((): Promise<never> => {
      throw new Error("boom");
    });
    const result = await new ClaudeAgent(undefined, undefined, undefined, resolver).send("Topic", {
      cwd: "/project",
      writeAccess: false,
    });
    expect(result).toEqual({ kind: "error", message: DEBATE_SANDBOX_ERROR });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("does not call the resolver in the implementation phase", async () => {
    queryMock.mockReturnValue(messages([successResult()]) as never);
    const resolver = vi.fn(async () => sandbox);
    await new ClaudeAgent(undefined, undefined, undefined, resolver).send("Topic", {
      cwd: "/project",
      writeAccess: true,
    });
    expect(resolver).not.toHaveBeenCalled();
    const options = queryMock.mock.calls[0]?.[0].options;
    expect("sandbox" in options).toBe(false);
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("cancels the turn if the abort happens during resolution", async () => {
    const controller = new AbortController();
    const resolver = vi.fn(async () => {
      controller.abort();
      return sandbox;
    });
    const result = await new ClaudeAgent(undefined, undefined, undefined, resolver).send("Topic", {
      cwd: "/project",
      writeAccess: false,
      signal: controller.signal,
    });
    expect(result).toEqual({ kind: "cancelled" });
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("ClaudeAgent — engine leftovers", () => {
  beforeEach(() => queryMock.mockReset());

  const sandbox = { cwd: "/r", home: "/h", extraDenyRead: [], secretEnvNames: [] };
  const resolver = async () => sandbox;

  function setup() {
    const calls: string[] = [];
    const snapshot = vi.fn(async (cwd: string) => {
      calls.push(`snapshot:${cwd}`);
      return new Set<string>([".claude"]) as ReadonlySet<string>;
    });
    const remove = vi.fn(async (cwd: string) => {
      calls.push(`remove:${cwd}`);
      return [] as string[];
    });
    const agent = new ClaudeAgent(undefined, undefined, undefined, resolver, { snapshot, remove });
    return { agent, snapshot, remove, calls };
  }

  it("takes a snapshot before query and cleans up after, with the turn's cwd", async () => {
    const { agent, snapshot, remove, calls } = setup();
    queryMock.mockImplementation(() => {
      calls.push("query");
      return messages([successResult()]);
    });
    const result = await agent.send("Topic", { cwd: "/project", writeAccess: false });
    expect(result).toMatchObject({ kind: "success" });
    expect(calls).toEqual(["snapshot:/project", "query", "remove:/project"]);
    expect(remove).toHaveBeenCalledWith("/project", await snapshot.mock.results[0]?.value);
  });

  it("also cleans up when the stream throws, without changing the result", async () => {
    const { agent, remove } = setup();
    queryMock.mockImplementation(async function* () {
      yield { type: "system" };
      throw new Error("broken stream");
    });
    const result = await agent.send("Topic", { cwd: "/project", writeAccess: false });
    expect(result).toMatchObject({ kind: "error" });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("does not touch the disk without a sandbox or in the implementation phase", async () => {
    const snapshot = vi.fn(async () => new Set<string>() as ReadonlySet<string>);
    const remove = vi.fn(async () => [] as string[]);
    queryMock.mockImplementation(() => messages([successResult()]));
    await new ClaudeAgent(undefined, undefined, undefined, async () => null, { snapshot, remove }).send("Topic", {
      cwd: "/project",
      writeAccess: false,
    });
    await new ClaudeAgent(undefined, undefined, undefined, resolver, { snapshot, remove }).send("Topic", {
      cwd: "/project",
      writeAccess: true,
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not change the result if the cleanup or the snapshot throw", async () => {
    const snapshot = vi.fn(async () => {
      throw new Error("snapshot");
    });
    const remove = vi.fn(async () => {
      throw new Error("remove");
    });
    queryMock.mockImplementation(() => messages([successResult()]));
    const agent = new ClaudeAgent(undefined, undefined, undefined, resolver, { snapshot, remove });
    const result = await agent.send("Topic", { cwd: "/project", writeAccess: false });
    expect(result).toMatchObject({ kind: "success" });
  });
});
