import { expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  throw new Error("debateOptions must not load the SDK");
});
import {
  CREDENTIAL_READ_DENY,
  DEBATE_ISOLATION,
  DEBATE_ISOLATION_KEYS,
  DEBATE_TOOLS,
  SANDBOXED_DEBATE_TOOLS,
  debateQueryOptions,
} from "../debateOptions.js";

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

it("sans sandbox, les options sont exactement celles d'avant", () => {
  const before = {
    tools: ["Read", "Grep", "Glob"],
    permissionMode: "default",
    allowedTools: [],
    settingSources: ["project"],
    strictMcpConfig: true,
    settings: { disableAllHooks: true, disableClaudeAiConnectors: true, disableSkillShellExecution: true },
  };
  expect(debateQueryOptions()).toEqual(before);
  expect(debateQueryOptions(null)).toEqual(debateQueryOptions());
  expect("sandbox" in debateQueryOptions(null)).toBe(false);
});

const sandboxed = { cwd: "/private/tmp/p", home: "/Users/u", extraDenyRead: [], secretEnvNames: [] };
const DENY_READ_RELATIVE = [
  ".ssh", ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".gnupg", ".netrc", ".git-credentials",
  ".npmrc", ".pypirc", ".config/gh", ".claude", ".claude.json", ".codex", "Library/Keychains",
  ".vault-token", ".cargo/credentials.toml", ".terraform.d/credentials.tfrc.json", ".password-store", ".config/op", ".local/share/keyrings", ".zsh_history", ".bash_history",
];

it("avec sandbox, Bash s'ajoute aux outils et le mode reste default sans outil pré-approuvé", () => {
  const o = debateQueryOptions(sandboxed);
  expect(o.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
  expect(SANDBOXED_DEBATE_TOOLS).toEqual(["Read", "Grep", "Glob", "Bash"]);
  expect(o.allowedTools).toEqual([]);
  expect(o.permissionMode).toBe("default");
  expect(o.settingSources).toEqual(["project"]);
  expect(o.strictMcpConfig).toBe(true);
  expect(o.settings).toEqual({ disableAllHooks: true, disableClaudeAiConnectors: true, disableSkillShellExecution: true });
});

it("avec sandbox, le bloc sandbox est exactement celui du design", () => {
  expect(debateQueryOptions(sandboxed).sandbox).toEqual({
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    filesystem: {
      denyWrite: ["/private/tmp/p"],
      denyRead: DENY_READ_RELATIVE.map((e) => `/Users/u/${e}`),
    },
  });
  expect(CREDENTIAL_READ_DENY).toEqual(DENY_READ_RELATIVE);
});

it("ne protège jamais .gitconfig en lecture", () => {
  const denyRead = debateQueryOptions(sandboxed).sandbox?.filesystem.denyRead ?? [];
  expect(denyRead).toHaveLength(24);
  expect(denyRead.some((p) => p.endsWith(".gitconfig"))).toBe(false);
});

it("deux appels ne partagent aucun tableau de la sandbox", () => {
  const first = debateQueryOptions(sandboxed);
  first.sandbox?.filesystem.denyRead.push("/x");
  first.sandbox?.filesystem.denyWrite.push("/y");
  first.sandbox?.network.allowedDomains.push("example.com");
  first.tools.push("Edit");
  const second = debateQueryOptions(sandboxed);
  expect(second.sandbox?.filesystem.denyRead).toHaveLength(24);
  expect(second.sandbox?.filesystem.denyWrite).toEqual(["/private/tmp/p"]);
  expect(second.sandbox?.network.allowedDomains).toEqual([]);
  expect(second.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
});

it("ajoute les cibles réelles des liens après les chemins du home", () => {
  const o = debateQueryOptions({ ...sandboxed, extraDenyRead: ["/vault/ssh"] });
  const denyRead = o.sandbox?.filesystem.denyRead ?? [];
  expect(denyRead).toHaveLength(25);
  expect(denyRead[0]).toBe("/Users/u/.ssh");
  expect(denyRead[24]).toBe("/vault/ssh");
});

it("masque les variables secrètes à Bash, et seulement s'il y en a", () => {
  const o = debateQueryOptions({ ...sandboxed, secretEnvNames: ["A_KEY", "GITHUB_TOKEN"] });
  expect(o.sandbox?.credentials).toEqual({
    envVars: [{ name: "A_KEY", mode: "deny" }, { name: "GITHUB_TOKEN", mode: "deny" }],
  });
  expect("credentials" in (debateQueryOptions(sandboxed).sandbox ?? {})).toBe(false);
});
