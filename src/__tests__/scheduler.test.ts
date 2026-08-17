/**
 * Deterministic tests for the Architecture C scheduler.
 *
 * Uses fake controllable agents with deferred promises — no real CLI calls.
 * Tests target the public invariants of the new architecture, not the internals.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentResult } from "../orchestrator/types.js";
import type { AgentSendOptions, CodingAgent } from "../agents/types.js";
import {
  CONSENSUS_INSTRUCTIONS,
  Scheduler,
  type SchedulerCallbacks,
} from "../orchestrator/scheduler.js";
import type { AgentId, TranscriptEntry } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fake controllable agent
// ─────────────────────────────────────────────────────────────────────────────

class FakeAgent implements CodingAgent {
  readonly id: AgentId;
  readonly label: string;
  private model = "fake-model";
  private pendingResolve: ((result: AgentResult) => void) | null = null;
  private sendCallCount = 0;
  private sendOptions: AgentSendOptions | null = null;
  lastMessage: string | null = null;

  constructor(id: AgentId) {
    this.id = id;
    this.label = `Fake ${id}`;
  }

  currentModel(): string {
    return this.model;
  }

  hasExplicitModel(): boolean {
    return true;
  }

  setModel(model: string): void {
    this.model = model;
  }

  resetSession(): void {
    // No-op
  }

  send(message: string, options: AgentSendOptions): Promise<AgentResult> {
    this.sendCallCount++;
    this.lastMessage = message;
    this.sendOptions = options;

    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  async stop(): Promise<void> {
    // Resolve with cancelled if pending
    if (this.pendingResolve) {
      this.pendingResolve({ kind: "cancelled" });
      this.pendingResolve = null;
    }
  }

  // Test helpers

  /**
   * Complete the pending send with a success result.
   */
  complete(text: string): void {
    if (!this.pendingResolve) throw new Error("No pending send");
    this.pendingResolve({ kind: "success", text });
    this.pendingResolve = null;
  }

  /**
   * Complete the pending send with an error.
   */
  fail(message: string): void {
    if (!this.pendingResolve) throw new Error("No pending send");
    this.pendingResolve({ kind: "error", message });
    this.pendingResolve = null;
  }

  /**
   * Complete the pending send with cancellation.
   */
  cancel(): void {
    if (!this.pendingResolve) throw new Error("No pending send");
    this.pendingResolve({ kind: "cancelled" });
    this.pendingResolve = null;
  }

  /**
   * Check if there's a pending send.
   */
  isPending(): boolean {
    return this.pendingResolve !== null;
  }

  /**
   * Get the number of times send was called.
   */
  getSendCount(): number {
    return this.sendCallCount;
  }

  emitActivity(activity: Parameters<NonNullable<AgentSendOptions["onActivity"]>>[0]): void {
    this.sendOptions?.onActivity?.(activity);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function createFakeAgents(): Record<AgentId, FakeAgent> {
  return {
    claude: new FakeAgent("claude"),
    codex: new FakeAgent("codex"),
  };
}

function createMockCallbacks(): SchedulerCallbacks & { entries: TranscriptEntry[] } {
  const entries: TranscriptEntry[] = [];
  return {
    entries,
    onEntry: vi.fn((entry: TranscriptEntry) => entries.push(entry)),
    onEntryStarted: vi.fn((entry: TranscriptEntry) => entries.push(entry)),
    onOutputChunk: vi.fn(),
    onEntryCompleted: vi.fn(),
    onEntryUpdate: vi.fn(),
    onTurnStart: vi.fn(),
    onTurnEnd: vi.fn(),
    onTurnError: vi.fn(),
    onActivity: vi.fn(),
    onContextUsage: vi.fn(),
    onPhaseChange: vi.fn(),
    onPausedChange: vi.fn(),
    onSuspensionChange: vi.fn(),
    onLifecycleChange: vi.fn(),
    onTopicAccepted: vi.fn(),
    onPermissionRequest: vi.fn(),
    onPermissionCancelled: vi.fn(),
    onConsensusReached: vi.fn(),
    onConsensusInvalidated: vi.fn(),
    onSynthesisReady: vi.fn(),
    onModelResolved: vi.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Scheduler", () => {
  let agents: Record<AgentId, FakeAgent>;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let scheduler: Scheduler;

  beforeEach(() => {
    agents = createFakeAgents();
    callbacks = createMockCallbacks();
    scheduler = new Scheduler(
      agents,
      { cwd: "/tmp", starter: "claude", autonomyBudget: { kind: "unbounded" } },
      callbacks,
    );
  });

  describe("Basic alternation and verbatim delivery", () => {
    it("should start with the starter agent", async () => {
      scheduler.start("Test topic");

      // Claude should be called first
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      expect(agents.codex.isPending()).toBe(false);

      // Complete Claude's turn
      agents.claude.complete("Response from Claude\n\n<<CONTINUE>>");

      // Codex should be called next with Claude's response
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(agents.codex.lastMessage).toContain("Response from Claude");
    });

    it("should deliver messages verbatim between agents", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Exact message to deliver\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      // The message should contain the exact text from Claude
      expect(agents.codex.lastMessage).toContain("Exact message to deliver");
    });

    /**
     * An agent that cannot tell who wrote what it is reading eventually answers
     * as if it were its counterpart — observed in a real session, where Claude
     * replied "ma réponse à Claude" and claimed a command-execution ability only
     * Codex has. The debate rules are sent once, on the first turn, so nothing
     * else keeps either party oriented over a long conversation.
     */
    it("should name the writer and the reader on every delivered block", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      expect(agents.claude.lastMessage).toContain("tu es Claude");
      agents.claude.complete("Ma question\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(agents.codex.lastMessage).toContain("tu es Codex");
      expect(agents.codex.lastMessage).toContain("[Claude → Codex]\nMa question");
    });

    it("should attribute each block separately when a turn folds several", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));

      // Codex's reply and the human's note reach Claude in the same turn.
      scheduler.intervene("Mon avis", "claude");
      agents.codex.complete("Question de Codex\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      const message = agents.claude.lastMessage ?? "";
      expect(message).toContain("[Codex → Claude]\nQuestion de Codex");
      expect(message).toContain("[Utilisateur → Claude]\nMon avis");
      // Attribution is rendered, never baked into the stored text.
      expect(message).not.toContain("[Message de l'utilisateur]");
    });
  });

  describe("Intervention during a turn", () => {
    it("should queue intervention received during busy turn", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      // The first turn validates the provisional subject. Exercise the regular
      // append-only intervention queue during the following debate turn.
      agents.claude.complete("Initial qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));

      // Intervention while Codex is still working
      scheduler.intervene("Human interruption", "codex");

      // Codex is still pending — intervention is queued
      expect(agents.codex.isPending()).toBe(true);

      agents.codex.complete("Codex response\n\n<<CONTINUE>>");

      // The intervention should have been recorded in transcript immediately
      const interventionEntry = callbacks.entries.find((e) => e.kind === "intervention");
      expect(interventionEntry).toBeDefined();
      expect(interventionEntry?.text).toBe("Human interruption");
    });

    it("should not lose interventions received during busy turn", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      agents.claude.complete("Initial qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));

      // Multiple interventions during a regular debate turn
      scheduler.intervene("First intervention", "claude");
      scheduler.intervene("Second intervention", "codex");

      // Both should be in transcript
      const interventions = callbacks.entries.filter((e) => e.kind === "intervention");
      expect(interventions.length).toBe(2);
    });
  });

  describe("Targeted and 'both' interventions", () => {
    it("should deliver targeted intervention only to specified agent", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude response\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Codex response\n\n<<CONTINUE>>");

      // Now both agents have had a turn, session is running
      // Pause it to intervene
      scheduler.pause();

      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      // Intervene to Claude only
      scheduler.intervene("For Claude only", "claude");

      // Claude should receive the intervention
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      expect(agents.claude.lastMessage).toContain("For Claude only");
    });

    it("should deliver 'both' intervention to both agents with same snapshot", async () => {
      scheduler.start("Test topic");

      // Round 1: Claude responds
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude initial\n\n<<CONTINUE>>");

      // Round 2: Codex responds → expectedNext becomes claude
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Codex initial\n\n<<CONTINUE>>");

      // Pause before claude can start its next turn
      scheduler.pause();
      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      // Intervene to both
      scheduler.intervene("Message for both", "both");

      // First agent (expectedNext = claude after codex responded) gets called
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      const firstMessage = agents.claude.lastMessage;
      expect(firstMessage).toContain("Message for both");

      agents.claude.complete("Claude reply\n\n<<CONTINUE>>");

      // Second agent gets called with SAME snapshot (not including first's reply)
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      const secondMessage = agents.codex.lastMessage;
      expect(secondMessage).toContain("Message for both");
      // First agent's reply should NOT be in second agent's snapshot
      expect(secondMessage).not.toContain("Claude reply");
    });

    it("should finish an active 'both' batch before starting the next intervention", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      scheduler.pause();
      agents.claude.complete("Initial response\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      scheduler.intervene("INTERVENTION_A", "both");

      // expectedNext is Codex after Claude's initial automatic turn.
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      const firstBatchCodexMessage = agents.codex.lastMessage!;
      expect(firstBatchCodexMessage.split("INTERVENTION_A")).toHaveLength(2);

      // A second intervention is visible immediately, but must remain pending
      // until both immutable jobs from the first batch have completed.
      scheduler.intervene("INTERVENTION_B", "both");
      expect(
        callbacks.entries.some((entry) => entry.kind === "intervention" && entry.text === "INTERVENTION_B"),
      ).toBe(true);

      agents.codex.complete("CODEX_BATCH_A_REPLY\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      const firstBatchClaudeMessage = agents.claude.lastMessage!;
      expect(firstBatchClaudeMessage.split("INTERVENTION_A")).toHaveLength(2);
      expect(firstBatchClaudeMessage).not.toContain("INTERVENTION_B");
      expect(firstBatchClaudeMessage).not.toContain("CODEX_BATCH_A_REPLY");

      agents.claude.complete("CLAUDE_BATCH_A_REPLY\n\n<<CONTINUE>>");

      // Only now may the second batch start, in the same expected order.
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      const secondBatchCodexMessage = agents.codex.lastMessage!;
      expect(secondBatchCodexMessage.split("INTERVENTION_B")).toHaveLength(2);

      agents.codex.complete("CODEX_BATCH_B_REPLY\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      const secondBatchClaudeMessage = agents.claude.lastMessage!;
      expect(secondBatchClaudeMessage.split("INTERVENTION_B")).toHaveLength(2);
      expect(secondBatchClaudeMessage).not.toContain("CODEX_BATCH_B_REPLY");

      scheduler.pause();
      agents.claude.complete("CLAUDE_BATCH_B_REPLY\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(callbacks.onTurnEnd).toHaveBeenCalledTimes(5));

      expect(agents.codex.getSendCount()).toBe(2);
      expect(agents.claude.getSendCount()).toBe(3);
    });
  });

  describe("Pending deliveries preservation", () => {
    it("should not overwrite pending deliveries with new intervention", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      agents.claude.complete("Initial qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));

      // First intervention while Codex is working
      scheduler.intervene("First", "codex");

      // Second intervention
      scheduler.intervene("Second", "claude");

      // Both interventions should be recorded
      const interventions = callbacks.entries.filter((e) => e.kind === "intervention");
      expect(interventions.length).toBe(2);
      expect(interventions[0]?.text).toBe("First");
      expect(interventions[1]?.text).toBe("Second");
    });
  });

  describe("Consensus on single epoch", () => {
    it("should detect consensus when both agents signal in same epoch", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude agrees\n\n<<CONSENSUS>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Codex agrees\n\n<<CONSENSUS>>");

      // Wait for consensus to be detected
      await vi.waitFor(() => expect(callbacks.onConsensusReached).toHaveBeenCalled());
    });

    it("should invalidate signals after intervention", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude agrees\n\n<<CONSENSUS>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));

      // Intervention before Codex responds — this increments epoch
      scheduler.intervene("Interruption", "codex");

      // Codex completes its AUTO job with CONSENSUS — but epoch has changed,
      // so the signal should NOT be recorded
      agents.codex.complete("Codex agrees\n\n<<CONSENSUS>>");

      // Drain will now process the intervention and call codex again
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));

      // Complete the intervention job
      agents.codex.complete("Acknowledged interruption\n\n<<CONTINUE>>");

      // The debate resumes automatically after the intervention batch — Claude
      // is called next with Codex's reply, no manual /resume needed
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      expect(agents.claude.lastMessage).toContain("Acknowledged interruption");
      expect(scheduler.isPaused()).toBe(false);

      // Consensus should NOT have been reached because Claude's signal
      // was invalidated by the intervention
      expect(callbacks.onConsensusReached).not.toHaveBeenCalled();
    });

    /**
     * Reaching the agreement through a human question is the normal shape of a
     * supervised debate, not an edge case: the human asks "are you both done?"
     * and both agents answer. Those turns are born from the intervention, and
     * discarding their signal for that reason alone made consensus unreachable
     * for anyone actually using the tool.
     */
    async function agreeAfterHumanQuestion(): Promise<void> {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Codex répond\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      scheduler.intervene("consensus ?", "both");
      agents.claude.complete("Je vérifie\n\n<<CONTINUE>>");

      // The batch runs the expected speaker first, so Codex agrees, then Claude
      // confirms — and Claude is therefore the one handed the synthesis.
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("D'accord\n\n<<CONSENSUS>>");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("D'accord aussi\n\n<<CONSENSUS>>");

      await vi.waitFor(() => expect(callbacks.onConsensusReached).toHaveBeenCalled());
    }

    it("should detect consensus on the turns a human intervention produced", async () => {
      await agreeAfterHumanQuestion();
      expect(scheduler.isConsensusReached()).toBe(true);
    });

    it("should not reopen a settled debate when the human resumes", async () => {
      await agreeAfterHumanQuestion();

      // The synthesis goes to whoever confirmed last, and the debate pauses
      // once it lands.
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Spécification finale");
      await vi.waitFor(() => expect(callbacks.onSynthesisReady).toHaveBeenCalled());

      const claudeSends = agents.claude.getSendCount();
      const codexSends = agents.codex.getSendCount();

      // Codex agreeing first queued a turn for Claude, before Claude had agreed
      // too. Nothing runs it spontaneously, but it survives in the queue — and
      // /resume would replay it, reopening a debate that is over. Only a real
      // intervention should do that, through a new epoch.
      scheduler.resume();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(agents.claude.getSendCount()).toBe(claudeSends);
      expect(agents.codex.getSendCount()).toBe(codexSends);
      expect(scheduler.isConsensusReached()).toBe(true);
    });
  });

  describe("Intervention resumes the debate loop (regression)", () => {
    it("should merge a pending automatic delivery into a targeted intervention snapshot", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      agents.claude.complete("Initial qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));

      // User answers Claude directly while Codex is still finishing its turn —
      // Codex's reply is about to be auto-enqueued to Claude when the
      // intervention is processed.
      scheduler.intervene("User's opinion", "claude");

      agents.codex.complete("Codex's question for Claude\n\n<<CONTINUE>>");

      // Claude must see BOTH Codex's message and the user's text in the same
      // turn — not just the user's text with Claude's message lost or delayed.
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      expect(agents.claude.lastMessage).toContain("Codex's question for Claude");
      expect(agents.claude.lastMessage).toContain("User's opinion");
      expect(agents.codex.getSendCount()).toBe(1);
    });

    it("should resume the automatic debate loop after a single-target intervention", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude response\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Codex response\n\n<<CONTINUE>>");

      scheduler.intervene("A note for Codex", "codex");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Acknowledged\n\n<<CONTINUE>>");

      // No manual /resume — the debate keeps going on its own
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      expect(scheduler.isPaused()).toBe(false);
    });
  });

  describe("Synthesis handling", () => {
    it("should trigger synthesis after consensus", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude agrees\n\n<<CONSENSUS>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Codex agrees\n\n<<CONSENSUS>>");

      // Wait for consensus
      await vi.waitFor(() => expect(callbacks.onConsensusReached).toHaveBeenCalled());

      // Synthesis should start
      await vi.waitFor(() => {
        // One of the agents should be called for synthesis
        return agents.claude.isPending() || agents.codex.isPending();
      });
    });

    it("should invalidate synthesis if intervention arrives during it", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude agrees\n\n<<CONSENSUS>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Codex agrees\n\n<<CONSENSUS>>");

      await vi.waitFor(() => expect(callbacks.onConsensusReached).toHaveBeenCalled());

      // Synthesis starts — find which agent
      await vi.waitFor(() => agents.claude.isPending() || agents.codex.isPending());

      // Intervention during synthesis
      scheduler.intervene("Interrupt synthesis", "claude");

      // onConsensusInvalidated should be called
      expect(callbacks.onConsensusInvalidated).toHaveBeenCalled();
    });
  });

  describe("Failure handling", () => {
    it("should keep failed job for retry", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.fail("Network error");

      // Session should pause on failure
      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      // onTurnError should be called
      expect(callbacks.onTurnError).toHaveBeenCalled();
    });

    it("should retry the same failed delivery after /resume", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      const originalMessage = agents.claude.lastMessage;
      agents.claude.fail("Limite Claude Code atteinte");

      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));
      scheduler.resume();

      await vi.waitFor(() => expect(agents.claude.getSendCount()).toBe(2));
      expect(agents.claude.lastMessage).toBe(originalMessage);
    });

    it("should not retry a failed intervention from an already-consumed wake-up", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      scheduler.intervene("Queued while the automatic turn is running", "codex");
      agents.claude.complete("Claude response\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.fail("Intervention delivery failed");

      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));
      expect(agents.codex.getSendCount()).toBe(1);
      expect(agents.codex.isPending()).toBe(false);
    });

    it("should not treat partial text as success on error", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      // Fail with error (simulating partial text scenario)
      agents.claude.fail("Connection lost");

      // Session should pause
      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      // Consensus should NOT be reached
      expect(callbacks.onConsensusReached).not.toHaveBeenCalled();
    });

    it("should distinguish cancellation from error", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.cancel();

      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      // Cancellation is a type of failure — job stays for retry
      expect(callbacks.onTurnError).not.toHaveBeenCalled(); // Cancel is not an error
    });

    it("does not let /resume overtake an in-flight /cancel", async () => {
      scheduler.start("Test topic");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      const originalMessage = agents.claude.lastMessage;

      expect(scheduler.cancel()).toBe(true);
      expect(scheduler.resume()).toEqual({ ok: false, reason: "cancelling" });
      expect(agents.claude.isPending()).toBe(true);

      agents.claude.cancel();
      await vi.waitFor(() => expect(scheduler.isCancellationSettling()).toBe(false));
      expect(scheduler.suspension()).toBe("cancelled");
      expect(scheduler.resume()).toEqual({ ok: true });
      await vi.waitFor(() => expect(agents.claude.getSendCount()).toBe(2));
      expect(agents.claude.lastMessage).toBe(originalMessage);
    });
  });

  describe("Ephemeral activities", () => {
    it("forwards command state without adding it to the permanent transcript", async () => {
      scheduler.start("Test topic");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      agents.claude.emitActivity({
        kind: "command",
        status: "running",
        label: "npm test\n--run",
      });

      expect(callbacks.onActivity).toHaveBeenCalledWith("claude", {
        kind: "command",
        status: "running",
        label: "npm test\n--run",
      });
      expect(callbacks.entries.some((entry) => entry.text.includes("npm test"))).toBe(false);
    });
  });

  describe("Pause and resume", () => {
    it("should pause after intervention batch", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude response\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      scheduler.pause();
      agents.codex.complete("Codex response\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));
    });

    it("should resume on /resume", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude response\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      scheduler.pause();
      agents.codex.complete("Codex response\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      scheduler.resume();

      // Should continue with next turn
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    });
  });

  describe("Drain wake-ups", () => {
    it("should deliver work queued reentrantly while the drain is stopping", async () => {
      let armed = false;
      let interventionQueued = false;
      let activeTurns = 0;
      let maxActiveTurns = 0;

      vi.mocked(callbacks.onTurnStart).mockImplementation(() => {
        activeTurns++;
        maxActiveTurns = Math.max(maxActiveTurns, activeTurns);
      });
      vi.mocked(callbacks.onTurnEnd).mockImplementation(() => {
        activeTurns--;
      });
      vi.mocked(callbacks.onPausedChange).mockImplementation((paused) => {
        if (paused && armed && !interventionQueued) {
          interventionQueued = true;
          scheduler.intervene("BOUNDARY_WAKE_UP", "codex");
        }
      });

      scheduler.start("Test topic");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      // Reach a stable paused state, then use implementation mode because its
      // intervention batches deliberately stop at the batch boundary.
      scheduler.pause();
      agents.claude.complete("Initial response\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      scheduler.beginImplementation();
      scheduler.intervene("First implementation job", "claude");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      armed = true;
      agents.claude.complete("Implementation complete");

      // onPausedChange(true) queues this intervention synchronously while the
      // existing drain promise still exists. It must trigger a final recheck,
      // without /resume and without a concurrent second drain.
      await vi.waitFor(() => expect(interventionQueued).toBe(true));
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(agents.codex.lastMessage).toContain("BOUNDARY_WAKE_UP");
      expect(maxActiveTurns).toBe(1);

      scheduler.pause();
      agents.codex.complete("Boundary intervention complete");
      await vi.waitFor(() => expect(callbacks.onTurnEnd).toHaveBeenCalledTimes(3));
      expect(activeTurns).toBe(0);
      expect(maxActiveTurns).toBe(1);
    });
  });

  describe("Implementation phase", () => {
    it("should not auto-chain in implementation phase", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude agrees\n\n<<CONSENSUS>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Codex agrees\n\n<<CONSENSUS>>");

      await vi.waitFor(() => expect(callbacks.onConsensusReached).toHaveBeenCalled());

      // Complete synthesis — codex does it since they confirmed consensus last
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Summary of decisions");

      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      // Record counts before implementation phase
      const codexCountBeforeImpl = agents.codex.getSendCount(); // 2: debate + synthesis

      // Start implementation
      scheduler.beginImplementation();

      // Manual intervention to Claude
      scheduler.intervene("Implement feature X", "claude");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("I implemented feature X");

      // Should pause after — no auto-chain to Codex
      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      // Codex should NOT have been called during implementation
      expect(agents.codex.getSendCount()).toBe(codexCountBeforeImpl);
    });
  });

  describe("Provisional topic protocol", () => {
    /**
     * A non-topic used to tear the session down and return to the welcome
     * screen, which wiped the answer off the screen before it could be read.
     * The conversation now simply stays open and waits, like any other request
     * for human input — nothing reaches project memory until a topic is
     * actually accepted.
     */
    it("keeps the session open on a genuine non-topic and waits for the human", async () => {
      scheduler.start("bonjour");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      agents.claude.complete("Bonjour ! Donne-moi un sujet technique à examiner.\n\n<<NO_TOPIC>>");

      await vi.waitFor(() => expect(scheduler.suspension()).toBe("waiting-human"));
      expect(scheduler.topicStatus()).toBe("provisional");
      expect(callbacks.onTopicAccepted).not.toHaveBeenCalled();
      expect(agents.codex.getSendCount()).toBe(0);
      expect(scheduler.lifecycleState()).toBe("open");
    });

    it("lets the next message replace the subject instead of clarifying it", async () => {
      scheduler.start("bonjour");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Pas de sujet ici.\n\n<<NO_TOPIC>>");
      await vi.waitFor(() => expect(scheduler.suspension()).toBe("waiting-human"));

      scheduler.intervene("Quelle architecture pour la file d'attente ?", "both");

      // The real subject qualifies on its own; "bonjour" must not survive as
      // the topic with the real one appended underneath as a clarification.
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      const message = agents.claude.lastMessage ?? "";
      expect(message).toContain("Quelle architecture pour la file d'attente ?");
      expect(message).not.toContain("Sujet proposé :\nbonjour");

      agents.claude.complete("Analysons.\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(callbacks.onTopicAccepted).toHaveBeenCalledOnce());
    });

    it("distinguishes a real topic needing clarification and waits for the human", async () => {
      scheduler.start("Choix d'architecture");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      agents.claude.complete("Quel volume de trafic faut-il soutenir ?\n\n<<WAIT_HUMAN>>");

      await vi.waitFor(() => expect(scheduler.suspension()).toBe("waiting-human"));
      expect(callbacks.onTopicAccepted).toHaveBeenCalledOnce();
      expect(agents.codex.getSendCount()).toBe(0);

      scheduler.intervene("10 000 requêtes par seconde", "both");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(agents.codex.lastMessage).toContain("Quel volume de trafic");
      expect(agents.codex.lastMessage).toContain("10 000 requêtes par seconde");
    });

    it("coalesces rapid clarifications and ignores the obsolete validation result", async () => {
      scheduler.start("Une architecture");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      expect(scheduler.intervene("pour un service local", "both")).toBe(true);
      expect(scheduler.intervene("sans dépendance réseau", "both")).toBe(true);
      agents.claude.complete("Réponse à l'ancienne version\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.claude.getSendCount()).toBe(2));
      expect(agents.claude.lastMessage).toContain("pour un service local");
      expect(agents.claude.lastMessage).toContain("sans dépendance réseau");
      expect(agents.codex.getSendCount()).toBe(0);

      agents.claude.complete("Version courante qualifiée\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(callbacks.onTopicAccepted).toHaveBeenCalledOnce();
    });

    it("requires an explicit retry or manual acceptance after a missing marker", async () => {
      scheduler.start("Sujet valide");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Analyse utile mais sans marqueur");

      await vi.waitFor(() => expect(scheduler.suspension()).toBe("protocol-error"));
      expect(callbacks.onTopicAccepted).not.toHaveBeenCalled();
      expect(agents.codex.getSendCount()).toBe(0);

      expect(scheduler.acceptTopic()).toBe(true);
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(agents.codex.lastMessage).toContain("Analyse utile mais sans marqueur");
    });
  });

  describe("WAIT_HUMAN inside immutable batches", () => {
    it("lets the second captured job finish, then suspends without losing either reply", async () => {
      scheduler.start("Sujet");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      scheduler.pause();
      agents.codex.complete("Contexte Codex\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(scheduler.suspension()).toBe("manual"));

      scheduler.intervene("Précision initiale", "both");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Question humaine de Claude\n\n<<WAIT_HUMAN>>");

      // The second job was captured before Claude answered and still runs.
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(agents.codex.lastMessage).not.toContain("Question humaine de Claude");
      agents.codex.complete("Réponse parallèle de Codex\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(scheduler.suspension()).toBe("waiting-human"));
      expect(agents.claude.isPending()).toBe(false);
      expect(agents.codex.isPending()).toBe(false);

      scheduler.intervene("Réponse de l'utilisateur", "both");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      expect(agents.claude.lastMessage).toContain("Réponse parallèle de Codex");
      expect(agents.claude.lastMessage).toContain("Réponse de l'utilisateur");
    });
  });

  describe("Explicit autonomy policy", () => {
    it("chains on its own when no policy was selected", async () => {
      // A policy is opt-in, not a prerequisite. The risk a mandatory budget
      // would bound is an unsupervised runaway chain, and Claudex has no
      // unsupervised mode: it refuses to start without a TTY and Escape pauses
      // it on one keypress. Demanding a policy first protected nothing and
      // disabled the one behaviour the tool exists for.
      const noPolicy = new Scheduler(agents, { cwd: "/tmp", starter: "claude" }, callbacks);
      noPolicy.start("Sujet");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(noPolicy.autonomyPolicy()).toBeUndefined();
      expect(noPolicy.suspension()).toBeNull();
    });

    it("counts actual automatic starts and /resume opens a new window", async () => {
      const bounded = new Scheduler(
        agents,
        { cwd: "/tmp", starter: "claude", autonomyBudget: { kind: "automatic-starts", maximum: 1 } },
        callbacks,
      );
      bounded.start("Sujet");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Premier départ automatique\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(bounded.suspension()).toBe("autonomy-exhausted"));
      expect(agents.claude.getSendCount()).toBe(1);
      expect(bounded.resume()).toEqual({ ok: true });
      await vi.waitFor(() => expect(agents.claude.getSendCount()).toBe(2));
    });
  });

  describe("Shutdown", () => {
    it("should stop all agents on shutdown", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      await scheduler.shutdown();

      // Agent should no longer be pending (cancelled)
      expect(agents.claude.isPending()).toBe(false);
    });

    it("coalesces shutdown, freezes a stable snapshot, and supports a failed-stop retry", async () => {
      scheduler.start("Test topic");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      let firstStop = true;
      vi.spyOn(agents.claude, "stop").mockImplementation(async () => {
        if (agents.claude.isPending()) agents.claude.cancel();
        if (firstStop) {
          firstStop = false;
          throw new Error("cleanup incomplet");
        }
      });

      const first = scheduler.shutdown();
      expect(scheduler.shutdown()).toBe(first);
      await expect(first).resolves.toMatchObject({
        ok: false,
        lifecycle: "shutdown-failed",
        errors: { claude: "cleanup incomplet" },
      });
      expect(scheduler.lifecycleState()).toBe("shutdown-failed");

      const retry = await scheduler.shutdown();
      expect(retry.ok).toBe(true);
      if (retry.ok) {
        expect(Object.isFrozen(retry.transcript)).toBe(true);
        expect(retry.transcript.every((entry) => Object.isFrozen(entry))).toBe(true);
      }
      expect(scheduler.lifecycleState()).toBe("closed");
    });
  });
});

describe("règles du débat", () => {
  const claudeSide = CONSENSUS_INSTRUCTIONS("Claude", "Codex");
  const codexSide = CONSENSUS_INSTRUCTIONS("Codex", "Claude");

  /**
   * La règle de preuve nommait Claude et Codex : elle disait à l'un que sa
   * lecture ne produit pas de faits, et à l'autre que son contradicteur ne peut
   * rien vérifier. Les deux agents doivent recevoir exactement les mêmes règles,
   * aux deux identités près.
   */
  it("donne les mêmes règles aux deux agents, aux identités près", () => {
    const swapped = claudeSide
      .replace(/Claude/gu, "__OTHER__")
      .replace(/Codex/gu, "Claude")
      .replace(/__OTHER__/gu, "Codex");
    expect(swapped).toBe(codexSide);
  });

  it("exige la commande et la sortie plutôt que la confiance", () => {
    expect(claudeSide).toContain("la commande exacte et sa sortie brute");
    expect(claudeSide).toContain("Exiger la preuve fait partie de ton rôle");
  });

  // Sinon la sortie valide la moins chère, dans le doute, est l'accord.
  it("fait payer le consensus au moins autant que la poursuite", () => {
    expect(claudeSide).toContain("examiné au moins une alternative sérieuse");
  });

  // Contrainte d'affichage appliquée par le renderer : l'imposer au modèle
  // dégrade les handoffs, qui sont des documents Markdown autoportants.
  it("n'impose aucune contrainte Markdown aux agents", () => {
    expect(claudeSide).not.toContain("Markdown");
    expect(claudeSide).toContain("aucun emoji");
  });
});
