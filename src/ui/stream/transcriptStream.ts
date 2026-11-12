/**
 * The renderer: session events in, formatted physical lines out.
 *
 * It owns one pipeline per entry —
 *
 *     raw delta
 *       -> MarkerFilter    (never print a protocol marker before the verdict)
 *       -> AnsiSanitizer   (never let an agent drive the terminal)
 *       -> LineBuffer      (whole physical lines only, Unicode-aware)
 *       -> MarkdownStreamer(style what is complete on this line, forever)
 *       -> StreamController(one writer, one order, append-only)
 *
 * — and holds nothing else. The scheduler owns the canonical transcript and
 * `DebateView` owns the scrollable presentation; this class only formats the new
 * text incrementally.
 *
 * Events are rendered in the order they happened. A human intervention or a tool
 * permission arriving mid-answer therefore interrupts that answer visually — the
 * running message's incomplete line is committed first, and the message picks up
 * on a new line afterwards. The stored transcript still groups each entry whole.
 *
 * The one exception to append-only is `reset`: when a working note turns out not
 * to belong to the answer, the running entry's body is rewound and re-rendered
 * from the text that remains, through a fresh pipeline, and the lines that had
 * been interleaved into it are written again after it. Only a writer that can
 * rewind (`length` and `rewind`) supports it; without one, a reset is ignored.
 */

import type { AgentId, TranscriptEntry } from "../../types.js";
import type { EntryOutcome, Signal } from "../../orchestrator/types.js";
import {
  AGENT_STYLE,
  ERROR_STYLE,
  GLYPH,
  HUMAN_STYLE,
  RAIL_WIDTH,
  SUMMARY_STYLE,
  SYSTEM_STYLE,
} from "../theme.js";
import chalk from "chalk";
import { LineBuffer, displayWidth, truncateEnd, type PhysicalLine } from "./lineBuffer.js";
import { MarkdownStreamer } from "./markdownStream.js";
import { MarkerFilter } from "./markerFilter.js";
import { AnsiSanitizer } from "./sanitize.js";
import { AsciiSymbolSanitizer, asciiSymbolsForDisplay } from "./asciiSymbols.js";
import { StreamController, line, type StreamWriter, type TranscriptLine } from "./streamController.js";

export interface EntryStyle {
  color: string;
  badge: string;
  /** Chatter gets a coloured left rail; chrome (system, permissions) doesn't. */
  rail: boolean;
  /** Body is read as markdown. Separate from `rail`: the consensus summary has one but not the other. */
  markdown: boolean;
  /** Chrome is quoted in a dim tone; an error keeps its full colour. */
  dim: boolean;
}

export interface TailView {
  text: string;
  color: string;
  rail: boolean;
}

/**
 * What the agent decided, in words, closing its turn.
 *
 * The protocol marker itself is filtered out of the transcript on purpose, which
 * left the reader unable to tell an agreement from a hand-over — or to see why
 * the debate had stopped. This says it plainly instead, and describes what the
 * agent did rather than predicting what the scheduler will do next, so the line
 * stays true even when the debate is suspended right after it.
 */
function verdictText(
  signal: Signal,
  from: AgentId,
  closesDebate: boolean,
  counted: boolean,
): { glyph: string; words: string } | null {
  const next = AGENT_STYLE[other(from)].badge;
  // A signal set aside says so instead of announcing a hand-over that did not
  // happen. A missing signal stays as it is: there was nothing to set aside.
  if (signal !== null && !counted) {
    return { glyph: GLYPH.dot, words: "Signal set aside: your message arrived during this turn" };
  }
  switch (signal) {
    case "continue":
      return { glyph: GLYPH.next, words: `Continues · over to ${next}` };
    // The two cases read very differently and must not share a wording: one
    // agreement leaves the debate running, the pair ends it. The scheduler
    // tells us which this is, since it compares the signals after the entry
    // has already been closed.
    case "consensus":
      return closesDebate
        ? { glyph: GLYPH.ok, words: "Consensus approved · the debate is closed" }
        : { glyph: GLYPH.ok, words: `Ready for consensus · over to ${next}` };
    case "wait-human":
      return { glyph: GLYPH.ask, words: "Waiting for your answer" };
    // This used to be silent, back when a non-topic closed the session and the
    // return to the welcome screen said it. The conversation stays open now, so
    // the turn has to say what it decided and what happens next like any other.
    case "no-topic":
      return { glyph: GLYPH.dot, words: "No topic to debate · the debate starts on your next message" };
    case null:
      return { glyph: GLYPH.warn, words: "No decision signalled" };
  }
}

