import type { Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Strictly read-only tools for debate phase.
 * Bash is explicitly excluded — it can write even with "read-only" intent,
 * and a permissive rule or distracted human approval could violate the invariant.
 */
export const DEBATE_TOOLS = ["Read", "Grep", "Glob"];

// Measured before this change: a hook of the analysed repository ran and MCP
// servers and claude.ai connectors were offered during a debate turn. A debate
// turn gets none of them. `satisfies Options` checks the top-level keys at
// compile time, but not those inside `settings` (the SDK's `Settings` accepts
// any key): a misspelled settings key is caught by the exact-object test in
// debateOptions.test.ts instead.
export const DEBATE_ISOLATION = {
  // No `mcpServers` is passed, so with this flag no MCP server is used at all
  // (project .mcp.json, user settings, plugins and agent frontmatter included).
  strictMcpConfig: true,
  // The `settings` option is the flag tier, which wins over the analysed
  // repository's own settings. Not `managedSettings`: that policy tier is
  // dropped on machines with an IT-managed tier and rewrites disableAllHooks
  // (spec D1), whereas the flag tier applies everywhere.
  settings: {
    // Hooks and statusLine from settings files and installed plugins.
    disableAllHooks: true,
    // `strictMcpConfig` does not name claude.ai cloud connectors.
    disableClaudeAiConnectors: true,
    // A command in the repository's skills or slash commands could run a shell;
    // the debate has no Skill tool, so closing it costs nothing.
    disableSkillShellExecution: true,
  },
} satisfies Options;

// Task 6's controls strip exactly these keys to prove the isolation is what blocks the breach.
export const DEBATE_ISOLATION_KEYS: ReadonlyArray<keyof typeof DEBATE_ISOLATION> = [
  "strictMcpConfig",
  "settings",
];

type Widen<T> = { [K in keyof T]: T[K] extends boolean ? boolean : T[K] extends object ? Widen<T[K]> : T[K] };

export interface DebateQueryOptions extends Widen<typeof DEBATE_ISOLATION> {
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
    ...DEBATE_ISOLATION,
    settings: { ...DEBATE_ISOLATION.settings },
  } satisfies Options;
}
