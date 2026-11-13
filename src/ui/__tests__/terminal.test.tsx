import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { Box, render, Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RENDER_OPTIONS } from "../../renderOptions.js";
import { installExitGuards, installResizeClear, MOUSE_OFF, MOUSE_ON, setMouseReporting } from "../terminal.js";

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

function fakeStdout(isTTY = true) {
  const writes: string[] = [];
  return { stdout: { isTTY, write: (data: string) => writes.push(data) }, writes };
}

describe("setMouseReporting", () => {
  it("uses SGR reporting with drag, and turns it off in reverse order", () => {
    expect(MOUSE_ON).toBe("\u001b[?1000h\u001b[?1002h\u001b[?1006h");
    expect(MOUSE_OFF).toBe("\u001b[?1006l\u001b[?1002l\u001b[?1000l");
  });

  it("writes MOUSE_ON once even if called twice", () => {
    const { stdout, writes } = fakeStdout();
    setMouseReporting(stdout, true);
    setMouseReporting(stdout, true);
    expect(writes).toEqual([MOUSE_ON]);
  });

  it("writes MOUSE_OFF once, and only after it was turned on", () => {
    const { stdout, writes } = fakeStdout();
    setMouseReporting(stdout, false);
    setMouseReporting(stdout, true);
    setMouseReporting(stdout, false);
    setMouseReporting(stdout, false);
    expect(writes).toEqual([MOUSE_ON, MOUSE_OFF]);
  });

  it("can be turned on again after being turned off", () => {
    const { stdout, writes } = fakeStdout();
    setMouseReporting(stdout, true);
    setMouseReporting(stdout, false);
    setMouseReporting(stdout, true);
    expect(writes).toEqual([MOUSE_ON, MOUSE_OFF, MOUSE_ON]);
  });

  it("writes nothing to an output that is not a terminal", () => {
    const { stdout, writes } = fakeStdout(false);
    setMouseReporting(stdout, true);
    setMouseReporting(stdout, false);
    expect(writes).toEqual([]);
  });
});

function fakeProcess() {
  return new EventEmitter();
}

describe("installExitGuards", () => {
  it("writes MOUSE_OFF on SIGTERM, then exits with 143", () => {
    const { stdout, writes } = fakeStdout();
    const proc = fakeProcess();
    const exit = vi.fn<(code: number) => void>(() => {
      writes.push("<exit>");
    });
    installExitGuards(stdout, exit, proc);
    setMouseReporting(stdout, true);

    proc.emit("SIGTERM", "SIGTERM");

    expect(writes).toEqual([MOUSE_ON, MOUSE_OFF, "<exit>"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
  });

  it("writes MOUSE_OFF on SIGHUP, then exits with 129", () => {
    const { stdout, writes } = fakeStdout();
    const proc = fakeProcess();
    const exit = vi.fn<(code: number) => void>();
    installExitGuards(stdout, exit, proc);
    setMouseReporting(stdout, true);

    proc.emit("SIGHUP", "SIGHUP");

    expect(writes).toEqual([MOUSE_ON, MOUSE_OFF]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(129);
  });

  it("writes MOUSE_OFF on a fatal error without handling it or exiting itself", () => {
    const { stdout, writes } = fakeStdout();
    const proc = fakeProcess();
    const exit = vi.fn<(code: number) => void>();
    installExitGuards(stdout, exit, proc);
    setMouseReporting(stdout, true);

    proc.emit("uncaughtExceptionMonitor", new Error("boom"), "uncaughtException");

    expect(writes).toEqual([MOUSE_ON, MOUSE_OFF]);
    expect(exit).not.toHaveBeenCalled();
    // A listener on these events would replace Node's own printing and exit code.
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
  });

  it("removes every listener it added", () => {
    const { stdout } = fakeStdout();
    const proc = fakeProcess();
    const remove = installExitGuards(stdout, vi.fn(), proc);
    remove();
    expect(proc.eventNames()).toEqual([]);
  });
});

// Runs a real Node process, so Node's own handling of fatal errors and signals
// is what is measured. Its stdout is a pipe; the guard gets a terminal-like
// writer onto it.
function runGuarded(body: string) {
  const terminalUrl = new URL("../terminal.ts", import.meta.url).href;
  const script = `
    import { writeSync } from "node:fs";
    import { installExitGuards, setMouseReporting } from ${JSON.stringify(terminalUrl)};
    const stdout = { isTTY: true, write: (data) => writeSync(1, data) };
    installExitGuards(stdout);
    setMouseReporting(stdout, true);
    ${body}
  `;
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (data: Buffer) => {
        out += data.toString();
        if (out.includes("ready") && body.includes("ready")) child.kill("SIGTERM");
      });
      child.stderr.on("data", (data: Buffer) => (err += data.toString()));
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout: out, stderr: err }));
    },
  );
}

describe("installExitGuards — real process", () => {
  it("turns the mouse off on an uncaught error, which is still printed with exit code 1", async () => {
    const result = await runGuarded(`setTimeout(() => { throw new Error("guarded boom"); });`);
    expect(result.stdout).toBe(MOUSE_ON + MOUSE_OFF);
    expect(result.stderr).toContain("guarded boom");
    expect(result.code).toBe(1);
  });

  it("turns the mouse off on an unhandled rejection, which is still printed with exit code 1", async () => {
    const result = await runGuarded(`Promise.reject(new Error("rejected boom"));`);
    expect(result.stdout).toBe(MOUSE_ON + MOUSE_OFF);
    expect(result.stderr).toContain("rejected boom");
    expect(result.code).toBe(1);
  });

  it("turns the mouse off on SIGTERM and exits with 143", async () => {
    const result = await runGuarded(`writeSync(1, "ready"); setInterval(() => {}, 1000);`);
    expect(result.stdout).toBe(`${MOUSE_ON}ready${MOUSE_OFF}`);
    expect(result.code).toBe(143);
  });
});
