import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/renderUnderCi.tsx", import.meta.url));

async function renderWithEnv(env: NodeJS.ProcessEnv) {
  const { stdout } = await run(process.execPath, ["--import", "tsx", fixture], { env });
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
  });

  it("draws in the alternate screen while running when CI is not set", async () => {
    const env = { ...process.env };
    delete env.CI;
    delete env.CONTINUOUS_INTEGRATION;

    const result = await renderWithEnv(env);

    expect(result).toEqual({ alternateScreen: true, frameDrawn: true });
  });
});
