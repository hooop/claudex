import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeEngineLeftovers, snapshotEngineLeftovers } from "../engineLeftovers.js";

describe("engineLeftovers", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "claudex-leftovers-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("lists only existing paths in the snapshot", async () => {
    expect([...(await snapshotEngineLeftovers(cwd))]).toEqual([]);
    mkdirSync(join(cwd, ".claude"));
    expect([...(await snapshotEngineLeftovers(cwd))]).toEqual([".claude"]);
    mkdirSync(join(cwd, ".claude", ".cc-writes"));
    expect([...(await snapshotEngineLeftovers(cwd))].sort()).toEqual([".claude", ".claude/.cc-writes"]);
  });

  it("removes .claude/.cc-writes and .claude created during the turn, and returns the list", async () => {
    const before = await snapshotEngineLeftovers(cwd);
    mkdirSync(join(cwd, ".claude", ".cc-writes"), { recursive: true });
    const removed = await removeEngineLeftovers(cwd, before);
    expect(removed).toEqual([".claude/.cc-writes", ".claude"]);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });

  it("keeps .claude if it existed before and removes only a new .cc-writes", async () => {
    mkdirSync(join(cwd, ".claude"));
    const before = await snapshotEngineLeftovers(cwd);
    mkdirSync(join(cwd, ".claude", ".cc-writes"));
    const removed = await removeEngineLeftovers(cwd, before);
    expect(removed).toEqual([".claude/.cc-writes"]);
    expect(existsSync(join(cwd, ".claude"))).toBe(true);
    expect(existsSync(join(cwd, ".claude", ".cc-writes"))).toBe(false);
  });

  it("never removes a non-empty folder", async () => {
    const before = await snapshotEngineLeftovers(cwd);
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), "{}");
    const removed = await removeEngineLeftovers(cwd, before);
    expect(removed).toEqual([]);
    expect(readFileSync(join(cwd, ".claude", "settings.json"), "utf8")).toBe("{}");
  });

  it("ignores a .claude symlink and does not touch its target", async () => {
    const target = mkdtempSync(join(tmpdir(), "claudex-leftovers-target-"));
    try {
      const before = await snapshotEngineLeftovers(cwd);
      symlinkSync(target, join(cwd, ".claude"));
      const removed = await removeEngineLeftovers(cwd, before);
      expect(removed).toEqual([]);
      expect(lstatSync(join(cwd, ".claude")).isSymbolicLink()).toBe(true);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("accepts missing paths", async () => {
    await expect(removeEngineLeftovers(cwd, new Set())).resolves.toEqual([]);
  });

  it("does not throw when the project folder no longer exists", async () => {
    await expect(removeEngineLeftovers(join(cwd, "absent"), new Set())).resolves.toEqual([]);
  });
});
