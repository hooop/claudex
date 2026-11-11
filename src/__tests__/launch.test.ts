import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsFinding } from "../agents/projectSettings.js";
import { prepareLaunch, SETTINGS_REFUSED_MESSAGE } from "../launch.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claudex-launch-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeHelper(): Promise<void> {
  await mkdir(join(dir, ".claude"));
  await writeFile(join(dir, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "touch /tmp/marker" }));
}

const HELPER_FINDING: SettingsFinding = {
  file: ".claude/settings.json",
  kind: "entries",
  entries: [{ key: "apiKeyHelper", value: "touch /tmp/marker" }],
};

describe("prepareLaunch", () => {
  it("starts without asking when the project has no command settings", async () => {
    const ask = vi.fn(async () => true);
    const decision = await prepareLaunch(dir, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(decision.kind).toBe("start");
    if (decision.kind !== "start") return;
    expect(decision.approved).toEqual([]);
    expect(decision.created).toContain(".claudex/.gitignore");
    expect(existsSync(join(dir, ".claudex"))).toBe(true);
  });

  it("leaves the project untouched when the human refuses", async () => {
    await writeHelper();
    const ask = vi.fn(async () => false);
    const decision = await prepareLaunch(dir, ask);
    expect(ask).toHaveBeenCalledWith([HELPER_FINDING]);
    expect(decision).toEqual({ kind: "refused" });
    expect(existsSync(join(dir, ".claudex"))).toBe(false);
  });

  it("starts with the approved findings when the human accepts", async () => {
    await writeHelper();
    const decision = await prepareLaunch(dir, async () => true);
    expect(decision.kind).toBe("start");
    if (decision.kind !== "start") return;
    expect(decision.approved).toEqual([HELPER_FINDING]);
    expect(existsSync(join(dir, ".claudex"))).toBe(true);
  });

  it("propagates an inspection failure without creating .claudex", async () => {
    const ask = vi.fn(async () => true);
    const failure = new Error("inspection failed");
    await expect(prepareLaunch(dir, ask, { inspect: () => Promise.reject(failure) })).rejects.toBe(failure);
    expect(ask).not.toHaveBeenCalled();
    expect(existsSync(join(dir, ".claudex"))).toBe(false);
  });

  it("explains in one line why nothing started", () => {
    expect(SETTINGS_REFUSED_MESSAGE).not.toContain("\n");
    expect(SETTINGS_REFUSED_MESSAGE.length).toBeGreaterThan(0);
  });
});
