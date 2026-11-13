/**
 * Layout invariants of the debate screen, read from whole frames: at every
 * supported size the frame fills the window minus Ink's spare row, the header
 * is on the first row and the footer on the last one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSendOptions, CodingAgent } from "../../agents/types.js";
import { DebateSession } from "../../orchestrator/session.js";
import type { AgentResult } from "../../orchestrator/types.js";
import type { AgentId, PermissionDecision } from "../../types.js";
import { DebateView } from "../DebateView.js";
import { MIN_ROWS, tooSmallMessage } from "../theme.js";
import { mountFrame, settle, type Size } from "./frameHarness.js";

class FakeAgent implements CodingAgent {
  readonly label: string;
  private options: AgentSendOptions | null = null;
  private resolve: ((result: AgentResult) => void) | null = null;

  constructor(readonly id: AgentId) {
    this.label = `Fake ${id}`;
  }

  currentModel() {
    return "fake-model";
  }
  hasExplicitModel() {
    return true;
  }
  setModel() {}
  resetSession() {}
  async stop() {
    this.resolve?.({ kind: "cancelled" });
    this.resolve = null;
  }

  send(_message: string, options: AgentSendOptions): Promise<AgentResult> {
    this.options = options;
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  get pending(): boolean {
    return this.resolve !== null;
  }

  emit(delta: string): void {
    this.options?.onTextDelta?.(delta);
  }

  askPermission(): Promise<PermissionDecision> | undefined {
    return this.options?.onPermissionRequest?.({
      id: "p1",
      agent: this.id,
      toolName: "Bash",
      input: { command: "ls" },
    });
  }
}

const PAGE_UP = "\u001b[5~";
const ESC = "\u001b";
const HEIGHTS = [MIN_ROWS, MIN_ROWS + 1, MIN_ROWS + 2, MIN_ROWS + 3, 20, 24, 40];

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function mount(size: Size = { columns: 100, rows: 24 }) {
  const agents = { claude: new FakeAgent("claude"), codex: new FakeAgent("codex") };
  const session = new DebateSession(agents, {
    cwd: "/tmp",
    starter: "claude",
    autonomyBudget: { kind: "unbounded" },
  });
  const screen = mountFrame(
    <DebateView
      session={session}
      topic="Layout topic"
      cwd="/tmp"
      status={{
        decisionsCount: 2,
        decisionsText: null,
        lastSession: null,
        autonomyBudget: null,
        claudeConfiguredModel: null,
        claudeDefaultModel: null,
        codexDefaultModel: null,
        codexDefaultEffort: null,
      }}
      coordinatorState={{ kind: "idle" }}
      coordinatorNotice={null}
      onLifecycleRequest={async () => ({ ok: true, message: "ok" })}
      onAutonomySelected={async () => {}}
    />,
    size,
  );
  cleanup = screen.unmount;
  await vi.waitFor(() => expect(agents.claude.pending).toBe(true));
  agents.claude.emit(Array.from({ length: 60 }, (_, i) => `history line ${i}\n`).join(""));
  await settle();
  return { screen, agents, session };
}

function expectWholeFrame(rows: string[], terminalRows: number) {
  expect(rows).toHaveLength(terminalRows - 1);
  expect(rows[0]).toMatch(/^CLAUDEX /u);
}

/** The transcript rows: between the header's heavy rule and the footer's thin rule. */
function transcript(rows: string[]): string[] {
  const start = rows.findIndex((row) => row.startsWith("━")) + 1;
  const end = rows.findIndex((row, index) => index >= start && row.startsWith("─"));
  return rows.slice(start, end);
}

describe("debate frame at every supported height", () => {
  it("keeps the header first and the model line last", async () => {
    const { screen } = await mount();
    for (const rows of HEIGHTS) {
      await screen.resize({ columns: 100, rows });
      const frame = screen.frame();
      expectWholeFrame(frame, rows);
      expect(frame.at(-1), `at ${rows} rows`).toContain("fake-model");
      expect(transcript(frame).length, `at ${rows} rows`).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the prompt last while the command palette is open", async () => {
    const { screen } = await mount();
    await screen.press("/");
    for (const rows of HEIGHTS) {
      await screen.resize({ columns: 100, rows });
      const frame = screen.frame();
      expectWholeFrame(frame, rows);
      // The palette deliberately takes the model line's place; the prompt is
      // the middle row of the three-row input bar, now the last surface.
      expect(frame.at(-2), `at ${rows} rows`).toContain("‣");
    }
  });

  it("keeps the permission question and the model line visible", async () => {
    const { screen, agents } = await mount();
    void agents.claude.askPermission();
    await settle();
    for (const rows of HEIGHTS) {
      await screen.resize({ columns: 100, rows });
      const frame = screen.frame();
      expectWholeFrame(frame, rows);
      expect(frame.at(-1), `at ${rows} rows`).toContain("fake-model");
      expect(frame.join("\n"), `at ${rows} rows`).toContain("Bash");
    }
  });
});

describe("debate screen below the minimum size", () => {
  it("shows only the too-small line, ignores keys, and comes back unchanged", async () => {
    const { screen } = await mount();
    const before = transcript(screen.frame());

    await screen.resize({ columns: 100, rows: MIN_ROWS - 1 });
    expect(screen.frame()).toEqual([tooSmallMessage()]);
    await screen.press(PAGE_UP);
    await screen.press(ESC);
    await settle();

    await screen.resize({ columns: 100, rows: 24 });
    const after = screen.frame();
    expectWholeFrame(after, 24);
    expect(transcript(after)).toEqual(before);
    expect(after.join("\n")).not.toContain("Paused");
  });

  it("keeps the draft typed before the window was shrunk too far", async () => {
    const { screen } = await mount();
    await screen.press("my draft");
    await screen.resize({ columns: 100, rows: MIN_ROWS - 1 });
    await screen.resize({ columns: 100, rows: 24 });
    expect(screen.frame().join("\n")).toContain("my draft");
  });
});
