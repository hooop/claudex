/**
 * The renderer: session events in, permanent terminal lines out.
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
 * — and holds nothing else. There is no model of the transcript here: the
 * scheduler already owns the canonical one, and the terminal's own scrollback
 * owns the visible one. That is what keeps the cost of an update proportional to
 * the new text rather than to the length of the debate.
 *
 * Events are rendered in the order they happened. A human intervention or a tool
 * permission arriving mid-answer therefore interrupts that answer visually — the
 * running message's incomplete line is committed first, and the message picks up
 * on a new line afterwards. The stored transcript still groups each entry whole.
 */

import type { AgentId, TranscriptEntry } from "../../types.js";
import type { Signal } from "../../orchestrator/types.js";
import { AGENT_STYLE, ERROR_STYLE, HUMAN_STYLE, RAIL_WIDTH, SUMMARY_STYLE, SYSTEM_STYLE } from "../theme.js";
import chalk from "chalk";
import { LineBuffer, displayWidth, truncateEnd, type PhysicalLine } from "./lineBuffer.js";
import { MarkdownStreamer } from "./markdownStream.js";
import { MarkerFilter } from "./markerFilter.js";
import { AnsiSanitizer } from "./sanitize.js";
import { AsciiSymbolSanitizer, asciiSymbolsForDisplay } from "./asciiSymbols.js";
import { StreamController, type StreamWriter } from "./streamController.js";

export interface EntryStyle {
  color: string;
  badge: string;
  /** Chatter gets a coloured left rail; chrome (system, permissions) doesn't. */
  rail: boolean;
}

export interface TailView {
  text: string;
  color: string;
  rail: boolean;
}

/** How a streaming entry ended, as far as the renderer needs to care. */
export type EntryOutcome =
  | { status: "ok"; signal: Signal; closesDebate?: boolean }
  | { status: "error"; message: string }
  | { status: "cancelled" };

/**
 * What the agent decided, in words, closing its turn.
 *
 * The protocol marker itself is filtered out of the transcript on purpose, which
 * left the reader unable to tell an agreement from a hand-over — or to see why
 * the debate had stopped. This says it plainly instead, and describes what the
 * agent did rather than predicting what the scheduler will do next, so the line
 * stays true even when the debate is suspended right after it.
 */
