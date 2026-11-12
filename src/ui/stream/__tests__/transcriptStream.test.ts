import chalk from "chalk";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../../../types.js";
import type { EntryOutcome, Signal } from "../../../orchestrator/types.js";
import { ERROR_STYLE } from "../../theme.js";
import { displayWidth } from "../lineBuffer.js";
import type { TranscriptLine } from "../streamController.js";
import { TranscriptStream, type TailView } from "../transcriptStream.js";

chalk.level = 3;

let seq = 0;
function entry(partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, "from" | "kind">): TranscriptEntry {
  return { id: `e${++seq}`, text: "", timestamp: Date.parse("2026-08-09T14:30:00Z"), ...partial };
}

/** The old block shape, so the assertions below keep reading the same text. */
const block = (lines: readonly TranscriptLine[]) => lines.map((l) => l.styled).join("\n") + "\n";

function harness(width = 60) {
  const writes: string[] = [];
  const tails: (TailView | null)[] = [];
  const stream = new TranscriptStream({
    write: (lines) => writes.push(block(lines)),
    width: () => width,
    onTail: (tail) => tails.push(tail),
    intervalMs: 0,
  });
  const output = () => writes.join("");
  const plain = () => output().replace(/\u001b\[[0-9;]*m/g, "");
  return { stream, writes, tails, output, plain };
}

describe("TranscriptStream", () => {
  it("writes a header then the message body", () => {
    const { stream, output, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Hello.\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });

    const lines = plain().split("\n");
    expect(lines[0]).toMatch(/^◆ CLAUDE {2,}\d\d:\d\d$/u);
    expect(lines).toContain("│ Hello.");
    expect(output()).toContain("\u001b[38;5;210m");
  });

  it("ends every write with a line end", () => {
    const { stream, writes } = harness();
    const e = entry({ from: "codex", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "one line\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });
    for (const write of writes) expect(write.endsWith("\n")).toBe(true);
  });

  it("truncates the topic shown on one row without modifying the canonical entry", () => {
    const { stream, plain } = harness(40);
    const e = entry({
      from: "system",
      kind: "system",
      text: `Topic: ${"distributed architecture ".repeat(5)}\nwith resume`,
    });
    const canonicalText = e.text;

    stream.entry(e);

    const rendered = plain().trimEnd();
    expect(rendered).toMatch(/^· Topic: /);
    expect(rendered).toMatch(/\.\.\.$/);
    expect(displayWidth(rendered)).toBeLessThanOrEqual(40);
    expect(rendered).not.toContain("\n");
    expect(e.text).toBe(canonicalText);
  });

  it("leaves two blank lines between the topic and Claude's first turn", () => {
    const { stream, plain } = harness();
    stream.entry(entry({ from: "system", kind: "system", text: "Topic: architecture" }));
    stream.entryStarted(entry({ from: "claude", kind: "message" }));

    const lines = plain().split("\n");
    const subject = lines.findIndex((line) => line.includes("Topic: architecture"));
    const claude = lines.findIndex((line) => line.includes("CLAUDE"));
    expect(lines.slice(subject + 1, claude)).toEqual(["", ""]);
  });

  it("never emits a clearing sequence", () => {
    const { stream, output } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    // Even if the agent produces one itself.
    stream.chunk(e.id, "before\u001b[2J\u001b[3Jafter\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });
    expect(output()).not.toMatch(/\u001b\[[0-9]*[JH]/);
    expect(output()).toContain("beforeafter");
  });

  it("replaces status pictograms before wrapping the line", () => {
    const { stream, plain } = harness(40);
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, `${"✓".repeat(30)}${"text rather long ".repeat(8)}\n`);
    stream.entryCompleted(e.id, { status: "ok", signal: null, counted: true });

    const body = plain()
      .split("\n")
      .filter((line) => line.includes("text") || line.includes("rather long"));
    expect(body.length).toBeGreaterThan(1);
    for (const line of body) expect(displayWidth(line)).toBeLessThanOrEqual(40);
    expect(plain()).not.toContain("✓");
    expect(plain()).toContain("[ok][ok]");
  });

  it("never commits a confirmed marker", () => {
    const { stream, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Agreed.\n\n");
    stream.chunk(e.id, "<<CONSENSUS>>");
    stream.entryCompleted(e.id, { status: "ok", signal: "consensus", counted: true });
    expect(plain()).not.toContain("CONSENSUS");
    expect(plain()).toContain("Agreed.");
  });

  it("keeps the marker if the turn did not confirm it", () => {
    const { stream, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Text\n<<CONSENSUS>>\nactually no\n");
    stream.entryCompleted(e.id, { status: "ok", signal: null, counted: true });
    expect(plain()).toContain("<<CONSENSUS>>");
    expect(plain()).toContain("actually no");
  });

  it("keeps the incomplete line out of the terminal, in the tail", () => {
    const { stream, plain, tails } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "a sentence with no end");
    stream.flush();
    expect(plain()).not.toContain("a sentence with no end");
    expect(tails.at(-1)?.text).toBe("a sentence with no end");
  });

  it("interleaves a note into a running answer, closing the open line", () => {
    const { stream, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "I am looking at the file");
    stream.entry(entry({ from: "claude", kind: "system", text: "Read src/cli.tsx" }));
    stream.chunk(e.id, " and I continue\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });

    const body = plain();
    expect(body.indexOf("I am looking at the file")).toBeLessThan(body.indexOf("Read src/cli.tsx"));
    expect(body.indexOf("Read src/cli.tsx")).toBeLessThan(body.indexOf("and I continue"));
  });

  it("writes nothing for an entry that is no longer active", () => {
    const { stream, writes } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });
    const before = writes.length;
    stream.chunk(e.id, "too late");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });
    expect(writes.length).toBe(before);
  });

  describe("end-of-turn verdict", () => {
    // The protocol marker is filtered out of the transcript: without this line,
    // one reads an answer without knowing what the agent decided, or why the
    // debate stops or continues.
    const verdictOf = (from: "claude" | "codex", signal: Signal, closesDebate = false) => {
      const { stream, plain } = harness();
      const e = entry({ from, kind: "message" });
      stream.entryStarted(e);
      stream.chunk(e.id, "My analysis.\n");
      stream.entryCompleted(e.id, { status: "ok", signal, counted: true, closesDebate });
      return plain();
    };

    it("names the decision and who gets the turn", () => {
      expect(verdictOf("claude", "continue")).toContain("→ Continues · over to Codex");
      expect(verdictOf("codex", "continue")).toContain("→ Continues · over to Claude");
    });

    // A lone agreement lets the debate run, the pair stops it: the two
    // situations must not read the same.
    it("tells the first agreement from the one that closes the debate", () => {
      const first = verdictOf("claude", "consensus");
      expect(first).toContain("✓ Ready for consensus · over to Codex");
      expect(first).not.toContain("approved");

      const last = verdictOf("codex", "consensus", true);
      expect(last).toContain("Consensus approved");
      expect(last).toContain("the debate is closed");
    });

    it("tells an agreement from a human wait", () => {
      expect(verdictOf("codex", "wait-human")).toContain("? Waiting for your answer");
    });

    it("says explicitly that a turn signalled nothing", () => {
      expect(verdictOf("claude", null)).toContain("! No decision signalled");
    });

    // Originally silent, when a non-topic closed the session: the return to the
    // welcome screen said it. The conversation stays open now, so this turn
    // must announce its decision and what follows like all the others.
    it("announces that there is no topic, and what happens next", () => {
      const verdict = verdictOf("claude", "no-topic");
      expect(verdict).toContain("· No topic to debate · the debate starts on your next message");
    });

    it("stays silent on the synthesis, which decides nothing", () => {
      const { stream, plain } = harness();
      const e = entry({ from: "system", kind: "summary" });
      stream.entryStarted(e);
      stream.chunk(e.id, "Final specification.\n");
      stream.entryCompleted(e.id, { status: "ok", signal: null, counted: true });
      expect(plain()).not.toContain("No decision signalled");
    });

    it("lets an error replace the verdict", () => {
      const { stream, plain } = harness();
      const e = entry({ from: "claude", kind: "message" });
      stream.entryStarted(e);
      stream.entryCompleted(e.id, { status: "error", message: "network down" });
      expect(plain()).toContain("Error: network down");
      expect(plain()).not.toContain("continues");
    });
  });

  it("reports an error and a cancellation at the end of a turn", () => {
    const err = harness();
    const e1 = entry({ from: "codex", kind: "message" });
    err.stream.entryStarted(e1);
    err.stream.entryCompleted(e1.id, { status: "error", message: "network down" });
    expect(err.plain()).toContain("Error: network down");

    const cancelled = harness();
    const e2 = entry({ from: "codex", kind: "message" });
    cancelled.stream.entryStarted(e2);
    cancelled.stream.entryCompleted(e2.id, { status: "cancelled" });
    expect(cancelled.plain()).toContain("· Cancelled");
  });

  it("visually tells Claude, Codex and the human apart", () => {
    const { stream, output, plain } = harness();
    for (const from of ["claude", "codex", "human"] as const) {
      const e = entry({ from, kind: from === "human" ? "intervention" : "message", text: "hi" });
      stream.entry(e);
    }
    // A distinct color per author, on the rail as on the badge.
    const colors = new Set(output().match(/\u001b\[38;(?:2;[0-9;]+|5;\d+)m/g) ?? []);
    expect(colors.size).toBeGreaterThanOrEqual(3);
    expect(output()).toContain("\u001b[38;5;210m");
    expect(output()).toContain("\u001b[38;5;159m");
    expect(plain()).toContain("◆ CLAUDE");
    expect(plain()).toContain("◆ CODEX");
    expect(plain()).toContain("◆ YOU");
  });

  it("never rewrites what is already written", () => {
    const { stream, writes } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "line one\n");
    const afterFirst = writes.join("");
    stream.chunk(e.id, "line two\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });
    expect(writes.join("").startsWith(afterFirst)).toBe(true);
  });

  it("keeps an update cost independent of the history length", () => {
    const { stream, writes } = harness();
    for (let i = 0; i < 200; i++) {
      const e = entry({ from: "claude", kind: "message" });
      stream.entryStarted(e);
      stream.chunk(e.id, `turn ${i}\n`);
      stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });
    }
    // Each write carries only new text: the sum stays linear.
    const total = writes.join("").length;
    expect(total).toBeLessThan(200 * 400);
  });

  it("wraps at the current width and applies a resize to the following lines", () => {
    const writes: string[] = [];
    let width = 30;
    const stream = new TranscriptStream({
      write: (lines) => writes.push(block(lines)),
      width: () => width,
      onTail: () => {},
      intervalMs: 0,
    });
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "a text long enough to need wrapping several times\n");
    width = 80;
    stream.chunk(e.id, "and a second line just as long but which fits now\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });

    const lines = writes.join("").replace(/\u001b\[[0-9;]*m/g, "").split("\n");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(lines.some((l) => l.includes("which fits now"))).toBe(true);
  });

  it("flushes the pending line on dispose", () => {
    const { stream, plain, tails } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "cut short");
    stream.dispose();
    expect(plain()).toContain("cut short");
    expect(tails.at(-1)).toBeNull();
  });
});

