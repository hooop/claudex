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

  /** Complete the pending send with any result, partial text included. */
  resolveWith(result: AgentResult): void {
    if (!this.pendingResolve) throw new Error("No pending send");
    this.pendingResolve(result);
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

  /** The options of the latest send, to inspect them or call a callback late. */
  lastOptions(): AgentSendOptions | null {
    return this.sendOptions;
  }

  streamText(delta: string): void {
    this.sendOptions?.onTextDelta?.(delta);
  }

  emitNote(note: string, streamed: boolean): void {
    this.sendOptions?.onNote?.(note, streamed);
  }

  emitTrace(event: Parameters<NonNullable<AgentSendOptions["onTrace"]>>[0]): void {
    this.sendOptions?.onTrace?.(event);
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
    onOutputReset: vi.fn(),
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
     * replied "my reply to Claude" and claimed a command-execution ability only
     * Codex has. The debate rules are sent once, on the first turn, so nothing
     * else keeps either party oriented over a long conversation.
     */
    it("should name the writer and the reader on every delivered block", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      expect(agents.claude.lastMessage).toContain("you are Claude");
      agents.claude.complete("My question\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(agents.codex.lastMessage).toContain("you are Codex");
      expect(agents.codex.lastMessage).toContain("[Claude → Codex]\nMy question");
    });

    it("should attribute each block separately when a turn folds several", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));

      // Codex's reply and the human's note reach Claude in the same turn.
      scheduler.intervene("My opinion", "claude");
      agents.codex.complete("Question from Codex\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      const message = agents.claude.lastMessage ?? "";
      expect(message).toContain("[Codex → Claude]\nQuestion from Codex");
      expect(message).toContain("[User → Claude]\nMy opinion");
      // Attribution is rendered, never baked into the stored text.
      expect(message.split("[User → Claude]")).toHaveLength(2);
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
      agents.codex.complete("Codex answers\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      scheduler.intervene("consensus ?", "both");
      agents.claude.complete("I am checking\n\n<<CONTINUE>>");

      // The batch runs the expected speaker first, so Codex agrees, then Claude
      // confirms — and Claude is therefore the one handed the synthesis.
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Agreed\n\n<<CONSENSUS>>");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Agreed too\n\n<<CONSENSUS>>");

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
      agents.claude.complete("Final specification");
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

    it("asks for the summary in the human's language, English as fallback", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Claude agrees\n\n<<CONSENSUS>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Codex agrees\n\n<<CONSENSUS>>");

      // Codex confirmed last, so it is handed the synthesis request.
      await vi.waitFor(() => expect(agents.codex.getSendCount()).toBe(2));
      expect(agents.codex.lastMessage).toContain(
        "Write this summary in the language of the human's messages; if you cannot determine or use that language, write it in English.",
      );
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
      agents.claude.fail("Claude Code limit reached");

      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));
      scheduler.resume();

      await vi.waitFor(() => expect(agents.claude.getSendCount()).toBe(2));
      expect(agents.claude.lastMessage).toBe(originalMessage);
    });

    /**
     * A failed first turn never reached the agent, so the debate rules it
     * carried were never read. Typing a message instead of /resume replaces
     * that turn, and the replacement must carry the rules in its place.
     */
    it("should send the debate rules again when a failed first qualification is replaced", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.fail("spawn claude ENOENT");
      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      scheduler.intervene("Precision", "both");

      await vi.waitFor(() => expect(agents.claude.getSendCount()).toBe(2));
      expect(agents.claude.lastMessage).toContain("Precision");
      expect(agents.claude.lastMessage).toContain("you are Claude");
    });

    it("should send the debate rules with an intervention that follows a failed first turn", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.fail("turn/start rejected: unknown model");
      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      scheduler.intervene("Use the default model", "codex");

      await vi.waitFor(() => expect(agents.codex.getSendCount()).toBe(2));
      expect(agents.codex.lastMessage).toContain("Use the default model");
      expect(agents.codex.lastMessage).toContain("you are Codex");
    });

    it("should not repeat the debate rules when a failed turn is retried after a delivered one", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.fail("turn/start rejected: unknown model");
      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      scheduler.intervene("Use the default model", "codex");
      await vi.waitFor(() => expect(agents.codex.getSendCount()).toBe(2));
      agents.codex.complete("Switched model\n\n<<CONTINUE>>");

      // The failed turn is retried next; the rules already arrived with the intervention.
      await vi.waitFor(() => expect(agents.codex.getSendCount()).toBe(3));
      expect(agents.codex.lastMessage).toContain("[Claude → Codex]\nQualification");
      expect(agents.codex.lastMessage).not.toContain("you are Codex");
    });

    it("should not repeat the debate rules when retrying an answer that lacked a marker", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification without a marker");
      await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

      // The agent answered, so it read the rules even though the answer is rejected.
      scheduler.resume();

      await vi.waitFor(() => expect(agents.claude.getSendCount()).toBe(2));
      expect(agents.claude.lastMessage).toContain("Test topic");
      expect(agents.claude.lastMessage).not.toContain("you are Claude");
    });

    it("should send the debate rules only once to an agent whose turn succeeded", async () => {
      scheduler.start("Test topic");

      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("Reply\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.claude.getSendCount()).toBe(2));
      expect(agents.claude.lastMessage).not.toContain("you are Claude");
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
      scheduler.start("hello");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      agents.claude.complete("Hello! Give me a technical topic to examine.\n\n<<NO_TOPIC>>");

      await vi.waitFor(() => expect(scheduler.suspension()).toBe("waiting-human"));
      expect(scheduler.topicStatus()).toBe("provisional");
      expect(callbacks.onTopicAccepted).not.toHaveBeenCalled();
      expect(agents.codex.getSendCount()).toBe(0);
      expect(scheduler.lifecycleState()).toBe("open");
    });

    it("lets the next message replace the subject instead of clarifying it", async () => {
      scheduler.start("hello");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("No topic here.\n\n<<NO_TOPIC>>");
      await vi.waitFor(() => expect(scheduler.suspension()).toBe("waiting-human"));

      scheduler.intervene("What architecture for the queue?", "both");

      // The real subject qualifies on its own; "hello" must not survive as
      // the topic with the real one appended underneath as a clarification.
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      const message = agents.claude.lastMessage ?? "";
      expect(message).toContain("What architecture for the queue?");
      expect(message).not.toContain("Proposed topic:\nhello");

      agents.claude.complete("Let us analyse.\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(callbacks.onTopicAccepted).toHaveBeenCalledOnce());
    });

    it("distinguishes a real topic needing clarification and waits for the human", async () => {
      scheduler.start("Architecture choice");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      agents.claude.complete("What traffic volume must be sustained?\n\n<<WAIT_HUMAN>>");

      await vi.waitFor(() => expect(scheduler.suspension()).toBe("waiting-human"));
      expect(callbacks.onTopicAccepted).toHaveBeenCalledOnce();
      expect(agents.codex.getSendCount()).toBe(0);

      scheduler.intervene("10,000 requests per second", "both");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(agents.codex.lastMessage).toContain("What traffic volume");
      expect(agents.codex.lastMessage).toContain("10,000 requests per second");
    });

    it("coalesces rapid clarifications and ignores the obsolete validation result", async () => {
      scheduler.start("An architecture");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      expect(scheduler.intervene("for a local service", "both")).toBe(true);
      expect(scheduler.intervene("without a network dependency", "both")).toBe(true);
      agents.claude.complete("Answer to the old version\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.claude.getSendCount()).toBe(2));
      expect(agents.claude.lastMessage).toContain("for a local service");
      expect(agents.claude.lastMessage).toContain("without a network dependency");
      expect(agents.codex.getSendCount()).toBe(0);

      agents.claude.complete("Current version qualified\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(callbacks.onTopicAccepted).toHaveBeenCalledOnce();
    });

    it("requires an explicit retry or manual acceptance after a missing marker", async () => {
      scheduler.start("Valid topic");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Useful analysis but no marker");

      await vi.waitFor(() => expect(scheduler.suspension()).toBe("protocol-error"));
      expect(callbacks.onTopicAccepted).not.toHaveBeenCalled();
      expect(agents.codex.getSendCount()).toBe(0);

      expect(scheduler.acceptTopic()).toBe(true);
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(agents.codex.lastMessage).toContain("Useful analysis but no marker");
    });
  });

  describe("WAIT_HUMAN inside immutable batches", () => {
    it("lets the second captured job finish, then suspends without losing either reply", async () => {
      scheduler.start("Topic");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      scheduler.pause();
      agents.codex.complete("Codex context\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(scheduler.suspension()).toBe("manual"));

      scheduler.intervene("Initial clarification", "both");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Human question from Claude\n\n<<WAIT_HUMAN>>");

      // The second job was captured before Claude answered and still runs.
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      expect(agents.codex.lastMessage).not.toContain("Human question from Claude");
      agents.codex.complete("Parallel answer from Codex\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(scheduler.suspension()).toBe("waiting-human"));
      expect(agents.claude.isPending()).toBe(false);
      expect(agents.codex.isPending()).toBe(false);

      scheduler.intervene("User answer", "both");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      expect(agents.claude.lastMessage).toContain("Parallel answer from Codex");
      expect(agents.claude.lastMessage).toContain("User answer");
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
      noPolicy.start("Topic");
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
      bounded.start("Topic");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      agents.claude.complete("Qualification\n\n<<CONTINUE>>");
      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.complete("First automatic start\n\n<<CONTINUE>>");

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

describe("debate rules", () => {
  const claudeSide = CONSENSUS_INSTRUCTIONS("Claude", "Codex");
  const codexSide = CONSENSUS_INSTRUCTIONS("Codex", "Claude");

  /**
   * The evidence rule used to name Claude and Codex: it told one that its
   * reading produces no facts, and the other that its counterpart cannot
   * verify anything. Both agents must receive exactly the same rules, apart
   * from the two identities.
   */
  it("gives both agents the same rules, apart from the identities", () => {
    const swapped = claudeSide
      .replace(/Claude/gu, "__OTHER__")
      .replace(/Codex/gu, "Claude")
      .replace(/__OTHER__/gu, "Codex");
    expect(swapped).toBe(codexSide);
  });

  it("demands the command and the output rather than trust", () => {
    expect(claudeSide).toContain("the exact command and its raw output");
    expect(claudeSide).toContain("Demanding the evidence is as much part of your role");
  });

  // Otherwise the cheapest valid exit, when in doubt, is agreement.
  it("makes consensus cost at least as much as continuing", () => {
    expect(claudeSide).toContain("examined at least one serious alternative");
  });

  // Claudex no longer writes to CLAUDE.md or AGENTS.md: these rules are the only
  // way both agents learn that the memory exists. It is named, not copied in, so
  // that it is not billed again on every call.
  it("names the project's versioned memory without importing it", () => {
    expect(claudeSide).toContain(".claudex/memory/decisions.md");
    expect(claudeSide).toContain(".claudex/memory/limits.md");
    expect(claudeSide).not.toContain("@.claudex");
    expect(claudeSide).not.toContain("devlog.md");
  });

  // A display constraint the renderer applies: imposing it on the model
  // degrades the handoffs, which are standalone Markdown documents.
  it("imposes no Markdown constraint on the agents", () => {
    expect(claudeSide).not.toContain("Markdown");
    expect(claudeSide).toContain("Do not use any emoji");
  });

  it("tells agents to answer in the human's language, English as fallback", () => {
    expect(claudeSide).toContain(
      "Write your debate messages in the language of the human's messages; if you cannot determine or use that language, write in English.",
    );
  });

  it("keeps every other text in English whatever the conversation language", () => {
    expect(claudeSide).toContain(
      "Everything else you write (code, code comments, commit messages, and the content of any file, including during the implementation phase) is in English, whatever the language of the conversation.",
    );
  });
});

describe("working notes and trace", () => {
  let agents: Record<AgentId, FakeAgent>;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  function startDebate(starter: AgentId): Scheduler {
    const scheduler = new Scheduler(
      agents,
      { cwd: "/tmp", starter, autonomyBudget: { kind: "unbounded" } },
      callbacks,
    );
    void scheduler.start("Test topic");
    return scheduler;
  }

  function messageEntryOf(agent: AgentId, index = 0): TranscriptEntry {
    const entry = callbacks.entries.filter((e) => e.from === agent && e.kind === "message")[index];
    if (!entry) throw new Error(`No message entry ${index} from ${agent}`);
    return entry;
  }

  beforeEach(() => {
    agents = createFakeAgents();
    callbacks = createMockCallbacks();
  });

  for (const [starter, other] of [
    ["claude", "codex"],
    ["codex", "claude"],
  ] as const) {
    it(`delivers and shows only the answer (${starter} starts)`, async () => {
      startDebate(starter);
      await vi.waitFor(() => expect(agents[starter].isPending()).toBe(true));

      agents[starter].streamText("Looking.");
      agents[starter].emitNote("Looking.", true);
      agents[starter].streamText("Answer.");
      agents[starter].complete("Answer.\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents[other].isPending()).toBe(true));
      expect(messageEntryOf(starter).text).toBe("Answer.");
      expect(agents[other].lastMessage).toContain("Answer.");
      expect(agents[other].lastMessage).not.toContain("Looking.");
    });

    it(`delivered text equals entry text (${starter} starts)`, async () => {
      startDebate(starter);
      await vi.waitFor(() => expect(agents[starter].isPending()).toBe(true));
      agents[starter].streamText("Reading the code.");
      agents[starter].emitNote("Reading the code.", true);
      agents[starter].complete("First answer.\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents[other].isPending()).toBe(true));
      agents[other].streamText("Checking.");
      agents[other].emitNote("Checking.", true);
      agents[other].complete("Second answer.\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents[starter].getSendCount()).toBe(2));
      const first = messageEntryOf(starter).text;
      const second = messageEntryOf(other).text;
      expect(first).toBe("First answer.");
      expect(second).toBe("Second answer.");
      expect(agents[other].lastMessage).toContain(`\n${first}`);
      expect(agents[starter].lastMessage).toContain(`\n${second}`);
      expect(agents[other].lastMessage).not.toContain("Reading the code.");
      expect(agents[starter].lastMessage).not.toContain("Checking.");
    });
  }

  it("resets the live output when a note is removed", async () => {
    startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    const entry = messageEntryOf("claude");

    agents.claude.streamText("Looking.");
    agents.claude.emitNote("Looking.", true);

    expect(callbacks.onOutputReset).toHaveBeenCalledTimes(1);
    expect(callbacks.onOutputReset).toHaveBeenCalledWith(entry.id, "");
    expect(entry.text).toBe("");
    expect(callbacks.onEntryUpdate).toHaveBeenLastCalledWith(entry);
  });

  it("keeps the text before a note that starts with a paragraph break", async () => {
    startDebate("codex");
    await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
    const entry = messageEntryOf("codex");

    agents.codex.streamText("Part one.");
    agents.codex.streamText("\n\nLooking.");
    agents.codex.emitNote("\n\nLooking.", true);

    expect(callbacks.onOutputReset).toHaveBeenCalledWith(entry.id, "Part one.");
    expect(entry.text).toBe("Part one.");
  });

  it("ignores an unstreamed note when trimming the live text", async () => {
    startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    const entry = messageEntryOf("claude");

    agents.claude.streamText("Answer");
    agents.claude.emitNote("x", false);

    expect(callbacks.onOutputReset).not.toHaveBeenCalled();
    expect(entry.text).toBe("Answer");
  });

  it("ignores a streamed note that is not the end of the live text", async () => {
    startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    const entry = messageEntryOf("claude");

    agents.claude.streamText("Answer");
    agents.claude.emitNote("Elsewhere", true);

    expect(callbacks.onOutputReset).not.toHaveBeenCalled();
    expect(entry.text).toBe("Answer");
  });

  it("emits the note as activity", async () => {
    startDebate("codex");
    await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));

    agents.codex.streamText("\n\nI will read the scheduler.");
    agents.codex.emitNote("\n\nI will read the scheduler.", true);

    expect(callbacks.onActivity).toHaveBeenLastCalledWith("codex", {
      kind: "note",
      status: "running",
      label: "I will read the scheduler.",
    });
  });

  it("keeps the signal after notes", async () => {
    const scheduler = startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    agents.claude.streamText("Checking the claim.");
    agents.claude.emitNote("Checking the claim.", true);
    agents.claude.streamText("Agreed.\n\n<<CONSENSUS>>");
    agents.claude.complete("Agreed.\n\n<<CONSENSUS>>");

    await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
    agents.codex.streamText("Verifying.");
    agents.codex.emitNote("Verifying.", true);
    agents.codex.streamText("Agreed too.\n\n<<CONSENSUS>>");
    agents.codex.complete("Agreed too.\n\n<<CONSENSUS>>");

    await vi.waitFor(() => expect(callbacks.onConsensusReached).toHaveBeenCalled());
    expect(scheduler.isConsensusReached()).toBe(true);
    expect(messageEntryOf("claude").text).toBe("Agreed.");
    expect(messageEntryOf("codex").text).toBe("Agreed too.");
  });

  it("passes onNote only to debate turns, and onTrace to every turn", async () => {
    const scheduler = startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    expect(agents.claude.lastOptions()?.onNote).toBeTypeOf("function");
    expect(agents.claude.lastOptions()?.onTrace).toBeTypeOf("function");
    agents.claude.complete("Claude agrees\n\n<<CONSENSUS>>");
    await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
    expect(agents.codex.lastOptions()?.onNote).toBeTypeOf("function");
    agents.codex.complete("Codex agrees\n\n<<CONSENSUS>>");

    // Codex confirmed last, so it writes the synthesis.
    await vi.waitFor(() => expect(agents.codex.getSendCount()).toBe(2));
    expect(agents.codex.lastOptions()?.onNote).toBeUndefined();
    expect(agents.codex.lastOptions()?.onTrace).toBeTypeOf("function");
    agents.codex.complete("Summary of decisions");
    await vi.waitFor(() => expect(scheduler.isPaused()).toBe(true));

    scheduler.beginImplementation();
    scheduler.intervene("Implement feature X", "claude");
    await vi.waitFor(() => expect(agents.claude.getSendCount()).toBe(2));
    expect(agents.claude.lastOptions()?.writeAccess).toBe(true);
    expect(agents.claude.lastOptions()?.onNote).toBeUndefined();
    expect(agents.claude.lastOptions()?.onTrace).toBeTypeOf("function");
  });

  it("does not reset the output when the result matches the stream", async () => {
    startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    agents.claude.streamText("Answer.\n\n<<CONTINUE>>");
    agents.claude.complete("Answer.\n\n<<CONTINUE>>");

    await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
    expect(callbacks.onOutputReset).not.toHaveBeenCalled();
  });

  it("resets to the result text when it differs from the stream", async () => {
    startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    const entry = messageEntryOf("claude");

    // The answer held only the marker, so the adapter falls back to every segment.
    agents.claude.streamText("Looking.");
    agents.claude.emitNote("Looking.", true);
    agents.claude.streamText("<<CONTINUE>>");
    agents.claude.complete("Looking.\n\n<<CONTINUE>>");

    await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
    expect(callbacks.onOutputReset).toHaveBeenLastCalledWith(entry.id, "Looking.\n\n<<CONTINUE>>");
    expect(entry.text).toBe("Looking.");
    expect(agents.codex.lastMessage).toContain("Looking.");
  });

  it("does not reset a turn without notes even if the result differs from the stream", async () => {
    startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    agents.claude.streamText("Streamed draft.");
    agents.claude.complete("Final answer.\n\n<<CONTINUE>>");

    await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
    expect(callbacks.onOutputReset).not.toHaveBeenCalled();
    expect(messageEntryOf("claude").text).toBe("Final answer.");
  });

  for (const ending of ["error", "cancelled"] as const) {
    it(`resets a ${ending === "error" ? "failed" : "cancelled"} turn with notes to its partial text`, async () => {
      startDebate("claude");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
      const entry = messageEntryOf("claude");

      agents.claude.streamText("Looking.");
      agents.claude.emitNote("Looking.", true);
      agents.claude.streamText("Half an");
      const completed = vi.mocked(callbacks.onEntryCompleted);
      const completedBefore = completed.mock.calls.length;
      agents.claude.resolveWith(
        ending === "error"
          ? { kind: "error", message: "boom", partialText: "Looking.\n\nHalf an" }
          : { kind: "cancelled", partialText: "Looking.\n\nHalf an" },
      );

      await vi.waitFor(() => expect(completed.mock.calls.length).toBe(completedBefore + 1));
      expect(callbacks.onOutputReset).toHaveBeenLastCalledWith(entry.id, "Looking.\n\nHalf an");
      const resetOrder = vi.mocked(callbacks.onOutputReset).mock.invocationCallOrder.at(-1) ?? 0;
      const completedOrder = completed.mock.invocationCallOrder.at(-1) ?? 0;
      expect(resetOrder).toBeLessThan(completedOrder);
      expect(entry.text.startsWith("Looking.\n\nHalf an")).toBe(true);
    });
  }

  it("does not reset a failed turn whose partial text matches the stream", async () => {
    startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    agents.claude.streamText("Looking.");
    agents.claude.emitNote("Looking.", true);
    agents.claude.streamText("Half");
    const resetsBefore = vi.mocked(callbacks.onOutputReset).mock.calls.length;
    agents.claude.resolveWith({ kind: "error", message: "boom", partialText: "Half" });

    await vi.waitFor(() => expect(callbacks.onTurnError).toHaveBeenCalled());
    expect(vi.mocked(callbacks.onOutputReset).mock.calls.length).toBe(resetsBefore);
  });

  it("records notes and tools in the trace", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const scheduler = startDebate("claude");
      await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));

      agents.claude.streamText("\n\nLooking.");
      agents.claude.emitNote("\n\nLooking.", true);
      agents.claude.emitTrace({
        kind: "tool",
        label: "Read src/a.ts",
        status: "success",
        output: "x".repeat(70 * 1024),
      });
      agents.claude.complete("Answer.\n\n<<CONTINUE>>");

      await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));
      agents.codex.emitTrace({ kind: "tool", label: "npm test", status: "failure", exitCode: 1 });

      const trace = scheduler.trace();
      expect(Object.isFrozen(trace)).toBe(true);
      expect(trace).toEqual([
        { agent: "claude", timestamp: 1_000, event: { kind: "note", text: "Looking." } },
        {
          agent: "claude",
          timestamp: 1_000,
          event: {
            kind: "tool",
            label: "Read src/a.ts",
            status: "success",
            output: "x".repeat(64 * 1024) + `\n[... ${6 * 1024} bytes omitted]`,
          },
        },
        {
          agent: "codex",
          timestamp: 1_000,
          event: { kind: "tool", label: "npm test", status: "failure", exitCode: 1 },
        },
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("removes a whitespace-only note from the live text without recording it", async () => {
    const scheduler = startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    const entry = messageEntryOf("claude");

    agents.claude.streamText("Answer.");
    agents.claude.streamText("\n\n");
    agents.claude.emitNote("\n\n", true);

    expect(entry.text).toBe("Answer.");
    expect(callbacks.onOutputReset).toHaveBeenCalledWith(entry.id, "Answer.");
    expect(scheduler.trace()).toEqual([]);
    expect(callbacks.onActivity).not.toHaveBeenCalledWith("claude", expect.objectContaining({ kind: "note" }));
  });

  it("ignores notes and traces from a turn that is over", async () => {
    const scheduler = startDebate("claude");
    await vi.waitFor(() => expect(agents.claude.isPending()).toBe(true));
    const staleOptions = agents.claude.lastOptions();
    const entry = messageEntryOf("claude");
    agents.claude.streamText("Answer.\n\n<<CONTINUE>>");
    agents.claude.complete("Answer.\n\n<<CONTINUE>>");
    await vi.waitFor(() => expect(agents.codex.isPending()).toBe(true));

    staleOptions?.onNote?.("Answer.\n\n<<CONTINUE>>", true);
    staleOptions?.onTrace?.({ kind: "tool", label: "late", status: "success" });

    expect(scheduler.trace()).toEqual([]);
    expect(callbacks.onOutputReset).not.toHaveBeenCalled();
    expect(entry.text).toBe("Answer.");
  });
});
