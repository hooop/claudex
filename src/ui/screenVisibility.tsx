import { Box, Text } from "ink";
import { createContext, useContext, type ReactNode } from "react";
import { isTooSmall, tooSmallMessage } from "./theme.js";

/**
 * False while the screen is hidden because the terminal is too small. Every
 * key and mouse listener of a screen reads it: a hidden screen must not let
 * the human act on what they cannot see (answer a permission, pause, scroll,
 * close a palette).
 */
export const ScreenVisibleContext = createContext(true);

export function useScreenVisible(): boolean {
  return useContext(ScreenVisibleContext);
}

export function TerminalTooSmall() {
  // Wrapped, not truncated: the required size is the part that must stay visible.
  return <Text wrap="wrap">{tooSmallMessage()}</Text>;
}

/**
 * Hides a screen below the minimum size instead of unmounting it, so its
 * state (transcript, scroll offset, draft, open palette) survives a window
 * shrunk too far and grown back.
 */
export function FittedScreen(props: { columns: number; rows: number; children: ReactNode }) {
  const visible = !isTooSmall(props.columns, props.rows);
  return (
    <ScreenVisibleContext.Provider value={visible}>
      {!visible && <TerminalTooSmall />}
      <Box display={visible ? "flex" : "none"} flexDirection="column">
        {props.children}
      </Box>
    </ScreenVisibleContext.Provider>
  );
}
