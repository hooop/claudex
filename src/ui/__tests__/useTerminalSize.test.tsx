import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render, Text } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { useTerminalSize } from "../useTerminalSize.js";

function fakeTerminal(columns: number, rows: number) {
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows,
    write: (data: string) => {
      writes.push(data);
      return true;
    },
  });
  return { stdout, writes };
}

function Probe() {
  const { columns, rows } = useTerminalSize();
  return <Text>{`${columns}x${rows}`}</Text>;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

function mount(terminal: ReturnType<typeof fakeTerminal>) {
  const app = render(<Probe />, {
    debug: true,
    patchConsole: false,
    stdout: terminal.stdout as never,
  });
  unmount = () => app.unmount();
  return app;
}

const lastWrite = (terminal: ReturnType<typeof fakeTerminal>) =>
  stripVTControlCharacters(terminal.writes.at(-1) ?? "");

describe("useTerminalSize", () => {
  it("starts from the stream's size", async () => {
    const terminal = fakeTerminal(100, 30);
    mount(terminal);
    await settle();
    expect(lastWrite(terminal)).toContain("100x30");
  });

  it("follows a resize", async () => {
    const terminal = fakeTerminal(100, 30);
    mount(terminal);
    await settle();
    terminal.stdout.rows = 40;
    terminal.stdout.columns = 60;
    terminal.stdout.emit("resize");
    await settle();
    expect(lastWrite(terminal)).toContain("60x40");
  });

  it("removes its listener on unmount", async () => {
    const terminal = fakeTerminal(100, 30);
    const before = terminal.stdout.listenerCount("resize");
    const app = mount(terminal);
    await settle();
    app.unmount();
    unmount = undefined;
    expect(terminal.stdout.listenerCount("resize")).toBe(before);
  });

  it("runs before listeners registered earlier, such as Ink's own", async () => {
    const terminal = fakeTerminal(100, 30);
    const earlier = () => {};
    terminal.stdout.on("resize", earlier);
    mount(terminal);
    await settle();
    expect(terminal.stdout.listeners("resize")[0]).not.toBe(earlier);
  });
});
