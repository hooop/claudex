import { EventEmitter } from "node:events";
import { render, Text } from "ink";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MouseProvider, useMouse } from "../MouseContext.js";
import type { MouseEvent } from "../mouseInput.js";

function fakeMouseSource() {
  const listeners = new Set<(event: MouseEvent) => void>();
  return {
    on(listener: (event: MouseEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: MouseEvent) {
      for (const listener of listeners) listener(event);
    },
    get size() {
      return listeners.size;
    },
  };
}

function fakeTerminal() {
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: () => true });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    read: () => null,
    ref: () => stdin,
    unref: () => stdin,
  });
  const stderr = Object.assign(new EventEmitter(), { write: () => true });
  return { stdout, stdin, stderr };
}

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

function mount(node: React.ReactNode) {
  const terminal = fakeTerminal();
  const app = render(node, {
    stdout: terminal.stdout as never,
    stdin: terminal.stdin as never,
    stderr: terminal.stderr as never,
    patchConsole: false,
  });
  unmount = () => app.unmount();
  return app;
}

const press: MouseEvent = { kind: "press", x: 1, y: 2 };

describe("useMouse", () => {
  it("delivers the source's events to an active handler", async () => {
    const source = fakeMouseSource();
    const received: MouseEvent[] = [];
    function Probe() {
      useMouse((event) => received.push(event), true);
      return <Text>probe</Text>;
    }
    mount(
      <MouseProvider source={source}>
        <Probe />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(source.size).toBe(1));
    source.emit(press);
    expect(received).toEqual([press]);
  });

  it("does not listen while inactive", async () => {
    const source = fakeMouseSource();
    const received: MouseEvent[] = [];
    function Probe() {
      useMouse((event) => received.push(event), false);
      return <Text>probe</Text>;
    }
    mount(
      <MouseProvider source={source}>
        <Probe />
      </MouseProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    source.emit(press);
    expect(source.size).toBe(0);
    expect(received).toEqual([]);
  });

  it("uses the latest handler without resubscribing", async () => {
    const source = fakeMouseSource();
    const received: string[] = [];
    let setLabel: (label: string) => void = () => {};
    function Probe() {
      const [label, set] = useState("first");
      setLabel = set;
      useMouse(() => received.push(label), true);
      return <Text>{label}</Text>;
    }
    mount(
      <MouseProvider source={source}>
        <Probe />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(source.size).toBe(1));
    setLabel("second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    source.emit(press);
    expect(received).toEqual(["second"]);
    expect(source.size).toBe(1);
  });

  it("unsubscribes on unmount", async () => {
    const source = fakeMouseSource();
    function Probe() {
      useMouse(() => {}, true);
      return <Text>probe</Text>;
    }
    const app = mount(
      <MouseProvider source={source}>
        <Probe />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(source.size).toBe(1));
    app.unmount();
    unmount = undefined;
    expect(source.size).toBe(0);
  });

  it("does nothing without a provider or with a null source", async () => {
    function Probe() {
      useMouse(() => {}, true);
      return <Text>probe</Text>;
    }
    mount(
      <>
        <Probe />
        <MouseProvider source={null}>
          <Probe />
        </MouseProvider>
      </>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
