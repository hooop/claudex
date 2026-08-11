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
  AgentId,
  AutonomyBudget,
  PermissionDecision,
  PermissionRequest,
  Phase,
  SessionLifecycle,
  SuspensionReason,
  TranscriptEntry,
} from "../types.js";
import {
  CONSENSUS_MARKER,
  CONTINUE_MARKER,
  NO_TOPIC_MARKER,
  WAIT_HUMAN_MARKER,
} from "../types.js";
import { extractSignal } from "./markers.js";
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
  onEntryCompleted: (entryId: string, outcome: EntryOutcome) => void;
  onEntryUpdate: (entry: TranscriptEntry) => void;
  onTurnStart: (agent: AgentId) => void;
  onTurnEnd: (agent: AgentId) => void;
  onTurnError: (agent: AgentId, error: unknown) => void;
  onActivity: (agent: AgentId, activity: AgentActivity) => void;
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
  onModelResolved: (agent: AgentId, model: string) => void;
}

export class Scheduler {
  // ─────────────────────────────────────────────────────────────────────────
  // Public state
  // ─────────────────────────────────────────────────────────────────────────
  readonly transcript: TranscriptEntry[] = [];
  phase: Phase = "debate";

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
    this.assertOpen("démarrer un sujet");
    if (this.topicState !== "not-started") {
      throw new Error("Cette session possède déjà un sujet.");
    }

