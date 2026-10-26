import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASES, MARKER_NAME, type CaseId, type VerificationCase } from "../cases.js";
import { runCase, type QueryFn, type RunSettings } from "../observe.js";

function caseOf(id: CaseId): VerificationCase {
  const found = CASES.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

const settings: RunSettings = {
  model: "test-model",
  maxTurns: 3,
  timeoutMs: 5_000,
  evilServerPath: "/path/to/evil-mcp-server.mjs",
};

const init = (overrides: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "init",
  tools: ["Read", "Grep", "Glob"],
  mcp_servers: [],
  permissionMode: "default",
  ...overrides,
});

const toolUse = (id: string, name: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", id, name, input: {} }] },
});

/** A fake query() that yields the given messages, then ends. */
function scripted(...messages: unknown[]): QueryFn {
  return async function* () {
    for (const message of messages) yield message;
  };
}

describe("runCase — what the stream tells", () => {
  it("collects init tools, permission mode and MCP servers", async () => {
    const query = scripted(
      init({
        tools: ["Read", "Grep", "Glob", "mcp__evil__write_file"],
        permissionMode: "plan",
        mcp_servers: [{ name: "evil", status: "connected" }],
      }),
      { type: "result", subtype: "success" },
    );

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.initTools).toEqual(["Read", "Grep", "Glob", "mcp__evil__write_file"]);
    expect(observation.initPermissionMode).toBe("plan");
    expect(observation.mcpServers).toEqual([{ name: "evil", status: "connected" }]);
    expect(observation.resultSubtype).toBe("success");
    expect(observation.error).toBeNull();
  });

  it("collects tool uses from assistant messages", async () => {
    const query = scripted(
      init(),
      toolUse("t1", "Grep"),
      toolUse("t2", "Glob"),
      // Not a tool use: must not be counted.
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    );

    const observation = await runCase(query, caseOf("F"), settings);

    expect(observation.toolUses).toEqual([
      { id: "t1", name: "Grep" },
      { id: "t2", name: "Glob" },
    ]);
  });

  it("collects every tool use of one assistant message, in order", async () => {
    const query = scripted(init(), {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Grep", input: {} },
          { type: "text", text: "and then" },
          { type: "tool_use", id: "t2", name: "Glob", input: {} },
        ],
      },
    });

    const observation = await runCase(query, caseOf("F"), settings);

    expect(observation.toolUses).toEqual([
      { id: "t1", name: "Grep" },
      { id: "t2", name: "Glob" },
    ]);
  });

  it("leaves everything empty when the stream carries nothing usable", async () => {
    const query = scripted(
      "not an object",
      null,
      { type: "system", subtype: "init", tools: "Read" },
      { type: "assistant", message: { content: "text" } },
      { type: "assistant" },
      { type: "result" },
    );

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation).toEqual({
      initTools: null,
      initPermissionMode: null,
      mcpServers: [],
      toolUses: [],
      permissionRequests: [],
      markerWritten: false,
      resultSubtype: null,
      error: null,
    });
  });
});

// An engine that failed (rejected model, lost login, API error) ends the stream
// with a normal-looking result message. If it were not reported as an error, a
// case could pass on the init message alone, having tested nothing.
describe("runCase — error results", () => {
  it("reports an error result even when its subtype is success", async () => {
    const query = scripted(init(), {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Invalid API key",
    });

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.error).toContain("success");
    expect(observation.error).toContain("Invalid API key");
    expect(observation.resultSubtype).toBe("success");
  });

  it("reports an error_during_execution result with its error strings", async () => {
    const query = scripted(init(), {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["model not found", "request failed"],
    });

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.error).toContain("error_during_execution");
    expect(observation.error).toContain("model not found");
    expect(observation.error).toContain("request failed");
  });

  it("reports an error result that carries no detail", async () => {
    const query = scripted(init(), { type: "result", subtype: "error_during_execution", is_error: true });

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.error).toContain("error_during_execution");
  });

  it("does not treat running out of turns as an engine failure", async () => {
    const query = scripted(init(), toolUse("t1", "Grep"), {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
    });

    const observation = await runCase(query, caseOf("F"), settings);

    expect(observation.error).toBeNull();
    expect(observation.resultSubtype).toBe("error_max_turns");
    expect(observation.toolUses).toEqual([{ id: "t1", name: "Grep" }]);
  });

  it("does not report a result that says it is not an error", async () => {
    const query = scripted(init(), { type: "result", subtype: "success", is_error: false, result: "hello" });

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.error).toBeNull();
  });
});