function other(agent: AgentId): AgentId {
  return agent === "claude" ? "codex" : "claude";
}

export interface TranscriptStreamOptions {
  write: StreamWriter;
  /** Columns available to a transcript line. Re-read on every use, for resizes. */
  width: () => number;
  onTail: (tail: TailView | null) => void;
  intervalMs?: number;
  /** Lines written so far. With `rewind`, lets `reset` find the running body. */
  length?: () => number;
  /** Drop every line from `toLength` on. */
  rewind?: (toLength: number) => void;
  /** Round number of an agent's turn, asked once when its header is written. */
  round?: (entry: TranscriptEntry) => number | null;
}

export function entryStyle(entry: TranscriptEntry): EntryStyle {
  const chrome = { rail: false, markdown: false, dim: true };
  const speech = { rail: true, markdown: true, dim: false };
  if (entry.kind === "error") return { ...ERROR_STYLE, ...chrome, dim: false };
  if (entry.kind === "summary") return { ...SUMMARY_STYLE, rail: false, markdown: true, dim: false };
  if (entry.from === "human") return { ...HUMAN_STYLE, ...speech };
  if (entry.from === "system") return { ...SYSTEM_STYLE, ...chrome };
  if (entry.kind === "system" || entry.kind === "permission") return { ...SYSTEM_STYLE, ...chrome };
  return { ...AGENT_STYLE[entry.from], ...speech };
}

function clockOf(timestamp: number): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * One entry's worth of streaming state. Created when the entry starts, thrown
 * away when it ends — nothing accumulates across the debate.
 */
class EntryPipeline {
  private readonly filter = new MarkerFilter();
  private readonly sanitizer = new AnsiSanitizer();
  private readonly ascii: AsciiSymbolSanitizer | null;
  private readonly markdown: MarkdownStreamer;
  private readonly buffer: LineBuffer;

  constructor(
    private readonly style: EntryStyle,
    width: number,
    asciiOnly: boolean,
  ) {
    this.buffer = new LineBuffer(this.bodyWidth(width));
    this.ascii = asciiOnly ? new AsciiSymbolSanitizer() : null;
    // The author's colour marks headings and line-opening labels, as the rail does.
    // The consensus summary has no author and keeps the quiet default.
    this.markdown = new MarkdownStreamer(style.rail ? { accent: terminalColor(style.color) } : {});
  }

  setWidth(width: number): void {
    this.buffer.setWidth(this.bodyWidth(width));
  }

  push(delta: string): TranscriptLine[] {
    const sanitized = this.sanitizer.push(this.filter.push(delta));
    const visible = this.ascii ? this.ascii.push(sanitized) : sanitized;
    return this.buffer.push(visible).map((line) => this.render(line));
  }

  /**
   * Commit the incomplete line so something permanent can be written after it.
   *
   * The ASCII sanitizer is flushed too: it withholds a trailing digit or `#` in
   * case the next chunk turns it into a keycap emoji, and a line that is about to
   * become scrollback can no longer receive it. Left pending, that character
   * reappears at the head of the next committed line — `budget of` / `12 dollars`.
   */
  interrupt(): TranscriptLine[] {
    const held = this.ascii ? this.ascii.flush() : "";
    const lines = held ? [...this.buffer.push(held), ...this.buffer.flush()] : this.buffer.flush();
    return lines.map((line) => this.render(line));
  }

