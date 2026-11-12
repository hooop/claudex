import { describe, expect, it } from "vitest";
import { extractSignal } from "../../../orchestrator/markers.js";
import { MarkerFilter } from "../markerFilter.js";

/** Feed a whole turn through the filter, one chunk at a time, as it streams. */
function run(chunks: string[], signalConfirmed?: boolean): string {
  const filter = new MarkerFilter();
  let out = "";
  for (const chunk of chunks) out += filter.push(chunk);
  const confirmed = signalConfirmed ?? extractSignal(chunks.join("")).signal !== null;
  return out + filter.finish(confirmed);
}

describe("MarkerFilter", () => {
  it("removes a terminal marker", () => {
    expect(run(["Agreed.\n\n", "<<CONSENSUS>>"])).toBe("Agreed.\n\n");
  });

  it("removes a terminal marker followed by a line end", () => {
    expect(run(["Agreed.\n\n<<CONSENSUS>>\n"])).toBe("Agreed.\n\n");
  });

  it("removes the whitespace held behind the marker", () => {
    expect(run(["Text\n<<CONSENSUS>>\n", "\n", "\n"])).toBe("Text\n");
  });

  it("reassembles a marker split across several chunks", () => {
    expect(run(["Text\n", "<<CON", "SEN", "SUS>>"])).toBe("Text\n");
  });

  it("releases the marker when content arrives behind it", () => {
    expect(run(["Text\n", "<<CONSENSUS>>\n", "\n", "actually no\n"])).toBe(
      "Text\n<<CONSENSUS>>\n\nactually no\n",
    );
  });

  it("does not hold a merely similar string", () => {
    expect(run(["Text\n", "<<CONSENSUSX>>\n"])).toBe("Text\n<<CONSENSUSX>>\n");
    expect(run(["we aim for the <<CONSENSUS>> here\n"])).toBe("we aim for the <<CONSENSUS>> here\n");
  });

  it("releases the marker if the signal is not confirmed", () => {
    expect(run(["Text\n<<CONSENSUS>>"], false)).toBe("Text\n<<CONSENSUS>>\n");
  });

  it("never leaks a marker before the decision", () => {
    const filter = new MarkerFilter();
    let out = filter.push("Text\n");
    out += filter.push("<<CONSENSUS>>");
    expect(out).toBe("Text\n");
    expect(filter.isHolding).toBe(true);
  });

  it("stays in parity with extractSignal, whatever the splitting", () => {
    const turns = [
      "Agreed.\n\n<<CONSENSUS>>",
      "Objection.\n<<CONTINUE>>\n",
      "Text\n<<CONSENSUS>>\nactually no",
      "No marker here.",
      "**<<CONSENSUS>>**",
      "<<CONTINUE>>",
      "Question.\n<<WAIT_HUMAN>>",
      "No topic.\n<<NO_TOPIC>>",
    ];

    for (const turn of turns) {
      const { cleanText, signal } = extractSignal(turn);
      // One character at a time: the worst possible splitting.
      const streamed = run([...turn], signal !== null);
      expect(streamed.replace(/\s+$/u, "")).toBe(cleanText);
    }
  });
});
