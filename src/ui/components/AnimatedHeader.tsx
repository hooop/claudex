import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import { headerFrame, HEADER_MAX_WIDTH, type HeaderAnimationId } from "../headerArt.js";

const FRAME_MS = 90;

/**
 * The animated band on the welcome screen.
 *
 * `active` is false during a debate — and there the header isn't rendered by Ink
 * at all: it is written once into the scrollback like any other permanent
 * content (see ui/stream/transcriptStream.ts). Anything Ink keeps in its tree is
 * redrawn on every update, and the header has nothing to say after the first
 * frame, so it doesn't belong there once a debate starts.
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
