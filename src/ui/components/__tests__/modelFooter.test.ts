import { describe, expect, it } from "vitest";
import { contextRemainingPercent } from "../ModelFooter.js";

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
