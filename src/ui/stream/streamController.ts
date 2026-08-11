/**
 * The only thing in Claudex allowed to put permanent text on the terminal.
 *
 * Everything funnels through one queue so there is never a second writer racing
 * the first, and so ordering is whatever order the events happened in. The write
 * itself goes through Ink's `useStdout().write`, which erases the dynamic footer,
 * appends the block, and redraws the footer underneath it — the append lands in
 * the terminal's own scrollback, where selection and copy work normally, and is
 * never touched again.
 *
 * Two rules hold the whole scheme together:
 *
 *  - every block ends in a newline, so the footer always starts on a fresh line;
 *  - nothing already written is ever rewritten.
 *
 * Lines are grouped at the renderer's own cadence rather than written per token:
 * a burst of deltas becomes one write instead of forty, and the cost of a write
 * is proportional to the new text, never to the length of the transcript.
 */

export type StreamWriter = (data: string) => void;

/** Ink throttles its own renders at 32 ms; matching it keeps the two in step. */
export const FLUSH_INTERVAL_MS = 32;

export interface StreamControllerOptions {
  write: StreamWriter;
  /** Called after every flush, so the footer can pick up the new pending tail. */
  onFlush?: () => void;
  intervalMs?: number;
}

export class StreamController {
  private queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly intervalMs: number;

  constructor(private options: StreamControllerOptions) {
    this.intervalMs = options.intervalMs ?? FLUSH_INTERVAL_MS;
  }

  /** Queue permanent lines. They must not contain newlines — one entry, one line. */
  push(lines: readonly string[]): void {
    if (this.disposed || lines.length === 0) return;
    for (const line of lines) this.queue.push(line);
    this.schedule();
  }

  /**
   * Ask for a flush at the next tick. Also used with an empty queue, to refresh
   * the footer's view of the pending tail at the same cadence.
   */
  schedule(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.intervalMs);
  }

  /**
   * Write immediately. Forced at the end of a message, before a permanent event
   * interleaves into a running one, and on error, cancellation or shutdown —
   * anywhere a delayed write would show things out of order.
   */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed) return;

    if (this.queue.length > 0) {
      const block = this.queue.join("\n") + "\n";
      this.queue = [];
      this.options.write(block);
    }

    this.options.onFlush?.();
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
