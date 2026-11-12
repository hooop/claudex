import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamController, line, type TranscriptLine } from "../streamController.js";

const L = (...texts: string[]): TranscriptLine[] => texts.map((t) => line(t));

function collector() {
  const writes: TranscriptLine[][] = [];
  return { writes, write: (lines: readonly TranscriptLine[]) => writes.push([...lines]) };
}

describe("StreamController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes nothing before the render cadence", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(L("one"));
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(32);
    expect(writes).toEqual([[{ styled: "one", softWrap: false }]]);
  });

  it("groups a burst of lines into a single write", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    for (let i = 0; i < 40; i++) c.push(L(`line ${i}`));
    vi.advanceTimersByTime(32);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(40);
  });

  it("passes each line on whole, with its soft-wrap flag", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push([line("a"), line("b", true)]);
    c.flush();
    expect(writes[0]).toEqual([
      { styled: "a", softWrap: false },
      { styled: "b", softWrap: true },
    ]);
  });

  it("preserves the order between immediate and deferred writes", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(L("streaming"));
    c.push(L("intervention"));
    c.flush();
    c.push(L("next"));
    c.flush();
    expect(writes.map((w) => w.map((l) => l.styled))).toEqual([["streaming", "intervention"], ["next"]]);
  });

  it("never writes an empty block", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.flush();
    c.push([]);
    vi.advanceTimersByTime(100);
    expect(writes).toEqual([]);
  });

  it("emits no clearing sequence", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(L("some text"));
    c.flush();
    expect(writes.flat().map((l) => l.styled).join("")).not.toMatch(/\u001b\[[0-9]*[JH]/);
  });

  it("reports every flush to refresh the footer", () => {
    const onFlush = vi.fn();
    const c = new StreamController({ write: () => {}, onFlush });
    c.schedule();
    vi.advanceTimersByTime(32);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("flushes what remains on dispose, then writes nothing more", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(L("last"));
    c.dispose();
    expect(writes.map((w) => w.map((l) => l.styled))).toEqual([["last"]]);
    c.push(L("after"));
    vi.advanceTimersByTime(100);
    expect(writes.map((w) => w.map((l) => l.styled))).toEqual([["last"]]);
  });
});
