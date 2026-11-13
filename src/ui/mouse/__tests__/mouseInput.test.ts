import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render, Text, useInput, usePaste } from "ink";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMouseFilteredStdin, type MouseEvent, parseMouseChunk } from "../mouseInput.js";

const ESC = "\u001b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Feeds chunks one by one through the pure core, as the stream does. */
function feed(chunks: readonly string[]) {
  let rest = "";
  let inPaste = false;
  let forward = "";
  const events: MouseEvent[] = [];
  for (const chunk of chunks) {
    const result = parseMouseChunk(rest + chunk, inPaste);
    forward += result.forward;
    events.push(...result.events);
    rest = result.rest;
    inPaste = result.inPaste;
  }
  return { forward, events, rest, inPaste };
}

describe("parseMouseChunk — SGR decoding", () => {
  it("decodes a left press with 1-based terminal cells turned 0-based", () => {
    expect(parseMouseChunk(`${ESC}[<0;10;5M`, false)).toEqual({
      forward: "",
      events: [{ kind: "press", x: 9, y: 4 }],
      rest: "",
      inPaste: false,
    });
  });

  it("decodes a drag with the left button held", () => {
    expect(parseMouseChunk(`${ESC}[<32;3;7M`, false).events).toEqual([{ kind: "drag", x: 2, y: 6 }]);
  });

  it("decodes a release", () => {
    expect(parseMouseChunk(`${ESC}[<0;1;1m`, false).events).toEqual([{ kind: "release", x: 0, y: 0 }]);
  });

  it("decodes the wheel up and down", () => {
    expect(parseMouseChunk(`${ESC}[<64;20;12M${ESC}[<65;21;13M`, false).events).toEqual([
      { kind: "wheel", direction: "up", x: 19, y: 11 },
      { kind: "wheel", direction: "down", x: 20, y: 12 },
    ]);
  });

  it("ignores the horizontal wheel (buttons 66 and 67) without forwarding it", () => {
    expect(parseMouseChunk(`a${ESC}[<66;5;5M${ESC}[<67;5;5M${ESC}[<70;5;5Mb`, false)).toEqual({
      forward: "ab",
      events: [],
      rest: "",
      inPaste: false,
    });
  });

  it("ignores the modifier bits (shift, meta, ctrl)", () => {
    expect(parseMouseChunk(`${ESC}[<28;2;2M${ESC}[<80;4;4M`, false).events).toEqual([
      { kind: "press", x: 1, y: 1 },
      { kind: "wheel", direction: "up", x: 3, y: 3 },
    ]);
  });

  it("drops reports of other buttons without forwarding them", () => {
    expect(parseMouseChunk(`a${ESC}[<1;2;2M${ESC}[<2;2;2M${ESC}[<2;2;2mb`, false)).toEqual({
      forward: "ab",
      events: [],
      rest: "",
      inPaste: false,
    });
  });

  it("handles large coordinates", () => {
    expect(parseMouseChunk(`${ESC}[<0;300;120M`, false).events).toEqual([{ kind: "press", x: 299, y: 119 }]);
  });
});

