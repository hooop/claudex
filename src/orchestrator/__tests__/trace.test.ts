import { describe, expect, it } from "vitest";
import { capTraceOutput, TRACE_OUTPUT_LIMIT_BYTES } from "../trace.js";

describe("capTraceOutput", () => {
  it("keeps a short output", () => {
    expect(capTraceOutput("")).toBe("");
    expect(capTraceOutput("ok\n")).toBe("ok\n");
  });

  it("keeps an output of exactly the limit", () => {
    const output = "a".repeat(TRACE_OUTPUT_LIMIT_BYTES);
    expect(capTraceOutput(output)).toBe(output);
  });

  it("caps at the byte limit and states the omitted bytes", () => {
    const output = "a".repeat(TRACE_OUTPUT_LIMIT_BYTES + 10);
    expect(capTraceOutput(output)).toBe(
      "a".repeat(TRACE_OUTPUT_LIMIT_BYTES) + "\n[... 10 bytes omitted]",
    );
  });

  it("does not split a multi-byte character", () => {
    // "é" is two bytes in UTF-8: the limit falls in the middle of the last one kept.
    const output = "a".repeat(TRACE_OUTPUT_LIMIT_BYTES - 1) + "é" + "b".repeat(5);
    expect(capTraceOutput(output)).toBe(
      "a".repeat(TRACE_OUTPUT_LIMIT_BYTES - 1) + "\n[... 7 bytes omitted]",
    );
  });

  it("does not split a four-byte character", () => {
    const output = "a".repeat(TRACE_OUTPUT_LIMIT_BYTES - 2) + "😀";
    expect(capTraceOutput(output)).toBe(
      "a".repeat(TRACE_OUTPUT_LIMIT_BYTES - 2) + "\n[... 4 bytes omitted]",
    );
  });
});
