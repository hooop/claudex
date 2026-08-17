export type AgentId = "claude" | "codex";

/** Occupancy of an agent's current conversation context after its latest model call. */
export interface AgentContextUsage {
  usedTokens: number;
  contextWindow: number;
}

export type Phase = "debate" | "implementation" | "ended";

/**
 * Optional cap the human puts on the autonomous agent-to-agent chain.
 *
 * Absence means unbounded: Claudex only runs attached to a TTY with an
 * always-live pause key, so supervision is structural and a mandatory budget
 * would bound a risk that cannot occur. A policy is what you set when you plan
 * to walk away from the terminal.
 */
export type AutonomyBudget =
  | { kind: "automatic-starts"; maximum: number }
  | { kind: "wall-time"; maximumMs: number }
  | { kind: "unbounded" };

export type SuspensionReason =
  | "manual"
  | "waiting-human"
  | "autonomy-exhausted"
  | "failed"
  | "protocol-error"
  | "cancelled";

export type SessionLifecycle = "open" | "closing" | "shutdown-failed" | "closed";

export type AgentActivityStatus = "running" | "success" | "failure";

/**
 * Ephemeral information about what an agent is doing right now.
 *
 * Activities belong to the bounded Ink footer, never to the permanent
 * transcript. In particular, command output is deliberately absent: the UI
 * only needs a compact indication that work is happening.
 */
export type AgentActivity =
  | { kind: "waiting"; status: "running" }
  | { kind: "responding"; status: "running" }
  | {
      kind: "command";
      status: AgentActivityStatus;
      label: string;
      activeCount?: number;
      durationMs?: number;
      exitCode?: number | null;
    }
  | {
      kind: "tool";
      status: AgentActivityStatus;
      label: string;
      activeCount?: number;
      durationMs?: number;
      exitCode?: number | null;
    };

export type TranscriptKind =
  | "message"
  | "intervention"
  | "system"
  | "permission"
  | "summary"
  | "error";

export interface TranscriptEntry {
  id: string;
  from: AgentId | "human" | "system";
  to?: AgentId | "both";
  kind: TranscriptKind;
  text: string;
  timestamp: number;
}

export interface PermissionRequest {
  id: string;
  agent: AgentId;
  toolName: string;
  input: unknown;
}

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message?: string };

export const CONSENSUS_MARKER = "<<CONSENSUS>>";
export const CONTINUE_MARKER = "<<CONTINUE>>";
export const NO_TOPIC_MARKER = "<<NO_TOPIC>>";
export const WAIT_HUMAN_MARKER = "<<WAIT_HUMAN>>";