describe("runCase — permission policy", () => {
  it("records canUseTool calls and answers with the policy", async () => {
    const answers: unknown[] = [];
    const query: QueryFn = async function* ({ options }) {
      const canUseTool = options.canUseTool as (
        name: string,
        input: Record<string, unknown>,
        opts: { toolUseID: string; signal: AbortSignal },
      ) => Promise<unknown>;
      const signal = new AbortController().signal;
      answers.push(await canUseTool("Write", { file_path: "x" }, { toolUseID: "t1", signal }));
      answers.push(await canUseTool("Read", { file_path: "y" }, { toolUseID: "t2", signal }));
      yield init();
    };

    const observation = await runCase(query, caseOf("G"), settings);

    expect(answers[0]).toMatchObject({ behavior: "deny" });
    expect((answers[0] as { message: string }).message).toEqual(expect.any(String));
    expect((answers[0] as { message: string }).message).not.toBe("");
    // 0.1.77 requires updatedInput on allow: the input must come back as received.
    expect(answers[1]).toEqual({ behavior: "allow", updatedInput: { file_path: "y" } });
    expect(observation.permissionRequests).toEqual([
      { toolUseID: "t1", toolName: "Write", decision: "deny" },
      { toolUseID: "t2", toolName: "Read", decision: "allow" },
    ]);
  });

  it("denies everything under the deny-all policy", async () => {
    let answer: unknown;
    const query: QueryFn = async function* ({ options }) {
      const canUseTool = options.canUseTool as (
        name: string,
        input: Record<string, unknown>,
        opts: { toolUseID: string },
      ) => Promise<unknown>;
      answer = await canUseTool("Read", {}, { toolUseID: "t9" });
      yield init();
    };

    const observation = await runCase(query, caseOf("E"), settings);

    expect(answer).toMatchObject({ behavior: "deny" });
    expect(observation.permissionRequests).toEqual([{ toolUseID: "t9", toolName: "Read", decision: "deny" }]);
  });

  it("passes no canUseTool for policy none", async () => {
    let received: Record<string, unknown> = {};
    const query: QueryFn = async function* ({ options }) {
      received = options;
      yield init();
    };

    await runCase(query, caseOf("A"), settings);

    expect("canUseTool" in received).toBe(false);
  });
});

