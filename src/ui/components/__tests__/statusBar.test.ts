import { renderToString } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { displayWidth } from "../../stream/lineBuffer.js";
import { AGENT_STYLE } from "../../theme.js";
import {
  describeActivity,
  fitActivityDescription,
  flattenActivityLabel,
  STATUS_BAR_RIGHT_INSET,
  StatusBar,
  statusBarWidth,
} from "../StatusBar.js";

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

describe("StatusBar activity formatting", () => {
  it("flattens multiline commands and strips terminal sequences", () => {
    expect(flattenActivityLabel("npm test\n  --run\t\u001b[2J maintenant")).toBe(
      "npm test --run maintenant",
    );
    expect(flattenActivityLabel("✅ done 🚀")).toBe("[ok] done");
  });

  it("summarizes several commands on the same row", () => {
    expect(
      describeActivity({
        kind: "command",
        status: "running",
        label: "npm test",
        activeCount: 3,
      }),
    ).toBe("3 commands running · $ npm test");
  });

  it("keeps a compact result until the next activity", () => {
    expect(
      describeActivity({
        kind: "command",
        status: "failure",
        label: "npm test",
        durationMs: 8_200,
        exitCode: 1,
      }),
    ).toBe("$ npm test · 8.2 s · code 1");
  });

  it("uses the new agent names and ANSI indexes", () => {
    expect(AGENT_STYLE.claude).toEqual({ color: "ansi256(210)", badge: "Claude" });
    expect(AGENT_STYLE.codex).toEqual({ color: "ansi256(159)", badge: "Codex" });
  });

  it("cuts a command before the prompt right edge with three dots", () => {
    const width = 80;
    const fitted = fitActivityDescription(
      "debate",
      "claude",
      {
        kind: "command",
        status: "running",
        label: "npm test --run a-particularly-long-test-suite ".repeat(3),
      },
      width,
    );
    const fixedWidth = 2 + displayWidth("Claude ");

    expect(STATUS_BAR_RIGHT_INSET).toBe(3);
    expect(statusBarWidth(width)).toBe(77);
    expect(fitted).toMatch(/\.\.\.$/);
    expect(fixedWidth + displayWidth(fitted)).toBeLessThanOrEqual(statusBarWidth(width));
  });

  it("reserves the width of the ASCII status", () => {
    const width = 50;
    const fitted = fitActivityDescription(
      "implementation",
      "codex",
      { kind: "tool", status: "success", label: "a very long activity ".repeat(5) },
      width,
    );
    const fixedWidth = displayWidth("Implementation  ·  [ok] Codex ");

    expect(fixedWidth + displayWidth(fitted)).toBeLessThanOrEqual(statusBarWidth(width));
  });

  it("shows nothing at rest during the debate", () => {
    const output = renderToString(
      createElement(StatusBar, {
        phase: "debate",
        thinkingAgent: null,
        activity: null,
        paused: false,
        width: 80,
      }),
    ).replace(ANSI_SEQUENCE, "");

    expect(output).toBe("");
    expect(output).not.toContain("Claude");
    expect(output).not.toContain("Codex");
  });

  it("starts directly with the agent during a debate activity", () => {
    const output = renderToString(
      createElement(StatusBar, {
        phase: "debate",
        thinkingAgent: "claude",
        activity: { kind: "tool", status: "success", label: "Read" },
        paused: false,
        width: 80,
      }),
    ).replace(ANSI_SEQUENCE, "");

    expect(output).toBe("[ok] Claude Read");
    expect(output).not.toContain("Debate");
  });

  it("keeps the agents in the implementation phase", () => {
    const output = renderToString(
      createElement(StatusBar, {
        phase: "implementation",
        thinkingAgent: null,
        activity: null,
        paused: false,
        width: 80,
      }),
    ).replace(ANSI_SEQUENCE, "");

    expect(output).toBe("Implementation  ·  Claude + Codex");
  });
});

describe("StatusBar note activity", () => {
  it("describes a note by its flattened text", () => {
    expect(describeActivity({ kind: "note", status: "running", label: "Reading\n the  memory" })).toBe(
      "Reading the memory",
    );
  });

  it("strips control sequences from a note", () => {
    expect(
      describeActivity({ kind: "note", status: "running", label: "Reading \u001b[31mfiles" }),
    ).not.toContain("\u001b");
  });
});
