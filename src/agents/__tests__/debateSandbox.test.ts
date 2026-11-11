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
  expect(await resolveDebateSandbox(link, "darwin", "/h", {})).toEqual({
    cwd: realpathSync(dir),
    home: "/h",
    extraDenyRead: [],
    secretEnvNames: [],
  });
});

it("linux et win32 : pas de Bash", async () => {
  const { dir } = tempProject();
  expect(await resolveDebateSandbox(dir, "linux", "/h")).toBeNull();
  expect(await resolveDebateSandbox(dir, "win32", "/h")).toBeNull();
});

it("dossier absent : rejette", async () => {
  await expect(resolveDebateSandbox(join(tmpdir(), "claudex-absent-dir-xyz"), "darwin", "/h")).rejects.toThrow();
});

it("un dossier de credentials en lien : sa cible réelle est ajoutée", async () => {
  const { dir } = tempProject();
  const home = mkdtempSync(join(tmpdir(), "claudex-home-"));
  const target = mkdtempSync(join(tmpdir(), "claudex-ssh-"));
  symlinkSync(target, join(home, ".ssh"));
  mkdirSync(join(home, ".aws"));
  const result = await resolveDebateSandbox(dir, "darwin", home, {});
  expect(result?.extraDenyRead).toEqual([realpathSync(target)]);
});

it("un home en lien : home devient son chemin réel", async () => {
  const { dir, link } = tempProject();
  const result = await resolveDebateSandbox(dir, "darwin", link, {});
  expect(result?.home).toBe(realpathSync(link));
});

it("un home introuvable est gardé tel quel", async () => {
  const { dir } = tempProject();
  const result = await resolveDebateSandbox(dir, "darwin", "/nonexistent-home-xyz", {});
  expect(result).toMatchObject({ home: "/nonexistent-home-xyz", extraDenyRead: [] });
});

it("les cibles en double sont dédoublonnées et triées", async () => {
  const { dir } = tempProject();
  const home = mkdtempSync(join(tmpdir(), "claudex-home-"));
  const b = mkdtempSync(join(tmpdir(), "claudex-b-"));
  const a = mkdtempSync(join(tmpdir(), "claudex-a-"));
  symlinkSync(b, join(home, ".ssh"));
  symlinkSync(b, join(home, ".aws"));
  symlinkSync(a, join(home, ".kube"));
  const result = await resolveDebateSandbox(dir, "darwin", home, {});
  expect(result?.extraDenyRead).toEqual([realpathSync(a), realpathSync(b)].sort());
});

it("variables secrètes : AUTH, DSN et DATABASE_URL en plus, mais ni PWD, ni PATH, ni GIT_AUTHOR_NAME", async () => {
  const { dir } = tempProject();
  const env = {
    XAUTH_TOKEN: "x", SENTRY_DSN: "x", DATABASE_URL: "x", PWD: "/p", PATH: "/bin", GIT_AUTHOR_NAME: "n", OAUTH_CODE: "x",
  };
  const result = await resolveDebateSandbox(dir, "darwin", "/h", env);
  expect(result?.secretEnvNames).toEqual(["DATABASE_URL", "OAUTH_CODE", "SENTRY_DSN", "XAUTH_TOKEN"]);
});

it("variables secrètes : noms reconnus sans tenir compte de la casse, triés", async () => {
  const { dir } = tempProject();
  const env = { github_token: "x", MY_API_KEY: "x", DB_PASSWORD: "x", PATH: "/bin", HOME: "/h", AWS_SECRET: "x", GIT_CREDENTIAL: "x" };
  const result = await resolveDebateSandbox(dir, "darwin", "/h", env);
  expect(result?.secretEnvNames).toEqual(["AWS_SECRET", "DB_PASSWORD", "GIT_CREDENTIAL", "MY_API_KEY", "github_token"]);
});
