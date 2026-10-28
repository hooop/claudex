import { describe, expect, it } from "vitest";
import { hasInteractiveTerminal } from "../renderOptions.js";

describe("hasInteractiveTerminal", () => {
  it("accepts a terminal on both input and output", () => {
    expect(hasInteractiveTerminal({ isTTY: true }, { isTTY: true })).toBe(true);
  });

  it("refuses piped input", () => {
    expect(hasInteractiveTerminal({ isTTY: false }, { isTTY: true })).toBe(false);
  });

  // `claudex | cat` or `claudex > file`: with interactive rendering forced, Ink
  // would stream every frame, escape codes included, into the pipe or file.
  it("refuses piped output", () => {
    expect(hasInteractiveTerminal({ isTTY: true }, { isTTY: false })).toBe(false);
  });

  // Node leaves isTTY undefined on streams that are not terminals.
  it("refuses streams that do not report isTTY", () => {
    expect(hasInteractiveTerminal({}, { isTTY: true })).toBe(false);
    expect(hasInteractiveTerminal({ isTTY: true }, {})).toBe(false);
  });
});
