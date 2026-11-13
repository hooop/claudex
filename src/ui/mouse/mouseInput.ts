import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** A mouse report from the terminal, in 0-based cells. */
export type MouseEvent =
  | { kind: "press" | "drag" | "release"; x: number; y: number }
  | { kind: "wheel"; direction: "up" | "down"; x: number; y: number };

const ESC = "\u001b";
const MOUSE_PREFIX = `${ESC}[<`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
// SGR report: ESC [ < button ; column ; row, then M (press, motion) or m (release).
const MOUSE_REPORT = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/y;
// A tail that could still grow into a report. Bounded so that a long run of
// digits typed outside a paste is never held back indefinitely.
const MOUSE_REPORT_PREFIX = /^\u001b\[<\d*(?:;\d*(?:;\d*)?)?$/;
const MAX_PREFIX_LENGTH = 32;

const WHEEL = 64;
const MOTION = 32;
const MODIFIERS = 4 | 8 | 16;
const BUTTON_BITS = 3;

function decode(button: number, column: number, row: number, final: string): MouseEvent | null {
  const b = button & ~MODIFIERS;
  const x = column - 1;
  const y = row - 1;
  if (b & WHEEL) {
    // Terminals send the wheel as presses only.
    if (final !== "M") return null;
    return { kind: "wheel", direction: b & 1 ? "down" : "up", x, y };
  }
  // Only the left button selects; the others are dropped.
  if ((b & BUTTON_BITS) !== 0) return null;
  if (final === "m") return { kind: "release", x, y };
  return { kind: b & MOTION ? "drag" : "press", x, y };
}

function isMouseReportPrefix(tail: string): boolean {
  return tail.length <= MAX_PREFIX_LENGTH && tail.startsWith(MOUSE_PREFIX) && MOUSE_REPORT_PREFIX.test(tail);
}

/**
 * A paste start marker is three bytes or more before it can be told apart
 * from a key; holding it costs no latency because Ink itself waits for the
 * rest of a CSI sequence. Without this, a split marker would let the paste
 * content be scanned for reports.
 */
function isPasteStartPrefix(tail: string): boolean {
  return tail.length >= 3 && tail.length < PASTE_START.length && PASTE_START.startsWith(tail);
}

/** Longest suffix of `text` that could be the start of the paste end marker. */
function pasteEndPrefixLength(text: string): number {
  for (let length = Math.min(PASTE_END.length - 1, text.length); length > 0; length--) {
    if (PASTE_END.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

/**
 * Splits complete SGR mouse reports out of terminal input. Everything else is
 * forwarded byte for byte, in order, so Ink parses keys exactly as it would
 * without the filter. `rest` is held for the next call: only an unfinished
 * report (already `ESC [ <`) or paste marker, never a lone `ESC` or `ESC [`,
 * which would delay the Esc key. Nothing is decoded inside a bracketed paste.
 */
export function parseMouseChunk(
  buffer: string,
  inPaste: boolean,
): { forward: string; events: MouseEvent[]; rest: string; inPaste: boolean } {
  let forward = "";
  const events: MouseEvent[] = [];
  let index = 0;

  while (index < buffer.length) {
    if (inPaste) {
      const end = buffer.indexOf(PASTE_END, index);
      if (end === -1) {
        // Ink delivers a paste only once its end marker arrives, so holding a
        // possible split marker here delays nothing.
        const held = pasteEndPrefixLength(buffer.slice(index));
        forward += buffer.slice(index, buffer.length - held);
        return { forward, events, rest: buffer.slice(buffer.length - held), inPaste };
      }
      forward += buffer.slice(index, end + PASTE_END.length);
      index = end + PASTE_END.length;
      inPaste = false;
      continue;
    }

    const escape = buffer.indexOf(ESC, index);
    if (escape === -1) {
      forward += buffer.slice(index);
      break;
    }
    forward += buffer.slice(index, escape);

    if (buffer.startsWith(PASTE_START, escape)) {
      forward += PASTE_START;
      index = escape + PASTE_START.length;
      inPaste = true;
      continue;
    }

    MOUSE_REPORT.lastIndex = escape;
    const report = MOUSE_REPORT.exec(buffer);
    if (report) {
      const event = decode(Number(report[1]), Number(report[2]), Number(report[3]), report[4] ?? "");
      if (event) events.push(event);
      index = MOUSE_REPORT.lastIndex;
      continue;
    }

    const tail = buffer.slice(escape);
    if (isMouseReportPrefix(tail) || isPasteStartPrefix(tail)) {
      return { forward, events, rest: tail, inPaste };
    }

    forward += ESC;
    index = escape + 1;
  }

  return { forward, events, rest: "", inPaste };
}

/**
 * Wraps the terminal's stdin for Ink: Ink reads every byte that is not a
 * mouse report, and listeners receive the reports as events. Without this the
 * reports would be typed into the input bar.
 *
 * Ink uses `isTTY`, `setRawMode`, `ref` and `unref` on its stdin; they act on
 * the real terminal. `setEncoding` and `read` stay on the filtered stream.
 */
export function createMouseFilteredStdin(source: NodeJS.ReadStream): {
  stdin: NodeJS.ReadStream;
  on(listener: (event: MouseEvent) => void): () => void;
} {
  const output = new PassThrough();
  const listeners = new Set<(event: MouseEvent) => void>();
  const decoder = new StringDecoder("utf8");
  let rest = "";
  let inPaste = false;

  source.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    const result = parseMouseChunk(rest + text, inPaste);
    rest = result.rest;
    inPaste = result.inPaste;
    if (result.forward) output.write(result.forward);
    for (const event of result.events) {
      for (const listener of [...listeners]) listener(event);
    }
  });
  source.on("end", () => {
    const tail = rest + decoder.end();
    rest = "";
    if (tail) output.write(tail);
    output.end();
  });

  const stdin = Object.assign(output, {
    isTTY: source.isTTY,
    setRawMode(mode: boolean) {
      source.setRawMode(mode);
      return stdin;
    },
    ref() {
      source.ref();
      return stdin;
    },
    unref() {
      source.unref();
      return stdin;
    },
  });

  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