describe("parseMouseChunk — what reaches Ink", () => {
  it("forwards a lone Esc immediately", () => {
    expect(parseMouseChunk(ESC, false)).toEqual({ forward: ESC, events: [], rest: "", inPaste: false });
  });

  it("forwards ESC [ at the end of a chunk immediately", () => {
    expect(parseMouseChunk(`x${ESC}[`, false)).toEqual({ forward: `x${ESC}[`, events: [], rest: "", inPaste: false });
  });

  it("forwards ESC [ A (arrow) untouched", () => {
    expect(parseMouseChunk(`${ESC}[A`, false)).toEqual({ forward: `${ESC}[A`, events: [], rest: "", inPaste: false });
  });

  it("forwards other escape sequences byte for byte", () => {
    const keys = `${ESC}[1;5C${ESC}OP${ESC}${ESC}[B${ESC}[3~${ESC}b\u007f\r`;
    expect(parseMouseChunk(keys, false)).toEqual({ forward: keys, events: [], rest: "", inPaste: false });
  });

  it("forwards an invalid ESC[<abc as is", () => {
    expect(parseMouseChunk(`${ESC}[<abc`, false)).toEqual({
      forward: `${ESC}[<abc`,
      events: [],
      rest: "",
      inPaste: false,
    });
  });

  it("forwards a report-shaped sequence with a wrong final byte as is", () => {
    expect(feed([`${ESC}[<0;1;1X`])).toEqual({ forward: `${ESC}[<0;1;1X`, events: [], rest: "", inPaste: false });
  });

  it("forwards typed keys interleaved with reports in order", () => {
    expect(feed([`ab${ESC}[<0;2;3Mc${ESC}[A${ESC}[<0;2;3md`])).toEqual({
      forward: `abc${ESC}[Ad`,
      events: [
        { kind: "press", x: 1, y: 2 },
        { kind: "release", x: 1, y: 2 },
      ],
      rest: "",
      inPaste: false,
    });
  });

  it("holds a report split over two chunks until it is complete", () => {
    const first = parseMouseChunk(`a${ESC}[<0;12`, false);
    expect(first).toEqual({ forward: "a", events: [], rest: `${ESC}[<0;12`, inPaste: false });

    const second = parseMouseChunk(`${first.rest};4Mb`, first.inPaste);
    expect(second).toEqual({ forward: "b", events: [{ kind: "press", x: 11, y: 3 }], rest: "", inPaste: false });
  });

  it("holds a bare ESC [ < at the end of a chunk", () => {
    expect(feed([`${ESC}[<`, "64;1;1M"])).toEqual({
      forward: "",
      events: [{ kind: "wheel", direction: "up", x: 0, y: 0 }],
      rest: "",
      inPaste: false,
    });
  });

  it("forwards a held prefix untouched when the next chunk shows it was not a report", () => {
    expect(feed([`${ESC}[<0;1`, `${ESC}`])).toEqual({ forward: `${ESC}[<0;1${ESC}`, events: [], rest: "", inPaste: false });
  });
});

describe("parseMouseChunk — bracketed paste", () => {
  it("leaves a mouse-like sequence inside bracketed paste untouched", () => {
    const paste = `${PASTE_START}look ${ESC}[<0;1;1M here${PASTE_END}`;
    expect(parseMouseChunk(paste, false)).toEqual({ forward: paste, events: [], rest: "", inPaste: false });
  });

  it("resumes decoding reports after the paste ends", () => {
    expect(parseMouseChunk(`${PASTE_START}x${PASTE_END}${ESC}[<0;1;1M`, false)).toEqual({
      forward: `${PASTE_START}x${PASTE_END}`,
      events: [{ kind: "press", x: 0, y: 0 }],
      rest: "",
      inPaste: false,
    });
  });

  it("keeps a paste open across chunks and never decodes inside it", () => {
    const chunks = [`${PASTE_START}one ${ESC}[<0;`, `1;1M two`, `${PASTE_END}${ESC}[<65;1;1M`];
    expect(feed(chunks)).toEqual({
      forward: `${PASTE_START}one ${ESC}[<0;1;1M two${PASTE_END}`,
      events: [{ kind: "wheel", direction: "down", x: 0, y: 0 }],
      rest: "",
      inPaste: false,
    });
  });

  it("sees the end of a paste whose end marker is split across chunks", () => {
    const chunks = [`${PASTE_START}text${ESC}[20`, `1~${ESC}[<0;1;1M`];
    expect(feed(chunks)).toEqual({
      forward: `${PASTE_START}text${PASTE_END}`,
      events: [{ kind: "press", x: 0, y: 0 }],
      rest: "",
      inPaste: false,
    });
  });

  it("sees the start of a paste whose start marker is split across chunks", () => {
    const chunks = [`${ESC}[20`, `0~${ESC}[<0;1;1M${PASTE_END}`];
    expect(feed(chunks)).toEqual({
      forward: `${PASTE_START}${ESC}[<0;1;1M${PASTE_END}`,
      events: [],
      rest: "",
      inPaste: false,
    });
  });
});

// A stand-in for process.stdin: a real readable stream plus the TTY methods.
function fakeSource() {
  const stream = new PassThrough();
  const calls: string[] = [];
  const source = Object.assign(stream, {
    isTTY: true,
    setRawMode(mode: boolean) {
      calls.push(`setRawMode(${mode})`);
      return source;
    },
    ref() {
      calls.push("ref");
      return source;
    },
    unref() {
      calls.push("unref");
      return source;
    },
  });
  return { source: source as unknown as NodeJS.ReadStream & PassThrough, calls };
}

