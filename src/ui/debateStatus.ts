import type { EntryOutcome, Signal } from "../orchestrator/types.js";
import type { AgentId, Phase, TranscriptEntry } from "../types.js";
import { AGENT_STYLE, CONSENSUS_COLOR, GLYPH, SYSTEM_STYLE } from "./theme.js";

export type AgentStance = "none" | "continues" | "ready" | "asks";
export type Stage = "debate" | "consensus" | "implementation" | "ended";

export interface DebateStatus {
  stance: Record<AgentId, AgentStance>;
  consensus: boolean;
  phase: Phase;
  /** Completed answering turns per agent in the current debate. */
  answered: Record<AgentId, number>;
}

export type StatusEvent =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "completed"; agent: AgentId | "system" | "human"; outcome: EntryOutcome }
  | { kind: "consensus-reached" }
  | { kind: "consensus-invalidated" }
  | { kind: "phase"; phase: Phase };

export const INITIAL_STATUS: DebateStatus = {
  stance: { claude: "none", codex: "none" },
  consensus: false,
  phase: "debate",
  answered: { claude: 0, codex: 0 },
};

const NO_STANCE: Record<AgentId, AgentStance> = { claude: "none", codex: "none" };

function stanceOf(signal: Signal): AgentStance {
  switch (signal) {
    case "continue":
      return "continues";
    case "consensus":
      return "ready";
    case "wait-human":
      return "asks";
    default:
      return "none";
  }
}

export function reduceStatus(status: DebateStatus, event: StatusEvent): DebateStatus {
  switch (event.kind) {
    case "entry":
      return event.entry.kind === "intervention" && event.entry.from === "human"
        ? { ...status, stance: NO_STANCE }
        : status;
    case "completed": {
      const { agent, outcome } = event;
      // Only the two agents hold a stance; system and human entries never do.
      if ((agent !== "claude" && agent !== "codex") || outcome.status !== "ok") return status;
      const answered =
        status.phase === "debate" ? { ...status.answered, [agent]: status.answered[agent] + 1 } : status.answered;
      // An uncounted signal belongs to an older epoch: the turn happened, its stance does not stand.
      const stance = outcome.counted ? { ...status.stance, [agent]: stanceOf(outcome.signal) } : status.stance;
      return { ...status, stance, answered };
    }
    case "consensus-reached":
      return { ...status, consensus: true };
    case "consensus-invalidated":
      return { ...status, consensus: false, stance: NO_STANCE };
    case "phase":
      return { ...status, phase: event.phase };
  }
}

export function stageOf(status: DebateStatus): Stage {
  if (status.phase === "ended" || status.phase === "implementation") return status.phase;
  return status.consensus ? "consensus" : "debate";
}

/** Round label for a turn starting now, or null outside the debate phase. */
export function roundForStart(status: DebateStatus, agent: AgentId): number | null {
  return status.phase === "debate" ? status.answered[agent] + 1 : null;
}

const STANCE_TEXT: Record<AgentStance, string> = {
  none: GLYPH.dot,
  continues: `${GLYPH.next} continues`,
  ready: `${GLYPH.ok} ready`,
  asks: `${GLYPH.ask} asks you`,
};

export function statusLine(status: DebateStatus): { text: string; color: string }[] {
  if (status.consensus) return [{ text: `${GLYPH.ok} Consensus`, color: CONSENSUS_COLOR }];
  const segment = (agent: AgentId) => ({
    text: `${AGENT_STYLE[agent].badge} ${STANCE_TEXT[status.stance[agent]]}`,
    color: AGENT_STYLE[agent].color,
  });
  return [segment("claude"), { text: ` ${GLYPH.dot} `, color: SYSTEM_STYLE.color }, segment("codex")];
}
