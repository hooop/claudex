import { inspectProjectSettings, type SettingsFinding } from "./agents/projectSettings.js";
import { initMemoryScaffold } from "./memory/store.js";

export type LaunchDecision =
  | { kind: "start"; approved: SettingsFinding[]; created: string[] }
  | { kind: "refused" };

export const SETTINGS_REFUSED_MESSAGE =
  "Claudex n'a pas démarré : les réglages Claude Code du projet (.claude/settings.json) n'ont pas été acceptés.";

/**
 * Runs before anything else touches the project: a refused project must be
 * left exactly as it was, so the memory scaffold only happens once the human
 * has accepted (or there was nothing to accept).
 */
export async function prepareLaunch(
  cwd: string,
  ask: (findings: SettingsFinding[]) => Promise<boolean>,
  deps: { inspect?: typeof inspectProjectSettings; scaffold?: typeof initMemoryScaffold } = {},
): Promise<LaunchDecision> {
  const { inspect = inspectProjectSettings, scaffold = initMemoryScaffold } = deps;
  const findings = await inspect(cwd);
  if (findings.length > 0 && !(await ask(findings))) return { kind: "refused" };
  const { created } = await scaffold(cwd);
  return { kind: "start", approved: findings, created };
}
