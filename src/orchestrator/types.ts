/**
 * Architecture C — Types for the delivery queue and scheduler.
 * See .claudex/memory/decisions.md for the full rationale.
 */

import type {
  AgentActivity,
  AgentId,
  PermissionRequest,
  Phase,
  SessionLifecycle,
  SuspensionReason,
  TranscriptEntry,
} from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent result contract (success | error | cancelled)
// ─────────────────────────────────────────────────────────────────────────────

export type AgentResultSuccess = {
  kind: "success";
  text: string;
  resolvedModel?: string;
};

export type AgentResultError = {
  kind: "error";
  message: string;
  /** Partial text received before the error, for transcript/diagnostic only. */
  partialText?: string;
};

export type AgentResultCancelled = {
  kind: "cancelled";
  /** Partial text received before cancellation, for transcript/diagnostic only. */
  partialText?: string;
};

export type AgentResult = AgentResultSuccess | AgentResultError | AgentResultCancelled;

// ─────────────────────────────────────────────────────────────────────────────
// Delivery structures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single delivery block — the atomic unit of content delivered to an agent.
 * The recipient is determined by which queue contains the block, not a field.
 */
export interface DeliveryBlock {
  id: string;
  seq: number;
  kind: "topic" | "intervention" | "agent";
  source: AgentId | "human";
  text: string;
  epoch: number;
}

/**
 * A job representing a pending delivery to a single agent.
 * Immutable snapshot once created — blocks are never mutated after job creation.
 */
export interface DeliveryJob {
  id: string;
  agent: AgentId;
  /** Immutable snapshot of blocks to deliver. */
  blocks: readonly DeliveryBlock[];
  epoch: number;
  origin: "initial" | "automatic" | "intervention";
  /** Links jobs from the same intervention batch. */
  batchId?: string;
  /** Order within a batch (0 = first). */
  order: number;
  /** Should the session pause after this batch completes? */
  pauseAfterBatch: boolean;
  status: "pending" | "inFlight" | "failed";
  attempts: number;
  error?: string;
  /** Clean response text after a successful run — read by batch completion to re-chain the debate. */
  resultText?: string;
  resultSignal?: Signal;
  /** Exact payload retained for deterministic retry of this immutable job. */
  message?: string;
  /** Revision of the provisional subject validated by an initial turn. */
  provisionalRevision?: number;
  /** Prevents a retry from consuming the same autonomy unit twice. */
  autonomyReserved?: boolean;
}

/**
 * A retentable synthesis job.
 */
export interface SynthesisJob {
  id: string;
  agent: AgentId;
  epoch: number;
  status: "pending" | "inFlight" | "failed";
  attempts: number;
  error?: string;
}

/**
 * Outcome of executing a single job — exhaustively handled by the drain.
 */
export type JobOutcome =
  | "continue" // Job succeeded, proceed to next eligible work
  | "stop" // Job succeeded, but session should pause (end of intervention batch)
  | "failed" // Job failed, remains in queue for retry
  | "cancelled" // Human cancellation; retry remains possible
  | "protocol-error" // Response is visible but cannot drive the state machine
  | "wait-human" // Agent explicitly needs clarification
  | "topic-rejected" // The provisional input was not a debate topic
  | "terminal"; // Consensus reached, trigger synthesis

// ─────────────────────────────────────────────────────────────────────────────
// Intervention batch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A batch groups jobs created from a single human intervention.
 * For target="both", contains two jobs executed sequentially.
 */
export interface InterventionBatch {
  id: string;
  jobs: DeliveryJob[];
  /** Epoch at which this batch was created. */
  epoch: number;
  /** Jobs completed so far (by id). Never replayed on resume. */
  completedJobIds: Set<string>;
  /** At least one immutable job asked the human to clarify before continuing. */
  waitingHuman: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending intervention (append-only producer side)
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingIntervention {
  id: string;
  text: string;
  target: AgentId | "both";
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consensus signals
// ─────────────────────────────────────────────────────────────────────────────

export type Signal = "continue" | "consensus" | "no-topic" | "wait-human" | null;

/**
 * How a streaming entry ended.
 *
 * `signal` is what lets the renderer drop a protocol marker it was holding back:
 * the scheduler has already run `extractSignal()` on the same text, so the two
 * never have to agree by coincidence. It carries which signal rather than just
 * whether there was one, because the reader is told in words what the agent
 * decided — the marker itself never reaches the transcript.
 */
export type EntryOutcome =
  | { status: "ok"; signal: Signal }
  | { status: "error"; message: string }
  | { status: "cancelled" };

export interface SignalRecord {
  signal: Signal;
  epoch: number;
}

export type ResumeResult =
  | { ok: true }
  | {
      ok: false;
      reason: "already-running" | "cancelling" | "waiting-human" | "session-closed";
    };

export type ShutdownComponent = "drain" | "claude" | "codex";

export type ShutdownResult =
  | { ok: true; transcript: readonly TranscriptEntry[] }
  | { ok: false; lifecycle: "shutdown-failed"; errors: Partial<Record<ShutdownComponent, string>> };

// ─────────────────────────────────────────────────────────────────────────────
// Session events (typed EventEmitter)
// ─────────────────────────────────────────────────────────────────────────────

export type SessionEvents = {
  /** A permanent entry, complete the moment it appears. */
  entry: [entry: TranscriptEntry];
  /** An entry that will be filled in by `output-chunk` deltas. */
  "entry-started": [entry: TranscriptEntry];
  /** The actual delta, not a cumulative snapshot — the renderer appends it as-is. */
  "output-chunk": [entryId: string, delta: string];
  "entry-completed": [entryId: string, outcome: EntryOutcome];
  /**
   * Cumulative snapshot of a growing entry. Kept for consumers that want the
   * whole text; the append-only renderer uses `output-chunk` instead, since
   * re-deriving a delta from a snapshot is quadratic in the length of the turn.
   */
  "entry-update": [entry: TranscriptEntry];
  "turn-start": [agent: AgentId];
  "turn-end": [agent: AgentId];
  "turn-error": [agent: AgentId, error: unknown];
  /** Ephemeral activity; never persisted as a transcript entry. */
  activity: [agent: AgentId, activity: AgentActivity];
  phase: [phase: Phase];
  "paused-changed": [paused: boolean];
  "suspension-changed": [reason: SuspensionReason | null];
  lifecycle: [lifecycle: SessionLifecycle];
  "topic-accepted": [];
  "topic-rejected": [];
  "permission-request": [request: PermissionRequest];
  "permission-cancelled": [requestId: string];
  "consensus-reached": [];
  "consensus-invalidated": [];
  "synthesis-ready": [summary: string];
};
