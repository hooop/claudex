import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TrustedDirError,
  assertEmptyDir,
  changedKeys,
  claudeConfigFile,
  readProjectEntry,
  resolveTrustedDir,
} from "../trustedDir.js";

let root: string;
let configFile: string;

beforeEach(() => {
  // realpath: on macOS tmpdir() itself sits behind the /var symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), "claudex-trusted-test-")));
  configFile = join(root, ".claude.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function config(projects: Record<string, unknown>): void {
  writeFileSync(configFile, JSON.stringify({ projects }));
}

function folder(name = "trusted"): string {
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
}

describe("resolveTrustedDir", () => {
  it("accepts a folder the config marks as trusted, and returns its real path", async () => {
    const dir = folder();
    config({ [dir]: { hasTrustDialogAccepted: true } });

    await expect(resolveTrustedDir(dir, configFile)).resolves.toBe(dir);
  });

  it("resolves a symlinked folder to the real path it looks up", async () => {
    const dir = folder();
    const link = join(root, "link");
    symlinkSync(dir, link);
    config({ [dir]: { hasTrustDialogAccepted: true } });

    await expect(resolveTrustedDir(link, configFile)).resolves.toBe(dir);
  });

  it("refuses a folder with no entry", async () => {
    const dir = folder();
    config({ "/somewhere/else": { hasTrustDialogAccepted: true } });

    await expect(resolveTrustedDir(dir, configFile)).rejects.toThrow(TrustedDirError);
  });

  it("refuses hasTrustDialogAccepted false", async () => {
    const dir = folder();
    config({ [dir]: { hasTrustDialogAccepted: false } });

    await expect(resolveTrustedDir(dir, configFile)).rejects.toThrow(TrustedDirError);
  });

  it("refuses a missing folder", async () => {
    config({});

    await expect(resolveTrustedDir(join(root, "nope"), configFile)).rejects.toThrow(TrustedDirError);
  });

  it("refuses a file given as folder", async () => {
    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    config({ [file]: { hasTrustDialogAccepted: true } });

    await expect(resolveTrustedDir(file, configFile)).rejects.toThrow(TrustedDirError);
  });

  it("refuses a missing config, naming its path", async () => {
    const dir = folder();

    await expect(resolveTrustedDir(dir, configFile)).rejects.toThrow(configFile);
  });

  it("refuses an unreadable config without printing it", async () => {
    const dir = folder();
    config({ [dir]: { hasTrustDialogAccepted: true, secret: "s3cr3t" } });
    chmodSync(configFile, 0o000);

    const error = await resolveTrustedDir(dir, configFile).catch((e: unknown) => e);
    chmodSync(configFile, 0o600);

    expect(error).toBeInstanceOf(TrustedDirError);
    expect((error as Error).message).toContain(configFile);
    expect((error as Error).message).not.toContain("s3cr3t");
  });

  it("refuses a malformed config without printing it", async () => {
    const dir = folder();
    writeFileSync(configFile, '{"secret":"s3cr3t"');

    const error = await resolveTrustedDir(dir, configFile).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TrustedDirError);
    expect((error as Error).message).toContain(configFile);
    expect((error as Error).message).not.toContain("s3cr3t");
  });

  it("refuses a config that is JSON but not an object with projects", async () => {
    const dir = folder();
    writeFileSync(configFile, "[1]");

    await expect(resolveTrustedDir(dir, configFile)).rejects.toThrow(TrustedDirError);
  });
});

describe("claudeConfigFile", () => {
  it("uses CLAUDE_CONFIG_DIR when set, the home directory otherwise", () => {
    expect(claudeConfigFile({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u")).toBe("/cfg/.claude.json");
    expect(claudeConfigFile({}, "/home/u")).toBe("/home/u/.claude.json");
  });
});

describe("assertEmptyDir", () => {
  it("passes on an empty folder", async () => {
    await expect(assertEmptyDir(folder())).resolves.toBeUndefined();
  });

  it("throws listing what it found, hidden entries included", async () => {
    const dir = folder();
    writeFileSync(join(dir, "a.txt"), "");
    writeFileSync(join(dir, ".hidden"), "");

    const error = await assertEmptyDir(dir).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TrustedDirError);
    expect((error as Error).message).toMatch(/a\.txt, \.hidden|\.hidden, a\.txt/);
  });
});

describe("readProjectEntry", () => {
  it("returns the entry of the folder, null when there is none", async () => {
    config({ "/a": { k: 1 } });

    await expect(readProjectEntry(configFile, "/a")).resolves.toEqual({ k: 1 });
    await expect(readProjectEntry(configFile, "/b")).resolves.toBeNull();
  });
});

describe("changedKeys", () => {
  it("names the keys added, removed or changed, sorted", () => {
    expect(changedKeys({ a: 1, b: [1] }, { a: 1, b: [1, 2], c: true })).toEqual(["b", "c"]);
    expect(changedKeys({ z: 1, a: 1 }, { a: 1 })).toEqual(["z"]);
  });

  it("treats a missing entry as empty", () => {
    expect(changedKeys(null, { a: 1 })).toEqual(["a"]);
    expect(changedKeys({ a: 1 }, null)).toEqual(["a"]);
  });

  it("returns nothing when equal", () => {
    expect(changedKeys({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
    expect(changedKeys(null, null)).toEqual([]);
  });
});
