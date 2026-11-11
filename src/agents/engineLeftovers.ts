import { lstat, rmdir } from "node:fs/promises";
import { join } from "node:path";

// With the sandbox on, the Claude Code engine creates these (empty) in the
// analysed project (measured on SDK 0.3.310). Innermost first, so that a parent
// is empty again by the time its turn comes.
export const ENGINE_LEFTOVER_DIRS = [".claude/.cc-writes", ".claude"] as const;

/** The leftover paths that already exist before the turn: those are never ours to remove. */
export async function snapshotEngineLeftovers(cwd: string): Promise<ReadonlySet<string>> {
  const existing = new Set<string>();
  for (const relative of ENGINE_LEFTOVER_DIRS) {
    try {
      await lstat(join(cwd, relative));
      existing.add(relative);
    } catch (error) {
      // Anything we could not inspect counts as present: better to keep a
      // directory than to remove one we know nothing about.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") existing.add(relative);
    }
  }
  return existing;
}

/**
 * Best-effort cleanup of the directories the engine created during the turn.
 * Non-recursive rmdir: it can only ever remove an empty directory, never content.
 * Never throws; returns the relative paths actually removed.
 */
export async function removeEngineLeftovers(cwd: string, before: ReadonlySet<string>): Promise<string[]> {
  const removed: string[] = [];
  for (const relative of ENGINE_LEFTOVER_DIRS) {
    if (before.has(relative)) continue;
    const path = join(cwd, relative);
    try {
      // A symlink is not something the engine created as a directory: leave it.
      if ((await lstat(path)).isSymbolicLink()) continue;
      await rmdir(path);
      removed.push(relative);
    } catch {
      // ENOENT, ENOTEMPTY, EACCES...: nothing to remove or not ours to remove.
    }
  }
  return removed;
}