  finish(signalConfirmed: boolean): TranscriptLine[] {
    const sanitized =
      this.sanitizer.push(this.filter.finish(signalConfirmed)) + this.sanitizer.flush();
    const rest = this.ascii ? this.ascii.push(sanitized) + this.ascii.flush() : sanitized;
    const lines = [...this.buffer.push(rest), ...this.buffer.flush()];
    return lines.map((line) => this.render(line));
  }

  tail(): TailView | null {
    const { text } = this.buffer.tail;
    if (text === "") return null;
    return { text, color: this.style.color, rail: this.style.rail };
  }

  private bodyWidth(width: number): number {
    return Math.max(8, width - (this.style.rail ? RAIL_WIDTH : 0));
  }

  private render(physical: PhysicalLine): TranscriptLine {
    return { styled: this.renderStyled(physical), softWrap: physical.continuation };
  }

  private renderStyled(physical: PhysicalLine): string {
    if (!this.style.markdown) {
      const colored = terminalColor(this.style.color)(physical.text);
      return this.style.dim ? chalk.dim(colored) : colored;
    }
    // No trailing space on a blank line: it would be copied out with the text.
    if (physical.text === "") return this.style.rail ? terminalColor(this.style.color)(GLYPH.rail) : "";
    // A fence marker renders to nothing at all, so the same rule applies to it:
    // the rail must not be left carrying a space that no glyph follows.
    const styled = this.markdown.style(physical);
    if (!this.style.rail) return styled;
    if (styled === "") return terminalColor(this.style.color)(GLYPH.rail);
    return railPrefix(this.style.color) + styled;
  }
}

/** One string per terminal row; a CRLF leaves no stray "\r" behind. */
function splitRows(text: string): string[] {
  return text.split(/\r?\n/u);
}

function terminalColor(color: string) {
  const ansi256 = /^ansi256\((\d+)\)$/.exec(color);
  return ansi256 ? chalk.ansi256(Number(ansi256[1])) : chalk.hex(color);
}

function railPrefix(color: string): string {
  return terminalColor(color)(GLYPH.rail) + " ";
}

function entryBody(entry: TranscriptEntry, style: EntryStyle, width: number): string {
  const body = `${style.badge ? `${style.badge} ` : ""}${entry.text}`;
  return isInitialSubject(entry) ? truncateEnd(body.replace(/\s+/gu, " ").trim(), width) : body;
}

function isInitialSubject(entry: TranscriptEntry): boolean {
  return entry.from === "system" && entry.kind === "system" && entry.text.startsWith("Topic:");
}

interface ActiveEntry {
  id: string;
  pipe: EntryPipeline;
  from: TranscriptEntry["from"];
  style: EntryStyle;
  asciiOnly: boolean;
  /** Line count right after the header: where a reset rewinds to. */
  bodyStart: number | null;
  /** Permanent lines written into the running entry, to write again after a reset. */
  interleaved: TranscriptLine[];
  /** The block was cut by other lines: its next write opens with a continued header. */
  interrupted: boolean;
  entry: TranscriptEntry;
}

export class TranscriptStream {
  private readonly controller: StreamController;
  private active: ActiveEntry | null = null;

  constructor(private readonly options: TranscriptStreamOptions) {
    this.controller = new StreamController({
      write: options.write,
      intervalMs: options.intervalMs,
      onFlush: () => this.options.onTail(this.active?.pipe.tail() ?? null),
    });
  }

  /** Pre-formatted permanent lines: the frozen header, the help panel. */
  raw(lines: readonly string[]): void {
    this.interruptActive();
    // Split defensively: a string with a line break would otherwise be one line
    // in the count and several rows on screen.
    this.pushPermanent(lines.flatMap((text) => splitRows(text).map((row) => line(row))));
    this.controller.flush();
  }

