// Erase the visible screen, then home the cursor so the repaint starts at the top.
const CLEAR_SCREEN = "\u001b[2J\u001b[H";

/**
 * Makes every resize end on one clean frame. Ink 7.1.1 clears its previous
 * frame only when the width shrinks or the old frame overflows the new
 * height; otherwise it diffs the new frame line by line against a frame the
 * terminal may have moved or reflowed, and the old frame shows through.
 *
 * `write` must be Ink's own `useStdout().write`: Ink erases its frame, writes
 * the data, then repaints its last frame in full and resets its diff state to
 * it. The listener is added after Ink's, so that last frame is the one Ink
 * just computed for the new size. `app.clear()` does not work here: it keeps
 * Ink's diff state on the erased frame, so unchanged lines are never redrawn.
 */
export function installResizeClear(
  stdout: NodeJS.WriteStream,
  write: (data: string) => void,
): () => void {
  const onResize = () => write(CLEAR_SCREEN);
  stdout.on("resize", onResize);
  return () => {
    stdout.off("resize", onResize);
  };
}
