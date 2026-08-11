import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamController } from "../streamController.js";

function collector() {
  const writes: string[] = [];
  return { writes, write: (data: string) => writes.push(data) };
}

describe("StreamController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("n'écrit rien avant la cadence de rendu", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(["une"]);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(32);
    expect(writes).toEqual(["une\n"]);
  });

  it("regroupe une rafale de lignes en une seule écriture", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    for (let i = 0; i < 40; i++) c.push([`ligne ${i}`]);
    vi.advanceTimersByTime(32);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.split("\n")).toHaveLength(41);
  });

  it("termine toujours le bloc par une fin de ligne", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(["a", "b"]);
    c.flush();
    expect(writes[0]).toBe("a\nb\n");
  });

  it("préserve l'ordre entre écritures immédiates et différées", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(["streaming"]);
    c.push(["intervention"]);
    c.flush();
    c.push(["suite"]);
    c.flush();
    expect(writes).toEqual(["streaming\nintervention\n", "suite\n"]);
  });

  it("n'écrit jamais un bloc vide", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.flush();
    c.push([]);
    vi.advanceTimersByTime(100);
    expect(writes).toEqual([]);
  });

  it("n'émet aucune séquence d'effacement", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(["du texte"]);
    c.flush();
    expect(writes.join("")).not.toMatch(/\u001b\[[0-9]*[JH]/);
  });

  it("signale chaque flush pour rafraîchir le pied de page", () => {
    const onFlush = vi.fn();
    const c = new StreamController({ write: () => {}, onFlush });
    c.schedule();
    vi.advanceTimersByTime(32);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("vide ce qui reste à la fermeture, puis n'écrit plus rien", () => {
    const { writes, write } = collector();
    const c = new StreamController({ write });
    c.push(["dernier"]);
    c.dispose();
    expect(writes).toEqual(["dernier\n"]);
    c.push(["après"]);
    vi.advanceTimersByTime(100);
    expect(writes).toEqual(["dernier\n"]);
  });
});
