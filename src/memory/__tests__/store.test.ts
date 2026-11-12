import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initMemoryScaffold,
  rememberAutonomyBudget,
  saveHandoff,
  saveTrace,
  saveTranscript,
  sessionTitle,
} from "../store.js";

describe("saveHandoff", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "claudex-store-test-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(cwd, { recursive: true, force: true });
  });

  it("rejects an empty or whitespace-only summary", async () => {
    await expect(saveHandoff(cwd, "Topic", "")).rejects.toThrow();
    await expect(saveHandoff(cwd, "Topic", "   \n  ")).rejects.toThrow();
  });

  it("writes a self-contained file with the required sections", async () => {
    const relPath = await saveHandoff(cwd, "Test topic", "- rule A\n- rule B");
    expect(relPath).toMatch(/^\.claudex[/\\]memory[/\\]handoffs[/\\].+\.md$/);

    const content = await readFile(path.join(cwd, relPath), "utf8");
    expect(content).toContain("# Test topic");
    expect(content).toContain("## Project memory");
    expect(content).toContain("## Agreed specification");
    expect(content).toContain("## Execution instructions");
    expect(content).toContain("- rule A");
    expect(content).toContain("- rule B");
  });

  it("logs the generated path in devlog.md", async () => {
    const relPath = await saveHandoff(cwd, "Topic", "- rule");
    const devlog = await readFile(path.join(cwd, ".claudex/memory/devlog.md"), "utf8");
    expect(devlog).toContain(relPath);
  });

  it("suffixes the filename on timestamp collision instead of overwriting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));

    const first = await saveHandoff(cwd, "Topic", "- rule 1");
    const second = await saveHandoff(cwd, "Topic", "- rule 2");

    expect(first).not.toBe(second);
    expect(second).toMatch(/-2\.md$/);

    const firstContent = await readFile(path.join(cwd, first), "utf8");
    const secondContent = await readFile(path.join(cwd, second), "utf8");
    expect(firstContent).toContain("- rule 1");
    expect(secondContent).toContain("- rule 2");
  });
});

describe("initMemoryScaffold", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "claudex-store-test-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /**
   * Claudex records debates inside the repository it is pointed at, which may
   * well belong to the user's employer. Without this file the first `git add .`
   * commits a full transcript of an internal discussion.
   */
  /** Patterns only — a commented mention must never count as a rule. */
  const rulesOf = (ignore: string) =>
    ignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

  it("excludes everything by default, including files future versions may add", async () => {
    const { created } = await initMemoryScaffold(cwd);
    expect(created).toContain(".claudex/.gitignore");

    const rules = rulesOf(await readFile(path.join(cwd, ".claudex/.gitignore"), "utf8"));
    expect(rules).toContain("*");
    // Nothing re-admits a transcript, a handoff, the devlog or local state.
    expect(rules.filter((r) => r.startsWith("!"))).toEqual([
      "!.gitignore",
      "!memory/",
      "!memory/decisions.md",
      "!memory/limits.md",
    ]);
  });

  it("leaves curated memory shareable, since the debate rules point at it", async () => {
    await initMemoryScaffold(cwd);
    const rules = rulesOf(await readFile(path.join(cwd, ".claudex/.gitignore"), "utf8"));

    expect(rules).toContain("!memory/decisions.md");
    expect(rules).toContain("!memory/limits.md");
  });

  it("never overwrites a policy the user has already adjusted", async () => {
    await initMemoryScaffold(cwd);
    const ignorePath = path.join(cwd, ".claudex/.gitignore");
    await writeFile(ignorePath, "memory/\n", "utf8");

    const { created } = await initMemoryScaffold(cwd);
    expect(created).not.toContain(".claudex/.gitignore");
    expect(await readFile(ignorePath, "utf8")).toBe("memory/\n");
  });
});

describe("transcript snapshots and project policy", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "claudex-store-test-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(cwd, { recursive: true, force: true });
  });

  it("labels /save output as a partial point-in-time snapshot", async () => {
    const relPath = await saveTranscript(
      cwd,
      "Topic",
      [{ id: "1", from: "human", kind: "intervention", text: "Text", timestamp: 1 }],
      { completeness: "partial" },
    );
    const content = await readFile(path.join(cwd, relPath), "utf8");

    expect(content).toContain("Partial snapshot captured");
    expect(content).toContain("is not a session close");
  });

  it("does not overwrite transcript files on a same-millisecond collision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T20:00:00.000Z"));
    const entries = [{ id: "1", from: "system" as const, kind: "system" as const, text: "A", timestamp: 1 }];

    const first = await saveTranscript(cwd, "Topic", entries);
    const second = await saveTranscript(cwd, "Topic", entries);

    expect(second).not.toBe(first);
    expect(second).toMatch(/-2\.md$/);
  });

  it("serializes concurrent state updates so the last autonomy policy wins", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        rememberAutonomyBudget(cwd, { kind: "automatic-starts", maximum: index + 1 }),
      ),
    );

    const state = JSON.parse(
      await readFile(path.join(cwd, ".claudex/memory/.state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(state).toEqual({
      autonomyBudget: { kind: "automatic-starts", maximum: 20 },
    });
  });
});

