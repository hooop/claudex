import { renderToString } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { isContextLow, ModelFooter, contextRemainingPercent } from "../ModelFooter.js";

describe("contextRemainingPercent", () => {
  it("rounds the remaining context to a whole percent", () => {
    expect(contextRemainingPercent({ usedTokens: 51_000, contextWindow: 200_000 })).toBe(
      "75%",
    );
  });

  it("clamps out-of-range values", () => {
    expect(
      contextRemainingPercent({ usedTokens: 300_000, contextWindow: 200_000 }),
    ).toBe("0%");
  });

  // A model change clears the measurement without resetting the session:
  // announcing "100% free" would remove the saturation alert at the very
  // moment the user is reacting to it.
  it("tells a missing measurement from an empty context", () => {
    expect(contextRemainingPercent(undefined)).toBeNull();
    expect(contextRemainingPercent(null)).toBeNull();
    expect(contextRemainingPercent({ usedTokens: 0, contextWindow: 0 })).toBeNull();
  });
});

describe("isContextLow", () => {
  it("is false when the context is unmeasured", () => {
    expect(isContextLow(null)).toBe(false);
    expect(isContextLow(undefined)).toBe(false);
    expect(isContextLow({ usedTokens: 0, contextWindow: 0 })).toBe(false);
  });

  it("is false at exactly 25% free and true below", () => {
    expect(isContextLow({ usedTokens: 150_000, contextWindow: 200_000 })).toBe(false);
    expect(isContextLow({ usedTokens: 152_000, contextWindow: 200_000 })).toBe(true);
    expect(isContextLow({ usedTokens: 200_000, contextWindow: 200_000 })).toBe(true);
  });
});

describe("ModelFooter showModels", () => {
  const models = { claude: "claude-m", codex: "codex-m" };

  it("draws only /help on the same single row when showModels is false", () => {
    const out = renderToString(
      createElement(ModelFooter, { models, contextUsage: {}, showModels: false }),
      { columns: 80 },
    );
    expect(out).toContain("/help");
    expect(out).not.toContain("claude-m");
    expect(out).not.toContain("codex-m");
    expect(out.split("\n")).toHaveLength(1);
    expect(out.trimEnd().endsWith("/help")).toBe(true);
  });

  it("draws the model names by default", () => {
    const out = renderToString(createElement(ModelFooter, { models }), { columns: 80 });
    expect(out).toContain("claude-m + codex-m");
  });
});
