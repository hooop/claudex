/**
 * Holds back protocol markers so they never reach the terminal.
 *
 * The transcript is append-only: once a line is written it is never rewritten.
 * That makes `<<CONSENSUS>>` a problem, because the scheduler only knows it was a
 * signal (and not literal text an agent quoted mid-argument) once the turn ends.
 * So a line that *could* be a terminal marker is retained here, along with the
 * blank lines behind it, until one of two things settles it:
 *
 *  - more real content arrives  → the marker wasn't terminal, release everything;
 *  - the turn ends              → `finish()` is told whether the signal was
 *                                 confirmed, and drops or releases accordingly.
 *
 * Everything retained is bounded: one marker-shaped line (capped by the grammar in
 * orchestrator/markers.ts), a count of blank lines, and one unterminated tail.
 */

import { scanMarkerLine } from "../../orchestrator/markers.js";

/** Blank lines kept behind a held marker. Beyond this they're simply dropped. */
const MAX_HELD_BLANKS = 16;

export class MarkerFilter {
  /** A complete line that matched the marker grammar, awaiting a verdict. */
  private heldMarker: string | null = null;
  private heldBlanks = 0;
  /** An unterminated line: a marker candidate, or blanks trailing a held marker. */
  private tail = "";

  /**
   * Feed a raw delta. Returns the text that is safe to display right now, which
   * may be empty while a marker candidate is being resolved.
   */
  push(chunk: string): string {
    let buf = this.tail + chunk;
    this.tail = "";
    let out = "";

    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      out += this.consumeLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }

    // `buf` is now an unterminated line.
    if (this.heldMarker !== null) {
      if (buf.trim() === "") {
        // Might still turn out to be another blank line behind the marker.
        this.tail = buf;
        return out;
      }
      out += this.releaseHeld();
    }

    if (scanMarkerLine(buf).kind === "no") out += buf;
    else this.tail = buf;

    return out;
  }

  /**
   * End of turn. `signalConfirmed` comes from the scheduler's own
   * `extractSignal()` run on the same text, so the two never disagree.
   */
  finish(signalConfirmed: boolean): string {
    // A turn can end on the marker with no trailing newline at all.
    if (this.heldMarker === null && this.tail !== "" && scanMarkerLine(this.tail).kind === "match") {
      this.heldMarker = this.tail;
      this.heldBlanks = 0;
      this.tail = "";
    }

    if (this.heldMarker !== null && signalConfirmed) {
      this.heldMarker = null;
      this.heldBlanks = 0;
      this.tail = "";
      return "";
    }

    const rest = this.tail;
    this.tail = "";
    return this.releaseHeld() + rest;
  }

  /** True while any marker-shaped text is being withheld from the terminal. */
  get isHolding(): boolean {
    return this.heldMarker !== null || this.tail !== "";
  }

  private consumeLine(line: string): string {
    if (this.heldMarker !== null) {
      if (line.trim() === "") {
        if (this.heldBlanks < MAX_HELD_BLANKS) this.heldBlanks++;
        return "";
      }
      // Content after the marker proves it wasn't terminal.
      return this.releaseHeld() + line + "\n";
    }

    if (scanMarkerLine(line).kind === "match") {
      this.heldMarker = line;
      this.heldBlanks = 0;
      return "";
    }

    return line + "\n";
  }

  private releaseHeld(): string {
    if (this.heldMarker === null) return "";
    const out = this.heldMarker + "\n" + "\n".repeat(this.heldBlanks);
    this.heldMarker = null;
    this.heldBlanks = 0;
    return out;
  }
}