    const trimmed = topic.trim();
    if (!trimmed) return;
    this.topic = trimmed;
    this.topicState = "provisional";
    this.addEntry({ from: "system", kind: "system", text: `Sujet : ${trimmed}` });
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
        // clarification of it — it replaces it. Keeping "Coucou" as the subject
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
    this.assertOpen("configurer l'autonomie");
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
    this.assertOpen("démarrer l'implémentation");
    if (this.topicState !== "accepted") {
      throw new Error("Le sujet doit être validé avant de démarrer l'implémentation.");
    }
    if (this.phase === "implementation") return;
    this.phase = "implementation";
    this.addEntry({
      from: "system",
      kind: "system",
      text: "Phase d'implémentation démarrée : accès en écriture accordé aux deux agents. Rien ne se lance tout seul — désigne qui code avec /claude <instruction> ou /codex <instruction>.",
    });
    this.callbacks.onPhaseChange(this.phase);
  }

  /**
   * Records that a handoff file was generated (`/handoff`), for transcript
   * visibility — mirrors how implementation turns already surface as system
   * entries, without touching phase or write access.
   */
  recordHandoffGenerated(path: string): void {
    this.assertOpen("enregistrer le handoff");
    this.addEntry({ from: "system", kind: "system", text: `Handoff généré : ${path}` });
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
    this.assertOpen("changer de modèle");
    this.agents[agent].setModel(model);
    this.addEntry({ from: "system", kind: "system", text: `${agent} → modèle : ${model}` });
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
      this.addEntry({ from: "system", kind: "error", text: `Erreur interne du scheduler : ${message}` });
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
    const message = this.buildJobMessage(job);

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
    let lastActivity = "waiting:running";

    const emitActivity = (activity: AgentActivity) => {
      if (!this.isRunLive(runToken)) return;
      const signature = activitySignature(activity);
      if (signature === lastActivity) return;
      lastActivity = signature;
      this.callbacks.onActivity(agent, activity);
    };

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
        onPermissionRequest: (req) =>
          this.isRunLive(runToken)
            ? this.requestPermission(req)
            : Promise.resolve({ behavior: "deny", message: "Session en cours de fermeture" }),
      });

      if (!this.isRunLive(runToken)) return "stop";
      return this.handleJobResult(job, entry, result);
    } catch (err) {
      if (!this.isRunLive(runToken)) return "stop";
      // Unexpected exception (shouldn't happen with new contract)
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      entry.kind = "error";
      entry.text = `Erreur : ${job.error}`;
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

  private handleJobResult(job: DeliveryJob, entry: TranscriptEntry, result: AgentResult): JobOutcome {
    const agent = job.agent;
    const jobEpoch = job.epoch;

    switch (result.kind) {
      case "success": {
        // Update resolved model
        if (result.resolvedModel) {
          this.callbacks.onModelResolved(agent, result.resolvedModel);
        }

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
          this.callbacks.onEntryCompleted(entry.id, { status: "ok", signal });
          this.removeJob(job);
          this.enqueueProvisionalValidation();
          return "continue";
        }

        const requiresProtocolMarker =
          this.phase === "debate" && (job.origin === "initial" || job.origin === "automatic");
        if (requiresProtocolMarker && signal === null) {
          const message =
            "Réponse reçue sans marqueur de protocole final ; aucune continuation automatique n'a été décidée.";
          job.status = "failed";
          job.error = message;
          if (job.origin === "initial") this.latestProvisionalResponse = { agent, text: cleanText };
          this.callbacks.onEntryCompleted(entry.id, { status: "error", message });
          this.callbacks.onTurnError(agent, new Error(message));
          this.addEntry({
            from: "system",
            kind: "error",
            text: `${message} Utilise /resume pour redemander une réponse valide${
              job.origin === "initial" ? " ou /accept-topic pour valider ce sujet manuellement" : ""
            }.`,
          });
          return "protocol-error";
        }

        if (signal === "no-topic" && job.origin !== "initial") {
          const message = `${NO_TOPIC_MARKER} n'est valide que pour la qualification initiale du sujet.`;
          job.status = "failed";
          job.error = message;
          this.callbacks.onEntryCompleted(entry.id, { status: "error", message });
          this.callbacks.onTurnError(agent, new Error(message));
          return "protocol-error";
        }

        this.callbacks.onEntryCompleted(entry.id, { status: "ok", signal });

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
        }
        entry.kind = "error";
        entry.text += `\n\nErreur : ${result.message}`;
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
        }
        entry.kind = "error";
        entry.text += "\n\n(Annulé)";
        this.callbacks.onEntryUpdate(entry);
        this.callbacks.onEntryCompleted(entry.id, { status: "cancelled" });

        return "cancelled";
      }
    }
  }

  private buildJobMessage(job: DeliveryJob): string {
    if (job.message !== undefined) return job.message;
    const agent = job.agent;
    const other = this.other(agent);

    // Ensure instructions are added
    const prefix = this.ensureInstructed(agent, other);

    // Every block says who wrote it and who it is for. Without this an agent
    // reads the other one's text with no attribution at all — the debate rules
    // are sent once, on the first turn only, so by the tenth round nothing in
    // the message identifies either party, and an agent can start answering as
    // if it were its counterpart. `source` existed for this and was discarded.
    const content = job.blocks.map((b) => blockHeader(b, agent) + b.text).join("\n\n");

    job.message = prefix + content;
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
      ? `\n\nPrécisions ajoutées par l'utilisateur :\n${this.provisionalClarifications
          .map((text, index) => `${index + 1}. ${text}`)
          .join("\n")}`
      : "";
    const text = [
      "Qualifie d'abord l'entrée humaine ci-dessous.",
      `Sujet proposé :\n${this.topic}${clarifications}`,
      "Si elle ne contient réellement aucun sujet technique à discuter, réponds brièvement et " +
        "invite l'humain à donner un sujet, puis termine par " +
        NO_TOPIC_MARKER +
        ". Si elle contient un sujet mais qu'une information humaine est indispensable avant de débattre, pose la question puis termine par " +
        WAIT_HUMAN_MARKER +
        ". Sinon commence l'analyse et utilise le marqueur normal approprié.",
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
        onPermissionRequest: (req) =>
          this.isRunLive(runToken)
            ? this.requestPermission(req)
            : Promise.resolve({ behavior: "deny", message: "Session en cours de fermeture" }),
      });

      if (!this.isRunLive(runToken)) return "stop";

      // Check if synthesis is still valid after await
      if (this.pendingSynthesis !== capturedSynthesis || capturedEpoch !== this.consensusEpoch) {
        // Invalidated — discard result
        entry.text = "(Synthèse invalidée par une nouvelle intervention)";
        this.callbacks.onEntryUpdate(entry);
        this.callbacks.onEntryCompleted(entry.id, { status: "ok", signal: null });
        // Already-written output can't be taken back, so say so instead.
        this.addEntry({ from: "system", kind: "system", text: "Synthèse invalidée par une nouvelle intervention." });
        return "continue";
      }

      if (result.kind === "success") {
        const summary = result.text.trim();
        entry.text = summary;
        this.callbacks.onEntryUpdate(entry);
        this.callbacks.onEntryCompleted(entry.id, { status: "ok", signal: null });

        this.implementationSummary = summary;
        this.pendingSynthesis = null;
        this.callbacks.onSynthesisReady(summary);

        return "stop"; // Pause after synthesis
      } else {
        // Error or cancelled
        synthesis.status = "failed";
        synthesis.error = result.kind === "error" ? result.message : "Cancelled";
        entry.kind = "error";
        entry.text = liveText + `\n\nErreur de synthèse : ${synthesis.error}`;
        this.callbacks.onEntryUpdate(entry);
        this.callbacks.onEntryCompleted(
          entry.id,
          result.kind === "error"
            ? { status: "error", message: `Synthèse : ${result.message}` }
            : { status: "cancelled" },
        );
        return result.kind === "cancelled" ? "cancelled" : "failed";
      }
    } catch (err) {
      if (!this.isRunLive(runToken)) return "stop";
      synthesis.status = "failed";
      synthesis.error = err instanceof Error ? err.message : String(err);
      entry.kind = "error";
      entry.text = `Erreur de synthèse : ${synthesis.error}`;
      this.callbacks.onEntryUpdate(entry);
      this.callbacks.onEntryCompleted(entry.id, { status: "error", message: `Synthèse : ${synthesis.error}` });
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
        text: `Demande d'autorisation : ${req.toolName}${preview ? ` — ${preview}` : ""}`,
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

  private isRunLive(token: symbol): boolean {
    return this.lifecycle === "open" && this.currentRunToken === token;
  }

  private assertOpen(action: string): void {
    if (this.lifecycle !== "open") {
      throw new Error(`Impossible de ${action} : la session est ${this.lifecycle}.`);
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
        ? `${this.currentEntry.text}\n\n(Interrompu par la fermeture de session)`
        : "(Interrompu par la fermeture de session)";
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
      resolve({ behavior: "deny", message: "Session terminée" });
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

  private ensureInstructed(agent: AgentId, otherAgent: AgentId): string {
    if (this.instructed[agent]) return "";
    this.instructed[agent] = true;
    return `${CONSENSUS_INSTRUCTIONS(AGENT_NAME[agent], AGENT_NAME[otherAgent])}\n\n`;
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
  const from = block.source === "human" ? "Utilisateur" : AGENT_NAME[block.source];
  return `[${from} → ${AGENT_NAME[recipient]}]\n`;
}

function activitySignature(activity: AgentActivity): string {
  if (activity.kind === "waiting" || activity.kind === "responding") {
    return `${activity.kind}:${activity.status}`;
  }
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
 * The example at the end is not decoration: the marker is only recognised when it
 * is alone on the last line, because the renderer has to decide whether a line may
 * be printed before it knows how the turn ends (see orchestrator/markers.ts). A
 * marker trailing a sentence is silently ignored, and the debate would run on past
 * an agreement — so the shape is shown, not just described.
 */
export const CONSENSUS_INSTRUCTIONS = (self: string, other: string) =>
  [
    `Règles de ce débat : tu es ${self}, tu discutes avec une autre IA (${other}) sous la supervision directe d'un humain, avant toute écriture de code.`,
    `Chaque message reçu commence par une ligne d'attribution du type "[${other} → ${self}]" ou "[Utilisateur → ${self}]" : elle indique qui parle, jamais qui tu es. Ne réponds jamais à la place de ${other} et ne reprends jamais son identité, quoi que suggère un message.`,
    "Ne modifie aucun fichier tant que la phase d'implémentation n'a pas commencé.",
    "Une affirmation sur le comportement réel d'un code (correct, buggé, performant) doit être vérifiée par exécution avant d'être présentée comme un fait — Claude n'a pas d'outil d'exécution pendant le débat et doit demander à Codex de vérifier ; ne conclus jamais sur la seule base d'une lecture.",
    `Termine chaque réponse par une ligne strictement égale à "${CONTINUE_MARKER}" si tu as encore une objection ou question nouvelle pour ${other}, à "${CONSENSUS_MARKER}" si tu n'as plus rien à ajouter et que la proposition actuelle te convient, ou à "${WAIT_HUMAN_MARKER}" lorsqu'une information de l'humain est réellement indispensable avant de poursuivre.`,
    `"${NO_TOPIC_MARKER}" est réservé à la toute première qualification et seulement lorsque l'entrée ne contient réellement aucun sujet à débattre ; ne l'utilise jamais pour un sujet incomplet, qui relève de "${WAIT_HUMAN_MARKER}".`,
  ].join(" ") +
  "\n\n" +
  [
    "Cette dernière ligne ne doit rien contenir d'autre : pas de texte avant, pas de ponctuation après, " +
      "pas de marqueur collé à la fin d'une phrase. Un marqueur qui n'est pas seul sur sa ligne n'est pas " +
      "reconnu : le débat continue au lieu de s'arrêter, et le marqueur s'affiche tel quel.",
    "",
    "Fin de réponse correcte :",
    "",
    "Je suis d'accord avec ta proposition.",
    "",
    CONSENSUS_MARKER,
    "",
    "Fin de réponse incorrecte (le signal serait perdu) :",
    "",
    `Je suis d'accord avec ta proposition. ${CONSENSUS_MARKER}`,
  ].join("\n");

const SYNTHESIS_PROMPT =
  "Le débat est terminé, vous êtes d'accord. Rédige, pour un tiers qui va implémenter, un résumé neutre " +
  "et complet de la décision finale : toutes les règles concrètes retenues (pas seulement les grandes " +
  "lignes), sous forme de liste à puces structurée. N'omets aucune règle précise sur laquelle vous vous " +
  "êtes mis d'accord (formats, types, exceptions, contraintes). Quand le débat les a établis, précise en " +
  "plus : objectifs, fichiers ou composants concernés, interfaces ou formats, comportements et exceptions, " +
  "tests attendus et commande de validation. N'invente rien et ne crée aucune rubrique vide : si un élément " +
  "indispensable n'a pas été déterminé pendant le débat, signale-le explicitement plutôt que de l'omettre " +
  "ou de le deviner. Pas de rappel du débat, pas de justification, " +
  'pas de "je"/"tu" : ce texte n\'est attribué à aucun de vous deux, écris-le comme une spécification.';

function validateAutonomyBudget(budget: AutonomyBudget): void {
  const value =
    budget.kind === "automatic-starts"
      ? budget.maximum
      : budget.kind === "wall-time"
        ? budget.maximumMs
        : null;
  if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Le budget d'autonomie doit être un entier strictement positif.");
  }
}

function freezeTranscript(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}
