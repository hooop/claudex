/**
 * Strips terminal control sequences out of agent output before it is displayed.
 *
 * Claudex writes agent text straight into the terminal buffer, so anything an
 * agent emits is executed by the emulator unless it is removed here: a stray
 * erase-screen sequence from a quoted log line would wipe the transcript, and a
 * carriage return would overwrite the line just printed. Both would break the
 * "never redraw committed output" guarantee the append-only renderer rests on.
 *
 * Colour is re-applied afterwards, but only by Claudex itself.
 */

/** Tab stops. Fixed rather than column-aware: line widths must stay predictable. */
export const TAB_WIDTH = 4;

/** Longest escape sequence we'll wait for across a chunk boundary. */
const MAX_PENDING_ESCAPE = 64;

const ESC = "\u001b";
const BEL = "\u0007";

/** OSC: ESC ] ... terminated by BEL or ST. */
const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
/** CSI: ESC [ params intermediates final. Covers colours, cursor moves, erases. */
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** Charset / DEC private two-byte selectors: ESC ( B, ESC # 8, ... */
const CHARSET = /\u001b[()#][\s\S]/g;
/** Single-byte escapes: ESC 7, ESC M, ... */
const SHORT_ESC = /\u001b[@-Z\\-_]/g;
/** Any escape byte left over once the known shapes are gone. */
const LONE_ESC = /\u001b/g;
/** Everything left in C0/C1 except LF (tabs are expanded before this runs). */
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** Stateless pass — use `AnsiSanitizer` when the text arrives in chunks. */
export function sanitizeForDisplay(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(CHARSET, "")
    .replace(SHORT_ESC, "")
    .replace(LONE_ESC, "")
    .replace(/\t/g, " ".repeat(TAB_WIDTH))
    .replace(CONTROLS, "");
}

function isCompleteEscape(s: string): boolean {
  if (s.startsWith(ESC + "]")) return s.slice(2).includes(BEL) || s.slice(2).includes(ESC + "\\");
  if (s.startsWith(ESC + "[")) return /^\u001b\[[0-?]*[ -/]*[@-~]/.test(s);
  if (/^\u001b[()#]/.test(s)) return s.length >= 3;
  return s.length >= 2;
}

/**
 * Chunk-aware sanitizer. An escape sequence can be split across two deltas, so a
 * trailing incomplete one is held back rather than having its bracket and digits
 * printed as text.
 */
export class AnsiSanitizer {
  private pending = "";

  push(chunk: string): string {
    let text = this.pending + chunk;
    this.pending = "";

    const at = text.lastIndexOf(ESC);
    if (at !== -1 && text.length - at <= MAX_PENDING_ESCAPE && !isCompleteEscape(text.slice(at))) {
      this.pending = text.slice(at);
      text = text.slice(0, at);
    }

    return sanitizeForDisplay(text);
  }

  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return sanitizeForDisplay(rest);
  }
}
