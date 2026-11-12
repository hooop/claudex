import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamController } from "../streamController.js";

function collector() {
  const writes: string[] = [];
  return { writes, write: (data: string) => writes.push(data) };
}

describe("StreamController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes nothing before the render cadence", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(["one"]);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(32);
    expect(writes).toEqual(["one\n"]);
  });

  it("groups a burst of lines into a single write", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    for (let i = 0; i < 40; i++) c.push([`line ${i}`]);
    vi.advanceTimersByTime(32);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.split("\n")).toHaveLength(41);
  });

  it("always ends the block with a line end", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(["a", "b"]);
    c.flush();
    expect(writes[0]).toBe("a\nb\n");
  });

  it("preserves the order between immediate and deferred writes", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(["streaming"]);
    c.push(["intervention"]);
    c.flush();
    c.push(["next"]);
    c.flush();
    expect(writes).toEqual(["streaming\nintervention\n", "next\n"]);
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
    c.push(["some text"]);
    c.flush();
    expect(writes.join("")).not.toMatch(/\u001b\[[0-9]*[JH]/);
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
    c.push(["last"]);
    c.dispose();
    expect(writes).toEqual(["last\n"]);
    c.push(["after"]);
    vi.advanceTimersByTime(100);
    expect(writes).toEqual(["last\n"]);
  });
});
