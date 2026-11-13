/**
 * Architecture C — Scheduler with delivery queues and single drain.
 *
 * Core invariants:
 * - One drain promise at a time (no concurrent scheduling)
 * - Interventions are append-only; the drain is the sole consumer
 * - Jobs have immutable snapshots; responses never leak into pending snapshots
 * - Consensus requires both signals from the same epoch
 * - Synthesis is retentable and epoch-guarded
 */

import { randomUUID } from "node:crypto";
import type { CodingAgent } from "../agents/types.js";
import { formatToolInput } from "../util/formatToolInput.js";
import type {
  AgentActivity,
  AgentContextUsage,
  AgentId,
  AutonomyBudget,
  PermissionDecision,
  PermissionRequest,
  Phase,
  SessionLifecycle,
  SuspensionReason,
  TraceEvent,
  TraceRecord,
  TranscriptEntry,
} from "../types.js";
import {
  CONSENSUS_MARKER,
  CONTINUE_MARKER,
  NO_TOPIC_MARKER,
  WAIT_HUMAN_MARKER,
} from "../types.js";
import { extractSignal } from "./markers.js";
import { capTraceOutput } from "./trace.js";
import type {
  AgentResult,
  DeliveryBlock,
  DeliveryJob,
  EntryOutcome,
  InterventionBatch,
  JobOutcome,
  PendingIntervention,
  ResumeResult,
  SignalRecord,
  ShutdownResult,
  SynthesisJob,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler
// ─────────────────────────────────────────────────────────────────────────────

export interface SchedulerOptions {
  cwd: string;
  starter: AgentId;
  autonomyBudget?: AutonomyBudget;
}

export interface SchedulerCallbacks {
  /** A permanent entry, complete the moment it appears. */
  onEntry: (entry: TranscriptEntry) => void;
  /** An entry whose text will arrive as deltas. */
  onEntryStarted: (entry: TranscriptEntry) => void;
  /** The delta itself — what the agent just produced, not the text so far. */
  onOutputChunk: (entryId: string, delta: string) => void;
  /** The entry's live body was rewritten (a note removed, or the result differs from the stream). */
  onOutputReset: (entryId: string, text: string) => void;
  onEntryCompleted: (entryId: string, outcome: EntryOutcome) => void;
  onEntryUpdate: (entry: TranscriptEntry) => void;
  onTurnStart: (agent: AgentId) => void;
  onTurnEnd: (agent: AgentId) => void;
  onTurnError: (agent: AgentId, error: unknown) => void;
  onActivity: (agent: AgentId, activity: AgentActivity) => void;
  onContextUsage: (agent: AgentId, usage: AgentContextUsage) => void;
  onPhaseChange: (phase: Phase) => void;
  onPausedChange: (paused: boolean) => void;
  onSuspensionChange: (reason: SuspensionReason | null) => void;
  onLifecycleChange: (lifecycle: SessionLifecycle) => void;
  onTopicAccepted: () => void;
  onPermissionRequest: (request: PermissionRequest) => void;
  onPermissionCancelled: (requestId: string) => void;
  onConsensusReached: () => void;
  onConsensusInvalidated: () => void;
  onSynthesisReady: (summary: string) => void;
}

export class Scheduler {
  // ─────────────────────────────────────────────────────────────────────────
  // Public state
  // ─────────────────────────────────────────────────────────────────────────
  readonly transcript: TranscriptEntry[] = [];
  phase: Phase = "debate";
  // Diagnostic log kept next to the transcript, never delivered to an agent.
  private readonly traceRecords: TraceRecord[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // Consensus and synthesis
  // ─────────────────────────────────────────────────────────────────────────
  private consensusEpoch = 0;
  private consensusReached = false;
  private signals: Record<AgentId, SignalRecord> = {
    claude: { signal: null, epoch: -1 },
    codex: { signal: null, epoch: -1 },
  };
  private pendingSynthesis: SynthesisJob | null = null;
  implementationSummary: string | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Delivery queues (per-agent)
  // ─────────────────────────────────────────────────────────────────────────
  private queues: Record<AgentId, DeliveryJob[]> = { claude: [], codex: [] };
  private globalSeq = 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Intervention batches and barrier
  // ─────────────────────────────────────────────────────────────────────────
  private pendingInterventions: PendingIntervention[] = [];
  private activeBatch: InterventionBatch | null = null;
  private barrierEpoch: number | null = null; // Blocks auto-deliveries newer than this

  // ─────────────────────────────────────────────────────────────────────────
  // Turn state
  // ─────────────────────────────────────────────────────────────────────────
  private expectedNext: AgentId;
  private paused = false;
  private suspensionReason: SuspensionReason | null = null;
  private busy = false;
  private drainPromise: Promise<void> | null = null;
  private drainRecheckRequested = false;
  private instructed: Record<AgentId, boolean> = { claude: false, codex: false };

  // ─────────────────────────────────────────────────────────────────────────
  // Permission queue
  // ─────────────────────────────────────────────────────────────────────────
  private permissionQueue: Array<{
    request: PermissionRequest;
    resolve: (decision: PermissionDecision) => void;
  }> = [];
  private activePermission: PermissionRequest | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Abort controller for current turn
  // ─────────────────────────────────────────────────────────────────────────
  private currentAbort: AbortController | null = null;
  private currentRunToken: symbol | null = null;
  private currentEntry: TranscriptEntry | null = null;
  private currentAgent: AgentId | null = null;
  private cancellationSettling = false;

  // ─────────────────────────────────────────────────────────────────────────
  // Provisional subject and autonomy policy
  // ─────────────────────────────────────────────────────────────────────────
  private topic = "";
  private topicState: "not-started" | "provisional" | "accepted" = "not-started";
  private provisionalRevision = 0;
  private provisionalClarifications: string[] = [];
  private latestProvisionalResponse: { agent: AgentId; text: string } | null = null;
  /** The last qualification found no subject, so the next message replaces it. */
  private provisionalWasNonTopic = false;
  private autonomyBudget: AutonomyBudget | undefined;
  private autonomyStartsUsed = 0;
  private autonomyWindowStartedAt: number | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Quiescent lifecycle
  // ─────────────────────────────────────────────────────────────────────────
  private lifecycle: SessionLifecycle = "open";
  private shutdownPromise: Promise<ShutdownResult> | null = null;
  private stableTranscript: readonly TranscriptEntry[] | null = null;

  constructor(
    private agents: Record<AgentId, CodingAgent>,
    private options: SchedulerOptions,
    private callbacks: SchedulerCallbacks,
  ) {
    this.expectedNext = options.starter;
    this.autonomyBudget = options.autonomyBudget;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start validation of a provisional topic. The first answer is human-driven
   * and therefore does not consume the autonomy budget.
   */
  async start(topic: string): Promise<void> {
    this.assertOpen("start a topic");
    if (this.topicState !== "not-started") {
      throw new Error("This session already has a topic.");
    }

    const trimmed = topic.trim();
    if (!trimmed) return;
    this.topic = trimmed;
    this.topicState = "provisional";
    this.addEntry({ from: "system", kind: "system", text: `Topic: ${trimmed}` });
    this.enqueueProvisionalValidation();
    await this.ensureDraining();
  }

  /**
   * Human intervention — append-only, never blocks or loses messages.
   */
  intervene(text: string, target: AgentId | "both"): boolean {
    if (this.lifecycle !== "open") return false;

    if (this.topicState === "provisional") {
      if (target !== "both") return false;
      this.addEntry({ from: "human", kind: "intervention", text, to: "both" });
      this.incrementEpoch();
      if (this.provisionalWasNonTopic) {
        // The previous entry held no subject at all, so this message is not a
        // clarification of it — it replaces it. Keeping "Hello" as the subject
        // and appending the real one underneath would qualify the wrong text.
        this.topic = text.trim() || this.topic;
        this.provisionalClarifications = [];
        this.provisionalWasNonTopic = false;
      } else {
        this.provisionalClarifications.push(text);
      }
      this.provisionalRevision++;
      this.latestProvisionalResponse = null;
      this.resetAutonomyWindow();
      this.setSuspension(null);

      // A validation which has not started can be replaced immediately. An
      // in-flight one is left immutable and will be classified stale.
      this.removePendingInitialJobs();
      if (!this.busy) this.enqueueProvisionalValidation();
      this.wakeDrain();
      return true;
    }

    // Record intervention in transcript immediately
    this.addEntry({ from: "human", kind: "intervention", text, to: target });

    // Increment consensus epoch immediately — invalidates any in-flight consensus
    this.incrementEpoch();

    // Append to pending interventions (drain will process)
    this.pendingInterventions.push({
      id: randomUUID(),
      text,
      target,
      timestamp: Date.now(),
    });

    this.resetAutonomyWindow();
    this.setSuspension(null);

    // Wake up drain
    this.wakeDrain();
    return true;
  }

  /**
   * Resume after pause.
   */
  resume(): ResumeResult {
    if (this.lifecycle !== "open") return { ok: false, reason: "session-closed" };
    if (!this.paused) return { ok: false, reason: "already-running" };
    if (this.cancellationSettling) {
      return { ok: false, reason: "cancelling" };
    }
    if (this.suspensionReason === "waiting-human") {
      return { ok: false, reason: "waiting-human" };
    }

    this.resetAutonomyWindow();
    this.setSuspension(null);

    // Reset failed synthesis to pending
    if (this.pendingSynthesis?.status === "failed") {
      this.pendingSynthesis.status = "pending";
    }

    // Wake up drain
    this.wakeDrain();
    return { ok: true };
  }

  /**
   * Pause the session — will stop after current turn.
   */
  pause(): void {
    if (this.lifecycle !== "open" || this.suspensionReason === "manual") return;
    this.setSuspension("manual");
  }

  /** Cancel the current turn without terminating or discarding the session. */
  cancel(): boolean {
    if (this.lifecycle !== "open" || !this.currentAbort) return false;
    this.cancellationSettling = true;
    this.setSuspension("cancelled");
    this.currentAbort.abort();
    return true;
  }

  /** Explicitly accepts the provisional topic after a protocol-invalid answer. */
  acceptTopic(): boolean {
    if (
      this.lifecycle !== "open" ||
      this.topicState !== "provisional" ||
      this.busy ||
      !this.latestProvisionalResponse
    ) {
      return false;
    }

    const response = this.latestProvisionalResponse;
    this.acceptProvisionalTopic();
    const next = this.other(response.agent);
    this.enqueueAutomatic(next, response.text);
    this.expectedNext = next;
    this.setSuspension(null);
    this.wakeDrain();
    return true;
  }

  setAutonomyBudget(budget: AutonomyBudget): void {
    this.assertOpen("configure autonomy");
    validateAutonomyBudget(budget);
    this.autonomyBudget = budget;
    this.resetAutonomyWindow();
    if (this.suspensionReason === "autonomy-exhausted") {
      this.setSuspension(null);
      this.wakeDrain();
    }
  }

  autonomyPolicy(): AutonomyBudget | undefined {
    return this.autonomyBudget;
  }

  topicStatus(): "not-started" | "provisional" | "accepted" {
    return this.topicState;
  }

  /**
   * Begin implementation phase.
   */
  beginImplementation(): void {
    this.assertOpen("start the implementation");
    if (this.topicState !== "accepted") {
      throw new Error("The topic must be validated before the implementation can start.");
    }
    if (this.phase === "implementation") return;
    this.phase = "implementation";
    this.addEntry({
      from: "system",
      kind: "system",
      text: "Implementation phase started: both agents have write access. Nothing starts on its own; pick who codes with /claude <instruction> or /codex <instruction>.",
    });
    this.callbacks.onPhaseChange(this.phase);
  }

  /**
   * Records that a handoff file was generated (`/handoff`), for transcript
   * visibility — mirrors how implementation turns already surface as system
   * entries, without touching phase or write access.
   */
  recordHandoffGenerated(path: string): void {
    this.assertOpen("record the handoff");
    this.addEntry({ from: "system", kind: "system", text: `Handoff generated: ${path}` });
  }

  /**
   * Answer a permission request.
   */
  answerPermission(id: string, decision: PermissionDecision): void {
    if (this.activePermission?.id === id) {
      // Find and resolve the active permission
      const idx = this.permissionQueue.findIndex((p) => p.request.id === id);
      if (idx !== -1) {
        const [entry] = this.permissionQueue.splice(idx, 1);
        entry!.resolve(decision);
        this.activePermission = null;

        // Show next permission if any
        this.showNextPermission();
      }
    }
  }

  /**
   * Set the model for an agent.
   */
  setModel(agent: AgentId, model: string): void {
    this.assertOpen("change the model");
    this.agents[agent].setModel(model);
    this.addEntry({ from: "system", kind: "system", text: `${agent} → model: ${model}` });
  }

  /**
   * Get current model for an agent.
   */
  modelOf(agent: AgentId): string {
    return this.agents[agent].currentModel();
  }

  /**
   * Check if busy.
   */
  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Check if paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  suspension(): SuspensionReason | null {
    return this.suspensionReason;
  }

  lifecycleState(): SessionLifecycle {
    return this.lifecycle;
  }

  isCancellationSettling(): boolean {
    return this.cancellationSettling;
  }

  /**
   * Check if consensus was reached.
   */
  isConsensusReached(): boolean {
    return this.consensusReached;
  }

  /** Immutable point-in-time copy; valid for /save even while a turn runs. */
  snapshot(): readonly TranscriptEntry[] {
    return freezeTranscript(this.transcript);
  }

  /** Immutable point-in-time copy of the session trace. */
  trace(): readonly TraceRecord[] {
    return Object.freeze(
      this.traceRecords.map((record) => Object.freeze({ ...record, event: Object.freeze({ ...record.event }) })),
    );
  }

  /**
   * Stop all agents and cancel pending permissions.
   */
  shutdown(): Promise<ShutdownResult> {
    if (this.lifecycle === "closed" && this.stableTranscript) {
      return Promise.resolve({ ok: true, transcript: this.stableTranscript });
    }
    if (this.lifecycle === "closing" && this.shutdownPromise) return this.shutdownPromise;

    this.beginClosing();
    const attempt = this.performShutdown();
    this.shutdownPromise = attempt;
    return attempt;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Drain loop
  // ─────────────────────────────────────────────────────────────────────────

  private ensureDraining(): Promise<void> {
    if (this.lifecycle !== "open") return Promise.resolve();
    // Calls made while a drain exists are wake-up requests, not no-ops. The
    // outer loop consumes the flag after drain() returns, including when work
    // was queued synchronously from a termination callback.
    this.drainRecheckRequested = true;
    if (this.drainPromise) return this.drainPromise;

    // Defer the first drain to a microtask so drainPromise is installed before
    // any scheduler callback can re-enter ensureDraining().
    const drainPromise = Promise.resolve().then(async () => {
      try {
        do {
          this.drainRecheckRequested = false;
          await this.drain();
        } while (this.drainRecheckRequested);
      } finally {
        this.drainPromise = null;
      }
    });
    this.drainPromise = drainPromise;
    return drainPromise;
  }

  private wakeDrain(): void {
    this.ensureDraining().then(undefined, (error: unknown) => {
      if (this.lifecycle !== "open") return;
      const message = error instanceof Error ? error.message : String(error);
      this.addEntry({ from: "system", kind: "error", text: `Internal scheduler error: ${message}` });
      this.setSuspension("failed");
    });
  }

  private async drain(): Promise<void> {
    while (true) {
      if (this.lifecycle !== "open") return;
      // Reaching the top means this drain is about to observe every source of
      // executable work. A wake-up received before this point is therefore
      // consumed; only one received after the final observation requires the
      // outer ensureDraining() loop to run again.
      this.drainRecheckRequested = false;

      // Priority 1: New interventions — always processed, even if paused, but
      // never allowed to replace a batch whose immutable jobs are incomplete.
      // Interventions implicitly unpause when their own batch can start.
      if (!this.activeBatch && this.pendingInterventions.length > 0) {
        // Human input opens a new causal/autonomy window.
        this.setSuspension(null);
        this.createBatchFromInterventions();
        continue;
      }

      // Priority 2: Active batch jobs (from intervention)
      if (this.activeBatch) {
        const outcome = await this.processActiveBatch();
        if (this.lifecycle !== "open") return;
        this.cancellationSettling = false;
        if (outcome === "stop") {
          this.setSuspension("manual");
          return;
        }
        if (outcome === "wait-human") {
          this.setSuspension("waiting-human");
          return;
        }
        if (outcome === "protocol-error") {
          this.setSuspension("protocol-error");
          return;
        }
        if (outcome === "cancelled") {
          this.setSuspension("cancelled");
          return;
        }
        if (outcome === "failed") {
          this.setSuspension("failed");
          return;
        }
        // "continue" — loop again
        continue;
      }

      // Priority 3: Pending synthesis still eligible
      if (this.hasPendingSynthesis()) {
        const outcome = await this.runSynthesis();
        if (this.lifecycle !== "open") return;
        this.cancellationSettling = false;
        if (outcome === "stop" || outcome === "failed") {
          this.setSuspension(outcome === "failed" ? "failed" : "manual");
          return;
        }
        if (outcome === "cancelled") {
          this.setSuspension("cancelled");
          return;
        }
        continue;
      }

      // Exit if paused (no intervention, no active batch, no synthesis)
      if (this.paused) {
        return;
      }

      // Priority 4: Failed jobs to retry
      const failedJob = this.findFailedJob();
      if (failedJob) {
        const outcome = await this.runJob(failedJob);
        if (this.lifecycle !== "open") return;
        this.cancellationSettling = false;
        if (outcome === "stop" || outcome === "failed" || outcome === "cancelled") {
          this.setSuspension(outcome === "cancelled" ? "cancelled" : outcome === "failed" ? "failed" : "manual");
          return;
        }
        if (outcome === "protocol-error") {
          this.setSuspension("protocol-error");
          return;
        }
        if (outcome === "wait-human") {
          this.setSuspension("waiting-human");
          return;
        }
        if (outcome === "terminal") {
          // Consensus — trigger synthesis
          continue;
        }
        continue;
      }

      // Priority 5: Automatic deliveries (debate phase only)
      if (this.phase === "debate") {
        const autoJob = this.findEligibleAutoJob();
        if (autoJob) {
          if (!this.canStartJob(autoJob)) return;
          const outcome = await this.runJob(autoJob);
          if (this.lifecycle !== "open") return;
          this.cancellationSettling = false;
          if (outcome === "stop" || outcome === "failed" || outcome === "cancelled") {
            this.setSuspension(outcome === "cancelled" ? "cancelled" : outcome === "failed" ? "failed" : "manual");
            return;
          }
          if (outcome === "protocol-error") {
            this.setSuspension("protocol-error");
            return;
          }
          if (outcome === "wait-human") {
            this.setSuspension("waiting-human");
            return;
          }
            if (outcome === "terminal") {
            // Consensus — trigger synthesis
            continue;
          }
          continue;
        }
      }

      // No work left — re-check to avoid lost wakeups
      if (
        this.pendingInterventions.length === 0 &&
        !this.activeBatch &&
        !this.hasPendingSynthesis() &&
        !this.findFailedJob() &&
        (this.phase !== "debate" || !this.findEligibleAutoJob())
      ) {
        return;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Batch creation
  // ─────────────────────────────────────────────────────────────────────────

  private createBatchFromInterventions(): void {
    // Defensive invariant: pending interventions stay append-only until the
    // current batch has completed; a future caller must not overwrite it.
    if (this.activeBatch) return;

    const intervention = this.pendingInterventions.shift();
    if (!intervention) return;

    const batchId = randomUUID();
    const epoch = this.consensusEpoch;
    const jobs: DeliveryJob[] = [];

    if (intervention.target === "both") {
      // Create jobs for both agents with same cutoff snapshot
      const claudeBlocks = this.createSnapshot("claude", intervention);
      const codexBlocks = this.createSnapshot("codex", intervention);

      // Execute in order: expected next first
      const first = this.expectedNext;
      const second = this.other(first);

      jobs.push(
        this.createJob(first, first === "claude" ? claudeBlocks : codexBlocks, {
          batchId,
          epoch,
          origin: "intervention",
          order: 0,
          pauseAfterBatch: true,
        }),
      );

      jobs.push(
        this.createJob(second, second === "claude" ? claudeBlocks : codexBlocks, {
          batchId,
          epoch,
          origin: "intervention",
          order: 1,
          pauseAfterBatch: true,
        }),
      );
    } else {
      // Single target
      const blocks = this.createSnapshot(intervention.target, intervention);
      jobs.push(
        this.createJob(intervention.target, blocks, {
          batchId,
          epoch,
          origin: "intervention",
          order: 0,
          pauseAfterBatch: true,
        }),
      );
    }

    this.activeBatch = {
      id: batchId,
      jobs,
      epoch,
      completedJobIds: new Set(),
      waitingHuman: false,
    };

    // Set barrier: responses from this batch stay behind for later delivery
    this.barrierEpoch = epoch;
  }

  /**
   * Pull any not-yet-delivered automatic blocks queued for `agent` out of its
   * queue, so a new delivery (intervention snapshot or automatic chain) can
   * fold them in instead of stacking a second turn behind them.
   */
  private drainPendingAutomatic(agent: AgentId): DeliveryBlock[] {
    const blocks: DeliveryBlock[] = [];
    const pending = this.queues[agent].filter((j) => j.status === "pending" && j.origin === "automatic");
    for (const job of pending) {
      blocks.push(...job.blocks);
      this.removeJob(job);
    }
    return blocks;
  }

  private createSnapshot(agent: AgentId, intervention: PendingIntervention): DeliveryBlock[] {
    // Absorb any automatic delivery still waiting for this agent so its content
    // isn't skipped or delivered out of order behind the intervention — e.g. the
    // other agent's message that triggered a human reply must reach this agent
    // together with that reply, not get stranded in the queue.
    const blocks = this.drainPendingAutomatic(agent);

    const seq = this.globalSeq++;
    blocks.push({
      id: randomUUID(),
      seq,
      kind: "intervention",
      source: "human",
      // Stored verbatim; attribution is rendered from `source` when the message
      // is built, so the block keeps exactly what the human typed.
      text: intervention.text,
      epoch: this.consensusEpoch,
    });

    return blocks;
  }

  private createJob(
    agent: AgentId,
    blocks: DeliveryBlock[],
    meta: {
      batchId?: string;
      epoch: number;
      origin: "initial" | "automatic" | "intervention";
      order: number;
      pauseAfterBatch: boolean;
      provisionalRevision?: number;
    },
  ): DeliveryJob {
    return {
      id: randomUUID(),
      agent,
      blocks: Object.freeze([...blocks]),
      epoch: meta.epoch,
      origin: meta.origin,
      batchId: meta.batchId,
      order: meta.order,
      pauseAfterBatch: meta.pauseAfterBatch,
      status: "pending",
      attempts: 0,
      provisionalRevision: meta.provisionalRevision,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Batch processing
  // ─────────────────────────────────────────────────────────────────────────

  private async processActiveBatch(): Promise<JobOutcome> {
    if (!this.activeBatch) return "continue";

    // Find next incomplete job in order
    const nextJob = this.activeBatch.jobs
      .filter((j) => !this.activeBatch!.completedJobIds.has(j.id))
      .sort((a, b) => a.order - b.order)[0];

    if (!nextJob) {
      // Defensive — an empty batch shouldn't normally occur
      return this.finishActiveBatch();
    }

    const outcome = await this.runJob(nextJob);

    if (outcome === "continue" || outcome === "terminal" || outcome === "wait-human") {
      // Mark job as completed — never replay
      this.activeBatch.completedJobIds.add(nextJob.id);
      if (outcome === "wait-human") this.activeBatch.waitingHuman = true;

      // Check if batch is now complete
      const remaining = this.activeBatch.jobs.filter((j) => !this.activeBatch!.completedJobIds.has(j.id));
      if (remaining.length === 0) {
        return this.finishActiveBatch();
      }

      return "continue";
    }

    // Failed/cancelled/protocol-invalid — keep the same immutable job for an
    // explicit retry and preserve the precise suspension reason.
    return outcome;
  }

  /**
   * Clear the batch/barrier and decide whether to pause or resume the debate.
   * In debate phase, the last job's reply re-enters the automatic loop so the
   * conversation keeps going after a human intervention instead of stalling —
   * only non-debate phases (where nothing runs on its own) still pause here.
   */
  private finishActiveBatch(): JobOutcome {
    const waitingHuman = this.activeBatch?.waitingHuman ?? false;
    this.barrierEpoch = null;
    this.activeBatch = null;

    if (waitingHuman) return "wait-human";
    if (this.phase === "debate") return "continue";

    return "stop";
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Job execution
  // ─────────────────────────────────────────────────────────────────────────

  private async runJob(job: DeliveryJob): Promise<JobOutcome> {
    if (this.lifecycle !== "open") return "stop";
    if (!this.reserveAutonomy(job)) return "stop";

    job.status = "inFlight";
    job.attempts++;

    const agent = job.agent;
    const message = this.pendingInstructions(agent) + this.buildJobMessage(job);

    this.busy = true;
    this.currentAbort = new AbortController();
    const runToken = Symbol(`turn:${job.id}`);
    this.currentRunToken = runToken;
    this.currentAgent = agent;
    this.callbacks.onTurnStart(agent);

    // Create transcript entry
    const entry = this.addEntry({ from: agent, kind: "message", text: "" }, { streaming: true });
    this.currentEntry = entry;
    let liveText = "";
    // Only a turn with notes can end with a result that differs from what was
    // streamed for a reason the view must show; without notes it behaves as before.
    let hadNotes = false;
    let lastActivity = "waiting:running";

    const emitActivity = (activity: AgentActivity) => {
      if (!this.isRunLive(runToken)) return;
      const signature = activitySignature(activity);
      if (signature === lastActivity) return;
      lastActivity = signature;
      this.callbacks.onActivity(agent, activity);
    };

    // Notes are separated from the answer only in debate turns; implementation
    // turns keep them in the message, as before (spec D5).
    const onNote =
      this.phase === "debate"
        ? (note: string, streamed: boolean) => {
            if (!this.isRunLive(runToken)) return;
            hadNotes = true;
            const text = note.trim();
            if (text !== "") this.recordTrace(agent, { kind: "note", text });
            // The raw note, paragraph break included, is what was streamed.
            if (streamed && liveText.endsWith(note)) {
              liveText = liveText.slice(0, liveText.length - note.length);
              entry.text = liveText;
              this.callbacks.onOutputReset(entry.id, liveText);
              this.callbacks.onEntryUpdate(entry);
            }
            if (text !== "") emitActivity({ kind: "note", status: "running", label: text });
          }
        : undefined;

    try {
      const result = await this.agents[agent].send(message, {
        cwd: this.options.cwd,
        writeAccess: this.phase === "implementation",
        signal: this.currentAbort.signal,
        onTextDelta: (delta) => {
          if (!this.isRunLive(runToken)) return;
          emitActivity({ kind: "responding", status: "running" });
          liveText += delta;
          entry.text = liveText;
          this.callbacks.onOutputChunk(entry.id, delta);
          this.callbacks.onEntryUpdate(entry);
        },
        onActivity: emitActivity,
        ...(onNote ? { onNote } : {}),
        onTrace: (event) => {
          if (this.isRunLive(runToken)) this.recordTrace(agent, event);
        },
        onContextUsage: (usage) => {
          if (this.isRunLive(runToken)) this.callbacks.onContextUsage(agent, usage);
        },
        onPermissionRequest: (req) =>
          this.isRunLive(runToken)
            ? this.requestPermission(req)
            : Promise.resolve({ behavior: "deny", message: "Session closing" }),
      });

      if (!this.isRunLive(runToken)) return "stop";
      return this.handleJobResult(job, entry, result, hadNotes ? liveText : null);
    } catch (err) {
      if (!this.isRunLive(runToken)) return "stop";
      // Unexpected exception (shouldn't happen with new contract)
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      entry.kind = "error";
      entry.text = `Error: ${job.error}`;
      this.callbacks.onEntryUpdate(entry);
      this.callbacks.onEntryCompleted(entry.id, { status: "error", message: job.error });
      this.callbacks.onTurnError(agent, err);
      return "failed";
    } finally {
      if (this.currentRunToken === runToken) {
        this.busy = false;
        this.currentAbort = null;
        this.currentRunToken = null;
        this.currentEntry = null;
        this.currentAgent = null;
        this.callbacks.onTurnEnd(agent);
      }
    }
  }

  private handleJobResult(
    job: DeliveryJob,
    entry: TranscriptEntry,
    result: AgentResult,
    /** What the live view shows, when the turn had notes; `null` otherwise. */
    noteTrimmedText: string | null,
  ): JobOutcome {
    const agent = job.agent;
    const jobEpoch = job.epoch;

    switch (result.kind) {
      case "success": {
        // Only an answered turn proves the agent read the rules it carried. A
        // failed one may be replaced by a new delivery, which must bring them.
        this.instructed[agent] = true;

        // The adapter's fallback (every segment, when the answer is empty) was
        // not what the live view last showed, so the view starts over from it.
        this.resetOutputIfChanged(entry, noteTrimmedText, result.text);

        // Parse the single shared protocol grammar before changing any causal
        // state. The visible body never includes a recognised marker.
        const { cleanText, signal } = extractSignal(result.text);
        entry.text = cleanText;
        job.resultText = cleanText;
        job.resultSignal = signal;
        this.callbacks.onEntryUpdate(entry);

        // An obsolete validation remains readable but cannot validate an older
        // revision of the subject or start an autonomous chain.
        if (job.origin === "initial" && job.provisionalRevision !== this.provisionalRevision) {
          // Obsolete, so its signal is set aside: it can neither count nor close.
          this.callbacks.onEntryCompleted(entry.id, {
            status: "ok",
            signal,
            counted: false,
            closesDebate: false,
          });
          this.removeJob(job);
          this.enqueueProvisionalValidation();
          return "continue";
        }

        const requiresProtocolMarker =
          this.phase === "debate" && (job.origin === "initial" || job.origin === "automatic");
        if (requiresProtocolMarker && signal === null) {
          const message =
            "Response received without a final protocol marker; no automatic continuation was decided.";
          job.status = "failed";
          job.error = message;
          if (job.origin === "initial") this.latestProvisionalResponse = { agent, text: cleanText };
          this.callbacks.onEntryCompleted(entry.id, { status: "error", message });
          this.callbacks.onTurnError(agent, new Error(message));
          this.addEntry({
            from: "system",
            kind: "error",
            text: `${message} Use /resume to ask again for a valid response${
              job.origin === "initial" ? " or /accept-topic to validate this topic manually" : ""
            }.`,
          });
          return "protocol-error";
        }

        if (signal === "no-topic" && job.origin !== "initial") {
          const message = `${NO_TOPIC_MARKER} is only valid for the initial qualification of the topic.`;
          job.status = "failed";
          job.error = message;
          this.callbacks.onEntryCompleted(entry.id, { status: "error", message });
          this.callbacks.onTurnError(agent, new Error(message));
          return "protocol-error";
        }

        // Whether this agreement is the one that ends the debate, decided here
        // because the renderer has to say so on the turn itself while the real
        // comparison below runs after the entry is already closed. Pure read:
        // this agent's own signal is recorded further down, and the rule
        // matches `checkConsensus` — both agents, same epoch.
        const otherSignal = this.signals[this.other(agent)];
        const closesDebate =
          signal === "consensus" &&
          jobEpoch === this.consensusEpoch &&
          otherSignal.signal === "consensus" &&
          otherSignal.epoch === this.consensusEpoch;
        this.callbacks.onEntryCompleted(entry.id, {
          status: "ok",
          signal,
          counted: jobEpoch === this.consensusEpoch,
          closesDebate,
        });

        // Remove job from queue (success = acquitted)
        this.removeJob(job);

        if (job.origin === "initial") {
          this.latestProvisionalResponse = { agent, text: cleanText };
          if (signal === "no-topic") {
            // Not a debatable subject — but the conversation stays open and on
            // screen. Tearing the session down here used to wipe the answer
            // before it could be read, and nothing about "this isn't a topic"
            // requires closing anything. The session simply waits, exactly as
            // it does for WAIT_HUMAN, and the next message replaces the
            // subject. Nothing reaches project memory until a topic is
            // actually accepted.
            this.provisionalWasNonTopic = true;
            return "wait-human";
          }
          this.provisionalWasNonTopic = false;

          this.acceptProvisionalTopic();
          const next = this.other(agent);
          this.enqueueAutomatic(next, cleanText);
          this.expectedNext = next;

          if (signal === "consensus") {
            this.signals[agent] = { signal, epoch: this.consensusEpoch };
          }
          return signal === "wait-human" ? "wait-human" : "continue";
        }

        // The epoch alone decides whether a signal still counts: a turn answering
        // the latest intervention carries the epoch that intervention created, so
        // two agents agreeing right after a human question really do agree, and
        // any newer input has already invalidated them via incrementEpoch().
        // Requiring `origin === "automatic"` on top of that made consensus
        // unreachable for the whole batch a human triggers — which is every turn
        // of a supervised debate.
        const isConsensusRelevant = jobEpoch === this.consensusEpoch;

        if ((signal === "continue" || signal === "consensus") && isConsensusRelevant) {
          this.signals[agent] = { signal, epoch: this.consensusEpoch };

          // Check for consensus — pass current agent as the last one to confirm
          if (this.checkConsensus(agent)) {
            return "terminal";
          }
        }

        // Responses from an immutable intervention batch are queued behind its
        // barrier, so both parallel answers survive without contaminating the
        // other job's captured snapshot.
        if (
          this.phase === "debate" &&
          (job.origin === "automatic" || job.origin === "intervention")
        ) {
          const next = this.other(agent);
          this.enqueueAutomatic(next, cleanText);
          this.expectedNext = next;
        }

        if (signal === "wait-human") return "wait-human";
        return "continue";
      }

      case "error": {
        job.status = "failed";
        job.error = result.message;

        // Show partial text in transcript if any
        if (result.partialText) {
          entry.text = result.partialText;
          this.resetOutputIfChanged(entry, noteTrimmedText, result.partialText);
        }
        entry.kind = "error";
        entry.text += `\n\nError: ${result.message}`;
        this.callbacks.onEntryUpdate(entry);
        this.callbacks.onEntryCompleted(entry.id, { status: "error", message: result.message });
        this.callbacks.onTurnError(agent, new Error(result.message));

        return "failed";
      }

      case "cancelled": {
        job.status = "failed";
        job.error = "Cancelled";

        if (result.partialText) {
          entry.text = result.partialText;
          this.resetOutputIfChanged(entry, noteTrimmedText, result.partialText);
        }
        entry.kind = "error";
        entry.text += "\n\n(Cancelled)";
        this.callbacks.onEntryUpdate(entry);
        this.callbacks.onEntryCompleted(entry.id, { status: "cancelled" });

        return "cancelled";
      }
    }
  }

  /**
   * After a turn with notes, the live view may no longer match the text the
   * entry keeps (the adapter's fallback, or a partial text): show the latter.
   */
  private resetOutputIfChanged(entry: TranscriptEntry, noteTrimmedText: string | null, text: string): void {
    if (noteTrimmedText !== null && text !== noteTrimmedText) {
      this.callbacks.onOutputReset(entry.id, text);
    }
  }

  private buildJobMessage(job: DeliveryJob): string {
    if (job.message !== undefined) return job.message;
    const agent = job.agent;

    // Every block says who wrote it and who it is for. Without this an agent
    // reads the other one's text with no attribution at all — the debate rules
    // are sent once, on the first answered turn only, so by the tenth round nothing in
    // the message identifies either party, and an agent can start answering as
    // if it were its counterpart. `source` existed for this and was discarded.
    const content = job.blocks.map((b) => blockHeader(b, agent) + b.text).join("\n\n");

    job.message = content;
    return job.message;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Automatic deliveries
  // ─────────────────────────────────────────────────────────────────────────

  private enqueueAutomatic(agent: AgentId, text: string): void {
    // Fold in anything already waiting for this agent instead of stacking a
    // second turn behind it — can happen when a prior delivery was blocked by
    // a barrier and only just got released.
    const blocks = this.drainPendingAutomatic(agent);

    const seq = this.globalSeq++;
    blocks.push({
      id: randomUUID(),
      seq,
      kind: "agent",
      source: this.other(agent),
      text,
      epoch: this.consensusEpoch,
    });

    const job = this.createJob(agent, blocks, {
      epoch: this.consensusEpoch,
      origin: "automatic",
      order: 0,
      pauseAfterBatch: false,
    });

    this.queues[agent].push(job);
  }

  private enqueueProvisionalValidation(): void {
    if (this.topicState !== "provisional" || this.lifecycle !== "open") return;
    const hasCurrentRevision = [...this.queues.claude, ...this.queues.codex].some(
      (job) =>
        job.origin === "initial" &&
        job.provisionalRevision === this.provisionalRevision &&
        (job.status === "pending" || job.status === "inFlight"),
    );
    if (hasCurrentRevision) return;

    const agent = this.options.starter;
    const clarifications = this.provisionalClarifications.length
      ? `\n\nClarifications added by the user:\n${this.provisionalClarifications
          .map((text, index) => `${index + 1}. ${text}`)
          .join("\n")}`
      : "";
    const text = [
      "First qualify the human input below.",
      `Proposed topic:\n${this.topic}${clarifications}`,
      "If it really contains no technical topic to discuss, answer briefly and " +
        "invite the human to give a topic, then end with " +
        NO_TOPIC_MARKER +
        ". If it contains a topic but information from the human is essential before debating, ask the question then end with " +
        WAIT_HUMAN_MARKER +
        ". Otherwise start the analysis and use the appropriate normal marker.",
    ].join("\n\n");
    const block: DeliveryBlock = {
      id: randomUUID(),
      seq: this.globalSeq++,
      kind: "topic",
      source: "human",
      text,
      epoch: this.consensusEpoch,
    };
    const job = this.createJob(agent, [block], {
      epoch: this.consensusEpoch,
      origin: "initial",
      order: 0,
      pauseAfterBatch: false,
      provisionalRevision: this.provisionalRevision,
    });
    this.queues[agent].push(job);
    this.expectedNext = agent;
  }

  private removePendingInitialJobs(): void {
    for (const agent of ["claude", "codex"] as const) {
      this.queues[agent] = this.queues[agent].filter(
        (job) => job.origin !== "initial" || job.status === "inFlight",
      );
    }
  }

  private findEligibleAutoJob(): DeliveryJob | null {
    // Prefer the expected next speaker
    const preferred = this.queues[this.expectedNext].find(
      (j) =>
        j.status === "pending" &&
        (j.origin === "initial" || j.origin === "automatic") &&
        !this.isBlockedByBarrier(j),
    );
    if (preferred) return preferred;

    // Fallback: any pending auto job by global sequence
    const all = [...this.queues.claude, ...this.queues.codex]
      .filter(
        (j) =>
          j.status === "pending" &&
          (j.origin === "initial" || j.origin === "automatic") &&
          !this.isBlockedByBarrier(j),
      )
      .sort((a, b) => {
        const seqA = a.blocks[0]?.seq ?? 0;
        const seqB = b.blocks[0]?.seq ?? 0;
        return seqA - seqB;
      });

    return all[0] ?? null;
  }

  private isBlockedByBarrier(job: DeliveryJob): boolean {
    if (this.barrierEpoch === null) return false;
    // Jobs created during or after the barrier epoch are blocked
    return job.epoch >= this.barrierEpoch && job.origin === "automatic";
  }

  private findFailedJob(): DeliveryJob | null {
    const all = [...this.queues.claude, ...this.queues.codex].filter((j) => j.status === "failed");
    return all[0] ?? null;
  }

  /**
   * An automatic turn needs a budget only when the human asked for one.
   *
   * The risk a mandatory budget would bound is an unsupervised runaway chain —
   * and Claudex has no unsupervised mode: `cli.tsx` refuses to start without a
   * TTY, and Escape pauses the debate on a single keypress that is caught even
   * mid-turn. Requiring a policy up front therefore protects nothing that isn't
   * already structurally guaranteed, while disabling the one behaviour the tool
   * exists for. `/autonomy starts N | time 5m` stays, for a human who wants a
   * hard cap because they intend to walk away.
   */
  private canStartJob(job: DeliveryJob): boolean {
    if (job.origin !== "automatic" || job.autonomyReserved) return true;
    if (!this.autonomyBudget) return true;

    if (this.autonomyBudget.kind === "unbounded") return true;
    if (this.autonomyBudget.kind === "automatic-starts") {
      if (this.autonomyStartsUsed < this.autonomyBudget.maximum) return true;
      this.setSuspension("autonomy-exhausted");
      return false;
    }

    if (this.autonomyWindowStartedAt === null) return true;
    if (Date.now() - this.autonomyWindowStartedAt < this.autonomyBudget.maximumMs) return true;
    this.setSuspension("autonomy-exhausted");
    return false;
  }

  private reserveAutonomy(job: DeliveryJob): boolean {
    if (job.origin !== "automatic" || job.autonomyReserved) return true;
    if (!this.canStartJob(job)) return false;
    job.autonomyReserved = true;
    if (this.autonomyWindowStartedAt === null) this.autonomyWindowStartedAt = Date.now();
    this.autonomyStartsUsed++;
    return true;
  }

  private resetAutonomyWindow(): void {
    this.autonomyStartsUsed = 0;
    this.autonomyWindowStartedAt = null;
    for (const job of [...this.queues.claude, ...this.queues.codex]) {
      if (job.origin === "automatic" && job.status !== "inFlight") job.autonomyReserved = false;
    }
  }

  private removeJob(job: DeliveryJob): void {
    const queue = this.queues[job.agent];
    const idx = queue.indexOf(job);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Consensus
  // ─────────────────────────────────────────────────────────────────────────

  private incrementEpoch(): void {
    this.consensusEpoch++;

    // Invalidate previous signals
    if (this.signals.claude.epoch < this.consensusEpoch) {
      this.signals.claude = { signal: null, epoch: -1 };
    }
    if (this.signals.codex.epoch < this.consensusEpoch) {
      this.signals.codex = { signal: null, epoch: -1 };
    }

    // Invalidate consensus state
    if (this.consensusReached) {
      this.consensusReached = false;
      this.implementationSummary = null;
      this.callbacks.onConsensusInvalidated();
    }

    // Invalidate pending synthesis
    if (this.pendingSynthesis) {
      this.pendingSynthesis = null;
    }
  }

  /** Drop not-yet-started automatic deliveries, in place so `removeJob` stays valid. */
  private discardPendingAutomaticJobs(): void {
    for (const queue of Object.values(this.queues)) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const job = queue[i]!;
        if (job.origin === "automatic" && job.status === "pending") queue.splice(i, 1);
      }
    }
  }

  private checkConsensus(lastAgent: AgentId): boolean {
    const claudeSig = this.signals.claude;
    const codexSig = this.signals.codex;

    // Both must have consensus signal from current epoch
    if (
      claudeSig.signal === "consensus" &&
      claudeSig.epoch === this.consensusEpoch &&
      codexSig.signal === "consensus" &&
      codexSig.epoch === this.consensusEpoch
    ) {
      this.consensusReached = true;
      this.callbacks.onConsensusReached();

      // A reply queued before the agreement (the first agent of a batch answers,
      // which enqueues a turn for the second one, who then agrees) would restart
      // the debate as soon as the synthesis finishes. Consensus supersedes it.
      // Only pending work is dropped: in-flight jobs stay immutable, and a later
      // intervention re-opens the loop through incrementEpoch() as usual.
      this.discardPendingAutomaticJobs();

      // Create synthesis job — assigned to the agent who just confirmed consensus
      this.pendingSynthesis = {
        id: randomUUID(),
        agent: lastAgent,
        epoch: this.consensusEpoch,
        status: "pending",
        attempts: 0,
      };

      return true;
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Synthesis
  // ─────────────────────────────────────────────────────────────────────────

  private hasPendingSynthesis(): boolean {
    return this.pendingSynthesis !== null && this.pendingSynthesis.status !== "failed";
  }

  private async runSynthesis(): Promise<JobOutcome> {
    if (this.lifecycle !== "open") return "stop";
    const synthesis = this.pendingSynthesis;
    if (!synthesis) return "continue";

    // Capture locally for epoch checks
    const capturedSynthesis = synthesis;
    const capturedEpoch = synthesis.epoch;

    synthesis.status = "inFlight";
    synthesis.attempts++;

    const agent = synthesis.agent;

    this.busy = true;
    this.currentAbort = new AbortController();
    const runToken = Symbol(`synthesis:${synthesis.id}`);
    this.currentRunToken = runToken;
    this.currentAgent = agent;
    this.callbacks.onTurnStart(agent);

    const entry = this.addEntry({ from: "system", kind: "summary", text: "" }, { streaming: true });
    this.currentEntry = entry;
    let liveText = "";
    let lastActivity = "waiting:running";

    const emitActivity = (activity: AgentActivity) => {
      if (!this.isRunLive(runToken)) return;
      const signature = activitySignature(activity);
      if (signature === lastActivity) return;
      lastActivity = signature;
      this.callbacks.onActivity(agent, activity);
    };

    try {
      const result = await this.agents[agent].send(SYNTHESIS_PROMPT, {
        cwd: this.options.cwd,
        writeAccess: false, // Synthesis is always read-only
        signal: this.currentAbort.signal,
        onTextDelta: (delta) => {
          if (!this.isRunLive(runToken)) return;
          emitActivity({ kind: "responding", status: "running" });
          liveText += delta;
          entry.text = liveText;
          this.callbacks.onOutputChunk(entry.id, delta);
          this.callbacks.onEntryUpdate(entry);
        },
        onActivity: emitActivity,
        onTrace: (event) => {
          if (this.isRunLive(runToken)) this.recordTrace(agent, event);
        },
        onContextUsage: (usage) => {
          if (this.isRunLive(runToken)) this.callbacks.onContextUsage(agent, usage);
        },
        onPermissionRequest: (req) =>
          this.isRunLive(runToken)
            ? this.requestPermission(req)
            : Promise.resolve({ behavior: "deny", message: "Session closing" }),
      });

      if (!this.isRunLive(runToken)) return "stop";

      // Check if synthesis is still valid after await
      if (this.pendingSynthesis !== capturedSynthesis || capturedEpoch !== this.consensusEpoch) {
        // Invalidated — discard result
        entry.text = "(Synthesis invalidated by a new intervention)";
        this.callbacks.onEntryUpdate(entry);
        this.callbacks.onEntryCompleted(entry.id, { status: "ok", signal: null, counted: true });
        // Already-written output can't be taken back, so say so instead.
        this.addEntry({ from: "system", kind: "system", text: "Synthesis invalidated by a new intervention." });
        return "continue";
      }

      if (result.kind === "success") {
        const summary = result.text.trim();
        entry.text = summary;
        this.callbacks.onEntryUpdate(entry);
        this.callbacks.onEntryCompleted(entry.id, { status: "ok", signal: null, counted: true });

        this.implementationSummary = summary;
        this.pendingSynthesis = null;
        this.callbacks.onSynthesisReady(summary);

        return "stop"; // Pause after synthesis
      } else {
        // Error or cancelled
        synthesis.status = "failed";
        synthesis.error = result.kind === "error" ? result.message : "Cancelled";
        entry.kind = "error";
        entry.text = liveText + `\n\nSynthesis error: ${synthesis.error}`;
        this.callbacks.onEntryUpdate(entry);
        this.callbacks.onEntryCompleted(
          entry.id,
          result.kind === "error"
            ? { status: "error", message: `Synthesis: ${result.message}` }
            : { status: "cancelled" },
        );
        return result.kind === "cancelled" ? "cancelled" : "failed";
      }
    } catch (err) {
      if (!this.isRunLive(runToken)) return "stop";
      synthesis.status = "failed";
      synthesis.error = err instanceof Error ? err.message : String(err);
      entry.kind = "error";
      entry.text = `Synthesis error: ${synthesis.error}`;
      this.callbacks.onEntryUpdate(entry);
      this.callbacks.onEntryCompleted(entry.id, { status: "error", message: `Synthesis: ${synthesis.error}` });
      return "failed";
    } finally {
      if (this.currentRunToken === runToken) {
        this.busy = false;
        this.currentAbort = null;
        this.currentRunToken = null;
        this.currentEntry = null;
        this.currentAgent = null;
        this.callbacks.onTurnEnd(agent);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Permissions
  // ─────────────────────────────────────────────────────────────────────────

  private requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      this.permissionQueue.push({ request: req, resolve });

      // Add to transcript
      const preview = formatToolInput(req.input);
      this.addEntry({
        from: req.agent,
        kind: "permission",
        text: `Permission request: ${req.toolName}${preview ? ` — ${preview}` : ""}`,
      });

      // Show if this is the first in queue
      if (!this.activePermission) {
        this.showNextPermission();
      }
    });
  }

  private showNextPermission(): void {
    const next = this.permissionQueue[0];
    if (next) {
      this.activePermission = next.request;
      this.callbacks.onPermissionRequest(next.request);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private acceptProvisionalTopic(): void {
    if (this.topicState !== "provisional") return;
    this.topicState = "accepted";
    this.removePendingInitialJobs();
    this.callbacks.onTopicAccepted();
  }

  private setSuspension(reason: SuspensionReason | null): void {
    if (this.suspensionReason === reason) return;
    const wasPaused = this.paused;
    this.suspensionReason = reason;
    this.paused = reason !== null;
    this.callbacks.onSuspensionChange(reason);
    if (wasPaused !== this.paused) this.callbacks.onPausedChange(this.paused);
  }

  private recordTrace(agent: AgentId, event: TraceEvent): void {
    const recorded =
      event.kind === "tool" && event.output !== undefined
        ? { ...event, output: capTraceOutput(event.output) }
        : event;
    this.traceRecords.push({ agent, timestamp: Date.now(), event: recorded });
  }

  private isRunLive(token: symbol): boolean {
    return this.lifecycle === "open" && this.currentRunToken === token;
  }

  private assertOpen(action: string): void {
    if (this.lifecycle !== "open") {
      throw new Error(`Cannot ${action}: the session is ${this.lifecycle}.`);
    }
  }

  private beginClosing(): void {
    this.lifecycle = "closing";
    this.callbacks.onLifecycleChange(this.lifecycle);

    this.currentAbort?.abort();

    // Freeze the visible partial turn synchronously. The run token is then
    // invalidated, so a late SDK callback cannot mutate the stable snapshot.
    if (this.currentEntry && this.currentRunToken) {
      this.currentEntry.kind = "error";
      this.currentEntry.text = this.currentEntry.text
        ? `${this.currentEntry.text}\n\n(Interrupted by the session closing)`
        : "(Interrupted by the session closing)";
      this.callbacks.onEntryUpdate(this.currentEntry);
      this.callbacks.onEntryCompleted(this.currentEntry.id, { status: "cancelled" });
      if (this.currentAgent) this.callbacks.onTurnEnd(this.currentAgent);
    }
    this.currentRunToken = null;
    this.currentEntry = null;
    this.currentAgent = null;
    this.currentAbort = null;
    this.busy = false;
    this.cancellationSettling = false;

    for (const { request, resolve } of this.permissionQueue) {
      resolve({ behavior: "deny", message: "Session ended" });
      this.callbacks.onPermissionCancelled(request.id);
    }
    this.permissionQueue = [];
    this.activePermission = null;
  }

  private async performShutdown(): Promise<ShutdownResult> {
    const drain = this.drainPromise ?? Promise.resolve();
    const results = await Promise.allSettled([
      drain,
      Promise.resolve().then(() => this.agents.claude.stop()),
      Promise.resolve().then(() => this.agents.codex.stop()),
    ]);
    const names = ["drain", "claude", "codex"] as const;
    const errors: Partial<Record<(typeof names)[number], string>> = {};
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const reason: unknown = result.reason;
        errors[names[index]!] = reason instanceof Error ? reason.message : String(reason);
      }
    });

    if (Object.keys(errors).length > 0) {
      this.lifecycle = "shutdown-failed";
      this.callbacks.onLifecycleChange(this.lifecycle);
      this.shutdownPromise = null;
      return { ok: false, lifecycle: "shutdown-failed", errors };
    }

    this.stableTranscript = freezeTranscript(this.transcript);
    this.lifecycle = "closed";
    this.phase = "ended";
    this.callbacks.onPhaseChange(this.phase);
    this.callbacks.onLifecycleChange(this.lifecycle);
    return { ok: true, transcript: this.stableTranscript };
  }

  private other(agent: AgentId): AgentId {
    return agent === "claude" ? "codex" : "claude";
  }

  /**
   * `streaming` entries are announced rather than delivered: their text arrives
   * afterwards as deltas, so the renderer can print the header now and append the
   * body as it comes instead of redrawing a growing block.
   */
  private addEntry(
    entry: Omit<TranscriptEntry, "id" | "timestamp">,
    options: { streaming?: boolean } = {},
  ): TranscriptEntry {
    const full: TranscriptEntry = { ...entry, id: randomUUID(), timestamp: Date.now() };
    this.transcript.push(full);
    if (options.streaming) this.callbacks.onEntryStarted(full);
    else this.callbacks.onEntry(full);
    return full;
  }

  /**
   * The debate rules, until the agent has answered a turn that carried them.
   * Decided at send time rather than stored in the job, so whichever delivery
   * reaches the agent first brings them, and a retry drops them only once
   * another delivery has been answered.
   */
  private pendingInstructions(agent: AgentId): string {
    if (this.instructed[agent]) return "";
    return `${CONSENSUS_INSTRUCTIONS(AGENT_NAME[agent], AGENT_NAME[this.other(agent)])}\n\n`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants and helpers
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_NAME: Record<AgentId, string> = { claude: "Claude", codex: "Codex" };

/**
 * Directional attribution for one delivered block.
 *
 * Naming both parties on every block is what keeps an agent oriented across a
 * long debate, at the cost of one short line. The topic block is exempt: it is
 * the framing instruction handed to the first agent, not something said to it
 * by someone else.
 */
function blockHeader(block: DeliveryBlock, recipient: AgentId): string {
  if (block.kind === "topic") return "";
  const from = block.source === "human" ? "User" : AGENT_NAME[block.source];
  return `[${from} → ${AGENT_NAME[recipient]}]\n`;
}

function activitySignature(activity: AgentActivity): string {
  if (activity.kind === "waiting" || activity.kind === "responding") {
    return `${activity.kind}:${activity.status}`;
  }
  if (activity.kind === "note") return `note:${activity.status}:${activity.label}`;
  return [
    activity.kind,
    activity.status,
    activity.label,
    activity.activeCount ?? "",
    activity.durationMs ?? "",
    activity.exitCode ?? "",
  ].join(":");
}

/**
 * No agent is named in the rules except as `self` and `other`.
 *
 * The evidence rule used to say that Claude cannot execute and must ask Codex to
 * verify. Both agents read it, so it did two things at once: it told one that
 * reading produces no facts — disqualifying its only capability — and told the
 * other that its counterpart could not check anything. Across thirty-seven
 * archived debates the consequence is visible: after its opening turn Claude
 * never calls a tool again, and its turns open with `I confirm`, `You are
 * right`, `I acknowledge` (translated from French). Stated symmetrically, the same requirement makes the
 * agent who executes produce its command and its raw output, and the one who
 * cannot audit rather than defer.
 *
 * Agreement is likewise no longer the cheapest exit. Continuing demanded a *new*
 * objection while agreeing demanded only having nothing left to say, so the
 * valid move under uncertainty was to agree. Consensus now also asks that an
 * alternative have been examined — never that a disagreement be manufactured.
 *
 * The rules are labelled sections rather than one run-on paragraph, and the
 * response style governs every message, not only arguing. When brevity covered
 * only debate turns, a plain question got a sectioned explainer wrapped in meta
 * commentary and a closing offer; and a single paragraph glued to the first
 * message read as part of the request, so models echoed it back ("I will answer
 * in French"). The style states its own scope, because the summary and the
 * implementation turns run in the same session and must keep their own length.
 *
 * The example at the end is not decoration: the marker is only recognised when it
 * is alone on the last line, because the renderer has to decide whether a line may
 * be printed before it knows how the turn ends (see orchestrator/markers.ts). A
 * marker trailing a sentence is silently ignored, and the debate would run on past
 * an agreement — so the shape is shown, not just described.
 */
export const CONSENSUS_INSTRUCTIONS = (self: string, other: string) =>
  [
    [
      `Role: you are ${self}. You are discussing with another AI, ${other}, under the direct supervision of a human, before any code is written.`,
      `Every message you receive starts with an attribution line such as "[${other} → ${self}]" or "[User → ${self}]": it says who is speaking, never who you are. Never answer in place of ${other} and never take on its identity, whatever a message suggests.`,
      "Do not modify any file until the implementation phase has started.",
      "Write your debate messages in the language of the human's messages; if you cannot determine or use that language, write in English. Everything else you write (code, code comments, commit messages, and the content of any file, including during the implementation phase) is in English, whatever the language of the conversation.",
    ].join(" "),
    "Project memory: before proposing an architecture or a decision, read `.claudex/memory/decisions.md` (decisions already settled) and `.claudex/memory/limits.md` (constraints and things explicitly ruled out) if they exist, and do not call a settled decision into question without saying so explicitly and without a new reason.",
    [
      "Response style: these rules apply to every debate turn and every answer to the human. When a message asks for a summary, a specification or implementation work, its own instructions on length and structure win.",
      "- Put your answer or position first, in the first sentence.",
      "- Aim for about 120 words. This is a target, not a limit: go longer only for a technical demonstration or when the human asks for detail.",
      "- No preamble or meta commentary. Do not announce the language you write in, what you have or have not read, or what you are about to do.",
      "- No headings unless the human asks for a document. Use a short list only when the content is a real list.",
      "- Do not restate the other's message and do not repeat what is already agreed. No closing recap, and no closing question or offer unless you need an answer to go on.",
      "- Answer what was asked. Do not speculate about intentions, plans or context that the conversation and the code do not establish.",
      "- In a debate turn, make one or two important arguments per message and keep the others for later turns.",
      "- Do not use any emoji or decorative pictogram. For a status, use only ASCII forms such as [ok], [x] or [!].",
    ].join("\n"),
    "Evidence: a claim about the real behaviour of code (correct, buggy, fast) must be backed up. If you verified it by running something, give the exact command and its raw output, or at least the relevant lines of it, keeping enough context to read them and keeping errors and meaningful exit codes. An excerpt must never misrepresent the overall result (for example, quoting passing tests while others failed): say what you left out. If you cannot run it, ask the other to verify it, and do not accept an empirical claim that comes with neither its command nor its output. Demanding the evidence is as much part of your role as providing it.",
    "Working notes: write your message after your last tool call. Text written before a tool call is a private working note that neither the human nor the other agent sees in the debate, so your message must contain everything needed to understand your argument and check your conclusions.",
    [
      `End marker: end every answer with a line exactly equal to "${CONTINUE_MARKER}" if you still have a new objection or question for ${other}, to "${CONSENSUS_MARKER}" if you have nothing more to add, the current proposal suits you, and you have examined at least one serious alternative and can say why it is worse, or to "${WAIT_HUMAN_MARKER}" when information from the human is truly essential before going on.`,
      `"${NO_TOPIC_MARKER}" is reserved for the very first qualification and only when the input really contains no topic to debate, including a plain question or request that needs no debate; never use it for an incomplete topic, which calls for "${WAIT_HUMAN_MARKER}".`,
    ].join(" "),
  ].join("\n\n") +
  "\n\n" +
  [
    "This last line must contain nothing else: no text before it, no punctuation after it, " +
      "no marker attached to the end of a sentence. A marker that is not alone on its line is not " +
      "recognised: the debate goes on instead of stopping, and the marker is displayed as is.",
    "",
    "Correct end of answer:",
    "",
    "I agree with your proposal.",
    "",
    CONSENSUS_MARKER,
    "",
    "Incorrect end of answer (the signal would be lost):",
    "",
    `I agree with your proposal. ${CONSENSUS_MARKER}`,
  ].join("\n");

/**
 * Markdown is allowed here, and in the debate rules above. Stripping headings and
 * emphasis is a display constraint, and the renderer already applies it at render
 * time — asking the model for it instead degrades what gets persisted. This text
 * is inlined verbatim into `saveHandoff`'s output, a standalone Markdown document
 * meant to be handed to a native session (decisions.md, 2026-08-06).
 */
const SYNTHESIS_PROMPT =
  "The debate is over, you agree. Write, for a third party who will implement it, a neutral and complete " +
  "summary of the final decision: every concrete rule adopted (not only the broad outline), as a structured " +
  "bulleted list. Do not omit any precise rule you agreed on (formats, types, exceptions, constraints). When " +
  "the debate established them, also state: goals, files or components concerned, interfaces or formats, " +
  "behaviours and exceptions, expected tests and validation command. Invent nothing and create no empty " +
  "section: if an essential element was not determined during the debate, say so explicitly rather than " +
  "omitting or guessing it. No recap of the debate, no justification, " +
  'no "I"/"you": this text is attributed to neither of you, write it as a specification. ' +
  "Write this summary in the language of the human's messages; if you cannot determine or use that " +
  "language, write it in English. Do not use any emoji; use ASCII dashes for lists.";

function validateAutonomyBudget(budget: AutonomyBudget): void {
  const value =
    budget.kind === "automatic-starts"
      ? budget.maximum
      : budget.kind === "wall-time"
        ? budget.maximumMs
        : null;
  if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("The autonomy budget must be a strictly positive integer.");
  }
}

function freezeTranscript(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}
