import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { Box, render, Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RENDER_OPTIONS } from "../../renderOptions.js";
import { installResizeClear } from "../terminal.js";

// Erase the whole visible screen. Whatever the terminal did to the old frame on
// resize (reflow, anchoring to the bottom), nothing of it survives this.
const ERASE_DISPLAY = "\u001b[2J";

function fakeTerminal(columns: number, rows: number) {
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows,
    write: (data: string) => {
      chunks.push(data);
      return true;
    },
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    read: () => null,
    ref: () => stdin,
    unref: () => stdin,
  });
  const stderr = Object.assign(new EventEmitter(), { write: () => true });
  return { stdout, stdin, stderr, chunks };
}

// Mirrors how Claudex sizes its frame: one row short of the window, re-measured
// on resize, so a height change changes the frame. Installs the clear as Root does.
function Frame() {
  const { stdout, write } = useStdout();
  const [rows, setRows] = useState(stdout.rows);
  useEffect(() => {
    const onResize = () => setRows(stdout.rows);
    stdout.prependListener("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  useEffect(() => installResizeClear(stdout, write), [stdout, write]);
  return (
    <Box flexDirection="column" height={rows - 1}>
      <Text>TOP-OF-FRAME</Text>
      <Box flexGrow={1} />
      <Text>BOTTOM-OF-FRAME</Text>
    </Box>
  );
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

async function resizeAndCapture(from: { columns: number; rows: number }, to: { columns: number; rows: number }) {
  const terminal = fakeTerminal(from.columns, from.rows);
  const app = render(<Frame />, {
    ...RENDER_OPTIONS,
    patchConsole: false,
    stdout: terminal.stdout as never,
    stdin: terminal.stdin as never,
    stderr: terminal.stderr as never,
  });
  unmount = () => app.unmount();
  await settle();
  terminal.chunks.length = 0;

  terminal.stdout.columns = to.columns;
  terminal.stdout.rows = to.rows;
  terminal.stdout.emit("resize");
  await settle();
  return terminal.chunks.join("");
}

// After the last full-screen erase, the whole frame must be written again,
// including the lines that did not change: an incremental diff would skip them
// and leave them blank or stale.
function expectCleanFrame(written: string) {
  const lastErase = written.lastIndexOf(ERASE_DISPLAY);
  expect(lastErase, "no full-screen erase after the resize").toBeGreaterThanOrEqual(0);
  const repaint = stripVTControlCharacters(written.slice(lastErase));
  expect(repaint).toContain("TOP-OF-FRAME");
  expect(repaint).toContain("BOTTOM-OF-FRAME");
}

describe("resize — one clean frame", () => {
  it("repaints the whole frame when the window grows taller", async () => {
    expectCleanFrame(await resizeAndCapture({ columns: 80, rows: 24 }, { columns: 80, rows: 40 }));
  });

  it("repaints the whole frame when the window gets shorter", async () => {
    expectCleanFrame(await resizeAndCapture({ columns: 80, rows: 40 }, { columns: 80, rows: 24 }));
  });

  it("repaints the whole frame when the window gets wider", async () => {
    expectCleanFrame(await resizeAndCapture({ columns: 80, rows: 24 }, { columns: 120, rows: 24 }));
  });

  it("repaints the whole frame when the window gets narrower", async () => {
    expectCleanFrame(await resizeAndCapture({ columns: 120, rows: 24 }, { columns: 80, rows: 24 }));
  });
});

describe("installResizeClear", () => {
  it("erases the screen and homes the cursor through the given writer on resize", () => {
    const stdout = new EventEmitter();
    const write = vi.fn();
    installResizeClear(stdout as never, write);

    stdout.emit("resize");

    expect(write).toHaveBeenCalledExactlyOnceWith("\u001b[2J\u001b[H");
  });

  it("runs after the listeners already registered, so it repaints Ink's new frame", () => {
    const stdout = new EventEmitter();
    const calls: string[] = [];
    stdout.on("resize", () => calls.push("ink"));
    installResizeClear(stdout as never, () => calls.push("clear"));

    stdout.emit("resize");

    expect(calls).toEqual(["ink", "clear"]);
  });

  it("stops clearing once removed", () => {
    const stdout = new EventEmitter();
    const write = vi.fn();
    const remove = installResizeClear(stdout as never, write);

    remove();
    stdout.emit("resize");

    expect(write).not.toHaveBeenCalled();
    expect(stdout.listenerCount("resize")).toBe(0);
  });
});
