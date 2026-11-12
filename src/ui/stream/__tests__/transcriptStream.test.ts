import chalk from "chalk";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../../../types.js";
import type { Signal } from "../../../orchestrator/types.js";
import { displayWidth } from "../lineBuffer.js";
import { TranscriptStream, type TailView } from "../transcriptStream.js";

chalk.level = 3;

let seq = 0;
function entry(partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, "from" | "kind">): TranscriptEntry {
  return { id: `e${++seq}`, text: "", timestamp: Date.parse("2026-08-09T14:30:00Z"), ...partial };
}

function harness(width = 60) {
  const writes: string[] = [];
  const tails: (TailView | null)[] = [];
  const stream = new TranscriptStream({
    write: (data) => writes.push(data),
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
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });

    const lines = plain().split("\n");
    expect(lines[0]).toContain("Claude");
    expect(lines[0]).not.toContain("● Claude");
    expect(lines).toContain("│ Hello.");
    expect(output()).toContain("\u001b[38;5;210m");
  });

  it("ends every write with a line end", () => {
    const { stream, writes } = harness();
    const e = entry({ from: "codex", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "one line\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
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
    expect(rendered).toMatch(/^:: Topic: /);
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
    const claude = lines.findIndex((line) => line.includes("Claude"));
    expect(lines.slice(subject + 1, claude)).toEqual(["", ""]);
  });

  it("never emits a clearing sequence", () => {
    const { stream, output } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    // Even if the agent produces one itself.
    stream.chunk(e.id, "before\u001b[2J\u001b[3Jafter\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
    expect(output()).not.toMatch(/\u001b\[[0-9]*[JH]/);
    expect(output()).toContain("beforeafter");
  });

  it("replaces status pictograms before wrapping the line", () => {
    const { stream, plain } = harness(40);
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, `${"✓".repeat(30)}${"text rather long ".repeat(8)}\n`);
    stream.entryCompleted(e.id, { status: "ok", signal: null });

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
    stream.entryCompleted(e.id, { status: "ok", signal: "consensus" });
    expect(plain()).not.toContain("CONSENSUS");
    expect(plain()).toContain("Agreed.");
  });

  it("keeps the marker if the turn did not confirm it", () => {
    const { stream, plain } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "Text\n<<CONSENSUS>>\nactually no\n");
    stream.entryCompleted(e.id, { status: "ok", signal: null });
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
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });

    const body = plain();
    expect(body.indexOf("I am looking at the file")).toBeLessThan(body.indexOf("Read src/cli.tsx"));
    expect(body.indexOf("Read src/cli.tsx")).toBeLessThan(body.indexOf("and I continue"));
  });

  it("writes nothing for an entry that is no longer active", () => {
    const { stream, writes } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
    const before = writes.length;
    stream.chunk(e.id, "too late");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
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
      stream.entryCompleted(e.id, { status: "ok", signal, closesDebate });
      return plain();
    };

    it("names the decision and who gets the turn", () => {
      expect(verdictOf("claude", "continue")).toContain("-> continues · hands over to Codex");
      expect(verdictOf("codex", "continue")).toContain("-> continues · hands over to Claude");
    });

    // A lone agreement lets the debate run, the pair stops it: the two
    // situations must not read the same.
    it("tells the first agreement from the one that closes the debate", () => {
      const first = verdictOf("claude", "consensus");
      expect(first).toContain("Claude is ready for a consensus");
      expect(first).toContain("over to Codex");
      expect(first).not.toContain("approved");

      const last = verdictOf("codex", "consensus", true);
      expect(last).toContain("Consensus approved");
      expect(last).toContain("the debate is closed");
    });

    it("tells an agreement from a human wait", () => {
      expect(verdictOf("codex", "wait-human")).toContain("[pause] waiting for your answer");
    });

    it("says explicitly that a turn signalled nothing", () => {
      expect(verdictOf("claude", null)).toContain("[!] no decision signalled");
    });

    // Originally silent, when a non-topic closed the session: the return to the
    // welcome screen said it. The conversation stays open now, so this turn
    // must announce its decision and what follows like all the others.
    it("announces that there is no topic, and what happens next", () => {
      const verdict = verdictOf("claude", "no-topic");
      expect(verdict).toContain("No topic to debate");
      expect(verdict).toContain("next message");
    });

    it("stays silent on the synthesis, which decides nothing", () => {
      const { stream, plain } = harness();
      const e = entry({ from: "system", kind: "summary" });
      stream.entryStarted(e);
      stream.chunk(e.id, "Final specification.\n");
      stream.entryCompleted(e.id, { status: "ok", signal: null });
      expect(plain()).not.toContain("no decision signalled");
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
    expect(cancelled.plain()).toContain("(Cancelled)");
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
    expect(plain()).toContain("│ Claude");
    expect(plain()).toContain("│ Codex");
    expect(plain()).not.toMatch(/● (?:Claude|Codex)|CLAUDE|CODEX/);
  });

  it("never rewrites what is already written", () => {
    const { stream, writes } = harness();
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "line one\n");
    const afterFirst = writes.join("");
    stream.chunk(e.id, "line two\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
    expect(writes.join("").startsWith(afterFirst)).toBe(true);
  });

  it("keeps an update cost independent of the history length", () => {
    const { stream, writes } = harness();
    for (let i = 0; i < 200; i++) {
      const e = entry({ from: "claude", kind: "message" });
      stream.entryStarted(e);
      stream.chunk(e.id, `turn ${i}\n`);
      stream.entryCompleted(e.id, { status: "ok", signal: "continue" });
    }
    // Each write carries only new text: the sum stays linear.
    const total = writes.join("").length;
    expect(total).toBeLessThan(200 * 400);
  });

  it("wraps at the current width and applies a resize to the following lines", () => {
    const writes: string[] = [];
    let width = 30;
    const stream = new TranscriptStream({
      write: (d) => writes.push(d),
      width: () => width,
      onTail: () => {},
      intervalMs: 0,
    });
    const e = entry({ from: "claude", kind: "message" });
    stream.entryStarted(e);
    stream.chunk(e.id, "a text long enough to need wrapping several times\n");
    width = 80;
    stream.chunk(e.id, "and a second line just as long but which fits now\n");
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });

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
      write: (d) => writes.push(d),
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
    stream.entryCompleted(e.id, { status: "ok", signal: "continue" });

    // "│" followed by a space would be copied along with the text on selection.
    expect(plain().split("\n")).not.toContain("│ ");
  });
});
