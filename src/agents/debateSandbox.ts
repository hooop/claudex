import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { CREDENTIAL_READ_DENY, type DebateSandbox } from "./debateOptions.js";

// Same idea as Codex's default shell environment policy, which drops variables
// whose name contains KEY, SECRET or TOKEN. A heuristic: a secret held in a
// variable named otherwise stays visible.
const SECRET_ENV_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null; // Missing entries have nothing to protect.
  }
}

// Bash is offered only where the OS sandbox is available (macOS). Real paths
// matter: the sandbox's rules apply to resolved paths, so a symlinked cwd would
// leave the project writable, and a symlinked ~/.ssh would leave its target readable.
export async function resolveDebateSandbox(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<DebateSandbox | null> {
  if (platform !== "darwin") return null;
  const realCwd = await realpath(cwd);
  const realHome = (await realpathOrNull(home)) ?? home;
  const extra = new Set<string>();
  for (const entry of CREDENTIAL_READ_DENY) {
    const path = join(realHome, entry);
    const target = await realpathOrNull(path);
    if (target !== null && target !== path) extra.add(target);
  }
  return {
    cwd: realCwd,
    home: realHome,
    extraDenyRead: [...extra].sort(),
    secretEnvNames: Object.keys(env).filter((name) => SECRET_ENV_NAME.test(name)).sort(),
  };
}
