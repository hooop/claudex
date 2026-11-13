import type { AgentResult } from "../orchestrator/types.js";
import type {
  AgentActivity,
  AgentContextUsage,
  AgentId,
  PermissionDecision,
  PermissionRequest,
  ToolTraceEvent,
} from "../types.js";

export const AUTO_MODEL_LABEL = "auto (detected on the 1st turn)";

export interface AgentSendOptions {
  cwd: string;
  writeAccess: boolean;
  /** The debate rules for this agent. Adapters send them through the system channel; they are identical for every send of a session. */
  instructions: string;
  onTextDelta?: (delta: string) => void;
  /** Latest occupancy of the resumed conversation's model context. */
  onContextUsage?: (usage: AgentContextUsage) => void;
  /** Ephemeral tool/command state for the single-line dynamic footer. */
  onActivity?: (activity: AgentActivity) => void;
  /** Separation is active only when this is passed. `streamed` says whether the note's text already went through onTextDelta, as the suffix since the last boundary. */
  onNote?: (note: string, streamed: boolean) => void;
  /** A finished tool or command, with its full output when the adapter has it. */
  onTrace?: (event: ToolTraceEvent) => void;
  /**
   * Permission request callback. The toolUseId should come from the SDK when available.
   */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
  /**
   * Abort signal for cancellation support.
   */
  signal?: AbortSignal;
}

export interface CodingAgent {
  readonly id: AgentId;
  readonly label: string;
  currentModel(): string;
  hasExplicitModel(): boolean;
  setModel(model: string): void;
  /** Drops the resumed session/thread id so the next send() starts a fresh conversation. */
  resetSession(): void;
  /**
   * Send a message to the agent and return a discriminated result.
   * Returns success | error | cancelled — never throws for expected failures.
   */
  send(message: string, options: AgentSendOptions): Promise<AgentResult>;
  /**
   * Interrupt any in-flight request and wait for cleanup.
   * Safe to call multiple times or when nothing is running.
   */
  stop(): Promise<void>;
}
