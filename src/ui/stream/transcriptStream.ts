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
  | { status: "ok"; signal: Signal }
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
function verdictText(signal: Signal, from: AgentId): string | null {
  switch (signal) {
    case "continue":
      return `↳ poursuit · passe la main à ${AGENT_STYLE[other(from)].badge}`;
    case "consensus":
      return "✓ d'accord, plus rien à ajouter";
    case "wait-human":
      return "⏸ attend ta réponse — débat en pause";
    // The rejection is already told by the return to the welcome screen, and
    // this turn is deliberately left out of the archived transcript.
    case "no-topic":
      return null;
    case null:
      return "⚠ aucune décision signalée";
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
  private readonly markdown = new MarkdownStreamer();
  private readonly buffer: LineBuffer;

  constructor(
    private readonly style: EntryStyle,
    width: number,
  ) {
    this.buffer = new LineBuffer(this.bodyWidth(width));
  }

  /** Chrome lines are quoted verbatim in one dim colour, not read as markdown. */
  private get formatted(): boolean {
    return this.style.rail;
  }

  setWidth(width: number): void {
    this.buffer.setWidth(this.bodyWidth(width));
  }

  push(delta: string): string[] {
    const visible = this.sanitizer.push(this.filter.push(delta));
    return this.buffer.push(visible).map((line) => this.render(line));
  }

  /** Commit the incomplete line so something permanent can be written after it. */
  interrupt(): string[] {
    return this.buffer.flush().map((line) => this.render(line));
  }

  finish(signalConfirmed: boolean): string[] {
    const rest = this.sanitizer.push(this.filter.finish(signalConfirmed)) + this.sanitizer.flush();
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
    return railPrefix(this.style.color) + this.markdown.style(line);
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
  const body = `${style.badge} ${entry.text}`;
  const isInitialSubject =
    entry.from === "system" && entry.kind === "system" && entry.text.startsWith("Sujet :");
  return isInitialSubject ? truncateEnd(body.replace(/\s+/gu, " ").trim(), width) : body;
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
    const pipe = new EntryPipeline(style, this.options.width());

    if (!style.rail) {
      this.controller.push([
        ...pipe.push(entryBody(entry, style, this.options.width())),
        ...pipe.finish(false),
      ]);
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
    const pipe = new EntryPipeline(style, this.options.width());
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
      lines.push(chalk.hex(ERROR_STYLE.color)(`${ERROR_STYLE.badge} Erreur : ${outcome.message}`));
    } else if (outcome.status === "cancelled") {
      lines.push(chalk.dim("(Annulé)"));
    } else if (active.from === "claude" || active.from === "codex") {
      // Only a debater closes a turn with a decision. The synthesis is written
      // by an agent too, but it speaks as the system and signals nothing.
      const verdict = verdictText(outcome.signal, active.from);
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
    const badge = isAgent ? style.badge : `● ${style.badge}`;
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