describe("TranscriptStream — cadence", () => {
  it("does not write once per token", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const stream = new TranscriptStream({
      write: (lines) => writes.push(block(lines)),
      width: () => 60,
      onTail: () => {},
    });
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    for (let i = 0; i < 50; i++) stream.chunk(e.id, `word ${i}\n`);
    // Nothing went out until the cadence is reached.
    const afterStart = writes.length;
    vi.advanceTimersByTime(32);
    expect(writes.length).toBe(afterStart + 1);
    vi.useRealTimers();
  });
});

describe("TranscriptStream — frozen lines", () => {
  it("commits the character held by the sanitizer before freezing the line", () => {
    const { stream, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    // The final "4" is held: a following fragment could turn it into a keycap.
    stream.chunk(e.id, "budget of 4");
    stream.raw(["---"]);
    stream.chunk(e.id, "2 dollars\n");

    const lines = plain().split("\n");
    expect(lines).toContain("│ budget of 4");
    expect(plain()).not.toContain("42 dollars");
  });

  it("leaves the rail bare on a code fence line", () => {
    const { stream, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "```ts\nconst a = 1;\n```\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });

    // "│" followed by a space would be copied along with the text on selection.
    expect(plain().split("\n")).not.toContain("│ ");
  });
});

describe("TranscriptStream — reset", () => {
  /** A writer that keeps whole lines, like `DebateView`, so it can rewind. */
  function rewindingHarness(width = 60) {
    const lines: string[] = [];
    const tails: (TailView | null)[] = [];
    const stream = new TranscriptStream({
      write: (written) => lines.push(...written.map((l) => l.styled)),
      width: () => width,
      onTail: (tail) => tails.push(tail),
      intervalMs: 0,
      length: () => lines.length,
      rewind: (toLength) => {
        lines.length = toLength;
      },
    });
    const plainLines = () => lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
    return { stream, lines, tails, plainLines };
  }

  it("removes a note from the running entry", () => {
    const { stream, plainLines, tails } = rewindingHarness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Looking around.\nStill looking");
    stream.flush();
    stream.reset(e.id, "");
    expect(tails.at(-1)).toBeNull();
    stream.chunk(e.id, "Answer.");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });

    const lines = plainLines();
    expect(lines[0]).toContain("CLAUDE");
    expect(lines[1]).toBe("│ Answer.");
    expect(lines.join("\n")).not.toContain("Looking around.");
    expect(lines.join("\n")).not.toContain("Still looking");
  });

  it("keeps interleaved lines after a reset", () => {
    const { stream, plainLines } = rewindingHarness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Note line\n");
    stream.entry(entry({ from: "human", kind: "message", text: "Please hurry." }));
    stream.reset(e.id, "");
    stream.chunk(e.id, "Answer.\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });

    const lines = plainLines();
    const text = lines.join("\n");
    expect(text).not.toContain("Note line");
    expect(text.split("Please hurry.").length - 1).toBe(1);
    const header = lines.findIndex((line) => line.includes("CLAUDE"));
    const intervention = lines.findIndex((line) => line.includes("Please hurry."));
    const answer = lines.indexOf("│ Answer.");
    expect(header).toBe(0);
    expect(intervention).toBeGreaterThan(header);
    expect(answer).toBeGreaterThan(intervention);
  });

  it("re-renders the new body before the interleaved lines", () => {
    const { stream, plainLines } = rewindingHarness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Kept part. Note");
    stream.raw(["--- frozen ---"]);
    stream.reset(e.id, "Kept part.");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });

    const lines = plainLines();
    expect(lines.slice(1, 3)).toEqual(["│ Kept part.", "--- frozen ---"]);
    expect(lines.join("\n")).not.toContain("Note");
  });

  it("holds back a protocol marker in the reset text until the verdict", () => {
    const { stream, plainLines } = rewindingHarness();
    const e = entry({ from: "codex", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Draft.\n");
    stream.reset(e.id, "Final.\n<<CONTINUE>>");
    expect(plainLines().join("\n")).not.toContain("<<CONTINUE>>");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });

    const text = plainLines().join("\n");
    expect(text).toContain("│ Final.");
    expect(text).not.toContain("Draft.");
    expect(text).not.toContain("<<CONTINUE>>");
  });

  it("forgets the interleaved lines once the entry is complete", () => {
    const { stream, plainLines } = rewindingHarness();
    const first = entry({ from: "claude", kind: "message" });
    stream.entryStarted(first);
    stream.raw(["--- once ---"]);
    stream.entryCompleted(first.id, { status: "ok", signal: "continue", counted: true });
    const second = entry({ from: "codex", kind: "message" });
    stream.entryStarted(second);
    stream.chunk(second.id, "Note\n");
    stream.reset(second.id, "");
    stream.entryCompleted(second.id, { status: "ok", signal: "continue", counted: true });

    expect(plainLines().filter((line) => line === "--- once ---")).toHaveLength(1);
    expect(plainLines().join("\n")).not.toContain("Note");
  });

  it("ignores a reset for an inactive entry", () => {
    const { stream, plainLines } = rewindingHarness();
    const done = entry({ from: "claude", kind: "message" });
    stream.entryStarted(done);
    stream.chunk(done.id, "Finished.\n");
    stream.entryCompleted(done.id, { status: "ok", signal: "continue", counted: true });
    const running = entry({ from: "codex", kind: "message" });
    stream.entryStarted(running);
    stream.chunk(running.id, "Running.\n");
    stream.flush();
    const before = plainLines();

    stream.reset(done.id, "");
    stream.reset("unknown", "");

    expect(plainLines()).toEqual(before);
  });

  it("does nothing without a rewinding writer", () => {
    const run = (withReset: boolean) => {
      const { stream, output } = harness();
      const e = entry({ id: "fixed", from: "claude", kind: "message" });
      stream.entryStarted(e);
      stream.chunk(e.id, "Looking.\n");
      if (withReset) stream.reset(e.id, "");
      stream.chunk(e.id, "Answer.\n");
      stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });
      return output();
    };
    expect(run(true)).toBe(run(false));
  });
});