  /** An entry that is already complete when it appears. */
  entry(entry: TranscriptEntry): void {
    this.interruptActive();

    const style = entryStyle(entry);
    const pipe = new EntryPipeline(style, this.options.width(), shouldUseAscii(entry));

    if (!style.rail && !style.markdown) {
      const lines = [
        ...pipe.push(entryBody(entry, style, this.options.width())),
        ...pipe.finish(false),
      ];
      // Keep the accepted prompt visually distinct from Claude's first turn.
      // These rows belong only to the terminal presentation; the canonical
      // transcript remains unchanged.
      if (isInitialSubject(entry)) lines.push(line(""), line(""));
      this.pushPermanent(lines);
      this.controller.flush();
      return;
    }

    this.pushPermanent([
      ...this.headerLines(entry, style),
      ...pipe.push(entry.text),
      ...pipe.finish(false),
      ...this.closingLines(entry, style),
      line(""),
    ]);
    this.controller.flush();
  }

  entryStarted(entry: TranscriptEntry): void {
    this.interruptActive();

    const style = entryStyle(entry);
    const asciiOnly = shouldUseAscii(entry);
    const pipe = new EntryPipeline(style, this.options.width(), asciiOnly);
    this.controller.push(this.headerLines(entry, style));
    this.controller.flush();
    this.active = {
      id: entry.id,
      pipe,
      from: entry.from,
      style,
      asciiOnly,
      bodyStart: this.options.length?.() ?? null,
      interleaved: [],
      interrupted: false,
      entry,
    };
  }

  chunk(id: string, delta: string): void {
    const active = this.active;
    if (!active || active.id !== id) return;
    active.pipe.setWidth(this.options.width());
    this.controller.push(this.resumed(active, active.pipe.push(delta)));
    this.controller.schedule();
  }

  /**
   * Replace everything streamed so far for the running entry with `text`.
   *
   * The new body goes through a fresh pipeline, so a protocol marker at its end
   * is held back exactly as a streamed one would be, and later chunks continue
   * from it.
   */
  reset(id: string, text: string): void {
    const active = this.active;
    const { length, rewind } = this.options;
    if (!active || active.id !== id || !length || !rewind || active.bodyStart === null) return;

    // Queued lines must reach the writer first, or the rewind would miss them.
    this.controller.flush();
    rewind(active.bodyStart);

    active.pipe = new EntryPipeline(active.style, this.options.width(), active.asciiOnly);
    const lines = active.pipe.push(text);
    if (active.interleaved.length > 0) {
      lines.push(...active.pipe.interrupt(), ...active.interleaved);
    }
    // The replayed block ends on the interleaved lines, so what follows resumes it.
    active.interrupted = active.interleaved.length > 0;
    this.controller.push(lines);
    this.controller.flush();
  }

  entryCompleted(id: string, outcome: EntryOutcome): void {
    const active = this.active;
    if (!active || active.id !== id) return;

    const turn = [
      ...active.pipe.finish(outcome.status === "ok" && outcome.signal !== null),
      ...this.closingLines(active.entry, active.style),
    ];
    // Only a debater closes a turn with a decision. The synthesis is written
    // by an agent too, but it speaks as the system and signals nothing.
    if (outcome.status === "ok" && (active.from === "claude" || active.from === "codex")) {
      turn.push(...this.verdictLines(outcome, active.from));
    }
    // An error or a cancellation speaks for itself, so it does not reopen the block.
    const lines = this.resumed(active, turn);
    if (outcome.status === "error") {
      // One TranscriptLine per row: a message with line breaks must not count as a
      // single line, or length(), rewind and the viewport height would be wrong.
      const paint = chalk.hex(ERROR_STYLE.color);
      const rows = splitRows(asciiSymbolsForDisplay(outcome.message));
      rows.forEach((row, index) => {
        lines.push(line(paint(index === 0 ? `${ERROR_STYLE.badge} Error: ${row}` : row)));
      });
    } else if (outcome.status === "cancelled") {
      lines.push(line(chalk.dim(`${GLYPH.dot} Cancelled`)));
    }
    lines.push(line(""));

    this.active = null;
    this.controller.push(lines);
    this.controller.flush();
  }

