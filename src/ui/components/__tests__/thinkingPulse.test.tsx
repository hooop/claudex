import chalk from "chalk";
import { EventEmitter } from "node:events";
import { render as inkRender, renderToString } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { displayWidth } from "../../stream/lineBuffer.js";
import { AGENT_STYLE, NARROW_COLUMNS } from "../../theme.js";
import { PULSE_WIDTH, ThinkingPulse } from "../ThinkingPulse.js";

chalk.level = 3;

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function render(agent: "claude" | "codex" | null, columns: number): string {
  return renderToString(createElement(ThinkingPulse, { agent, columns }), { columns });
}

describe("ThinkingPulse", () => {
  it("renders nothing while no agent thinks", () => {
    expect(render(null, 80)).toBe("");
  });

  it("renders 8 columns in the agent's colour", () => {
    expect(PULSE_WIDTH).toBe(8);
    const claude = render("claude", 80);
    const codex = render("codex", 80);
    expect(displayWidth(claude.replace(ANSI_SEQUENCE, ""))).toBe(PULSE_WIDTH);
    expect(displayWidth(codex.replace(ANSI_SEQUENCE, ""))).toBe(PULSE_WIDTH);
    // ansi256(210) and ansi256(159) as 256-colour foreground escapes.
    expect(AGENT_STYLE.claude.color).toBe("ansi256(210)");
    expect(claude).toContain("\u001b[38;5;210m");
    expect(claude).not.toContain("\u001b[38;5;159m");
    expect(codex).toContain("\u001b[38;5;159m");
    expect(codex).not.toContain("\u001b[38;5;210m");
  });

  it(`is hidden below ${NARROW_COLUMNS} columns`, () => {
    expect(render("claude", NARROW_COLUMNS - 1)).toBe("");
    expect(render("claude", NARROW_COLUMNS)).not.toBe("");
  });

  describe("timer", () => {
    afterEach(() => vi.useRealTimers());

    it("animates while shown and stops its timer on unmount", async () => {
      vi.useFakeTimers();
      const setSpy = vi.spyOn(globalThis, "setInterval");
      const clearSpy = vi.spyOn(globalThis, "clearInterval");
      const writes: string[] = [];
      const stdout = Object.assign(new EventEmitter(), {
        isTTY: true,
        columns: 80,
        rows: 24,
        write: (data: string) => writes.push(data),
      });
      const app = inkRender(createElement(ThinkingPulse, { agent: "claude", columns: 80 }), {
        stdout: stdout as never,
        patchConsole: false,
        interactive: true,
      });
      const frame = () => writes.join("").replace(ANSI_SEQUENCE, "");

      // The pulse's own interval (90 ms frames), among any Ink may have set.
      const pulseTimers = setSpy.mock.results
        .filter((_, index) => setSpy.mock.calls[index]?.[1] === 90)
        .map((result) => result.value as unknown);
      expect(pulseTimers).toHaveLength(1);

      const first = frame();
      await vi.advanceTimersByTimeAsync(500);
      const later = frame();
      expect(later).not.toBe(first);

      clearSpy.mockClear();
      app.unmount();
      expect(clearSpy.mock.calls.map(([id]) => id as unknown)).toContain(pulseTimers[0]);
      const before = writes.length;
      vi.advanceTimersByTime(1000);
      expect(writes).toHaveLength(before);
    });
  });
});
