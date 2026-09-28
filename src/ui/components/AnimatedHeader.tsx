import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import { headerFrame, HEADER_MAX_WIDTH, type HeaderAnimationId } from "../headerArt.js";

const FRAME_MS = 90;

/**
 * The animated band on the welcome screen.
 *
 * This five-row version belongs to the welcome screen. DebateView renders its
 * own single-row variant with agent-specific flashes.
 */
export function AnimatedHeader(props: { active?: boolean; animation: HeaderAnimationId }) {
  const { active = true, animation } = props;
  const { stdout } = useStdout();
  const width = Math.min(stdout?.columns || 80, HEADER_MAX_WIDTH);
  const [clock, setClock] = useState(() => ({ animation, t: 0 }));

  useEffect(() => {
    setClock({ animation, t: 0 });
    if (!active) return;
    const id = setInterval(
      () =>
        setClock((current) => ({
          animation,
          t: current.animation === animation ? current.t + 1.6 : 1.6,
        })),
      FRAME_MS,
    );
    return () => clearInterval(id);
  }, [active, animation]);

  // The prop changes one render before its effect runs. Showing t=0 during that
  // render prevents the new equation inheriting the previous one's phase.
  const t = clock.animation === animation ? clock.t : 0;

  return (
    <Box flexDirection="column">
      {headerFrame(width, t, animation).map((bands, y) => (
        <Text key={y}>
          {bands.map((band, b) => (
            <Text key={b} color={band.color}>
              {band.chars}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
