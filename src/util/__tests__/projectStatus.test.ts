import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatClaudeModel, getProjectStatus } from "../projectStatus.js";

describe("getProjectStatus — modèles affichés au lancement", () => {
  let root: string;
  let claudeConfig: string;
  let codexConfig: string;
  let previousClaudeConfig: string | undefined;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "claudex-status-"));
    claudeConfig = path.join(root, "claude-config");
    codexConfig = path.join(root, "codex-config");
    mkdirSync(claudeConfig, { recursive: true });
    mkdirSync(codexConfig, { recursive: true });
    previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = claudeConfig;
    process.env.CODEX_HOME = codexConfig;
  });

  afterEach(() => {
    if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("respecte les réglages effectifs sans les transformer en sélection explicite", () => {
    writeFileSync(path.join(claudeConfig, "settings.json"), JSON.stringify({ model: "opus" }));
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    writeFileSync(
      path.join(root, ".claude/settings.local.json"),
      JSON.stringify({ model: "sonnet" }),
    );
    writeFileSync(
      path.join(codexConfig, "config.toml"),
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "max"\n',
    );

    const status = getProjectStatus(root);

    expect(status.claudeDefaultModel).toBe("Sonnet 5");
    expect(status.codexDefaultModel).toBe("gpt-5.6-sol");
    expect(status.codexDefaultEffort).toBe("max");
  });

  it("ne présente pas les modèles d'une ancienne session comme encore actifs", () => {
    mkdirSync(path.join(root, ".claudex/memory"), { recursive: true });
    writeFileSync(
      path.join(root, ".claudex/memory/.state.json"),
      JSON.stringify({
        lastKnownModels: {
          claude: "claude-opus-4-5-20251101",
          codex: "gpt-5.5",
        },
      }),
    );

    const status = getProjectStatus(root);

    expect(status.claudeDefaultModel).toBeNull();
    expect(status.codexDefaultModel).toBeNull();
  });

  it("respecte un choix automatique de projet même si l'utilisateur a configuré un modèle", () => {
    writeFileSync(path.join(claudeConfig, "settings.json"), JSON.stringify({ model: "opus" }));
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    writeFileSync(
      path.join(root, ".claude/settings.local.json"),
      JSON.stringify({ model: "default" }),
    );

    expect(getProjectStatus(root).claudeDefaultModel).toBeNull();
  });
});

describe("formatClaudeModel", () => {
  it("partage les libellés du sélecteur et formate les identifiants résolus", () => {
    expect(formatClaudeModel("opus")).toBe("Opus 5");
    expect(formatClaudeModel("claude-sonnet-5-20260801")).toBe("Sonnet 5");
  });
});
