import type { RenderOptions } from "ink";

/**
 * How `cli.tsx` mounts Claudex. The alternate screen gives Claudex a real
 * viewport: header and footer stay fixed while the app scrolls only the
 * transcript.
 *
 * `interactive` is forced because Ink otherwise treats any environment with CI
 * set as non-interactive, even on a real terminal: it then skips the alternate
 * screen and draws only the final frame, leaving the user a blank screen for
 * the whole session. `cli.tsx` already refuses to start without a TTY.
 */
export const RENDER_OPTIONS = {
  exitOnCtrlC: false,
  alternateScreen: true,
  incrementalRendering: true,
  interactive: true,
} satisfies RenderOptions;
