import type { AgentId, AutonomyBudget } from "../types.js";

export type Command =
  | { kind: "intervene"; target: AgentId | "both"; text: string }
  | { kind: "model"; agent: AgentId; model: string }
  | { kind: "implement"; agent?: AgentId; extra?: string }
  | { kind: "handoff" }
  | { kind: "topic" }
  | { kind: "decisions" }
  | { kind: "resume" }
  | { kind: "pause" }
  | { kind: "cancel" }
  | { kind: "accept-topic" }
  | { kind: "autonomy"; budget?: AutonomyBudget; remember: boolean; error?: string }
  | { kind: "decide"; topic: string; approach: string }
  | { kind: "limit"; text: string }
  | { kind: "new"; discard: boolean }
  | { kind: "save" }
  | { kind: "quit"; discard: boolean }
  | { kind: "retry" }
  | { kind: "emergency-exit" }
  | { kind: "help" }
  | { kind: "noop" };

export const DECIDE_USAGE = "Usage : /decide <sujet> | <approche> — les deux parties sont requises.";
export const AUTONOMY_USAGE =
  "Usage : /autonomy unbounded | starts <entier positif> | time <durée avec unité ms|s|m|h> [--remember]";

/**
 * "/decide" writes straight into decisions.md, so a missing half must never
 * reach appendDecision(): it silently appends an empty "## <date> —" entry.
 * Returns the message to show the user, or null when the command is usable.
 */
export function decideUsageError(cmd: Extract<Command, { kind: "decide" }>): string | null {
  return cmd.topic && cmd.approach ? null : DECIDE_USAGE;
}

/**
 * Plain text with no leading "/" is an intervention addressed to both
 * agents by default (matches how the user runs this manually today:
 * everyone always sees everything). "/claude" and "/codex" narrow the
 * target to one agent.
 */
export function parseCommand(raw: string): Command {
  const input = raw.trim();
  if (!input) return { kind: "noop" };

  if (!input.startsWith("/")) {
    return { kind: "intervene", target: "both", text: input };
  }

  const [head, ...rest] = input.slice(1).split(/\s+/);
  const tail = input.slice(1 + (head?.length ?? 0)).trim();

  switch (head) {
    case "claude":
    case "codex":
      return { kind: "intervene", target: head, text: tail };
    case "model": {
      const agent = rest[0];
      const model = rest.slice(1).join(" ");
      if (agent !== "claude" && agent !== "codex") {
        return { kind: "noop" };
      }
      return { kind: "model", agent, model };
    }
    case "implement": {
      const agent = rest[0];
      if (agent === "claude" || agent === "codex") {
        const extra = rest.slice(1).join(" ").trim();
        return { kind: "implement", agent, extra: extra || undefined };
      }
      return { kind: "implement" };
    }
    case "handoff":
      return { kind: "handoff" };
    case "sujet":
      return { kind: "topic" };
    case "decisions":
      return { kind: "decisions" };
    case "resume":
      return { kind: "resume" };
    case "pause":
      return { kind: "pause" };
    case "cancel":
      return { kind: "cancel" };
    case "accept-topic":
      return { kind: "accept-topic" };
    case "autonomy":
      return parseAutonomy(rest);
    case "decide": {
      const [topic, approach] = tail.split("|").map((s) => s.trim());
      return { kind: "decide", topic: topic ?? "", approach: approach ?? "" };
    }
    case "limit":
      return { kind: "limit", text: tail };
    case "new":
      return { kind: "new", discard: rest.includes("--discard") };
    case "save":
      return { kind: "save" };
    case "quit":
    case "exit":
      return { kind: "quit", discard: rest.includes("--discard") };
    case "retry":
      return { kind: "retry" };
    case "emergency-exit":
      return { kind: "emergency-exit" };
    case "help":
    case "?":
      return { kind: "help" };
    default:
      return { kind: "noop" };
  }
}

function parseAutonomy(parts: string[]): Extract<Command, { kind: "autonomy" }> {
  const remember = parts.includes("--remember");
  const args = parts.filter((part) => part !== "--remember");
  const mode = args[0];

  if (mode === "unbounded" && args.length === 1) {
    return { kind: "autonomy", budget: { kind: "unbounded" }, remember };
  }

  if (mode === "starts" && args.length === 2) {
    const maximum = parsePositiveInteger(args[1]);
    return maximum === null
      ? { kind: "autonomy", remember, error: AUTONOMY_USAGE }
      : { kind: "autonomy", budget: { kind: "automatic-starts", maximum }, remember };
  }

  if (mode === "time" && args.length === 2) {
    const maximumMs = parseDuration(args[1]);
    return maximumMs === null
      ? { kind: "autonomy", remember, error: AUTONOMY_USAGE }
      : { kind: "autonomy", budget: { kind: "wall-time", maximumMs }, remember };
  }

  return { kind: "autonomy", remember, error: AUTONOMY_USAGE };
}

function parsePositiveInteger(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d*$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** A duration must carry its unit; Claudex never guesses one. */
export function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = /^([1-9]\d*)(ms|s|m|h)$/u.exec(raw);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const value = amount * factor;
  return Number.isSafeInteger(value) ? value : null;
}
