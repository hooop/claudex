import { renderToString } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { CLAUDEX_VERSION } from "../../../version.js";
import { INITIAL_STATUS, reduceStatus } from "../../debateStatus.js";
import { HEADER_MAX_WIDTH } from "../../headerArt.js";
import { displayWidth } from "../../stream/lineBuffer.js";
import { NARROW_COLUMNS } from "../../theme.js";
import { DEBATE_HEADER_ROWS, DebateHeader } from "../DebateHeader.js";

const MEMORY = { decisionsCount: 2, lastSession: "2026-08-10T11:42:17.288Z" };

function rows(columns: number, topic = "Test topic", status = INITIAL_STATUS): string[] {
  return renderToString(
    createElement(DebateHeader, { columns, topic, status, memory: MEMORY }),
    { columns },
  ).split("\n");
}

describe("DebateHeader", () => {
  it("is four rows tall", () => {
    expect(DEBATE_HEADER_ROWS).toBe(4);
  });

  it.each([40, 60, 80, 120])("takes exactly four rows within the width at %i columns", (columns) => {
    const lines = rows(columns, "word ".repeat(300));
    expect(lines).toHaveLength(DEBATE_HEADER_ROWS);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(Math.min(columns, HEADER_MAX_WIDTH));
    }
  });

  it("shows the name, version and stage on the first row", () => {
    expect(rows(80)[0]).toMatch(new RegExp(`^CLAUDEX ${CLAUDEX_VERSION.replace(/\./g, "\\.")} · debate`));
  });

  it("shows the status only from 60 columns", () => {
    expect(rows(NARROW_COLUMNS)[0]).toContain("Claude · · Codex ·");
    expect(rows(NARROW_COLUMNS - 1)[0]).not.toContain("Claude");
    expect(rows(80)[0]!.trimEnd().endsWith("Codex ·")).toBe(true);
  });

  it("right-aligns the status", () => {
    const first = rows(80)[0]!;
    expect(displayWidth(first)).toBe(80);
  });

  it("shows consensus stage after consensus-reached", () => {
    const status = reduceStatus(INITIAL_STATUS, { kind: "consensus-reached" });
    const first = rows(80, "Test topic", status)[0]!;
    expect(first).toContain("· consensus");
    expect(first.trimEnd().endsWith("✓ Consensus")).toBe(true);
  });

  it("the topic takes one row", () => {
    const lines = rows(80, "first\nsecond\r\n\tthird " + "x".repeat(400));
    expect(lines[1]).toMatch(/^Topic {2}first second third x+… \/topic$/);
    expect(displayWidth(lines[1]!)).toBe(80);
  });

  it("keeps a short topic whole", () => {
    expect(rows(80)[1]).toBe("Topic  Test topic");
  });

  it("shows the memory line and a heavy rule", () => {
    const lines = rows(80);
    expect(lines[2]).toMatch(/^Memory 2 settled decisions +last session: /);
    expect(lines[3]).toBe("━".repeat(80));
  });

  it("caps the width at the header maximum", () => {
    expect(rows(200)[3]).toBe("━".repeat(HEADER_MAX_WIDTH));
  });
});
