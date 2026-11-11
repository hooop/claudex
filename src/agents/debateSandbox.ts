import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import type { DebateSandbox } from "./debateOptions.js";

// Bash is offered only where the OS sandbox is available (macOS). The real path
// matters: the sandbox's deny rules apply to resolved paths, so a symlinked cwd
// would leave the project writable.
export async function resolveDebateSandbox(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): Promise<DebateSandbox | null> {
  if (platform !== "darwin") return null;
  return { cwd: await realpath(cwd), home };
}
