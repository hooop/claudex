// Erase the visible screen, then home the cursor so the repaint starts at the top.
const CLEAR_SCREEN = "\u001b[2J\u001b[H";

/**
 * Makes every resize end on one clean frame. Ink 7.1.1 clears its previous
 * frame only when the width shrinks or the old frame overflows the new
 * height; otherwise it diffs the new frame line by line against a frame the
 * terminal may have moved or reflowed, and the old frame shows through.
 *
 * `write` must be Ink's own `useStdout().write`: Ink erases its frame, writes
 * the data, then repaints its last frame in full and resets its diff state to
 * it. The listener is added after Ink's, so that last frame is the one Ink
 * just computed for the new size. `app.clear()` does not work here: it keeps
 * Ink's diff state on the erased frame, so unchanged lines are never redrawn.
 */
export function installResizeClear(
  stdout: NodeJS.WriteStream,
  write: (data: string) => void,
): () => void {
  const onResize = () => write(CLEAR_SCREEN);
  stdout.on("resize", onResize);
  return () => {
    stdout.off("resize", onResize);
  };
}

export const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
export const MOUSE_OFF = "\u001b[?1006l\u001b[?1002l\u001b[?1000l";

type TerminalOutput = { write(data: string): unknown; isTTY?: boolean };

// Per output, so that a second write of the same state is skipped and an exit
// path never turns off what was never turned on.
const mouseReporting = new WeakMap<TerminalOutput, boolean>();

/**
 * Turns SGR mouse reporting (press, drag, release, wheel) on or off. Idempotent.
 * Written straight to the terminal rather than through Ink: a mode switch
 * draws nothing, so it cannot disturb Ink's frame.
 */
export function setMouseReporting(stdout: TerminalOutput, on: boolean): void {
  if (!stdout.isTTY) return;
  if ((mouseReporting.get(stdout) ?? false) === on) return;
  mouseReporting.set(stdout, on);
  stdout.write(on ? MOUSE_ON : MOUSE_OFF);
}

type ProcessEvents = Pick<NodeJS.EventEmitter, "on" | "off">;

const SIGNAL_EXIT_CODES = { SIGTERM: 128 + 15, SIGHUP: 128 + 1 } as const;

/**
 * Mouse reporting left on after Claudex dies floods the user's shell with
 * escape sequences on every mouse move, so every abnormal exit turns it off.
 *
 * Fatal errors go through `uncaughtExceptionMonitor`, which also sees
 * unhandled rejections (Node raises them as uncaught exceptions): a monitor
 * observes without handling, so Node still prints the error and exits with
 * code 1. A listener on `uncaughtException` or `unhandledRejection` would
 * replace that. A signal listener does replace Node's default, so the guard
 * exits itself with 128 + the signal number; that `exit` still runs Ink's
 * own exit cleanup.
 */
export function installExitGuards(
  stdout: TerminalOutput,
  onExit: (code: number) => void = (code) => process.exit(code),
  events: ProcessEvents = process,
): () => void {
  const onFatal = () => setMouseReporting(stdout, false);
  const signalHandlers = Object.entries(SIGNAL_EXIT_CODES).map(([signal, code]) => {
    const handler = () => {
      setMouseReporting(stdout, false);
      onExit(code);
    };
    events.on(signal, handler);
    return [signal, handler] as const;
  });
  events.on("uncaughtExceptionMonitor", onFatal);
  return () => {
    for (const [signal, handler] of signalHandlers) events.off(signal, handler);
    events.off("uncaughtExceptionMonitor", onFatal);
  };
}
