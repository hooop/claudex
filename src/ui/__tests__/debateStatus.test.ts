import { describe, expect, it } from "vitest";
import type { EntryOutcome, Signal } from "../../orchestrator/types.js";
import type { TranscriptEntry } from "../../types.js";
import {
  INITIAL_STATUS,
  reduceStatus,
  roundForStart,
  stageOf,
  statusLine,
  type DebateStatus,
  type StatusEvent,
} from "../debateStatus.js";
import { AGENT_STYLE, CONSENSUS_COLOR } from "../theme.js";

function ok(signal: Signal, counted = true): EntryOutcome {
  return { status: "ok", signal, counted };
}

function run(events: StatusEvent[], from: DebateStatus = INITIAL_STATUS): DebateStatus {
  return events.reduce(reduceStatus, from);
}

const done = (agent: "claude" | "codex" | "system" | "human", outcome: EntryOutcome): StatusEvent => ({
  kind: "completed",
  agent,
  outcome,
});

const intervention: TranscriptEntry = {
  id: "i1",
  from: "human",
  to: "both",
  kind: "intervention",
  text: "hold on",
  timestamp: 0,
};

describe("reduceStatus", () => {
  it("starts in the debate phase with no stance", () => {
    expect(INITIAL_STATUS).toEqual({
      stance: { claude: "none", codex: "none" },
      consensus: false,
      phase: "debate",
      answered: { claude: 0, codex: 0 },
    });
  });

  it.each([
    ["continue", "continues"],
    ["consensus", "ready"],
    ["wait-human", "asks"],
    ["no-topic", "none"],
    [null, "none"],
  ] as const)("a counted %s signal sets the stance %s", (signal, stance) => {
    const s = run([done("claude", ok("continue")), done("codex", ok("continue")), done("claude", ok(signal))]);
    expect(s.stance.claude).toBe(stance);
    expect(s.stance.codex).toBe("continues");
  });

  it("a human intervention resets both stances", () => {
    const s = run([
      done("claude", ok("consensus")),
      done("codex", ok("wait-human")),
      { kind: "entry", entry: intervention },
    ]);
    expect(s.stance).toEqual({ claude: "none", codex: "none" });
    expect(s.answered).toEqual({ claude: 1, codex: 1 });
  });

  it("a non-intervention entry changes nothing", () => {
    const before = run([done("claude", ok("consensus"))]);
    const after = reduceStatus(before, { kind: "entry", entry: { ...intervention, from: "claude", kind: "message" } });
    expect(after).toEqual(before);
  });

  it("consensus-invalidated resets stances and consensus", () => {
    const s = run([
      done("claude", ok("consensus")),
      { kind: "consensus-reached" },
      { kind: "consensus-invalidated" },
    ]);
    expect(s.consensus).toBe(false);
    expect(s.stance).toEqual({ claude: "none", codex: "none" });
  });

  it("consensus-reached sets consensus", () => {
    expect(run([{ kind: "consensus-reached" }]).consensus).toBe(true);
  });

  it("an uncounted turn increments answered but leaves the stance", () => {
    const s = run([done("claude", ok("continue")), done("claude", ok("consensus", false))]);
    expect(s.stance.claude).toBe("continues");
    expect(s.answered.claude).toBe(2);
  });

  it("an uncounted consensus does not show as ready", () => {
    const s = run([done("codex", ok("consensus", false))]);
    expect(s.stance.codex).toBe("none");
    expect(statusLine(s).map((x) => x.text).join("")).not.toContain("ready");
  });

  it.each([{ status: "error", message: "boom" }, { status: "cancelled" }] as EntryOutcome[])(
    "a $status turn changes nothing",
    (outcome) => {
      const before = run([done("claude", ok("continue"))]);
      expect(reduceStatus(before, done("claude", outcome))).toEqual(before);
    },
  );

  it("ignores system and human completions", () => {
    expect(reduceStatus(INITIAL_STATUS, done("system", ok("consensus")))).toEqual(INITIAL_STATUS);
    expect(reduceStatus(INITIAL_STATUS, done("human", ok("continue")))).toEqual(INITIAL_STATUS);
  });

  it("does not count answers outside the debate phase", () => {
    const s = run([{ kind: "phase", phase: "implementation" }, done("claude", ok("continue"))]);
    expect(s.answered.claude).toBe(0);
    expect(s.phase).toBe("implementation");
  });
});

describe("roundForStart", () => {
  it("a retried turn keeps its round", () => {
    const s = run([]);
    expect(roundForStart(s, "claude")).toBe(1);
    const failed = reduceStatus(s, done("claude", { status: "error", message: "x" }));
    expect(roundForStart(failed, "claude")).toBe(1);
  });

  it("rounds are counted per agent", () => {
    const s = run([done("claude", ok("continue")), done("codex", ok("continue")), done("claude", ok("continue"))]);
    expect(roundForStart(s, "claude")).toBe(3);
    expect(roundForStart(s, "codex")).toBe(2);
  });

  it("implementation turns are labelled as such, ended ones have no round", () => {
    expect(roundForStart(run([{ kind: "phase", phase: "implementation" }]), "claude")).toBe("implementation");
    expect(roundForStart(run([{ kind: "phase", phase: "ended" }]), "codex")).toBeNull();
  });
});

describe("stageOf", () => {
  it("derives the stage from phase and consensus", () => {
    expect(stageOf(INITIAL_STATUS)).toBe("debate");
    expect(stageOf(run([{ kind: "consensus-reached" }]))).toBe("consensus");
    expect(stageOf(run([{ kind: "consensus-reached" }, { kind: "phase", phase: "implementation" }]))).toBe(
      "implementation",
    );
    expect(stageOf(run([{ kind: "phase", phase: "ended" }]))).toBe("ended");
  });
});

describe("statusLine", () => {
  it("shows both agents with their stance", () => {
    const s = run([done("claude", ok("consensus")), done("codex", ok("wait-human"))]);
    const line = statusLine(s);
    expect(line.map((x) => x.text)).toEqual(["Claude ✓ ready", " · ", "Codex ? asks you"]);
    expect(line[0]?.color).toBe(AGENT_STYLE.claude.color);
    expect(line[2]?.color).toBe(AGENT_STYLE.codex.color);
  });

  it("shows the other stances", () => {
    const s = run([done("claude", ok("continue"))]);
    expect(statusLine(s).map((x) => x.text)).toEqual(["Claude → continues", " · ", "Codex ·"]);
  });

  it("statusLine shows only consensus once both agree", () => {
    const s = run([done("claude", ok("consensus")), done("codex", ok("consensus")), { kind: "consensus-reached" }]);
    expect(statusLine(s)).toEqual([{ text: "✓ Consensus", color: CONSENSUS_COLOR }]);
  });
});
