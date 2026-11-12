import { describe, expect, it } from "vitest";
import { extractSignal, scanMarkerLine } from "../markers.js";
import { CONSENSUS_INSTRUCTIONS } from "../scheduler.js";

describe("scanMarkerLine", () => {
  it("recognises a marker alone on its line", () => {
    expect(scanMarkerLine("<<CONSENSUS>>")).toEqual({ kind: "match", marker: "<<CONSENSUS>>" });
    expect(scanMarkerLine("<<CONTINUE>>")).toEqual({ kind: "match", marker: "<<CONTINUE>>" });
    expect(scanMarkerLine("<<NO_TOPIC>>")).toEqual({ kind: "match", marker: "<<NO_TOPIC>>" });
    expect(scanMarkerLine("<<WAIT_HUMAN>>")).toEqual({ kind: "match", marker: "<<WAIT_HUMAN>>" });
  });

  it("tolerates bounded markdown decoration", () => {
    expect(scanMarkerLine("**<<CONSENSUS>>**").kind).toBe("match");
    expect(scanMarkerLine("  _ <<CONTINUE>> _  ").kind).toBe("match");
  });

  it("rejects decoration beyond the bound", () => {
    // At most two padding runs and one decoration run, on each side.
    expect(scanMarkerLine("*".repeat(5) + "<<CONSENSUS>>").kind).toBe("no");
    expect(scanMarkerLine(" ".repeat(17) + "<<CONSENSUS>>").kind).toBe("no");
    expect(scanMarkerLine("<<CONSENSUS>>" + " ".repeat(17)).kind).toBe("no");
  });

  it("reports a prefix that could still become a marker", () => {
    expect(scanMarkerLine("<<CONSE").kind).toBe("partial");
    expect(scanMarkerLine("<").kind).toBe("partial");
    expect(scanMarkerLine("").kind).toBe("partial");
    expect(scanMarkerLine("  **").kind).toBe("partial");
  });

  it("rejects a line that holds anything besides the marker", () => {
    expect(scanMarkerLine("we agree <<CONSENSUS>>").kind).toBe("no");
    expect(scanMarkerLine("<<CONSENSUS>> but with a reservation").kind).toBe("no");
    expect(scanMarkerLine("<<CONSENSUSX>>").kind).toBe("no");
    expect(scanMarkerLine("a normal sentence").kind).toBe("no");
  });
});

describe("extractSignal", () => {
  it("detaches a terminal marker from the message body", () => {
    expect(extractSignal("Agreed.\n\n<<CONSENSUS>>")).toEqual({
      cleanText: "Agreed.",
      signal: "consensus",
    });
    expect(extractSignal("Objection.\n<<CONTINUE>>")).toEqual({
      cleanText: "Objection.",
      signal: "continue",
    });
    expect(extractSignal("I need the volume.\n<<WAIT_HUMAN>>").signal).toBe("wait-human");
    expect(extractSignal("No topic.\n<<NO_TOPIC>>").signal).toBe("no-topic");
  });

  it("ignores whitespace after the marker", () => {
    expect(extractSignal("Text\n\n<<CONSENSUS>>\n\n   \n").signal).toBe("consensus");
  });

  it("signals nothing when the marker is followed by content", () => {
    const text = "Text\n<<CONSENSUS>>\nactually no";
    expect(extractSignal(text)).toEqual({ cleanText: text, signal: null });
  });

  it("signals nothing without a marker", () => {
    expect(extractSignal("Just some text.\n")).toEqual({ cleanText: "Just some text.", signal: null });
  });

  it("accepts a message reduced to the marker alone", () => {
    expect(extractSignal("<<CONSENSUS>>")).toEqual({ cleanText: "", signal: "consensus" });
  });
});

/**
 * The instructions sent to the agents show what the end of an answer must look like.
 * If someone edits this example without looking at the parser — or the reverse — the
 * debate would never stop on a consensus again, without any warning. Hence this
 * test, which runs the prompt's examples through the real parser.
 */
describe("CONSENSUS_INSTRUCTIONS", () => {
  const prompt = CONSENSUS_INSTRUCTIONS("Claude", "Codex");
  const INCORRECT = "Incorrect end of answer";

  function exampleAfter(heading: string): string {
    const start = prompt.indexOf(heading);
    expect(start, `heading not found in the instructions: ${heading}`).toBeGreaterThan(-1);
    const rest = prompt.slice(start + heading.length);
    const end = rest.indexOf(INCORRECT);
    return (end === -1 ? rest : rest.slice(0, end)).trim();
  }

  it("asks for density as a target, not a limit", () => {
    expect(prompt).toContain("as briefly as possible, but as precisely as necessary");
    expect(prompt).toContain("200 words");
    expect(prompt).toMatch(/target, not a limit/);
  });

  it("asks for the position first and no restating", () => {
    expect(prompt).toContain("position or main objection first");
    expect(prompt).toMatch(/do not restate/i);
  });

  it("allows headings only when they help", () => {
    expect(prompt).toMatch(/headings or lists only when they make the message easier to follow/i);
  });

  it("makes working notes private", () => {
    expect(prompt).toContain("after your last tool call");
    expect(prompt).toContain("private working note");
  });

  it("allows evidence excerpts under conditions", () => {
    expect(prompt).toContain("relevant lines");
    expect(prompt).toMatch(/exit code/i);
    expect(prompt).toMatch(/misrepresent/i);
    expect(prompt).toMatch(/say what you left out/i);
    expect(prompt).toContain("exact command");
  });

  it("shows a correct example that the parser really recognises", () => {
    expect(extractSignal(exampleAfter("Correct end of answer:")).signal).toBe("consensus");
  });

  it("shows a counter-example that the parser really rejects", () => {
    expect(extractSignal(exampleAfter(INCORRECT)).signal).toBeNull();
  });
});
