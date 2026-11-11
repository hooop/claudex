// Helpers for running the cases in a folder the maintainer already trusted in
// Claude Code. File system only, and read-only on the account's configuration:
// nothing here writes to .claude.json. Error messages name paths, never the
// content of the configuration.
import { readFile, readdir, realpath, rm, rmdir, lstat, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export class TrustedDirError extends Error {}

export function claudeConfigFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readProjects(configFile: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(configFile, "utf8");
  } catch {
    throw new TrustedDirError(`cannot read the Claude configuration ${configFile}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TrustedDirError(`the Claude configuration ${configFile} is not valid JSON`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.projects)) {
    throw new TrustedDirError(`the Claude configuration ${configFile} has no "projects" object`);
  }
  return parsed.projects;
}

/**
 * Claude Code inherits trust from an ancestor folder, and an explicit false on
 * the folder itself does not block it, so the folder is accepted when it or
 * any ancestor up to "/" is accepted. `trustedBy` is the nearest such entry.
 */
export async function resolveTrustedDir(dir: string, configFile: string): Promise<{ dir: string; trustedBy: string }> {
  let real: string;
  try {
    real = await realpath(dir);
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new TrustedDirError(`--trusted-dir ${dir} is not an existing folder`);
  }
  const projects = await readProjects(configFile);
  for (let path = real; ; path = dirname(path)) {
    const entry = projects[path];
    if (isRecord(entry) && entry.hasTrustDialogAccepted === true) return { dir: real, trustedBy: path };
    if (dirname(path) === path) break;
  }
  throw new TrustedDirError(
    `neither ${real} nor any folder above it is trusted in ${configFile}: run claude in it once, accept the trust dialog, then quit`,
  );
}

export async function assertEmptyDir(dir: string): Promise<void> {
  const entries = await readdir(dir);
  if (entries.length > 0) {
    throw new TrustedDirError(`the trusted folder ${dir} is not empty, found: ${entries.join(", ")}`);
  }
}

export async function readProjectEntry(configFile: string, realDir: string): Promise<Record<string, unknown> | null> {
  const entry = (await readProjects(configFile))[realDir];
  return isRecord(entry) ? entry : null;
}

export function changedKeys(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  const a = before ?? {};
  const b = after ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort();
}

export type TreeSnapshot = Map<string, "file" | "dir" | "link">;

/** Every path under `dir` (relative) with its type, without following symlinks. */
export async function snapshotTree(dir: string): Promise<TreeSnapshot> {
  const entries: TreeSnapshot = new Map();
  const walk = async (relative: string): Promise<void> => {
    for (const name of await readdir(join(dir, relative))) {
      const path = join(relative, name);
      const info = await lstat(join(dir, path));
      if (info.isDirectory()) {
        entries.set(path, "dir");
        await walk(path);
      } else {
        entries.set(path, info.isSymbolicLink() ? "link" : "file");
      }
    }
  };
  await walk("");
  return entries;
}

/**
 * Removes what a snapshot accounts for, nothing else. A path that is not in
 * the snapshot, or whose type changed (a directory swapped for a symlink would
 * make a deletion follow it out of the folder), is unaccounted: only the
 * marker is removed and the folder is left for the maintainer. Directories go
 * with a non-recursive rmdir, deepest first, so one that still holds something
 * throws instead of being emptied.
 */
export async function cleanupToSnapshot(
  dir: string,
  snapshot: TreeSnapshot,
  extraFile: string,
): Promise<{ unaccounted: string[] }> {
  const now = await snapshotTree(dir);
  await rm(join(dir, extraFile), { force: true });
  // A snapshot path now missing (deleted by the engine) is unaccounted too.
  const changed = [...now].filter(([path, type]) => path !== extraFile && snapshot.get(path) !== type).map(([path]) => path);
  const missing = [...snapshot.keys()].filter((path) => !now.has(path));
  const unaccounted = [...changed, ...missing].sort();
  if (unaccounted.length > 0) return { unaccounted };

  // Checked again right before each deletion, parents included, in case the
  // tree moved since the listing.
  const verify = async (path: string): Promise<void> => {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("/");
      const info = await lstat(join(dir, sub));
      const type = info.isDirectory() ? "dir" : info.isSymbolicLink() ? "link" : "file";
      if (type !== snapshot.get(sub)) throw new TrustedDirError(`${sub} changed type during the cleanup in ${dir}; the cleanup stopped, and the marker and some snapshot entries may already be removed`);
    }
  };
  const files = [...snapshot].filter(([, type]) => type !== "dir").map(([path]) => path);
  const dirs = [...snapshot].filter(([, type]) => type === "dir").map(([path]) => path);
  for (const file of files) {
    await verify(file);
    await rm(join(dir, file), { force: true });
  }
  for (const sub of dirs.sort((a, b) => b.length - a.length)) {
    await verify(sub);
    await rmdir(join(dir, sub));
  }
  return { unaccounted: [] };
}
