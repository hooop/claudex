import type { RenderOptions } from "ink";

/**
 * How `cli.tsx` mounts Claudex. The alternate screen gives Claudex a real
 * viewport: header and footer stay fixed while the app scrolls only the
 * transcript.
 *
 * `interactive` is forced because Ink otherwise treats any environment with CI
 * set as non-interactive, even on a real terminal: it then skips the alternate
 * screen and draws only the final frame, leaving the user a blank screen for
 * the whole session. `cli.tsx` only renders once `hasInteractiveTerminal` holds.
 */
export const RENDER_OPTIONS = {
  exitOnCtrlC: false,
  alternateScreen: true,
  incrementalRendering: true,
  interactive: true,
} satisfies RenderOptions;

type MaybeTerminal = { isTTY?: boolean };

/**
 * Whether Claudex can run on these streams. Both must be terminals: input for
 * the keyboard, output because `RENDER_OPTIONS` forces interactive rendering,
 * which would otherwise stream every frame into a pipe or file.
 */
export function hasInteractiveTerminal(stdin: MaybeTerminal, stdout: MaybeTerminal): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}
