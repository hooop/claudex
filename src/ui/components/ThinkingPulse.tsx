import { Text } from "ink";
import { useEffect, useState } from "react";
import type { AgentId } from "../../types.js";
import { DEFAULT_HEADER_ANIMATION, headerFrame } from "../headerArt.js";
import { AGENT_STYLE, NARROW_COLUMNS } from "../theme.js";

export const PULSE_WIDTH = 8;
const FRAME_MS = 90;
const FRAME_STEP = 1.6;

/** Whether the pulse is drawn, so the status text can reserve its room. */
export function pulseShown(agent: AgentId | null, columns: number): boolean {
  return agent !== null && columns >= NARROW_COLUMNS;
}

/**
 * The welcome header's animation, shrunk to one row beside the status text and
 * painted in the thinking agent's colour. The clock lives here so a tick
 * re-renders only this component, not the whole debate view.
 */
export function ThinkingPulse(props: { agent: AgentId | null; columns: number }) {
  const { agent, columns } = props;
  const shown = pulseShown(agent, columns);
  const [t, setT] = useState(0);

  useEffect(() => {
    if (!shown) return;
    const id = setInterval(() => setT((current) => current + FRAME_STEP), FRAME_MS);
    return () => clearInterval(id);
  }, [shown]);

  if (!shown || agent === null) return null;
  const color = AGENT_STYLE[agent].color;
  const row = headerFrame(PULSE_WIDTH, t, DEFAULT_HEADER_ANIMATION)[0] ?? [];
  return (
    <Text>
      {row.map((band, index) => (
        <Text key={index} color={color}>
          {band.chars}
        </Text>
      ))}
    </Text>
  );
}
