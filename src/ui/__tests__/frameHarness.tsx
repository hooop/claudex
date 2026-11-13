import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import type { ReactElement } from "react";

export interface Size {
  columns: number;
  rows: number;
}

export async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mounts a screen on a fake terminal in Ink's debug mode, where every write is
 * a whole frame. Layout tests read positions from that frame: asserting that a
 * text was written somewhere proves nothing about where it landed.
 */
export function mountFrame(node: ReactElement, size: Size) {
  const writes: string[] = [];
  const inputQueue: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: size.columns,
    rows: size.rows,
    write: (data: string) => {
      writes.push(data);
      return true;
    },
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    read: () => inputQueue.shift() ?? null,
    ref: () => stdin,
    unref: () => stdin,
  });
  const stderr = Object.assign(new EventEmitter(), { write: () => true });
  const app = render(node, {
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: stderr as never,
  });

  return {
    stdout,
    rerender: (next: ReactElement) => app.rerender(next),
    async resize(next: Size) {
      stdout.columns = next.columns;
      stdout.rows = next.rows;
      stdout.emit("resize");
      await settle();
    },
    async press(input: string) {
      inputQueue.push(input);
      stdin.emit("readable");
      await settle(30);
    },
    /** The rows of the last frame, without colours or cursor sequences. */
    frame(): string[] {
      const last = writes.at(-1) ?? "";
      const rows = stripVTControlCharacters(last).split("\n");
      // Ink ends a frame that does not fill the screen with a newline.
      if (rows.at(-1) === "") rows.pop();
      return rows;
    },
    unmount: () => app.unmount(),
  };
}
