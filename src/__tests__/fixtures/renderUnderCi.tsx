/**
 * Mounts a frame with Claudex's render options on a fake terminal and reports
 * what reached the screen while the app was still running.
 *
 * Run in a child process by renderOptions.test.ts: Ink reads the CI variable
 * once, when it is first imported, so the parent test cannot set it in-process.
 */
import { EventEmitter } from "node:events";
import { render, Text } from "ink";
import { RENDER_OPTIONS } from "../../renderOptions.js";

const chunks: string[] = [];
const stdout = Object.assign(new EventEmitter(), {
  isTTY: true,
  columns: 80,
  rows: 24,
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

const app = render(<Text>frame drawn</Text>, {
  ...RENDER_OPTIONS,
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: stderr as never,
  patchConsole: false,
});

// Ink throttles its renders; leave it time to draw before looking.
await new Promise((resolve) => setTimeout(resolve, 200));
const whileRunning = chunks.join("");
app.unmount();

process.stdout.write(
  JSON.stringify({
    alternateScreen: whileRunning.includes("\u001b[?1049h"),
    frameDrawn: whileRunning.includes("frame drawn"),
  }),
);
