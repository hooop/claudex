import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { ClaudeAgent } from "../claudeAgent.js";

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
    expect(result).toMatchObject({ kind: "success", text: "Bonjour", resolvedModel: "claude-test" });
    expect(agent.currentModel()).toBe("Test");
    expect(queryMock.mock.calls[0]?.[0]?.options.model).toBeUndefined();
    expect(queryMock.mock.calls[0]?.[0]?.options.includePartialMessages).toBe(true);

    agent.resetSession();
    expect(agent.currentModel()).toBe("Opus 4.5");
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
