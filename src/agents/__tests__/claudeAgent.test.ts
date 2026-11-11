import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { ClaudeAgent } from "../claudeAgent.js";
import { SETTINGS_CHANGED_MESSAGE } from "../projectSettings.js";

async function* messages(items: unknown[]) {
  for (const item of items) yield item;
}

function successResult() {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "session-1",
    modelUsage: { "claude-test": { contextWindow: 200_000 } },
  };
}

describe("ClaudeAgent streaming", () => {
  beforeEach(() => queryMock.mockReset());

  it("émet les vrais text_delta sans répéter le message assistant final", async () => {
    queryMock.mockReturnValue(
      messages([
        {
          type: "stream_event",
          session_id: "session-1",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Bon" },
          },
        },
        {
          type: "stream_event",
          session_id: "session-1",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "jour" },
          },
        },
        {
          type: "assistant",
          session_id: "session-1",
          message: {
            model: "claude-test",
            usage: {
              input_tokens: 1_000,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 2_000,
              output_tokens: 300,
            },
            content: [{ type: "text", text: "Bonjour" }],
          },
        },
        successResult(),
      ]) as never,
    );

    const deltas: string[] = [];
    const contexts: unknown[] = [];
    const agent = new ClaudeAgent(undefined, "Opus 4.5");
    expect(agent.currentModel()).toBe("Opus 4.5");
    expect(agent.hasExplicitModel()).toBe(false);

    const result = await agent.send("Sujet", {
      cwd: "/tmp",
      writeAccess: false,
      onTextDelta: (delta) => deltas.push(delta),
      onContextUsage: (usage) => contexts.push(usage),
    });

    expect(deltas).toEqual(["Bon", "jour"]);
    expect(contexts).toEqual([{ usedTokens: 3_500, contextWindow: 200_000 }]);
    expect(result).toMatchObject({ kind: "success", text: "Bonjour" });
    expect(agent.currentModel()).toBe("Test");
    expect(queryMock.mock.calls[0]?.[0]?.options.model).toBeUndefined();
    expect(queryMock.mock.calls[0]?.[0]?.options.includePartialMessages).toBe(true);
    // Mesuré : les réglages utilisateur coûtent 13 300 tokens de prompt système
    // par appel, en catalogues de plugins qu'un agent limité à Read/Grep/Glob
    // ne peut pas utiliser. Le seul champ utile, le modèle par défaut, est lu
    // par Claudex et passé explicitement.
    expect(queryMock.mock.calls[0]?.[0]?.options.settingSources).toEqual(["project"]);

    agent.resetSession();
    expect(agent.currentModel()).toBe("Opus 4.5");
  });

  it("affiche le modèle qui a répondu, pas le premier modèle listé dans modelUsage", async () => {
    // Measured on SDK 0.3.310: with model "opus", modelUsage lists the engine's
    // background Haiku first, then the model that actually answered.
    queryMock.mockReturnValue(
      messages([
        {
          type: "assistant",
          session_id: "session-1",
          message: {
            model: "claude-opus-5-5",
            usage: { input_tokens: 1_000, output_tokens: 100 },
            content: [{ type: "text", text: "Résumé" }],
          },
        },
        {
          ...successResult(),
          modelUsage: {
            "claude-haiku-5-5": { contextWindow: 200_000 },
            "claude-opus-5-5": { contextWindow: 200_000 },
          },
        },
      ]) as never,
    );

    const agent = new ClaudeAgent("opus", "Opus 5");
    await agent.send("Sujet", { cwd: "/tmp", writeAccess: false });

    expect(agent.currentModel()).toBe("Opus 5.5");
  });

  it("affiche le libellé du sélecteur dès qu'un modèle est choisi", () => {
    const agent = new ClaudeAgent();
    agent.setModel("sonnet");
    expect(agent.currentModel()).toBe("Sonnet 5");
    expect(agent.hasExplicitModel()).toBe(true);
  });

  it("explique clairement quand le choix automatique n'est pas encore résolu", () => {
    expect(new ClaudeAgent().currentModel()).toBe("auto (détecté au 1er tour)");
  });

  it("conserve le message assistant complet comme fallback", async () => {
    queryMock.mockReturnValue(
      messages([
        {
          type: "assistant",
          session_id: "session-1",
          message: { content: [{ type: "text", text: "Réponse complète" }] },
        },
        successResult(),
      ]) as never,
    );

    const deltas: string[] = [];
    const result = await new ClaudeAgent().send("Sujet", {
      cwd: "/tmp",
      writeAccess: false,
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["Réponse complète"]);
    expect(result).toMatchObject({ kind: "success", text: "Réponse complète" });
  });

  it("transforme une limite de session en erreur explicite et reprenable", async () => {
    queryMock.mockReturnValue(
      messages([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "session-1",
          modelUsage: {},
          errors: ["You've hit your session limit · resets 11:50pm"],
        },
      ]) as never,
    );

    const result = await new ClaudeAgent().send("Sujet", { cwd: "/tmp", writeAccess: false });

    expect(result).toMatchObject({ kind: "error" });
    if (result.kind === "error") {
      expect(result.message).toContain("Limite Claude Code atteinte");
      expect(result.message).toContain("/resume");
      expect(result.message).not.toContain("Unknown SDK error");
    }
  });
});

