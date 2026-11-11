import type { Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Strictly read-only tools for debate phase.
 * Bash is explicitly excluded — it can write even with "read-only" intent,
 * and a permissive rule or distracted human approval could violate the invariant.
 */
export const DEBATE_TOOLS = ["Read", "Grep", "Glob"];

export interface DebateQueryOptions {
  tools: string[];
  permissionMode: "default";
  allowedTools: string[];
  settingSources: Array<"project">;
}

// Lives apart from claudeAgent.ts so the read-only verification script can
// import the options Claudex ships without loading the SDK at runtime.
// A function, not a constant: every caller gets its own arrays, so none can
// alter another's options.
export function debateQueryOptions(): DebateQueryOptions {
  return {
    // Real availability restriction: this is what keeps the debate read-only.
    tools: [...DEBATE_TOOLS],
    // Deliberately always "default", never "plan": plan mode carries its own
    // built-in ritual (present a plan, call ExitPlanMode) that conflicts with
    // the debate's own instructions and has been observed to confuse the model
    // about which protocol to follow. Read-only enforcement during the debate
    // comes from `tools` above.
    permissionMode: "default",
    // No auto-approved tools in debate — everything requires human approval
    allowedTools: [],
    // Measured on this machine: loading user settings costs 13 300 tokens
    // of system prompt per call — plugin and skill catalogues an agent
    // restricted to Read/Grep/Glob can never use. A debate turn makes
    // dozens of calls, so it is paid dozens of times. The one field
    // Claudex needs from those settings is the default model, which it
    // reads itself and passes as `model`.
    //
    // Project settings stay: that is where the user's own CLAUDE.md lives,
    // and their instructions apply during a debate too.
    settingSources: ["project"],
  } satisfies Options;
}
