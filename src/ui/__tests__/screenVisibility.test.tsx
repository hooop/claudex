import { Text } from "ink";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionViewer } from "../components/DecisionViewer.js";
import { InputBar } from "../components/InputBar.js";
import { ModelPicker } from "../components/ModelPicker.js";
import { PermissionModal } from "../components/PermissionModal.js";
import type { MouseEvent } from "../mouse/mouseInput.js";
import { MouseProvider, useMouse } from "../mouse/MouseContext.js";
import { FittedScreen, ScreenVisibleContext } from "../screenVisibility.js";
import { tooSmallMessage } from "../theme.js";
import { mountFrame, settle } from "./frameHarness.js";

const ESC = "\u001b";
const ENTER = "\r";
const SIZE = { columns: 80, rows: 24 };
const request = { id: "p1", agent: "claude" as const, toolName: "Bash", input: { command: "ls" } };

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function hidden(node: ReactNode) {
  return <ScreenVisibleContext.Provider value={false}>{node}</ScreenVisibleContext.Provider>;
}

async function mount(node: ReactNode, size = SIZE) {
  const screen = mountFrame(<>{node}</>, size);
  cleanup = screen.unmount;
  await settle();
  return screen;
}

describe("keys are ignored while the screen is hidden", () => {
  it("does not answer a permission request", async () => {
    const onDecide = vi.fn();
    const screen = await mount(hidden(<PermissionModal request={request} onDecide={onDecide} width={80} />));
    await screen.press("y");
    await screen.press("n");
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("still answers a permission request while visible", async () => {
    const onDecide = vi.fn();
    const screen = await mount(<PermissionModal request={request} onDecide={onDecide} width={80} />);
    await screen.press("y");
    expect(onDecide).toHaveBeenCalledWith(true);
  });

  it("neither closes nor selects in the model picker", async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const screen = await mount(
      hidden(<ModelPicker agent="claude" onSelect={onSelect} onCancel={onCancel} width={80} />),
    );
    await screen.press(ENTER);
    await screen.press(ESC);
    await settle();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("does not close the decision viewer", async () => {
    const onClose = vi.fn();
    const screen = await mount(
      hidden(<DecisionViewer markdown={"# Decisions\n\nOne."} width={80} height={10} onClose={onClose} />),
    );
    await screen.press(ESC);
    await settle();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("neither types, pastes nor submits in the input bar", async () => {
    const onSubmit = vi.fn();
    const screen = await mount(hidden(<InputBar disabled={false} placeholder="type here" onSubmit={onSubmit} />));
    await screen.press("abc");
    await screen.press("\u001b[200~pasted\u001b[201~");
    await screen.press(ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.frame().join("\n")).not.toMatch(/abc|pasted/);
  });
});

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <Text>
      count {count}
      {count === 0 ? <Bump onBump={() => setCount(1)} /> : null}
    </Text>
  );
}

function Bump(props: { onBump: () => void }) {
  // Changes the state once after mount, so a remount would show 0 again.
  setTimeout(props.onBump, 0);
  return null;
}

function MouseProbe(props: { onEvent: (event: MouseEvent) => void }) {
  useMouse(props.onEvent, true);
  return <Text>probe</Text>;
}

describe("the mouse is ignored while the screen is hidden", () => {
  it("delivers no event to a hidden screen", async () => {
    const listeners = new Set<(event: MouseEvent) => void>();
    const source = {
      on(listener: (event: MouseEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const onEvent = vi.fn();
    await mount(
      <MouseProvider source={source}>{hidden(<MouseProbe onEvent={onEvent} />)}</MouseProvider>,
    );
    for (const listener of listeners) listener({ kind: "wheel", direction: "up", x: 1, y: 1 });
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("FittedScreen", () => {
  it("shows only the too-small line below the minimum", async () => {
    const screen = await mount(
      <FittedScreen columns={40} rows={14}>
        <Text>the screen</Text>
      </FittedScreen>,
    );
    expect(screen.frame()).toEqual([tooSmallMessage()]);
  });

  it("shows the screen at the minimum", async () => {
    const screen = await mount(
      <FittedScreen columns={40} rows={15}>
        <Text>the screen</Text>
      </FittedScreen>,
    );
    expect(screen.frame()).toEqual(["the screen"]);
  });

  it("keeps the screen mounted while hidden", async () => {
    const at = (rows: number) => (
      <FittedScreen columns={40} rows={rows}>
        <Counter />
      </FittedScreen>
    );
    const screen = await mount(at(15));
    expect(screen.frame()).toEqual(["count 1"]);
    screen.rerender(at(14));
    await settle();
    screen.rerender(at(15));
    await settle();
    expect(screen.frame()).toEqual(["count 1"]);
  });
});