describe("runCase — query call", () => {
  it("passes the case options, the prompt and the run settings", async () => {
    let received: { prompt: string; options: Record<string, unknown> } | undefined;
    const query: QueryFn = async function* (params) {
      received = params;
      yield init();
    };

    await runCase(query, caseOf("E"), { ...settings, maxTurns: 4 });

    expect(received?.prompt).toContain(MARKER_NAME);
    expect(received?.options).toMatchObject({
      ...caseOf("E").options,
      model: "test-model",
      maxTurns: 4,
    });
    expect(received?.options.abortController).toBeInstanceOf(AbortController);
    expect(typeof received?.options.cwd).toBe("string");
  });

  it("builds a git repository in a temp dir and removes it afterwards", async () => {
    let cwd = "";
    let hadGit = false;
    let hadSharedFiles = false;
    const query: QueryFn = async function* ({ options }) {
      cwd = options.cwd as string;
      hadGit = existsSync(join(cwd, ".git"));
      hadSharedFiles =
        readFileSync(join(cwd, "README.md"), "utf8").includes("claudex-marker") &&
        readFileSync(join(cwd, "notes.md"), "utf8").includes("claudex-marker");
      yield init();
    };

    await runCase(query, caseOf("E"), settings);

    expect(cwd).not.toBe("");
    expect(hadGit).toBe(true);
    expect(hadSharedFiles).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it("writes the case's project files", async () => {
    let settingsJson = "";
    const query: QueryFn = async function* ({ options }) {
      settingsJson = readFileSync(join(options.cwd as string, ".claude", "settings.json"), "utf8");
      yield init();
    };

    await runCase(query, caseOf("G"), settings);

    expect(settingsJson).toContain("bypassPermissions");
  });

  it("points the case's marker path and evil server at the throwaway project", async () => {
    let mcpJson = "";
    let cwd = "";
    const query: QueryFn = async function* ({ options }) {
      cwd = options.cwd as string;
      mcpJson = readFileSync(join(cwd, ".mcp.json"), "utf8");
      yield init();
    };

    await runCase(query, caseOf("H"), settings);

    const server = (JSON.parse(mcpJson) as { mcpServers: { evil: { args: string[] } } }).mcpServers.evil;
    expect(server.args[0]).toBe(settings.evilServerPath);
    expect(server.args[1]).toBe(join(cwd, MARKER_NAME));
  });

  it("gives case I its probe tool", async () => {
    let prompt = "";
    const query: QueryFn = async function* (params) {
      prompt = params.prompt;
      yield init();
    };

    await runCase(query, caseOf("I"), { ...settings, probeTool: "mcp__vault__whoami" });

    expect(prompt).toContain("mcp__vault__whoami");
  });

  it("rejects, and leaves no temp dir behind, when the case cannot be set up", async () => {
    const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("claudex-readonly-"));
    const before = leftovers();

    // Case I throws while building its prompt without a probe tool.
    await expect(runCase(scripted(init()), caseOf("I"), settings)).rejects.toThrow("probe tool");

    expect(leftovers()).toEqual(before);
  });
});

describe("runCase — marker file", () => {
  it("detects the marker file", async () => {
    let cwd = "";
    const query: QueryFn = async function* ({ options }) {
      cwd = options.cwd as string;
      writeFileSync(join(cwd, MARKER_NAME), "pwned");
      yield init();
    };

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.markerWritten).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it("reports no marker when nothing wrote it", async () => {
    const observation = await runCase(scripted(init()), caseOf("E"), settings);

    expect(observation.markerWritten).toBe(false);
  });

  it("still detects the marker when the query then throws", async () => {
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, MARKER_NAME), "pwned");
      yield init();
      throw new Error("boom");
    };

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.markerWritten).toBe(true);
    expect(observation.error).toContain("boom");
  });
});

describe("runCase — failures", () => {
  it("reports a thrown SDK error", async () => {
    const query: QueryFn = async function* () {
      yield* [];
      throw new Error("engine exploded");
    };

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.error).toContain("engine exploded");
    expect(observation.initTools).toBeNull();
  });

  it("keeps what was observed before the error", async () => {
    const query: QueryFn = async function* () {
      yield init();
      yield toolUse("t1", "Read");
      throw new Error("lost connection");
    };

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.initTools).toEqual(["Read", "Grep", "Glob"]);
    expect(observation.toolUses).toEqual([{ id: "t1", name: "Read" }]);
    expect(observation.error).toContain("lost connection");
  });

  it("reports a non-Error throw", async () => {
    const query: QueryFn = async function* () {
      yield* [];
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "plain string";
    };

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.error).toContain("plain string");
  });

  it("times out a turn that never ends", async () => {
    const query: QueryFn = async function* ({ options }) {
      yield init();
      const signal = (options.abortController as AbortController).signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };

    const observation = await runCase(query, caseOf("A"), { ...settings, timeoutMs: 50 });

    expect(observation.error).toMatch(/timed out after 50 ?ms/i);
    expect(observation.initTools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("reports the timeout even when the SDK ends quietly on abort", async () => {
    const query: QueryFn = async function* ({ options }) {
      yield init();
      const signal = (options.abortController as AbortController).signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve());
      });
    };

    const observation = await runCase(query, caseOf("A"), { ...settings, timeoutMs: 50 });

    expect(observation.error).toMatch(/timed out/i);
  });

  it("does not wait for a query that ignores the abort", async () => {
    const query: QueryFn = async function* () {
      yield init();
      await new Promise<void>(() => undefined);
    };

    const observation = await runCase(query, caseOf("A"), { ...settings, timeoutMs: 50 });

    expect(observation.error).toMatch(/timed out/i);
  });

  it("ignores what a straggling stream reports after the timeout", async () => {
    const query: QueryFn = async function* () {
      yield init();
      await new Promise((resolve) => setTimeout(resolve, 150));
      yield toolUse("late", "Bash");
    };

    const observation = await runCase(query, caseOf("A"), { ...settings, timeoutMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(observation.toolUses).toEqual([]);
  });
});
