import { describe, expect, it } from "vitest";
import { AUTONOMY_USAGE, DECIDE_USAGE, decideUsageError, parseCommand } from "../commands.js";

describe("parseCommand", () => {
  it("parses /handoff", () => {
    expect(parseCommand("/handoff")).toEqual({ kind: "handoff" });
  });

  it("ignores trailing text after /handoff (no arguments expected)", () => {
    expect(parseCommand("/handoff now")).toEqual({ kind: "handoff" });
  });

  it("splits /decide on the pipe and trims both halves", () => {
    expect(parseCommand("/decide  File de livraisons | Architecture C  ")).toEqual({
      kind: "decide",
      topic: "File de livraisons",
      approach: "Architecture C",
    });
  });

  it("leaves both halves empty for a bare /decide", () => {
    expect(parseCommand("/decide")).toEqual({ kind: "decide", topic: "", approach: "" });
  });

  it("parses lifecycle commands without making discard implicit", () => {
    expect(parseCommand("/new")).toEqual({ kind: "new", discard: false });
    expect(parseCommand("/quit --discard")).toEqual({ kind: "quit", discard: true });
    expect(parseCommand("/retry")).toEqual({ kind: "retry" });
    expect(parseCommand("/cancel")).toEqual({ kind: "cancel" });
    expect(parseCommand("/emergency-exit")).toEqual({ kind: "emergency-exit" });
  });

  it("requires explicit, dimensioned autonomy values", () => {
    expect(parseCommand("/autonomy unbounded")).toEqual({
      kind: "autonomy",
      budget: { kind: "unbounded" },
      remember: false,
    });
    expect(parseCommand("/autonomy starts 7 --remember")).toEqual({
      kind: "autonomy",
      budget: { kind: "automatic-starts", maximum: 7 },
      remember: true,
    });
    expect(parseCommand("/autonomy time 5m")).toEqual({
      kind: "autonomy",
      budget: { kind: "wall-time", maximumMs: 300_000 },
      remember: false,
    });
    expect(parseCommand("/autonomy time 5")).toEqual({
      kind: "autonomy",
      remember: false,
      error: AUTONOMY_USAGE,
    });
  });
});

describe("decideUsageError", () => {
  const decide = (raw: string) => {
    const cmd = parseCommand(raw);
    if (cmd.kind !== "decide") throw new Error(`expected a decide command, got ${cmd.kind}`);
    return cmd;
  };

  it("accepts a command with both halves", () => {
    expect(decideUsageError(decide("/decide sujet | approche"))).toBeNull();
  });

  // These are the inputs that used to append an empty "## <date> —" entry.
  it.each(["/decide", "/decide    ", "/decide texte sans barre", "/decide | approche", "/decide sujet |"])(
    "rejects %j",
    (raw) => {
      expect(decideUsageError(decide(raw))).toBe(DECIDE_USAGE);
    },
  );
});
