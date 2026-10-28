import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/renderUnderCi.tsx", import.meta.url));
// `--import tsx` resolves from the child's cwd, whatever directory vitest runs from.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// Starting a child process with tsx is slow on a loaded CI runner.
const CHILD_PROCESS_TIMEOUT = 15_000;

async function renderWithEnv(env: NodeJS.ProcessEnv) {
  const { stdout } = await run(process.execPath, ["--import", "tsx", fixture], {
    env,
    cwd: repoRoot,
  });
  return JSON.parse(stdout) as { alternateScreen: boolean; frameDrawn: boolean };
}

describe("render options", () => {
  /**
   * Ink treats any environment with CI set as non-interactive, even on a real
   * terminal: it skips the alternate screen and draws only the final frame, so
   * a user whose shell exports CI would stare at a blank screen all session.
   */
  it("draws in the alternate screen while running even when CI is set", async () => {
    const result = await renderWithEnv({ ...process.env, CI: "true" });

    expect(result).toEqual({ alternateScreen: true, frameDrawn: true });
  }, CHILD_PROCESS_TIMEOUT);

  it("draws in the alternate screen while running when CI is not set", async () => {
    const env = { ...process.env };
    delete env.CI;
    delete env.CONTINUOUS_INTEGRATION;

    const result = await renderWithEnv(env);

    expect(result).toEqual({ alternateScreen: true, frameDrawn: true });
  }, CHILD_PROCESS_TIMEOUT);
});
