import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutonomyBudget } from "../types.js";

export interface ProjectStatus {
  decisionsCount: number;
  lastSession: string | null;
  /** Last model actually used by Claude, formatted — null until a first real turn has happened. */
  claudeDefaultModel: string | null;
  /** Codex's configured default model, read from ~/.codex/config.toml — no API call needed. */
  codexDefaultModel: string | null;
  codexDefaultEffort: string | null;
  autonomyBudget: AutonomyBudget | null;
}

/** "claude-sonnet-5" -> "Sonnet 5", "claude-opus-4-7" -> "Opus 4.7", drops trailing snapshot dates. */
function formatClaudeModel(id: string): string {
  const noDate = id.replace(/-\d{8}$/, "");
  const stripped = noDate.replace(/^claude-/, "");
  const parts = stripped.split("-");
  const family = parts[0];
  if (!family) return id;
  const name = family[0]!.toUpperCase() + family.slice(1);
  const version = parts.slice(1).join(".");
  return version ? `${name} ${version}` : name;
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
  lastKnownModels?: { claude?: string };
  autonomyBudget?: unknown;
} {
  const p = path.join(cwd, ".claudex/memory/.state.json");
  if (!existsSync(p)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const state = parsed as Record<string, unknown>;
    const models =
      typeof state.lastKnownModels === "object" && state.lastKnownModels !== null
        ? (state.lastKnownModels as Record<string, unknown>)
        : {};
    return {
      lastKnownModels: {
        claude: typeof models.claude === "string" ? models.claude : undefined,
      },
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
  if (existsSync(decisionsPath)) {
    const content = readFileSync(decisionsPath, "utf8");
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
  const lastClaude = state.lastKnownModels?.claude ?? null;
  const codexDefault = readCodexDefault();

  return {
    decisionsCount,
    lastSession,
    claudeDefaultModel: lastClaude ? formatClaudeModel(lastClaude) : null,
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