function fakeOutput() {
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: () => true,
  });
  const stderr = Object.assign(new EventEmitter(), { write: () => true });
  return { stdout, stderr };
}

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("createMouseFilteredStdin", () => {
  it("emits decoded events and lets everything else through", async () => {
    const { source } = fakeSource();
    const filtered = createMouseFilteredStdin(source);
    filtered.stdin.setEncoding("utf8");
    const events: MouseEvent[] = [];
    filtered.on((event) => events.push(event));

    source.write(`a${ESC}[<0;5;`);
    source.write(`6Mb`);
    await vi.waitFor(() => expect(events).toEqual([{ kind: "press", x: 4, y: 5 }]));
    let text = "";
    let chunk: string | null;
    while ((chunk = filtered.stdin.read() as string | null) !== null) text += chunk;
    expect(text).toBe("ab");
  });

  it("stops notifying a listener once it unsubscribes", async () => {
    const { source } = fakeSource();
    const filtered = createMouseFilteredStdin(source);
    const events: MouseEvent[] = [];
    const off = filtered.on((event) => events.push(event));
    off();
    const later: MouseEvent[] = [];
    filtered.on((event) => later.push(event));

    source.write(`${ESC}[<0;1;1M`);
    await vi.waitFor(() => expect(later).toHaveLength(1));
    expect(events).toEqual([]);
  });

  it("reassembles a character split across two byte chunks", async () => {
    const { source } = fakeSource();
    const filtered = createMouseFilteredStdin(source);
    filtered.stdin.setEncoding("utf8");
    const bytes = Buffer.from("é", "utf8");
    source.write(bytes.subarray(0, 1));
    source.write(bytes.subarray(1));
    await vi.waitFor(() => expect(filtered.stdin.read()).toBe("é"));
  });

  it("delegates the TTY methods to the source", () => {
    const { source, calls } = fakeSource();
    const { stdin } = createMouseFilteredStdin(source);
    expect(stdin.isTTY).toBe(true);
    stdin.ref();
    stdin.setRawMode(true);
    stdin.setRawMode(false);
    stdin.unref();
    expect(calls).toEqual(["ref", "setRawMode(true)", "setRawMode(false)", "unref"]);
  });

  it("serves a real Ink render: typed text, a lone Esc and pastes arrive, reports never do", async () => {
    const { source } = fakeSource();
    const filtered = createMouseFilteredStdin(source);
    const events: MouseEvent[] = [];
    filtered.on((event) => events.push(event));
    const inputs: string[] = [];
    const pastes: string[] = [];
    let escapes = 0;

    function Probe() {
      const [typed, setTyped] = useState("");
      useInput((input, key) => {
        if (key.escape) escapes += 1;
        inputs.push(input);
        setTyped((current) => current + input);
      });
      usePaste((text) => pastes.push(text));
      return createElement(Text, null, `typed:${typed}`);
    }

    const { stdout, stderr } = fakeOutput();
    const app = render(createElement(Probe), {
      stdout: stdout as never,
      stderr: stderr as never,
      stdin: filtered.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });
    cleanup = () => app.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));

    source.write(`hi${ESC}[<0;3;4M`);
    source.write(`${ESC}[<32;5;4M${ESC}[<0;`);
    source.write(`6;4m!`);
    await vi.waitFor(() => expect(inputs.join("")).toBe("hi!"));
    expect(events).toEqual([
      { kind: "press", x: 2, y: 3 },
      { kind: "drag", x: 4, y: 3 },
      { kind: "release", x: 5, y: 3 },
    ]);

    source.write(ESC);
    await vi.waitFor(() => expect(escapes).toBe(1));

    source.write(`${PASTE_START}copied ${ESC}[<0;1;1M text${PASTE_END}`);
    await vi.waitFor(() => expect(pastes).toEqual([`copied ${ESC}[<0;1;1M text`]));
    expect(events).toHaveLength(3);
    expect(inputs.join("")).not.toContain("[<");
  });
});
