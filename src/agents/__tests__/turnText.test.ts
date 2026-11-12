import { describe, expect, it } from "vitest";
import { composeTurnText } from "../turnText.js";

describe("composeTurnText", () => {
  it("returns the answer only", () => {
    expect(
      composeTurnText([
        { kind: "note", text: "a" },
        { kind: "answer", text: "b" },
      ]),
    ).toBe("b");
  });

  it("joins answer segments as-is", () => {
    expect(
      composeTurnText([
        { kind: "answer", text: "x" },
        { kind: "note", text: "n" },
        { kind: "answer", text: "y" },
      ]),
    ).toBe("xy");
  });

  it("falls back to all segments when the answer is empty", () => {
    expect(
      composeTurnText([
        { kind: "note", text: "Reading." },
        { kind: "answer", text: "" },
      ]),
    ).toBe("Reading.");
  });

  it("falls back when the answer is only a marker", () => {
    expect(
      composeTurnText([
        { kind: "note", text: "Found it." },
        { kind: "answer", text: "\n<<CONSENSUS>>\n" },
      ]),
    ).toBe("Found it.\n\n<<CONSENSUS>>");
  });

  it("returns an empty string for no segments", () => {
    expect(composeTurnText([])).toBe("");
  });
});
