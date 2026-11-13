import { describe, expect, it } from "vitest";
import {
  DEBATE_HEADER_ROWS,
  INK_SPARE_ROWS,
  isTooSmall,
  MAX_DYNAMIC_ROWS,
  MIN_COLS,
  MIN_ROWS,
  MIN_TRANSCRIPT_ROWS,
  RULE_ROWS,
  tooSmallMessage,
} from "../theme.js";

describe("minimum terminal size", () => {
  it("is the debate frame's fixed rows plus one transcript row and Ink's spare row", () => {
    expect(MIN_ROWS).toBe(
      DEBATE_HEADER_ROWS + MIN_TRANSCRIPT_ROWS + RULE_ROWS + MAX_DYNAMIC_ROWS + INK_SPARE_ROWS,
    );
    expect(MIN_ROWS).toBe(15);
    expect(MIN_COLS).toBe(40);
  });

  it("accepts exactly the minimum and rejects one row or one column less", () => {
    expect(isTooSmall(40, 15)).toBe(false);
    expect(isTooSmall(40, 14)).toBe(true);
    expect(isTooSmall(39, 15)).toBe(true);
    expect(isTooSmall(0, 0)).toBe(true);
  });

  it("names the minimum in the message", () => {
    expect(tooSmallMessage()).toBe("Terminal too small: enlarge it to at least 40 × 15");
  });
});
