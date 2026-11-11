import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  throw new Error("projectSettings must not load the SDK");
});
import {
  COMMAND_SETTING_KEYS,
  PROJECT_SETTINGS_FILES,
  type SettingsFinding,
  formatSettingValue,
  inspectProjectSettings,
  sameFindings,
} from "../projectSettings.js";

const FILE = ".claude/settings.json";
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claudex-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSettings(content: string): Promise<void> {
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(join(dir, FILE), content);
}

function unreadable(findings: SettingsFinding[], expectedReason?: string): void {
  expect(findings).toHaveLength(1);
  const finding = findings[0];
  expect(finding?.file).toBe(FILE);
  expect(finding?.kind).toBe("unreadable");
  if (finding?.kind === "unreadable") {
    expect(finding.reason.length).toBeGreaterThan(0);
    if (expectedReason !== undefined) expect(finding.reason).toBe(expectedReason);
  }
}

describe("inspectProjectSettings", () => {
  it("reads only the measured settings file", () => {
    expect(PROJECT_SETTINGS_FILES).toEqual([FILE]);
  });

  it("finds nothing without a .claude directory", async () => {
    expect(await inspectProjectSettings(dir)).toEqual([]);
  });

  it("finds nothing in an empty object or in unrelated settings", async () => {
    await writeSettings("{}");
    expect(await inspectProjectSettings(dir)).toEqual([]);
    await writeSettings(JSON.stringify({ permissions: { allow: ["Read"] }, model: "x" }));
    expect(await inspectProjectSettings(dir)).toEqual([]);
  });

  it.each(COMMAND_SETTING_KEYS)("flags %s", async (key) => {
    await writeSettings(JSON.stringify({ [key]: "run-me --now" }));
    expect(await inspectProjectSettings(dir)).toEqual([
      { file: FILE, kind: "entries", entries: [{ key, value: "run-me --now" }] },
    ]);
  });

  it("flags a helper whose value is not a string", async () => {
    await writeSettings(JSON.stringify({ apiKeyHelper: 42 }));
    expect(await inspectProjectSettings(dir)).toEqual([
      { file: FILE, kind: "entries", entries: [{ key: "apiKeyHelper", value: 42 }] },
    ]);
  });

  it("ignores an empty env", async () => {
    await writeSettings(JSON.stringify({ env: {} }));
    expect(await inspectProjectSettings(dir)).toEqual([]);
  });

  it("flags every env variable separately", async () => {
    await writeSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://x", FOO: "1" } }));
    expect(await inspectProjectSettings(dir)).toEqual([
      {
        file: FILE,
        kind: "entries",
        entries: [
          { key: "env.ANTHROPIC_BASE_URL", value: "http://x" },
          { key: "env.FOO", value: "1" },
        ],
      },
    ]);
  });

  it("flags a non-object env with its raw value", async () => {
    await writeSettings(JSON.stringify({ env: "x" }));
    expect(await inspectProjectSettings(dir)).toEqual([
      { file: FILE, kind: "entries", entries: [{ key: "env", value: "x" }] },
    ]);
  });

  it.each([
    ["invalid JSON", "{ nope"],
    ["a leading BOM", "\ufeff{}"],
    ["a comment", '{\n// hi\n"model": "x"}'],
    ["a top-level array", "[]"],
    ["a top-level string", '"string"'],
    ["null", "null"],
  ])("reports %s as unreadable", async (_name, content) => {
    await writeSettings(content);
    unreadable(await inspectProjectSettings(dir));
  });

  it("reports a directory in place of the file as unreadable", async () => {
    await mkdir(join(dir, FILE), { recursive: true });
    unreadable(await inspectProjectSettings(dir), "not a regular file");
  });

  it.skipIf(process.getuid?.() === 0)("reports a file without read permission as unreadable", async () => {
    await writeSettings("{}");
    await chmod(join(dir, FILE), 0o000);
    unreadable(await inspectProjectSettings(dir));
  });

  it("never puts file content in the reason of a malformed file", async () => {
    await writeSettings('{ "\u001b[1A\u202e": nope');
    unreadable(await inspectProjectSettings(dir), "invalid JSON");
  });

  it("escapes control and bidirectional characters in an env variable name", async () => {
    await writeSettings(JSON.stringify({ env: { "A\u001b[1A\u202eB": "1" } }));
    const [finding] = await inspectProjectSettings(dir);
    const key = finding?.kind === "entries" ? finding.entries[0]?.key : undefined;
    expect(key).toBe("env.A\\u001b[1A\\u202eB");
  });

  it("reports a non-object top level with a fixed reason", async () => {
    await writeSettings("[]");
    unreadable(await inspectProjectSettings(dir), "not a JSON object");
  });

  it.skipIf(process.platform === "win32")("reports a symlink to a FIFO without hanging", async () => {
    const outside = await mkdtemp(join(tmpdir(), "claudex-fifo-"));
    try {
      const fifo = join(outside, "pipe");
      execFileSync("mkfifo", [fifo]);
      await mkdir(join(dir, ".claude"));
      await symlink(fifo, join(dir, FILE));
      unreadable(await inspectProjectSettings(dir), "not a regular file");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a file larger than 1 MiB", async () => {
    await writeSettings(" ".repeat(1_048_576 + 1));
    unreadable(await inspectProjectSettings(dir), "larger than 1 MiB");
  });

  it("accepts a file of exactly 1 MiB", async () => {
    await writeSettings("{}" + " ".repeat(1_048_576 - 2));
    expect(await inspectProjectSettings(dir)).toEqual([]);
  });

  it("flags env: null with its raw value", async () => {
    await writeSettings('{"env": null}');
    expect(await inspectProjectSettings(dir)).toEqual([
      { file: FILE, kind: "entries", entries: [{ key: "env", value: null }] },
    ]);
  });

  it("flags env: [] with its raw value", async () => {
    await writeSettings('{"env": []}');
    expect(await inspectProjectSettings(dir)).toEqual([
      { file: FILE, kind: "entries", entries: [{ key: "env", value: [] }] },
    ]);
  });

  it("flags an env variable named __proto__", async () => {
    await writeSettings('{"env": {"__proto__": "x"}}');
    expect(await inspectProjectSettings(dir)).toEqual([
      { file: FILE, kind: "entries", entries: [{ key: "env.__proto__", value: "x" }] },
    ]);
  });

  it("reads through a symlink pointing outside the project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "claudex-outside-"));
    try {
      await writeFile(join(outside, "real.json"), JSON.stringify({ apiKeyHelper: "evil" }));
      await mkdir(join(dir, ".claude"));
      await symlink(join(outside, "real.json"), join(dir, FILE));
      expect(await inspectProjectSettings(dir)).toEqual([
        { file: FILE, kind: "entries", entries: [{ key: "apiKeyHelper", value: "evil" }] },
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("sameFindings", () => {
  const a: SettingsFinding[] = [
    { file: "b.json", kind: "entries", entries: [{ key: "x", value: { p: 1, q: 2 } }, { key: "y", value: 1 }] },
    { file: "a.json", kind: "unreadable", reason: "EISDIR" },
  ];

  it("ignores the order of files, entries and object keys", () => {
    const b: SettingsFinding[] = [
      { file: "a.json", kind: "unreadable", reason: "EISDIR" },
      { file: "b.json", kind: "entries", entries: [{ key: "y", value: 1 }, { key: "x", value: { q: 2, p: 1 } }] },
    ];
    expect(sameFindings(a, b)).toBe(true);
  });

  it("treats two empty lists as the same", () => {
    expect(sameFindings([], [])).toBe(true);
  });

  it("detects a changed value", () => {
    const b: SettingsFinding[] = [
      { file: "b.json", kind: "entries", entries: [{ key: "x", value: { p: 1, q: 3 } }, { key: "y", value: 1 }] },
      a[1] as SettingsFinding,
    ];
    expect(sameFindings(a, b)).toBe(false);
  });

  it("detects an added entry, an added file and a different kind", () => {
    const entry: SettingsFinding = { file: "b.json", kind: "entries", entries: [{ key: "x", value: 1 }] };
    expect(sameFindings([entry], [{ ...entry, entries: [...entry.entries, { key: "z", value: 1 }] }])).toBe(false);
    expect(sameFindings([entry], [entry, { file: "c.json", kind: "unreadable", reason: "EISDIR" }])).toBe(false);
    expect(sameFindings([entry], [{ file: "b.json", kind: "unreadable", reason: "EISDIR" }])).toBe(false);
  });
});

describe("formatSettingValue", () => {
  it("escapes control characters", () => {
    expect(formatSettingValue("a\u001b[2Jb\n")).toBe('"a\\u001b[2Jb\\n"');
  });

  it("escapes bidirectional overrides", () => {
    expect(formatSettingValue("x\u202ey")).toBe('"x\\u202ey"');
  });

  it("escapes C1 controls, line separators and isolates", () => {
    expect(formatSettingValue("\u007f\u009b\u2028\u2066\u200f")).toBe('"\\u007f\\u009b\\u2028\\u2066\\u200f"');
  });

  it.each([
    ["U+200B", "\u200b"],
    ["U+FEFF", "\ufeff"],
    ["U+061C", "\u061c"],
    ["U+00AD", "\u00ad"],
    ["U+3164", "\u3164"],
    ["U+115F", "\u115f"],
    ["U+1160", "\u1160"],
  ])("escapes %s", (_name, char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    expect(formatSettingValue(`a${char}b`)).toBe(`"a\\u${code}b"`);
  });

  it("formats objects as JSON", () => {
    expect(formatSettingValue({ b: 1 })).toBe('{"b":1}');
  });
});
