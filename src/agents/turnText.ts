import { extractSignal } from "../orchestrator/markers.js";

export interface TurnSegment {
  kind: "note" | "answer";
  text: string;
}

/**
 * Answer segments joined as-is; if that holds nothing but whitespace or a
 * protocol marker, every segment's text in order, trimmed, joined with "\n\n".
 * The fallback keeps a turn whose whole content was classified as notes from
 * reaching the other agent empty.
 */
export function composeTurnText(segments: readonly TurnSegment[]): string {
  const answer = segments
    .filter((segment) => segment.kind === "answer")
    .map((segment) => segment.text)
    .join("");
  if (extractSignal(answer).cleanText.trim() !== "") return answer;

  return segments
    .map((segment) => segment.text.trim())
    .filter((text) => text !== "")
    .join("\n\n");
}
