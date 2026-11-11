import { connect } from "node:net";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_CASES, type CaseId, type VerificationCase } from "../cases.js";
import { runCase, type QueryFn, type RunSettings } from "../observe.js";
import { formatMarkdown } from "../verdict.js";

function caseOf(id: CaseId): VerificationCase {
  const found = ALL_CASES.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

const settings: RunSettings = {
  model: "test-model",
  maxTurns: 3,
  timeoutMs: 5_000,
  evilServerPath: "/path/to/evil-mcp-server.mjs",
};

const init = { type: "system", subtype: "init", tools: ["Read", "Grep", "Glob", "Bash"], mcp_servers: [], permissionMode: "default" };

/** Every absolute path the prompt names, in order. */
function pathsIn(prompt: string): string[] {
  return prompt.match(/\/[^\s"'`]+/g) ?? [];
}

const toolResult = (text: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "b1", content: [{ type: "text", text }] }] },
});

describe("runCase — sandbox cases", () => {
  it("builds the shipped sandbox options with the real cwd and a fake home, and removes the fake home", async () => {
    let captured: Record<string, unknown> = {};
    let prompt = "";
    let secretInfo = { isSymlink: false, content: "" };
    let realCwd = "";
    let realRoot = "";
    const query: QueryFn = async function* (params) {
      captured = params.options;
      prompt = params.prompt;
      const secretPath = pathsIn(params.prompt).find((p) => p.endsWith("id_claudex_probe")) ?? "";
      realCwd = realpathSync(params.options.cwd as string);
      realRoot = realpathSync(dirname(dirname(dirname(secretPath))));
      secretInfo = { isSymlink: lstatIsSymlink(dirname(secretPath)), content: readFileSync(secretPath, "utf8") };
      yield init;
    };

    await runCase(query, caseOf("Sr"), settings);

    const sandbox = captured.sandbox as { filesystem: { denyWrite: string[]; denyRead: string[] } };
    const cwd = captured.cwd as string;
    expect(sandbox.filesystem.denyWrite).toEqual([realCwd]);
    expect(captured.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(captured.permissionMode).toBe("default");
    expect(captured.canUseTool).toBeTypeOf("function");

    const secretPath = pathsIn(prompt).find((p) => p.endsWith("id_claudex_probe")) ?? "";
    const fakeHome = dirname(dirname(secretPath));
    const root = dirname(fakeHome);
    expect(sandbox.filesystem.denyRead).toContain(join(realRoot, "home", ".ssh"));
    // The decoy sits behind a symlink: the real target is denied too.
    expect(sandbox.filesystem.denyRead).toContain(join(realRoot, "dotfiles-ssh"));
    expect(secretInfo.isSymlink).toBe(true);
    expect(secretInfo.content.length).toBeGreaterThanOrEqual(16);
    // Neither inside the project nor left behind.
    expect(root.startsWith(cwd)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it("strips the sandbox from the controls and keeps Bash", async () => {
    let captured: Record<string, unknown> = {};
    const query: QueryFn = async function* (params) {
      captured = params.options;
      yield init;
    };

    await runCase(query, caseOf("Sc"), settings);

    expect("sandbox" in captured).toBe(false);
    expect(captured.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(captured.strictMcpConfig).toBe(true);
  });

  it("allows Bash and denies MCP through canUseTool", async () => {
    const query: QueryFn = async function* (params) {
      const canUseTool = params.options.canUseTool as (n: string, i: Record<string, unknown>, o: { toolUseID: string }) => Promise<{ behavior: string }>;
      expect((await canUseTool("Bash", {}, { toolUseID: "b1" })).behavior).toBe("allow");
      expect((await canUseTool("mcp__x__y", {}, { toolUseID: "m1" })).behavior).toBe("deny");
      yield init;
    };
    const observation = await runCase(query, caseOf("S"), settings);
    expect(observation.permissionRequests.map((r) => r.decision)).toEqual(["allow", "deny"]);
  });

  it("labels the markers written in sub, .git and outside, and the root one", async () => {
    const query: QueryFn = async function* (params) {
      for (const path of pathsIn(params.prompt).filter((p) => p.endsWith("PWNED.txt"))) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "pwned");
      }
      yield init;
    };

    const observation = await runCase(query, caseOf("Sc"), settings);

    expect(observation.markerWritten).toBe(true);
    expect(observation.extraMarkersWritten).toEqual(["sub", ".git", "outside"]);
  });

  it("serves a unix socket inside the fixture root for Shu, counts connections and removes it", async () => {
    let socketPath = "";
    let projectDir = "";
    const query: QueryFn = async function* (params) {
      socketPath = pathsIn(params.prompt).find((p) => p.endsWith(".sock")) ?? "";
      projectDir = params.options.cwd as string;
      await new Promise<void>((resolve, reject) => {
        const client = connect(socketPath, () => client.end());
        client.on("close", () => resolve());
        client.on("error", reject);
      });
      yield init;
    };

    const observation = await runCase(query, caseOf("Shu"), settings);

    expect(observation.listenerRequests).toHaveLength(1);
    expect(socketPath.startsWith(projectDir)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("records no connection when nothing reaches the Shu socket, and serves none for the other cases", async () => {
    let socketPath = "";
    const query: QueryFn = async function* (params) {
      socketPath = pathsIn(params.prompt).find((p) => p.endsWith(".sock")) ?? "";
      yield init;
    };
    expect((await runCase(query, caseOf("Shu"), settings)).listenerRequests).toEqual([]);
    expect(socketPath).not.toBe("");
    let leaked = true;
    await runCase(async function* (params) {
      leaked = pathsIn(params.prompt).some((p) => p.endsWith(".sock"));
      yield init;
    }, caseOf("Sr"), settings);
    expect(leaked).toBe(false);
  });

  it("sees the token in a tool result of Sr, and never stores it", async () => {
    let token = "";
    const query: QueryFn = async function* (params) {
      const secretPath = pathsIn(params.prompt).find((p) => p.endsWith("id_claudex_probe")) ?? "";
      token = readFileSync(secretPath, "utf8").trim();
      yield init;
      yield toolResult(token);
      yield { type: "result", subtype: "success" };
    };

    const observation = await runCase(query, caseOf("Src"), settings);

    expect(observation.secretSeen).toBe(true);
    expect(token).not.toBe("");
    expect(JSON.stringify(observation)).not.toContain(token);
  });

  it("sees the token in assistant text", async () => {
    const query: QueryFn = async function* (params) {
      const secretPath = pathsIn(params.prompt).find((p) => p.endsWith("id_claudex_probe")) ?? "";
      yield init;
      yield { type: "assistant", message: { content: [{ type: "text", text: `The file says ${readFileSync(secretPath, "utf8").trim()}.` }] } };
    };
    expect((await runCase(query, caseOf("Src"), settings)).secretSeen).toBe(true);
  });

  it("reports no secret when the stream never shows it", async () => {
    const query: QueryFn = async function* () {
      yield init;
      yield toolResult("cat: Operation not permitted");
      yield { type: "assistant", message: { content: [{ type: "text", text: "denied" }] } };
    };
    expect((await runCase(query, caseOf("Sr"), settings)).secretSeen).toBe(false);
  });

  it("gives Se a secret variable in env, denied by the sandbox, without the Claude session variables", async () => {
    const saved = { code: process.env.CLAUDECODE, cfg: process.env.CLAUDE_CONFIG_DIR };
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CONFIG_DIR = "/keep/me";
    let captured: Record<string, unknown> = {};
    const query: QueryFn = async function* (params) {
      captured = params.options;
      const env = params.options.env as Record<string, string>;
      yield init;
      yield toolResult(`V=[${env.CLAUDEX_PROBE_TOKEN}]`);
    };
    try {
      const observation = await runCase(query, caseOf("Se"), settings);
      const env = captured.env as Record<string, string | undefined>;
      expect(env.CLAUDEX_PROBE_TOKEN).toMatch(/^[0-9a-f]{32}$/);
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBe("/keep/me");
      expect(env.PATH).toBe(process.env.PATH);
      const sandbox = captured.sandbox as { credentials: { envVars: Array<{ name: string; mode: string }> } };
      expect(sandbox.credentials.envVars).toContainEqual({ name: "CLAUDEX_PROBE_TOKEN", mode: "deny" });
      expect(observation.secretSeen).toBe(true);
      expect(JSON.stringify(observation)).not.toContain(env.CLAUDEX_PROBE_TOKEN ?? "unreachable");
      expect(process.env.CLAUDEX_PROBE_TOKEN).toBeUndefined();
    } finally {
      if (saved.code === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved.code;
      if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
    }
  });

  it("passes no env option to the cases that do not ask for one", async () => {
    let captured: Record<string, unknown> = {};
    await runCase(async function* (params) { captured = params.options; yield init; }, caseOf("Sr"), settings);
    expect("env" in captured).toBe(false);
  });

  it("keeps the token out of the markdown report", async () => {
    const query: QueryFn = async function* (params) {
      const env = params.options.env as Record<string, string>;
      yield init;
      yield toolResult(env.CLAUDEX_PROBE_TOKEN ?? "");
    };
    let token = "";
    const spy: QueryFn = async function* (params) {
      token = (params.options.env as Record<string, string>).CLAUDEX_PROBE_TOKEN ?? "";
      yield* query(params);
    };
    const observation = await runCase(spy, caseOf("Sec"), settings);
    const md = formatMarkdown(
      [{ id: "Sec", gate: "control", observations: [observation], verdict: { status: "pass", reasons: [] } }],
      { sdkVersion: "1", claudeCodeVersion: null, model: "m", folder: "f" },
    );
    expect(token).not.toBe("");
    expect(md).not.toContain(token);
    expect(md).toContain("- secret seen: yes");
  });
});

const bashUse = (input: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input }] },
});

describe("runCase — what Bash was asked", () => {
  it("marks the probe seen when a Bash command contains the case's target, and stores no command text", async () => {
    const query: QueryFn = async function* (params) {
      const secretPath = pathsIn(params.prompt).find((p) => p.endsWith("id_claudex_probe")) ?? "";
      yield init;
      yield bashUse({ command: `cat ${secretPath}` });
    };
    const observation = await runCase(query, caseOf("Sr"), settings);
    expect(observation.bashProbed).toBe(true);
    expect(JSON.stringify(observation)).not.toContain("id_claudex_probe");
  });

  it("does not mark the probe for another Bash command, a non-Bash tool or no command", async () => {
    const query: QueryFn = async function* () {
      yield init;
      yield bashUse({ command: "ls" });
      yield bashUse({});
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: { command: "id_claudex_probe" } }] } };
    };
    expect((await runCase(query, caseOf("Sr"), settings)).bashProbed).toBe(false);
  });

  it("uses the target of each case: the variable name for Se, the marker name for S", async () => {
    const se = await runCase(async function* () { yield init; yield bashUse({ command: 'echo "V=[$CLAUDEX_PROBE_TOKEN]"' }); }, caseOf("Se"), settings);
    expect(se.bashProbed).toBe(true);
    const s = await runCase(async function* () { yield init; yield bashUse({ command: "touch /x/PWNED.txt" }); }, caseOf("S"), settings);
    expect(s.bashProbed).toBe(true);
  });

  it("records whether dangerouslyDisableSandbox: true was ever sent, only a real true counting", async () => {
    const sent = await runCase(async function* () { yield init; yield bashUse({ command: "touch PWNED.txt", dangerouslyDisableSandbox: true }); }, caseOf("Sd"), settings);
    expect(sent.disableSandboxSent).toBe(true);
    const no = await runCase(async function* () { yield init; yield bashUse({ command: "touch PWNED.txt" }); yield bashUse({ dangerouslyDisableSandbox: "true" }); }, caseOf("Sd"), settings);
    expect(no.disableSandboxSent).toBe(false);
  });

  it("leaves both unset outside the sandbox cases", async () => {
    const e = ALL_CASES.find((c) => c.id === "E") as VerificationCase;
    const observation = await runCase(async function* () { yield init; yield bashUse({ command: "x", dangerouslyDisableSandbox: true }); }, e, settings);
    expect(observation.bashProbed).toBeUndefined();
    expect(observation.disableSandboxSent).toBeUndefined();
  });
});

describe("runCase — sandbox cases in a trusted folder", () => {
  let root: string;
  let dir: string;
  let trusted: RunSettings;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "claudex-sandbox-trusted-")));
    dir = join(root, "trusted");
    mkdirSync(dir);
    const configFile = join(root, "claude.json");
    writeFileSync(configFile, JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
    trusted = { ...settings, trusted: { dir, configFile } };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("removes the markers an uncontained run wrote, keeps the fake home out of the folder and leaves it empty", async () => {
    let outsideDir = "";
    const query: QueryFn = async function* (params) {
      const paths = pathsIn(params.prompt).filter((p) => p.endsWith("PWNED.txt"));
      for (const path of paths) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "pwned");
      }
      outsideDir = dirname(paths[3] ?? "");
      yield init;
    };

    const observation = await runCase(query, caseOf("Sc"), trusted);

    expect(observation.extraMarkersWritten).toEqual(["sub", ".git", "outside"]);
    expect(readdirSync(dir)).toEqual([]);
    expect(outsideDir.startsWith(dir)).toBe(false);
    expect(existsSync(dirname(outsideDir))).toBe(false);
  });
});

function lstatIsSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
