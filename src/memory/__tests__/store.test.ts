import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initMemoryScaffold,
  rememberAutonomyBudget,
  rememberModel,
  saveHandoff,
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
    await expect(saveHandoff(cwd, "Sujet", "")).rejects.toThrow();
    await expect(saveHandoff(cwd, "Sujet", "   \n  ")).rejects.toThrow();
  });

  it("writes a self-contained file with the required sections", async () => {
    const relPath = await saveHandoff(cwd, "Sujet de test", "- règle A\n- règle B");
    expect(relPath).toMatch(/^\.claudex[/\\]memory[/\\]handoffs[/\\].+\.md$/);

    const content = await readFile(path.join(cwd, relPath), "utf8");
    expect(content).toContain("# Sujet de test");
    expect(content).toContain("## Mémoire projet");
    expect(content).toContain("## Spécification consensuelle");
    expect(content).toContain("## Consigne d'exécution");
    expect(content).toContain("- règle A");
    expect(content).toContain("- règle B");
  });

  it("logs the generated path in devlog.md", async () => {
    const relPath = await saveHandoff(cwd, "Sujet", "- règle");
    const devlog = await readFile(path.join(cwd, ".claudex/memory/devlog.md"), "utf8");
    expect(devlog).toContain(relPath);
  });

  it("suffixes the filename on timestamp collision instead of overwriting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));

    const first = await saveHandoff(cwd, "Sujet", "- règle 1");
    const second = await saveHandoff(cwd, "Sujet", "- règle 2");

    expect(first).not.toBe(second);
    expect(second).toMatch(/-2\.md$/);

    const firstContent = await readFile(path.join(cwd, first), "utf8");
    const secondContent = await readFile(path.join(cwd, second), "utf8");
    expect(firstContent).toContain("- règle 1");
    expect(secondContent).toContain("- règle 2");
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

  it("leaves curated memory shareable, since CLAUDE.md and AGENTS.md point at it", async () => {
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
      "Sujet",
      [{ id: "1", from: "human", kind: "intervention", text: "Texte", timestamp: 1 }],
      { completeness: "partial" },
    );
    const content = await readFile(path.join(cwd, relPath), "utf8");

    expect(content).toContain("Instantané partiel capturé");
    expect(content).toContain("n'est pas une clôture de session");
  });

  it("does not overwrite transcript files on a same-millisecond collision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T20:00:00.000Z"));
    const entries = [{ id: "1", from: "system" as const, kind: "system" as const, text: "A", timestamp: 1 }];

    const first = await saveTranscript(cwd, "Sujet", entries);
    const second = await saveTranscript(cwd, "Sujet", entries);

    expect(second).not.toBe(first);
    expect(second).toMatch(/-2\.md$/);
  });

  it("serializes concurrent state updates so model and autonomy policy both survive", async () => {
    await Promise.all([
      rememberModel(cwd, "claude", "claude-test"),
      rememberAutonomyBudget(cwd, { kind: "automatic-starts", maximum: 4 }),
    ]);

    const state = JSON.parse(
      await readFile(path.join(cwd, ".claudex/memory/.state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(state).toMatchObject({
      lastKnownModels: { claude: "claude-test" },
      autonomyBudget: { kind: "automatic-starts", maximum: 4 },
    });
  });
});

describe("sessionTitle", () => {
  it("laisse un sujet court intact", () => {
    expect(sessionTitle("  Revue du scheduler  ")).toBe("Revue du scheduler");
  });

  it("réduit un prompt à une ligne", () => {
    expect(sessionTitle("Premier axe\n\n  puis le second")).toBe("Premier axe puis le second");
  });

  // Le devlog est lu au démarrage de chaque session : y recopier un prompt
  // d'audit de plusieurs milliers de mots le faisait grossir sans borne.
  it("tronque un long prompt et signale la coupe", () => {
    const title = sessionTitle("mot ".repeat(200));
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("CLAUDE.md généré", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "claudex-store-test-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // `@fichier` recopie le fichier entier dans le prompt système à chaque appel,
  // alors qu'AGENTS.md se contente de nommer les mêmes fichiers à Codex.
  it("nomme la mémoire du projet au lieu de l'importer", async () => {
    await initMemoryScaffold(cwd);
    const claudeMd = await readFile(path.join(cwd, "CLAUDE.md"), "utf8");
    const agentsMd = await readFile(path.join(cwd, "AGENTS.md"), "utf8");

    expect(claudeMd).not.toContain("@.claudex/memory/");
    for (const file of ["decisions.md", "limits.md", "devlog.md"]) {
      expect(claudeMd).toContain(`.claudex/memory/${file}`);
      expect(agentsMd).toContain(`.claudex/memory/${file}`);
    }
  });
});
