/**
 * DebateSession — High-level session wrapper using the new Scheduler.
 *
 * This is a thin adapter that:
 * - Provides backward-compatible event API using TypedEmitter
 * - Delegates all scheduling logic to the Scheduler
 * - Manages model persistence
 */

import type { CodingAgent } from "../agents/types.js";
import { rememberModel } from "../memory/store.js";
import type {
  AgentId,
  AutonomyBudget,
  PermissionDecision,
  Phase,
  SessionLifecycle,
  SuspensionReason,
  TranscriptEntry,
} from "../types.js";
import { Scheduler } from "./scheduler.js";
import { TypedEmitter } from "./typedEmitter.js";
import type { ResumeResult, SessionEvents, ShutdownResult } from "./types.js";

interface SessionOptions {
  cwd: string;
  starter: AgentId;
  autonomyBudget?: AutonomyBudget;
}

/**
 * Turn-taking state machine for a Claude <-> Codex debate.
 *
 * Design notes (see .claudex/memory/decisions.md for the full rationale):
 * - Architecture C: delivery queues per recipient, immutable snapshots, single drain
 * - Full verbatim forwarding between agents, no summarization
 * - Causal consensus with epochs — interventions invalidate previous signals
 * - Intervention batches with barriers — responses stay behind for later delivery
 * - Retentable synthesis job
 */
export class DebateSession extends TypedEmitter<SessionEvents> {
  private scheduler: Scheduler;
  private readonly cwd: string;

  constructor(
    agents: Record<AgentId, CodingAgent>,
    options: SessionOptions,
  ) {
    super();
    this.cwd = options.cwd;

    // Create scheduler with callbacks that emit events
    this.scheduler = new Scheduler(agents, options, {
      onEntry: (entry) => this.emit("entry", entry),
      onEntryStarted: (entry) => this.emit("entry-started", entry),
      onOutputChunk: (entryId, delta) => this.emit("output-chunk", entryId, delta),
      onEntryCompleted: (entryId, outcome) => this.emit("entry-completed", entryId, outcome),
      onEntryUpdate: (entry) => this.emit("entry-update", entry),
      onTurnStart: (agent) => this.emit("turn-start", agent),
      onTurnEnd: (agent) => this.emit("turn-end", agent),
      onTurnError: (agent, error) => this.emit("turn-error", agent, error),
      onActivity: (agent, activity) => this.emit("activity", agent, activity),
      onContextUsage: (agent, usage) => this.emit("context-usage", agent, usage),
      onPhaseChange: (phase) => this.emit("phase", phase),
      onPausedChange: (paused) => this.emit("paused-changed", paused),
      onSuspensionChange: (reason) => this.emit("suspension-changed", reason),
      onLifecycleChange: (lifecycle) => this.emit("lifecycle", lifecycle),
      onTopicAccepted: () => this.emit("topic-accepted"),
      onPermissionRequest: (request) => this.emit("permission-request", request),
      onPermissionCancelled: (requestId) => this.emit("permission-cancelled", requestId),
      onConsensusReached: () => this.emit("consensus-reached"),
      onConsensusInvalidated: () => this.emit("consensus-invalidated"),
      onSynthesisReady: (summary) => this.emit("synthesis-ready", summary),
      onModelResolved: (agent, model) => {
        rememberModel(this.cwd, agent, model).then(undefined, () => undefined);
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public getters (delegated to scheduler)
  // ─────────────────────────────────────────────────────────────────────────

  get transcript(): TranscriptEntry[] {
    return this.scheduler.transcript;
  }

  get phase(): Phase {
    return this.scheduler.phase;
  }

  get implementationSummary(): string | null {
    return this.scheduler.implementationSummary;
  }

  get suspensionReason(): SuspensionReason | null {
    return this.scheduler.suspension();
  }

  get lifecycle(): SessionLifecycle {
    return this.scheduler.lifecycleState();
  }

  get topicStatus(): "not-started" | "provisional" | "accepted" {
    return this.scheduler.topicStatus();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API (delegated to scheduler)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start a debate on a topic.
   */
  async start(topic: string): Promise<void> {
    await this.scheduler.start(topic);
  }

  /**
   * Human intervention — never blocks or loses messages.
   * Input is always active, even during a turn.
   */
  intervene(text: string, target: AgentId | "both"): boolean {
    return this.scheduler.intervene(text, target);
  }

  /**
   * Resume after pause.
   */
  resume(): ResumeResult {
    return this.scheduler.resume();
  }

  /**
   * Pause the session — will stop after current turn.
   */
  pause(): void {
    this.scheduler.pause();
  }

  cancel(): boolean {
    return this.scheduler.cancel();
  }

  acceptTopic(): boolean {
    return this.scheduler.acceptTopic();
  }

  setAutonomyBudget(budget: AutonomyBudget): void {
    this.scheduler.setAutonomyBudget(budget);
  }

  autonomyPolicy(): AutonomyBudget | undefined {
    return this.scheduler.autonomyPolicy();
  }

  snapshot(): readonly TranscriptEntry[] {
    return this.scheduler.snapshot();
  }

  /**
   * Begin implementation phase.
   */
  beginImplementation(): void {
    this.scheduler.beginImplementation();
  }

  /**
   * Record that a handoff file was generated (`/handoff`).
   */
  recordHandoffGenerated(path: string): void {
    this.scheduler.recordHandoffGenerated(path);
  }

  /**
   * Answer a permission request.
   * Requires explicit y/n — Enter alone does not approve.
   */
  answerPermission(id: string, decision: PermissionDecision): void {
    this.scheduler.answerPermission(id, decision);
  }

  /**
   * Set the model for an agent.
   */
  setModel(agent: AgentId, model: string): void {
    this.scheduler.setModel(agent, model);
  }

  /**
   * Get current model for an agent.
   */
  modelOf(agent: AgentId): string {
    return this.scheduler.modelOf(agent);
  }

  /**
   * Check if busy.
   */
  isRunning(): boolean {
    return this.scheduler.isBusy();
  }

  isCancellationSettling(): boolean {
    return this.scheduler.isCancellationSettling();
  }

  /**
   * Check if paused.
   */
  isPaused(): boolean {
    return this.scheduler.isPaused();
  }

  /**
   * Check if consensus was reached.
   */
  isConsensusReached(): boolean {
    return this.scheduler.isConsensusReached();
  }

  /**
   * Check if we can resume (paused with pending work).
   */
  canResume(): boolean {
    return this.scheduler.isPaused();
  }

  /**
   * Stop all agents and cancel pending permissions.
   */
  shutdown(): Promise<ShutdownResult> {
    return this.scheduler.shutdown();
  }
}