  /** Write everything queued right now, instead of at the next tick. */
  flush(): void {
    this.controller.flush();
  }

  dispose(): void {
    // Commit what the turn had produced so far, including anything the marker
    // filter was still holding: on a quit or an interrupt there is no verdict
    // coming, and losing the text would be worse than showing a stray marker.
    if (this.active) {
      this.controller.push(this.active.pipe.finish(false));
      this.active = null;
    }
    this.controller.dispose();
    this.options.onTail(null);
  }

  /**
   * Close the running message's open line before writing anything else, so the
   * interleaving the reader sees matches the order events actually happened in.
   */
  private interruptActive(): void {
    if (!this.active) return;
    this.controller.push(this.active.pipe.interrupt());
  }

  /** Write lines that belong to no running entry, remembering them for a reset. */
  private pushPermanent(lines: readonly TranscriptLine[]): void {
    if (this.active && lines.length > 0) {
      this.active.interleaved.push(...lines);
      this.active.interrupted = true;
    }
    this.controller.push(lines);
  }

  /**
   * Text, a remainder or a verdict of a running turn that other lines have cut:
   * it opens with a continued header, so the rest is never anonymous.
   */
  private resumed(active: ActiveEntry, lines: TranscriptLine[]): TranscriptLine[] {
    if (!active.interrupted || lines.length === 0 || !active.style.rail) return lines;
    active.interrupted = false;
    const head = terminalColor(active.style.color).bold(`${GLYPH.mark} ${authorName(active.style)} (continued)`);
    return [line(head), ...lines];
  }

  private verdictLines(
    outcome: Extract<EntryOutcome, { status: "ok" }>,
    from: AgentId,
  ): TranscriptLine[] {
    const verdict = verdictText(outcome.signal, from, outcome.closesDebate === true, outcome.counted);
    if (!verdict) return [];
    const { color } = AGENT_STYLE[from];
    // Blank rail line first: the verdict is about the turn, not a last
    // sentence of it, and must not read as one.
    return [
      line(terminalColor(color)(GLYPH.rail)),
      line(`${railPrefix(color)}${terminalColor(color)(verdict.glyph)} ${chalk.dim(verdict.words)}`),
    ];
  }

  /** The consensus summary's closing rule; every other entry just ends. */
  private closingLines(entry: TranscriptEntry, style: EntryStyle): TranscriptLine[] {
    if (entry.kind !== "summary") return [];
    return [line(terminalColor(style.color)(GLYPH.ruleHeavy.repeat(this.options.width())))];
  }

  private headerLines(entry: TranscriptEntry, style: EntryStyle): TranscriptLine[] {
    const width = this.options.width();
    const paint = terminalColor(style.color);

    if (entry.kind === "summary") {
      return [line(paint(GLYPH.ruleHeavy.repeat(width))), line(paint.bold(style.badge)), line("")];
    }

    const target = entry.to ? (entry.to === "both" ? " → both" : ` → ${entry.to}`) : "";
    const left = `${GLYPH.mark} ${authorName(style)}${target}`;
    const isAgent = entry.from === "claude" || entry.from === "codex";
    const round = isAgent ? (this.options.round?.(entry) ?? null) : null;
    const clock = clockOf(entry.timestamp);
    const right = round === null ? clock : `Round ${round} ${GLYPH.dot} ${clock}`;

    // Right-aligned to the content width, rail column included.
    const gap = " ".repeat(Math.max(1, width - displayWidth(left) - displayWidth(right)));
    const head = paint.bold(`${GLYPH.mark} ${authorName(style)}`) + chalk.dim(target) + gap + chalk.dim(right);
    return [line(head)];
  }
}

function authorName(style: EntryStyle): string {
  return style.badge.toUpperCase();
}

function shouldUseAscii(entry: TranscriptEntry): boolean {
  return entry.from === "claude" || entry.from === "codex" || entry.kind === "summary";
}
