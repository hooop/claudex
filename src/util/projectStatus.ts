import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutonomyBudget } from "../types.js";

export interface ProjectStatus {
  decisionsCount: number;
  decisionsText: string | null;
  lastSession: string | null;
  /** Explicitly configured Claude model, formatted for display. */
  claudeDefaultModel: string | null;
  /**
   * The same setting, verbatim, to hand to the SDK. The debate no longer loads
   * user settings — they cost far more in system prompt than the one field
   * Claudex actually needs from them — so this preference has to be carried
   * across explicitly rather than resolved by the CLI.
   */
  claudeConfiguredModel: string | null;
  /** Codex's configured default model, read from ~/.codex/config.toml — no API call needed. */
  codexDefaultModel: string | null;
  codexDefaultEffort: string | null;
  autonomyBudget: AutonomyBudget | null;
}

const CLAUDE_ALIAS_LABELS: Record<string, string> = {
  opus: "Opus 5",
  sonnet: "Sonnet 5",
  haiku: "Haiku 4.5",
  fable: "Fable 5",
};

/** "claude-sonnet-5" -> "Sonnet 5", "claude-opus-4-7" -> "Opus 4.7", drops trailing snapshot dates. */
export function formatClaudeModel(id: string): string {
  const alias = CLAUDE_ALIAS_LABELS[id.toLowerCase()];
  if (alias) return alias;
  const noDate = id.replace(/-\d{8}$/, "");
  const stripped = noDate.replace(/^claude-/, "");
  const parts = stripped.split("-");
  const family = parts[0];
  if (!family) return id;
  const name = family[0]!.toUpperCase() + family.slice(1);
  const version = parts.slice(1).join(".");
  return version ? `${name} ${version}` : name;
}

function readClaudeConfiguredModel(cwd: string): string | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  // The SDK loads user settings first, then project and local project settings.
  // Apply the same precedence while reading only the harmless `model` field.
  const settingsPaths = [
    path.join(configDir, "settings.json"),
    path.join(cwd, ".claude/settings.json"),
    path.join(cwd, ".claude/settings.local.json"),
  ];
  let model: string | null = null;
  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) continue;
      const candidate = (parsed as Record<string, unknown>).model;
      if (typeof candidate === "string" && candidate.trim()) {
        const configured = candidate.trim();
        model = configured.toLowerCase() === "default" ? null : configured;
      }
    } catch {
      // A malformed optional settings file must not prevent Claudex from starting.
    }
  }
  return model;
}

function readCodexDefault(): { model: string | null; effort: string | null } {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configPath = path.join(home, "config.toml");
  if (!existsSync(configPath)) return { model: null, effort: null };
  try {
    const content = readFileSync(configPath, "utf8");
    const topLevel = content.split(/\n\[/)[0] ?? ""; // stop before the first [section] to avoid per-project overrides
    const model = topLevel.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    const effort = topLevel.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    return { model, effort };
  } catch {
    return { model: null, effort: null };
  }
}

function readClaudexState(cwd: string): {
  autonomyBudget?: unknown;
} {
  const p = path.join(cwd, ".claudex/memory/.state.json");
  if (!existsSync(p)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const state = parsed as Record<string, unknown>;
    return {
      autonomyBudget: state.autonomyBudget,
    };
  } catch {
    return {};
  }
}

export function getProjectStatus(cwd: string): ProjectStatus {
  const decisionsPath = path.join(cwd, ".claudex/memory/decisions.md");
  const devlogPath = path.join(cwd, ".claudex/memory/devlog.md");

  let decisionsCount = 0;
  let decisionsText: string | null = null;
  if (existsSync(decisionsPath)) {
    const content = readFileSync(decisionsPath, "utf8");
    decisionsText = content;
    decisionsCount = (content.match(/^## /gm) ?? []).length;
  }

  let lastSession: string | null = null;
  if (existsSync(devlogPath)) {
    const content = readFileSync(devlogPath, "utf8");
    const matches = [...content.matchAll(/^### (.+)$/gm)];
    const last = matches.at(-1);
    lastSession = last ? last[1]! : null;
  }

  const state = readClaudexState(cwd);
  const configuredClaude = readClaudeConfiguredModel(cwd);
  const codexDefault = readCodexDefault();

  return {
    decisionsCount,
    decisionsText,
    lastSession,
    claudeDefaultModel: configuredClaude ? formatClaudeModel(configuredClaude) : null,
    claudeConfiguredModel: configuredClaude,
    codexDefaultModel: codexDefault.model,
    codexDefaultEffort: codexDefault.effort,
    autonomyBudget: validAutonomyBudget(state.autonomyBudget) ? state.autonomyBudget : null,
  };
}

function validAutonomyBudget(value: unknown): value is AutonomyBudget {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "unbounded") return true;
  if (candidate.kind !== "automatic-starts" && candidate.kind !== "wall-time") return false;
  const maximum =
    candidate.kind === "automatic-starts" ? candidate.maximum : candidate.maximumMs;
  return typeof maximum === "number" && Number.isSafeInteger(maximum) && maximum > 0;
}