describe("ClaudeAgent — réglages par phase", () => {
  beforeEach(() => queryMock.mockReset());

  /**
   * Retirer les réglages utilisateur allège le débat, mais les instructions
   * projet — le CLAUDE.md de l'utilisateur — doivent rester dans
   * les deux phases, et l'implémentation garde l'outillage global.
   */
  it("charge les réglages utilisateur seulement pendant l'implémentation", async () => {
    queryMock.mockReturnValue(messages([successResult()]));
    const agent = new ClaudeAgent();
    await agent.send("Applique la spécification", { cwd: "/tmp", writeAccess: true });

    const options = queryMock.mock.calls[0]?.[0]?.options;
    expect(options.settingSources).toEqual(["project", "user"]);
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(options).not.toHaveProperty("strictMcpConfig");
    expect(options).not.toHaveProperty("settings");
  });

  it("transmet au SDK le modèle configuré que Claudex a lu lui-même", async () => {
    queryMock.mockReturnValue(messages([successResult()]));
    const agent = new ClaudeAgent("opus");
    await agent.send("Sujet", { cwd: "/tmp", writeAccess: false });

    expect(queryMock.mock.calls[0]?.[0]?.options.model).toBe("opus");
  });

  /**
   * En débat, la lecture seule ne repose que sur `tools` et `canUseTool` :
   * `permissionMode: "plan"` et `allowedTools` ne l'imposent pas dans le SDK
   * installé (limits.md, 2026-08-29). Ce test fige ces réglages pour qu'une
   * mise à jour du SDK ne les relâche pas en silence.
   */
  it("restreint le débat à Read, Grep et Glob, sous arbitrage humain", async () => {
    queryMock.mockReturnValue(messages([successResult()]));
    const agent = new ClaudeAgent();
    await agent.send("Sujet", {
      cwd: "/tmp",
      writeAccess: false,
      onPermissionRequest: async () => ({ behavior: "deny" }),
    });

    const options = queryMock.mock.calls[0]?.[0]?.options;
    expect(options.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(options.permissionMode).toBe("default");
    expect(options.allowedTools).toEqual([]);
    expect(options.settingSources).toEqual(["project"]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings).toEqual({ disableAllHooks: true, disableClaudeAiConnectors: true, disableSkillShellExecution: true });
    expect(options).not.toHaveProperty("mcpServers");
    expect(typeof options.canUseTool).toBe("function");
  });

  it("relaie chaque demande d'outil à l'humain et applique sa réponse", async () => {
    queryMock.mockReturnValue(messages([successResult()]));
    const onPermissionRequest = vi
      .fn()
      .mockResolvedValueOnce({ behavior: "allow" })
      .mockResolvedValueOnce({ behavior: "deny", message: "non" })
      .mockResolvedValueOnce({ behavior: "deny" });
    const onActivity = vi.fn();
    const agent = new ClaudeAgent();
    await agent.send("Sujet", { cwd: "/tmp", writeAccess: false, onPermissionRequest, onActivity });

    const canUseTool = queryMock.mock.calls[0]?.[0]?.options.canUseTool as (
      name: string,
      input: unknown,
      opts: { toolUseID: string },
    ) => Promise<unknown>;
    const input = { file_path: "/tmp/a" };
    const results = [
      await canUseTool("Read", input, { toolUseID: "tu-1" }),
      await canUseTool("Read", input, { toolUseID: "tu-2" }),
      await canUseTool("Read", input, { toolUseID: "tu-3" }),
    ];

    expect(onPermissionRequest.mock.calls[0]?.[0]).toEqual({
      id: "tu-1",
      agent: "claude",
      toolName: "Read",
      input,
    });
    expect(results).toEqual([
      { behavior: "allow", updatedInput: input },
      { behavior: "deny", message: "non" },
      { behavior: "deny", message: "Refused by user" },
    ]);
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tool", label: "lit /tmp/a", status: "running" }),
    );
  });
});

describe("ClaudeAgent settings guard", () => {
  beforeEach(() => queryMock.mockReset());

  it.each([false, true])("refuses the turn without calling query (writeAccess %s)", async (writeAccess) => {
    const guard = vi.fn(async () => SETTINGS_CHANGED_MESSAGE);
    const agent = new ClaudeAgent(undefined, undefined, guard);
    const result = await agent.send("Sujet", { cwd: "/projet", writeAccess });
    expect(result).toEqual({ kind: "error", message: SETTINGS_CHANGED_MESSAGE });
    expect(guard).toHaveBeenCalledWith("/projet");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("fails closed when the guard itself rejects", async () => {
    const agent = new ClaudeAgent(undefined, undefined, async () => {
      throw new Error("boom");
    });
    const result = await agent.send("Sujet", { cwd: "/projet", writeAccess: false });
    expect(result).toEqual({ kind: "error", message: SETTINGS_CHANGED_MESSAGE });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns cancelled before consulting the guard when already aborted", async () => {
    const guard = vi.fn(async () => SETTINGS_CHANGED_MESSAGE);
    const controller = new AbortController();
    controller.abort();
    const agent = new ClaudeAgent(undefined, undefined, guard);
    const result = await agent.send("Sujet", { cwd: "/projet", writeAccess: false, signal: controller.signal });
    expect(result).toEqual({ kind: "cancelled" });
    expect(guard).not.toHaveBeenCalled();
  });

  it("sends the turn when the guard returns null, with the same options as without a guard", async () => {
    queryMock.mockReturnValue(messages([successResult()]) as never);
    await new ClaudeAgent().send("Sujet", { cwd: "/projet", writeAccess: false });
    const unguarded = queryMock.mock.calls[0]?.[0];

    queryMock.mockReset();
    queryMock.mockReturnValue(messages([successResult()]) as never);
    const guard = vi.fn(async () => null);
    const result = await new ClaudeAgent(undefined, undefined, guard).send("Sujet", {
      cwd: "/projet",
      writeAccess: false,
    });
    expect(result).toMatchObject({ kind: "success" });
    expect(guard).toHaveBeenCalledWith("/projet");
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(queryMock.mock.calls[0]?.[0])).toBe(JSON.stringify(unguarded));
  });
});
