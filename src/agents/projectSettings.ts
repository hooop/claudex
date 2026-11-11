import { readFile } from "node:fs/promises";
import { join } from "node:path";

// From the 0.3.310 sdk.d.ts `Settings`: the keys whose value is a command the
// engine runs. Re-read at every SDK upgrade.
export const COMMAND_SETTING_KEYS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "proxyAuthHelper",
] as const;

// Relative to the project directory. This list was measured (see
// `.claudex/memory/limits.md`): under Claudex's setting sources the engine reads
// neither the git root's settings from a subfolder nor settings.local.json.
// It must match the files the engine really reads.
export const PROJECT_SETTINGS_FILES: readonly string[] = [".claude/settings.json"];

export type SettingsFinding =
  | { file: string; kind: "entries"; entries: Array<{ key: string; value: unknown }> }
  | { file: string; kind: "unreadable"; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flaggedEntries(settings: Record<string, unknown>): Array<{ key: string; value: unknown }> {
  const entries: Array<{ key: string; value: unknown }> = [];
  for (const key of COMMAND_SETTING_KEYS) {
    if (settings[key] !== undefined) entries.push({ key, value: settings[key] });
  }
  const env = settings.env;
  if (isPlainObject(env)) {
    for (const [name, value] of Object.entries(env)) entries.push({ key: `env.${name}`, value });
  } else if (env !== undefined) {
    entries.push({ key: "env", value: env });
  }
  return entries;
}

async function inspectFile(projectDir: string, file: string): Promise<SettingsFinding | null> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, file), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return { file, kind: "unreadable", reason: code ?? (error as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { file, kind: "unreadable", reason: `invalid JSON: ${(error as Error).message}` };
  }
  // A file we cannot interpret may still be read differently by the engine, so
  // it is reported instead of being treated as empty.
  if (!isPlainObject(parsed)) return { file, kind: "unreadable", reason: "not a JSON object" };
  const entries = flaggedEntries(parsed);
  return entries.length > 0 ? { file, kind: "entries", entries } : null;
}

export async function inspectProjectSettings(projectDir: string): Promise<SettingsFinding[]> {
  const findings: SettingsFinding[] = [];
  for (const file of PROJECT_SETTINGS_FILES) {
    const finding = await inspectFile(projectDir, file);
    if (finding) findings.push(finding);
  }
  return findings;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function canonicalFindings(findings: readonly SettingsFinding[]): string {
  const sorted = [...findings]
    .sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0))
    .map((finding) =>
      finding.kind === "entries"
        ? {
            ...finding,
            entries: [...finding.entries]
              .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
              .map((entry) => ({ key: entry.key, value: canonical(entry.value) })),
          }
        : finding,
    );
  return JSON.stringify(sorted);
}

export function sameFindings(a: readonly SettingsFinding[], b: readonly SettingsFinding[]): boolean {
  return canonicalFindings(a) === canonicalFindings(b);
}

// Settings come from the analysed project, so a value must not be able to move
// the cursor, hide text or reorder it once shown in the terminal.
export function formatSettingValue(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.replace(
    /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
