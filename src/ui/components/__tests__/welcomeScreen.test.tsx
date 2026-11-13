import { afterEach, describe, expect, it } from "vitest";
import type { CodingAgent } from "../../../agents/types.js";
import type { AgentId } from "../../../types.js";
import type { ProjectStatus } from "../../../util/projectStatus.js";
import { mountFrame, type Size } from "../../__tests__/frameHarness.js";
import { DEFAULT_HEADER_ANIMATION, HEADER_MAX_WIDTH } from "../../headerArt.js";
import { tooSmallMessage } from "../../theme.js";
import { WelcomeScreen } from "../WelcomeScreen.js";

function agent(id: AgentId): CodingAgent {
  return {
    id,
    label: id,
    currentModel: () => `${id}-model`,
    hasExplicitModel: () => true,
    setModel: () => {},
    resetSession: () => {},
    stop: () => Promise.resolve(),
    send: () => Promise.resolve({ kind: "cancelled" }),
  };
}

const status: ProjectStatus = {
  decisionsCount: 2,
  decisionsText: null,
  lastSession: null,
  autonomyBudget: null,
  claudeConfiguredModel: "claude-model",
  claudeDefaultModel: "claude-model",
  codexDefaultModel: "codex-model",
  codexDefaultEffort: "medium",
};

const PLACEHOLDER = "Describe the technical problem";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function mount(size: Size) {
  const screen = mountFrame(
    <WelcomeScreen
      agents={{ claude: agent("claude"), codex: agent("codex") }}
      status={status}
      headerAnimation={DEFAULT_HEADER_ANIMATION}
      onHeaderAnimationChange={() => {}}
      onStart={() => {}}
    />,
    size,
  );
  cleanup = screen.unmount;
  await screen.resize(size);
  return screen;
}

function expectWholeFrame(rows: string[], terminalRows: number) {
  expect(rows).toHaveLength(terminalRows - 1);
  expect(rows[0]?.trim()).not.toBe("");
  expect(rows.at(-1)).toContain("/help");
  // The prompt row sits in the middle of the three-row input bar, above the model line.
  expect(rows.at(-3)).toContain(PLACEHOLDER);
}

describe("WelcomeScreen follows the terminal size", () => {
  it("fills a taller window, with the footer on the last row", async () => {
    const screen = await mount({ columns: 80, rows: 24 });
    await screen.resize({ columns: 80, rows: 40 });
    expectWholeFrame(screen.frame(), 40);
  });

  it("fits a shorter window, with the header on the first row", async () => {
    const screen = await mount({ columns: 80, rows: 40 });
    await screen.resize({ columns: 80, rows: 16 });
    expectWholeFrame(screen.frame(), 16);
  });

  it("widens the memory divider when the window gets wider", async () => {
    const screen = await mount({ columns: 80, rows: 24 });
    await screen.resize({ columns: 120, rows: 24 });
    const divider = screen.frame().find((row) => /^-+$/u.test(row.trim()));
    expect(divider?.trim()).toHaveLength(Math.min(120, HEADER_MAX_WIDTH));
  });

  it("shows only the too-small line below the minimum, and ignores keys there", async () => {
    const screen = await mount({ columns: 80, rows: 24 });
    await screen.resize({ columns: 80, rows: 12 });
    expect(screen.frame()).toEqual([tooSmallMessage()]);
    await screen.press("hidden");
    await screen.resize({ columns: 80, rows: 24 });
    const rows = screen.frame();
    expectWholeFrame(rows, 24);
    expect(rows.join("\n")).not.toContain("hidden");
  });

  it("keeps the draft when the window is shrunk too far and grown back", async () => {
    const screen = await mount({ columns: 80, rows: 24 });
    await screen.press("draft");
    await screen.resize({ columns: 80, rows: 12 });
    await screen.resize({ columns: 80, rows: 24 });
    expect(screen.frame().at(-3)).toContain("draft");
  });
});
