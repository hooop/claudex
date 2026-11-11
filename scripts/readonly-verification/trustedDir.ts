// Helpers for running the cases in a folder the maintainer already trusted in
// Claude Code. File system only, and read-only on the account's configuration:
// nothing here writes to .claude.json. Error messages name paths, never the
// content of the configuration.
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

export class TrustedDirError extends Error {}

export function claudeConfigFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
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

export async function resolveTrustedDir(dir: string, configFile: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(dir);
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new TrustedDirError(`--trusted-dir ${dir} is not an existing folder`);
  }
  const entry = (await readProjects(configFile))[real];
  if (!isRecord(entry) || entry.hasTrustDialogAccepted !== true) {
    throw new TrustedDirError(
      `${real} is not trusted in ${configFile}: run claude in it once, accept the trust dialog, then quit`,
    );
  }
  return real;
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
