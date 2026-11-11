import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveDebateSandbox } from "../debateSandbox.js";

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "claudex-sandbox-"));
  const dir = join(root, "real");
  mkdirSync(dir);
  const link = join(root, "link");
  symlinkSync(dir, link);
  return { dir, link };
}

it("darwin : renvoie le chemin réel", async () => {
  const { dir, link } = tempProject();
  expect(await resolveDebateSandbox(link, "darwin", "/h")).toEqual({ cwd: realpathSync(dir), home: "/h" });
});

it("linux et win32 : pas de Bash", async () => {
  const { dir } = tempProject();
  expect(await resolveDebateSandbox(dir, "linux", "/h")).toBeNull();
  expect(await resolveDebateSandbox(dir, "win32", "/h")).toBeNull();
});

it("dossier absent : rejette", async () => {
  await expect(resolveDebateSandbox(join(tmpdir(), "claudex-absent-dir-xyz"), "darwin", "/h")).rejects.toThrow();
});