describe("sessionTitle", () => {
  it("leaves a short topic intact", () => {
    expect(sessionTitle("  Scheduler review  ")).toBe("Scheduler review");
  });

  it("collapses a prompt to one line", () => {
    expect(sessionTitle("First angle\n\n  then the second")).toBe("First angle then the second");
  });

  // The devlog is an index of sessions: copying an audit prompt of several
  // thousand words into it made it grow without bound.
  it("truncates a long prompt and flags the cut", () => {
    const title = sessionTitle("word ".repeat(200));
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
  });
});

// CLAUDE.md and AGENTS.md belong to the user: anything Claudex wrote there
// would be read by every Claude Code or Codex session opened in the repository
// afterwards, debate or not. Memory goes through the debate rules.
describe("the user's instruction files", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "claudex-store-test-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("creates none on first launch", async () => {
    const { created } = await initMemoryScaffold(cwd);

    expect(existsSync(path.join(cwd, "CLAUDE.md"))).toBe(false);
    expect(existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
    expect(created.filter((file) => /CLAUDE\.md|AGENTS\.md/u.test(file))).toEqual([]);
  });

  it("leaves existing ones untouched, launch after launch", async () => {
    const claudeMd = "# My rules\n\nNo memory here.\n";
    const agentsMd = "# Agents\n";
    await writeFile(path.join(cwd, "CLAUDE.md"), claudeMd, "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), agentsMd, "utf8");

    await initMemoryScaffold(cwd);
    await initMemoryScaffold(cwd);

    expect(await readFile(path.join(cwd, "CLAUDE.md"), "utf8")).toBe(claudeMd);
    expect(await readFile(path.join(cwd, "AGENTS.md"), "utf8")).toBe(agentsMd);
  });
});

describe("saveTrace", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "claudex-store-test-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const transcriptPath = ".claudex/memory/transcripts/2026-01-01-topic.md";

  it("writes the trace next to the transcript", async () => {
    const rel = await saveTrace(cwd, transcriptPath, [
      { agent: "codex", timestamp: Date.UTC(2026, 0, 1), event: { kind: "note", text: "Looking at the parser" } },
    ]);

    expect(rel).toBe(".claudex/memory/transcripts/2026-01-01-topic.trace.md");
    const content = await readFile(path.join(cwd, rel ?? ""), "utf8");
    expect(content).toContain("# Diagnostic trace");
    expect(content).toContain("2026-01-01-topic.md");
    expect(content).toContain("2026-01-01T00:00:00.000Z · CODEX · note");
    expect(content).toContain("Looking at the parser");
  });

  it("writes nothing for an empty trace", async () => {
    expect(await saveTrace(cwd, transcriptPath, [])).toBeNull();
    expect(existsSync(path.join(cwd, ".claudex/memory/transcripts/2026-01-01-topic.trace.md"))).toBe(false);
  });

  it("fences an output containing backticks", async () => {
    const rel = await saveTrace(cwd, transcriptPath, [
      { agent: "claude", timestamp: 0, event: { kind: "tool", label: "Bash ls", status: "success", output: "a\n```\nb" } },
    ]);
    const content = await readFile(path.join(cwd, rel ?? ""), "utf8");

    expect(content).toContain("````\na\n```\nb\n````");
  });

  it("fences an output with a very large number of backtick runs", async () => {
    const output = "`a".repeat(500_000) + "````";
    const rel = await saveTrace(cwd, transcriptPath, [
      { agent: "claude", timestamp: 0, event: { kind: "tool", label: "Bash cat", status: "success", output } },
    ]);
    const content = await readFile(path.join(cwd, rel ?? ""), "utf8");

    expect(content).toContain(`\`\`\`\`\`\n${output}\n\`\`\`\`\``);
  });

  it("marks a failed tool with its exit code", async () => {
    const rel = await saveTrace(cwd, transcriptPath, [
      { agent: "codex", timestamp: 0, event: { kind: "tool", label: "npm test", status: "failure", exitCode: 2 } },
    ]);
    const content = await readFile(path.join(cwd, rel ?? ""), "utf8");

    expect(content).toContain("tool [x] npm test (exit 2)");
  });

  it("flattens a multi-line label to one heading line", async () => {
    const rel = await saveTrace(cwd, transcriptPath, [
      { agent: "codex", timestamp: 0, event: { kind: "tool", label: "echo a\n# injected", status: "success" } },
    ]);
    const content = await readFile(path.join(cwd, rel ?? ""), "utf8");

    expect(content).toContain("tool [ok] echo a # injected");
    expect(content).not.toContain("\n# injected");
  });

  it("refuses to overwrite an existing trace", async () => {
    const records = [{ agent: "codex" as const, timestamp: 0, event: { kind: "note" as const, text: "x" } }];
    await saveTrace(cwd, transcriptPath, records);

    await expect(saveTrace(cwd, transcriptPath, records)).rejects.toThrow(/EEXIST/);
  });
});