describe("TranscriptStream — soft wraps", () => {
  it("marks wrapped continuation lines as soft wraps", () => {
    const written: TranscriptLine[] = [];
    const stream = new TranscriptStream({
      write: (lines) => written.push(...lines),
      width: () => 30,
      onTail: () => {},
      intervalMs: 0,
    });
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue", counted: true });
    stream.dispose();

    const body = written.filter((l) => l.styled.includes("alpha") || l.softWrap);
    expect(body.map((l) => l.softWrap)).toEqual([false, true, true]);
    // Headers, the blank separators and the verdict are never soft wraps.
    expect(written.filter((l) => !body.includes(l)).some((l) => l.softWrap)).toBe(false);
  });
});

describe("TranscriptStream — multi-line input", () => {
  it("writes one line per row of a multi-line error message", () => {
    // `count` is kept by the writer itself, independently of the rows asserted on.
    let count = 0;
    const rows: string[] = [];
    const stream = new TranscriptStream({
      write: (lines) => {
        count += lines.length;
        rows.push(...lines.map((l) => l.styled));
      },
      width: () => 60,
      onTail: () => {},
      length: () => count,
      rewind: (n) => {
        count = n;
        rows.length = n;
      },
      intervalMs: 0,
    });
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    const before = count;
    stream.entryCompleted(e.id, { status: "error", message: "first\nsecond" });
    const plain = rows.slice(before).map((r) => r.replace(/\u001b\[[0-9;]*m/g, ""));
    // Two error rows, then the blank separator that closes every entry.
    expect(plain).toEqual([`${ERROR_STYLE.badge} Error: first`, "second", ""]);
    expect(count - before).toBe(3);
    expect(rows.every((r) => !r.includes("\n"))).toBe(true);
  });

  it("splits raw lines that contain a line break, CRLF included", () => {
    const rows: string[] = [];
    const stream = new TranscriptStream({
      write: (lines) => rows.push(...lines.map((l) => l.styled)),
      width: () => 60,
      onTail: () => {},
      intervalMs: 0,
    });
    stream.raw(["a\nb", "c\r\nd"]);
    expect(rows).toEqual(["a", "b", "c", "d"]);
  });
});

describe("TranscriptStream — turn blocks", () => {
  const ok = (signal: Signal, extra: Partial<Extract<EntryOutcome, { status: "ok" }>> = {}): EntryOutcome => ({
    status: "ok",
    signal,
    counted: true,
    ...extra,
  });
  const clock = (e: TranscriptEntry) => {
    const d = new Date(e.timestamp);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  function withRound(round: (e: TranscriptEntry) => number | null, width = 60) {
    const writes: string[] = [];
    const stream = new TranscriptStream({
      write: (lines) => writes.push(block(lines)),
      width: () => width,
      onTail: () => {},
      intervalMs: 0,
      round,
    });
    const plainRows = () => writes.join("").replace(/\u001b\[[0-9;]*m/g, "").split("\n");
    return { stream, plainRows };
  }

  it("right-aligns round and clock to the content width", () => {
    const { stream, plainRows } = withRound(() => 3);
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    const header = plainRows()[0]!;
    expect(header.startsWith("◆ CLAUDE")).toBe(true);
    expect(header.endsWith(`Round 3 · ${clock(e)}`)).toBe(true);
    expect(displayWidth(header)).toBe(60);
  });

  it("omits the round when the callback returns null", () => {
    const { stream, plainRows } = withRound(() => null);
    const e = entry({ from: "codex", kind: "message" });
    stream.entryStarted(e);
    const header = plainRows()[0]!;
    expect(header.endsWith(`  ${clock(e)}`)).toBe(true);
    expect(header).not.toContain("Round");
    expect(displayWidth(header)).toBe(60);
  });

  it("calls the round callback once per agent entry, at the start", () => {
    const round = vi.fn(() => 2);
    const { stream } = withRound(round);
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "text\n");
    stream.entryCompleted(e.id, ok("continue"));
    expect(round).toHaveBeenCalledTimes(1);
    expect(round).toHaveBeenCalledWith(e);
  });

  it("shows no round for a human intervention and names its target", () => {
    const { stream, plainRows } = withRound(() => 5);
    stream.entry(entry({ from: "human", kind: "intervention", text: "stop", to: "both" }));
    stream.entry(entry({ from: "human", kind: "intervention", text: "you", to: "claude" }));
    const rows = plainRows();
    expect(rows[0]).toMatch(/^◆ YOU → both {2,}\d\d:\d\d$/u);
    expect(rows.find((r) => r.startsWith("◆ YOU → claude"))).toMatch(/^◆ YOU → claude {2,}\d\d:\d\d$/u);
    expect(rows.join("\n")).not.toContain("Round");
  });

  it("puts the body directly under the header, behind the rail", () => {
    const { stream, plainRows } = withRound(() => null);
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Hello.\n");
    stream.flush();
    expect(plainRows().slice(0, 2)).toEqual([expect.stringMatching(/^◆ CLAUDE/u), "│ Hello."]);
  });

  describe("verdicts", () => {
    const verdictRows = (outcome: EntryOutcome) => {
      const { stream, plainRows } = withRound(() => null);
      const e = entry({ from: "codex", kind: "message" });
      stream.entryStarted(e);
      stream.chunk(e.id, "Body.\n");
      stream.entryCompleted(e.id, outcome);
      return plainRows();
    };

    it("follows the body with a blank rail line, the verdict and a blank line", () => {
      expect(verdictRows(ok("continue")).slice(1, 6)).toEqual([
        "│ Body.",
        "│",
        "│ → Continues · over to Claude",
        "",
        "",
      ]);
    });

    it("closes the debate with the approved wording", () => {
      expect(verdictRows(ok("consensus", { closesDebate: true }))).toContain(
        "│ ✓ Consensus approved · the debate is closed",
      );
    });

    it("shows the set-aside verdict for an uncounted signal", () => {
      for (const signal of ["continue", "consensus", "wait-human", "no-topic"] as const) {
        const rows = verdictRows(ok(signal, { counted: false }));
        expect(rows).toContain("│ · Signal set aside: your message arrived during this turn");
        expect(rows.join("\n")).not.toContain("Continues");
      }
    });

    it("still reports a missing signal when it was not counted", () => {
      expect(verdictRows(ok(null, { counted: false }))).toContain("│ ! No decision signalled");
    });

    it("colours the glyph with the author and dims the words", () => {
      const { stream, output } = harness();
      const e = entry({ from: "codex", kind: "message" });
      stream.entryStarted(e);
      stream.entryCompleted(e.id, ok("continue"));
      expect(output()).toContain(`\u001b[38;5;159m→\u001b[39m`);
      expect(output()).toContain(chalk.dim("Continues · over to Claude"));
    });
  });

  describe("system lines", () => {
    it("writes a notice as a dim dot line without a rail", () => {
      const { stream, output, plain } = harness();
      stream.entry(entry({ from: "system", kind: "system", text: "Switched model" }));
      expect(plain().split("\n")[0]).toBe("· Switched model");
      expect(output()).toContain(chalk.dim(chalk.hex("#8b949e")("· Switched model")));
    });

    it("writes an error entry with a bang in the error colour, not dimmed", () => {
      const { stream, output, plain } = harness();
      stream.entry(entry({ from: "system", kind: "error", text: "boom" }));
      expect(plain().split("\n")[0]).toBe("! boom");
      expect(output()).toContain(chalk.hex(ERROR_STYLE.color)("! boom"));
    });
  });

  describe("continued header", () => {
    it("writes a continued header when an intervention interrupts a running turn", () => {
      const { stream, plain } = harness();
      const e = entry({ from: "codex", kind: "message" });
      stream.entryStarted(e);
      stream.chunk(e.id, "First part.\n");
      stream.entry(entry({ from: "human", kind: "intervention", text: "wait", to: "codex" }));
      stream.chunk(e.id, "Second part.\n");
      stream.entryCompleted(e.id, ok("continue"));

      const rows = plain().split("\n");
      const resumed = rows.indexOf("│ Second part.");
      expect(rows[resumed - 1]).toBe("◆ CODEX (continued)");
      expect(rows.filter((r) => r.includes("(continued)"))).toHaveLength(1);
      expect(rows.indexOf("│ First part.")).toBeLessThan(rows.findIndex((r) => r.includes("YOU")));
    });

    it("writes it once per interruption, not per chunk", () => {
      const { stream, plain } = harness();
      const e = entry({ from: "claude", kind: "message" });
      stream.entryStarted(e);
      stream.entry(entry({ from: "claude", kind: "system", text: "Read a.ts" }));
      stream.chunk(e.id, "one\n");
      stream.chunk(e.id, "two\n");
      stream.entry(entry({ from: "claude", kind: "system", text: "Read b.ts" }));
      stream.chunk(e.id, "three\n");
      stream.flush();
      expect(plain().split("\n").filter((r) => r === "◆ CLAUDE (continued)")).toHaveLength(2);
    });

    it("writes it before the verdict when the turn ends right after an interruption", () => {
      const { stream, plain } = harness();
      const e = entry({ from: "claude", kind: "message" });
      stream.entryStarted(e);
      stream.entry(entry({ from: "claude", kind: "system", text: "Read a.ts" }));
      stream.entryCompleted(e.id, ok("continue"));
      const rows = plain().split("\n");
      expect(rows[rows.indexOf("│ → Continues · over to Codex") - 2]).toBe("◆ CLAUDE (continued)");
    });

    it("does not write one when nothing interrupted the turn", () => {
      const { stream, plain } = harness();
      const e = entry({ from: "claude", kind: "message" });
      stream.entryStarted(e);
      stream.chunk(e.id, "one\n");
      stream.entryCompleted(e.id, ok("continue"));
      expect(plain()).not.toContain("(continued)");
    });

    it("writes it after a reset that replays interleaved lines, counting it as a normal line", () => {
      const lines: string[] = [];
      const stream = new TranscriptStream({
        write: (written) => lines.push(...written.map((l) => l.styled)),
        width: () => 60,
        onTail: () => {},
        intervalMs: 0,
        length: () => lines.length,
        rewind: (n) => {
          lines.length = n;
        },
      });
      const e = entry({ from: "claude", kind: "message" });
      stream.entryStarted(e);
      stream.chunk(e.id, "Note\n");
      stream.entry(entry({ from: "human", kind: "message", text: "hurry" }));
      stream.chunk(e.id, "more\n");
      stream.reset(e.id, "");
      stream.chunk(e.id, "Answer.\n");
      stream.flush();

      const rows = lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));
      expect(rows.filter((r) => r.includes("(continued)"))).toHaveLength(1);
      expect(rows.indexOf("◆ CLAUDE (continued)")).toBe(rows.indexOf("│ Answer.") - 1);
      expect(rows.join("\n")).not.toContain("Note");

      // A second reset rewinds exactly to the body start: nothing is left over.
      stream.reset(e.id, "");
      const after = lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));
      expect(after.filter((r) => r.includes("(continued)"))).toHaveLength(0);
      expect(after.filter((r) => r.includes("hurry"))).toHaveLength(1);
    });
  });

  describe("consensus summary", () => {
    it("frames the consensus summary with rules and keeps its markdown", () => {
      const { stream, output, plain } = harness();
      const e = entry({ from: "system", kind: "summary" });
      stream.entryStarted(e);
      stream.chunk(e.id, "## Decision\nUse **queues**.\n");
      stream.entryCompleted(e.id, ok(null));

      const rule = "━".repeat(60);
      expect(plain().split("\n")).toEqual([rule, "CONSENSUS", "", "Decision", "Use queues.", rule, "", ""]);
      expect(output()).toContain(chalk.hex("#57d68d")(rule));
      expect(output()).toContain(chalk.hex("#57d68d").bold("CONSENSUS"));
      expect(output()).toContain(chalk.bold("queues"));
    });

    it("frames a complete summary the same way", () => {
      const { stream, plain } = harness(40);
      stream.entry(entry({ from: "system", kind: "summary", text: "Done." }));
      const rule = "━".repeat(40);
      expect(plain().split("\n")).toEqual([rule, "CONSENSUS", "", "Done.", rule, "", ""]);
    });

    it("keeps a blank line inside the summary free of any rail", () => {
      const { stream, plain } = harness();
      stream.entry(entry({ from: "system", kind: "summary", text: "a\n\nb" }));
      expect(plain().split("\n")).not.toContain("│");
      expect(plain().split("\n").slice(3, 6)).toEqual(["a", "", "b"]);
    });
  });
});
