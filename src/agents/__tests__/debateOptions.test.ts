import { expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  throw new Error("debateOptions must not load the SDK");
});
import { DEBATE_ISOLATION, DEBATE_ISOLATION_KEYS, DEBATE_TOOLS, debateQueryOptions } from "../debateOptions.js";

it("gives the debate its read-only tools, the default mode, no pre-approved tool and project settings only", () => {
  expect(debateQueryOptions()).toEqual({
    tools: ["Read", "Grep", "Glob"],
    permissionMode: "default",
    allowedTools: [],
    settingSources: ["project"],
    strictMcpConfig: true,
    settings: { disableAllHooks: true, disableClaudeAiConnectors: true, disableSkillShellExecution: true },
  });
  expect(debateQueryOptions()).not.toHaveProperty("mcpServers");
  expect(DEBATE_TOOLS).toEqual(["Read", "Grep", "Glob"]);
});

it("returns a fresh object on every call", () => {
  const first = debateQueryOptions();
  first.tools.push("Bash");
  first.allowedTools.push("Bash");
  first.settingSources.push("project");
  first.settings.disableAllHooks = false;
  expect(debateQueryOptions().tools).toEqual(["Read", "Grep", "Glob"]);
  expect(debateQueryOptions().allowedTools).toEqual([]);
  expect(debateQueryOptions().settingSources).toEqual(["project"]);
  expect(debateQueryOptions().settings).toEqual({ disableAllHooks: true, disableClaudeAiConnectors: true, disableSkillShellExecution: true });
});

it("lists exactly the keys of DEBATE_ISOLATION", () => {
  expect([...DEBATE_ISOLATION_KEYS].sort()).toEqual(Object.keys(DEBATE_ISOLATION).sort());
});
