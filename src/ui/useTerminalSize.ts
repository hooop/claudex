import { useStdout } from "ink";
import { useEffect, useRef, useState } from "react";

export interface TerminalSize {
  columns: number;
  rows: number;
}

function sizeOf(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  return { columns: stdout?.columns || 80, rows: stdout?.rows || 24 };
}

/**
 * The terminal size, as React state. Every component whose layout depends on
 * the size must read it here: Ink's own resize handler only lays out the
 * existing tree again, so a component that reads `stdout.rows` during render
 * keeps the old size until something else happens to re-render it.
 *
 * `onResize` runs inside the resize event, before the new size is set, so
 * state it clears (a selection, for one) is gone from the first frame drawn
 * at the new size rather than one frame later.
 */
export function useTerminalSize(onResize?: () => void): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => sizeOf(stdout));
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  });

  useEffect(() => {
    const update = () => {
      const next = sizeOf(stdout);
      // Same values keep the same object, so an unchanged size costs no render.
      setSize((current) =>
        current.columns === next.columns && current.rows === next.rows ? current : next,
      );
    };
    // Ink registered its listener when it mounted. Running first makes React
    // commit the new size before Ink computes the frame for it.
    const onTerminalResize = () => {
      onResizeRef.current?.();
      update();
    };
    stdout.prependListener("resize", onTerminalResize);
    // A resize between the first render and this effect would otherwise be missed.
    update();
    return () => {
      stdout.off("resize", onTerminalResize);
    };
  }, [stdout]);

  return size;
}