function verdictText(signal: Signal, from: AgentId, closesDebate: boolean): string | null {
  const me = AGENT_STYLE[from].badge;
  switch (signal) {
    case "continue":
      return `-> poursuit · passe la main à ${AGENT_STYLE[other(from)].badge}`;
    // The two cases read very differently and must not share a wording: one
    // agreement leaves the debate running, the pair ends it. The scheduler
    // tells us which this is, since it compares the signals after the entry
    // has already been closed.
    case "consensus":
      return closesDebate
        ? "[ok] Consensus approuvé — le débat est clos"
        : `[ok] ${me} est prêt pour un consensus — au tour de ${AGENT_STYLE[other(from)].badge}`;
    case "wait-human":
      return "[pause] attend ta réponse — débat en pause";
    // This used to be silent, back when a non-topic closed the session and the
    // return to the welcome screen said it. The conversation stays open now, so
    // the turn has to say what it decided and what happens next like any other.
    case "no-topic":
      return "Aucun sujet à débattre — le débat démarrera sur ton prochain message";
    case null:
      return "[!] aucune décision signalée";
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
}

export function entryStyle(entry: TranscriptEntry): EntryStyle {
  if (entry.kind === "error") return { ...ERROR_STYLE, rail: false };
  if (entry.kind === "summary") return { ...SUMMARY_STYLE, rail: true };
  if (entry.from === "human") return { ...HUMAN_STYLE, rail: true };
  if (entry.from === "system") return { ...SYSTEM_STYLE, rail: false };
  if (entry.kind === "system" || entry.kind === "permission") return { ...SYSTEM_STYLE, rail: false };
  return { ...AGENT_STYLE[entry.from], rail: true };
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
  private readonly markdown = new MarkdownStreamer();
  private readonly buffer: LineBuffer;

  constructor(
    private readonly style: EntryStyle,
    width: number,
    asciiOnly: boolean,
  ) {
    this.buffer = new LineBuffer(this.bodyWidth(width));
    this.ascii = asciiOnly ? new AsciiSymbolSanitizer() : null;
  }

  /** Chrome lines are quoted verbatim in one dim colour, not read as markdown. */
  private get formatted(): boolean {
    return this.style.rail;
  }

  setWidth(width: number): void {
    this.buffer.setWidth(this.bodyWidth(width));
  }

  push(delta: string): string[] {
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
   * reappears at the head of the next committed line — `budget de` / `12 euros`.
   */
  interrupt(): string[] {
    const held = this.ascii ? this.ascii.flush() : "";
    const lines = held ? [...this.buffer.push(held), ...this.buffer.flush()] : this.buffer.flush();
    return lines.map((line) => this.render(line));
  }

  finish(signalConfirmed: boolean): string[] {
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

  private render(line: PhysicalLine): string {
    if (!this.formatted) return chalk.dim(terminalColor(this.style.color)(line.text));
    // No trailing space on a blank line: it would be copied out with the text.
    if (line.text === "") return terminalColor(this.style.color)("│");
    // A fence marker renders to nothing at all, so the same rule applies to it:
    // the rail must not be left carrying a space that no glyph follows.
    const styled = this.markdown.style(line);
    if (styled === "") return terminalColor(this.style.color)("│");
    return railPrefix(this.style.color) + styled;
  }
}

function terminalColor(color: string) {
  const ansi256 = /^ansi256\((\d+)\)$/.exec(color);
  return ansi256 ? chalk.ansi256(Number(ansi256[1])) : chalk.hex(color);
}

function railPrefix(color: string): string {
  return terminalColor(color)("│") + " ";
}

function entryBody(entry: TranscriptEntry, style: EntryStyle, width: number): string {
  const body = `${style.badge ? `${style.badge} ` : ""}${entry.text}`;
  return isInitialSubject(entry) ? truncateEnd(body.replace(/\s+/gu, " ").trim(), width) : body;
}

function isInitialSubject(entry: TranscriptEntry): boolean {
  return entry.from === "system" && entry.kind === "system" && entry.text.startsWith("Sujet :");
}

export class TranscriptStream {
  private readonly controller: StreamController;
  private active: { id: string; pipe: EntryPipeline; from: TranscriptEntry["from"] } | null = null;

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
    this.controller.push(lines);
    this.controller.flush();
  }

  /** An entry that is already complete when it appears. */
  entry(entry: TranscriptEntry): void {
    this.interruptActive();

    const style = entryStyle(entry);
    const pipe = new EntryPipeline(style, this.options.width(), shouldUseAscii(entry));

    if (!style.rail) {
      const lines = [
        ...pipe.push(entryBody(entry, style, this.options.width())),
        ...pipe.finish(false),
      ];
      // Keep the accepted prompt visually distinct from Claude's first turn.
      // These rows belong only to the terminal presentation; the canonical
      // transcript remains unchanged.
      if (isInitialSubject(entry)) lines.push("", "");
      this.controller.push(lines);
      this.controller.flush();
      return;
    }

    this.controller.push([
      ...this.headerLines(entry, style),
      ...pipe.push(entry.text),
      ...pipe.finish(false),
      "",
    ]);
    this.controller.flush();
  }

  entryStarted(entry: TranscriptEntry): void {
    this.interruptActive();

    const style = entryStyle(entry);
    const pipe = new EntryPipeline(style, this.options.width(), shouldUseAscii(entry));
    this.active = { id: entry.id, pipe, from: entry.from };
    this.controller.push(this.headerLines(entry, style));
    this.controller.flush();
  }

  chunk(id: string, delta: string): void {
    const active = this.active;
    if (!active || active.id !== id) return;
    active.pipe.setWidth(this.options.width());
    this.controller.push(active.pipe.push(delta));
    this.controller.schedule();
  }

  entryCompleted(id: string, outcome: EntryOutcome): void {
    const active = this.active;
    if (!active || active.id !== id) return;

    const lines = active.pipe.finish(outcome.status === "ok" && outcome.signal !== null);
    if (outcome.status === "error") {
      lines.push(
        chalk.hex(ERROR_STYLE.color)(
          `${ERROR_STYLE.badge} Erreur : ${asciiSymbolsForDisplay(outcome.message)}`,
        ),
      );
    } else if (outcome.status === "cancelled") {
      lines.push(chalk.dim("(Annulé)"));
    } else if (active.from === "claude" || active.from === "codex") {
      // Only a debater closes a turn with a decision. The synthesis is written
      // by an agent too, but it speaks as the system and signals nothing.
      const verdict = verdictText(outcome.signal, active.from, outcome.closesDebate === true);
      const color = AGENT_STYLE[active.from].color;
      // Blank rail line first: the verdict is about the turn, not a last
      // sentence of it, and must not read as one.
      if (verdict) lines.push(terminalColor(color)("│"), railPrefix(color) + chalk.dim(verdict));
    }
    lines.push("");

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

  private headerLines(entry: TranscriptEntry, style: EntryStyle): string[] {
    const width = this.options.width();
    const target = entry.to ? (entry.to === "both" ? " → les deux" : ` → ${entry.to}`) : "";
    const clock = entry.kind === "summary" ? "" : clockOf(entry.timestamp);
    const isAgent = entry.from === "claude" || entry.from === "codex";
    const badge = isAgent ? style.badge : `* ${style.badge}`;
    const label = `${badge}${target}`;

    const room = width - RAIL_WIDTH - displayWidth(label) - displayWidth(clock);
    const gap = " ".repeat(Math.max(1, room));

    const head =
      railPrefix(style.color) +
      terminalColor(style.color).bold(badge) +
      chalk.dim(target) +
      gap +
      chalk.dim(clock);

    return [head, terminalColor(style.color)("│")];
  }
}

function shouldUseAscii(entry: TranscriptEntry): boolean {
  return entry.from === "claude" || entry.from === "codex" || entry.kind === "summary";
}
