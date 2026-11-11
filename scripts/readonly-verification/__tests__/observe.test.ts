import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CASES, MARKER_NAME, type CaseId, type VerificationCase } from "../cases.js";
import { runCase, type QueryFn, type RunSettings } from "../observe.js";
import { TrustedDirError } from "../trustedDir.js";

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
        mcp_servers: [
          { name: "evil", status: "connected", source: "project" },
          { name: "old", status: "pending" },
        ],
        plugins: [{ name: "p", path: "/x/p" }],
        skills: ["s"],
        apiKeySource: "none",
      }),
      { type: "result", subtype: "success" },
    );

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.initTools).toEqual(["Read", "Grep", "Glob", "mcp__evil__write_file"]);
    expect(observation.initPermissionMode).toBe("plan");
    expect(observation.mcpServers).toEqual([
      { name: "evil", status: "connected", source: "project" },
      { name: "old", status: "pending", source: null },
    ]);
    expect(observation.initPlugins).toEqual([{ name: "p", path: "/x/p" }]);
    expect(observation.initSkills).toEqual(["s"]);
    expect(observation.apiKeySource).toBe("none");
    expect(observation.resultSubtype).toBe("success");
    expect(observation.error).toBeNull();
  });

  it("never drops an MCP server entry it cannot parse", async () => {
    const query = scripted(
      init({ mcp_servers: [{ name: "x" }, { status: "pending" }, "weird", null] }),
    );

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.mcpServers).toEqual([
      { name: "x", status: "unknown", source: null },
      { name: "(unparsed)", status: "pending", source: null },
      { name: "(unparsed)", status: "unknown", source: null },
      { name: "(unparsed)", status: "unknown", source: null },
    ]);
  });

  it("records a placeholder server when mcp_servers is not an array", async () => {
    const observation = await runCase(scripted(init({ mcp_servers: { evil: {} } })), caseOf("E"), settings);

    expect(observation.mcpServers).toEqual([{ name: "(unparsed mcp_servers)", status: "unknown", source: null }]);
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
      initPlugins: [],
      initSkills: [],
      apiKeySource: null,
      toolUses: [],
      permissionRequests: [],
      markerWritten: false,
      resultSubtype: null,
      error: null,
      trustStateChanges: null,
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

  // Same rule as the adapter (src/agents/claudeAgent.ts): the subtype alone is enough.
  it("reports an error_* subtype even when is_error is absent or false", async () => {
    for (const flagged of [{}, { is_error: false }]) {
      const query = scripted(init(), {
        type: "result",
        subtype: "error_during_execution",
        errors: ["model not found"],
        ...flagged,
      });

      const observation = await runCase(query, caseOf("E"), settings);

      expect(observation.error, JSON.stringify(flagged)).toContain("error_during_execution");
      expect(observation.error, JSON.stringify(flagged)).toContain("model not found");
    }
  });

  it("reports error_max_budget_usd as an engine failure without is_error", async () => {
    const query = scripted(init(), { type: "result", subtype: "error_max_budget_usd" });

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.error).toContain("error_max_budget_usd");
  });

  it("still does not treat running out of turns as a failure when is_error is absent", async () => {
    const query = scripted(init(), { type: "result", subtype: "error_max_turns" });

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.error).toBeNull();
    expect(observation.resultSubtype).toBe("error_max_turns");
  });

  it("does not report a success subtype without is_error", async () => {
    const query = scripted(init(), { type: "result", subtype: "success", result: "hello" });

    const observation = await runCase(query, caseOf("E"), settings);

    expect(observation.error).toBeNull();
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

  it("rejects, and leaves no temp dir behind, when the case cannot be set up", async () => {
    const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("claudex-readonly-"));
    const before = leftovers();

    const broken: VerificationCase = {
      ...caseOf("E"),
      projectFiles: () => {
        throw new Error("cannot build project");
      },
    };
    await expect(runCase(scripted(init()), broken, settings)).rejects.toThrow("cannot build project");

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

describe("runCase — trusted folder", () => {
  let root: string;
  let dir: string;
  let configFile: string;
  let trusted: RunSettings;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "claudex-trusted-run-")));
    dir = join(root, "trusted");
    mkdirSync(dir);
    configFile = join(root, ".claude.json");
    writeFileSync(configFile, JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
    trusted = { ...settings, trusted: { dir, configFile } };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runs in the trusted folder and leaves it empty", async () => {
    let cwd = "";
    const query: QueryFn = async function* ({ options }) {
      cwd = options.cwd as string;
      yield init();
    };

    const observation = await runCase(query, caseOf("L"), trusted);

    expect(cwd).toBe(dir);
    expect(readdirSync(dir)).toEqual([]);
    expect(observation.trustStateChanges).toEqual([]);
  });

  it("removes the marker the case's breach wrote", async () => {
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, MARKER_NAME), "pwned");
      yield init();
    };

    const observation = await runCase(query, caseOf("E"), trusted);

    expect(observation.markerWritten).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a folder that is not empty before the case, and touches nothing", async () => {
    writeFileSync(join(dir, "keep.txt"), "mine");

    await expect(runCase(scripted(init()), caseOf("E"), trusted)).rejects.toThrow(TrustedDirError);

    expect(readdirSync(dir)).toEqual(["keep.txt"]);
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("mine");
  });

  it("stops when the engine left a file it cannot account for", async () => {
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "other.txt"), "x");
      yield init();
    };

    await expect(runCase(query, caseOf("E"), trusted)).rejects.toThrow(/other\.txt/);

    expect(existsSync(join(dir, "other.txt"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });

  it.each([".claude/settings.local.json", ".git/hooks/x"])(
    "stops and keeps %s when the engine wrote it inside a directory the run created",
    async (relative) => {
      const query: QueryFn = async function* ({ options }) {
        const path = join(options.cwd as string, relative);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "x");
        yield init();
      };

      await expect(runCase(query, caseOf("L"), trusted)).rejects.toThrow(relative);

      expect(existsSync(join(dir, relative))).toBe(true);
    },
  );

  it("removes only the marker when it stops on an unaccounted file", async () => {
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "other.txt"), "x");
      writeFileSync(join(options.cwd as string, MARKER_NAME), "pwned");
      yield init();
    };

    await expect(runCase(query, caseOf("E"), trusted)).rejects.toThrow(/other\.txt/);

    expect(existsSync(join(dir, MARKER_NAME))).toBe(false);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });

  it("names the changed project entry keys, never values, when it stops", async () => {
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "other.txt"), "x");
      writeFileSync(
        configFile,
        JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["sEcReT"] } } }),
      );
      yield init();
    };

    const error = await runCase(query, caseOf("E"), trusted).catch((e: unknown) => e);

    expect((error as Error).message).toContain("enabledMcpjsonServers");
    expect((error as Error).message).not.toContain("sEcReT");
  });

  it("leaves the folder empty and propagates the error when the setup throws", async () => {
    const broken: VerificationCase = {
      ...caseOf("E"),
      projectFiles: () => {
        throw new Error("cannot build project");
      },
    };

    await expect(runCase(scripted(init()), broken, trusted)).rejects.toThrow("cannot build project");

    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(["/abs.txt", "../up.txt", "a/../b.txt", "a//b.txt", "./c.txt", ""])(
    "rejects the case file path %j at setup",
    async (bad) => {
      const evil: VerificationCase = { ...caseOf("E"), projectFiles: () => ({ [bad]: "x" }) };

      await expect(runCase(scripted(init()), evil, trusted)).rejects.toThrow(/invalid case file path/);

      expect(readdirSync(dir)).toEqual([]);
      expect(existsSync(join(root, "up.txt"))).toBe(false);
    },
  );

  it("removes the project directories of the case, not only its files", async () => {
    await runCase(scripted(init()), caseOf("L"), trusted);

    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("reports the project entry keys the run changed", async () => {
    const query: QueryFn = async function* () {
      writeFileSync(
        configFile,
        JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["evil"] } } }),
      );
      yield init();
    };

    const observation = await runCase(query, caseOf("E"), trusted);

    expect(observation.trustStateChanges).toEqual(["enabledMcpjsonServers"]);
  });
});
