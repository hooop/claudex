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

it("darwin: returns the real path", async () => {
  const { dir, link } = tempProject();
  expect(await resolveDebateSandbox(link, "darwin", "/h", {})).toEqual({
    cwd: realpathSync(dir),
    home: "/h",
    extraDenyRead: [],
    secretEnvNames: [],
  });
});

it("linux and win32: no Bash", async () => {
  const { dir } = tempProject();
  expect(await resolveDebateSandbox(dir, "linux", "/h")).toBeNull();
  expect(await resolveDebateSandbox(dir, "win32", "/h")).toBeNull();
});

it("missing folder: rejects", async () => {
  await expect(resolveDebateSandbox(join(tmpdir(), "claudex-absent-dir-xyz"), "darwin", "/h")).rejects.toThrow();
});

it("a credentials folder that is a link: its real target is added", async () => {
  const { dir } = tempProject();
  const home = mkdtempSync(join(tmpdir(), "claudex-home-"));
  const target = mkdtempSync(join(tmpdir(), "claudex-ssh-"));
  symlinkSync(target, join(home, ".ssh"));
  mkdirSync(join(home, ".aws"));
  const result = await resolveDebateSandbox(dir, "darwin", home, {});
  expect(result?.extraDenyRead).toEqual([realpathSync(target)]);
});

it("a home that is a link: home becomes its real path", async () => {
  const { dir, link } = tempProject();
  const result = await resolveDebateSandbox(dir, "darwin", link, {});
  expect(result?.home).toBe(realpathSync(link));
});

it("a home that cannot be found is kept as is", async () => {
  const { dir } = tempProject();
  const result = await resolveDebateSandbox(dir, "darwin", "/nonexistent-home-xyz", {});
  expect(result).toMatchObject({ home: "/nonexistent-home-xyz", extraDenyRead: [] });
});

it("duplicate targets are deduplicated and sorted", async () => {
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

it("secret variables: AUTH, DSN and DATABASE_URL on top, but not PWD, PATH or GIT_AUTHOR_NAME", async () => {
  const { dir } = tempProject();
  const env = {
    XAUTH_TOKEN: "x", SENTRY_DSN: "x", DATABASE_URL: "x", PWD: "/p", PATH: "/bin", GIT_AUTHOR_NAME: "n", OAUTH_CODE: "x",
  };
  const result = await resolveDebateSandbox(dir, "darwin", "/h", env);
  expect(result?.secretEnvNames).toEqual(["DATABASE_URL", "OAUTH_CODE", "SENTRY_DSN", "XAUTH_TOKEN"]);
});

it("secret variables: AUTHORIZATION is hidden, GIT_COMMITTER_NAME and GIT_AUTHOR_EMAIL stay visible", async () => {
  const { dir } = tempProject();
  const env = { HTTP_AUTHORIZATION: "Bearer x", AUTHORIZATION_HEADER: "x", GIT_AUTHOR_EMAIL: "e", GIT_COMMITTER_NAME: "n" };
  const result = await resolveDebateSandbox(dir, "darwin", "/h", env);
  expect(result?.secretEnvNames).toEqual(["AUTHORIZATION_HEADER", "HTTP_AUTHORIZATION"]);
});

it("secret variables: names recognised case-insensitively, sorted", async () => {
  const { dir } = tempProject();
  const env = { github_token: "x", MY_API_KEY: "x", DB_PASSWORD: "x", PATH: "/bin", HOME: "/h", AWS_SECRET: "x", GIT_CREDENTIAL: "x" };
  const result = await resolveDebateSandbox(dir, "darwin", "/h", env);
  expect(result?.secretEnvNames).toEqual(["AWS_SECRET", "DB_PASSWORD", "GIT_CREDENTIAL", "MY_API_KEY", "github_token"]);
});
