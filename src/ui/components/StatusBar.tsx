import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { AgentActivity, AgentId, Phase, SuspensionReason } from "../../types.js";
import { displayWidth, truncateEnd } from "../stream/lineBuffer.js";
import { sanitizeForDisplay } from "../stream/sanitize.js";
import { asciiSymbolsForDisplay } from "../stream/asciiSymbols.js";
import { AGENT_STYLE } from "../theme.js";
import { INPUT_BAR_RIGHT_PADDING } from "./InputBar.js";

const PHASE_LABEL: Record<Phase, string> = {
  debate: "",
  implementation: "Implémentation",
  ended: "Terminé",
};

/** Align status truncation with the prompt's outer edge and its right breathing room. */
export const STATUS_BAR_RIGHT_INSET = INPUT_BAR_RIGHT_PADDING + 1;

export function statusBarWidth(width: number): number {
  return Math.max(1, width - STATUS_BAR_RIGHT_INSET);
}

/** Flatten untrusted tool text before Ink is allowed to draw it on one row. */
export function flattenActivityLabel(label: string): string {
  return asciiSymbolsForDisplay(sanitizeForDisplay(label)).replace(/\s+/gu, " ").trim();
}

export function describeActivity(activity: AgentActivity): string {
  if (activity.kind === "waiting") return "prépare sa réponse…";
  if (activity.kind === "responding") return "répond…";

  const label = flattenActivityLabel(activity.label) || (activity.kind === "command" ? "commande" : "outil");
  const duration = formatDuration(activity.durationMs);

  if (activity.kind === "command") {
    if (activity.status === "running") {
      return (activity.activeCount ?? 1) > 1
        ? `${activity.activeCount} commandes en cours · $ ${label}`
        : `exécute : $ ${label}`;
    }
    const exit = activity.status === "failure" && activity.exitCode != null ? ` · code ${activity.exitCode}` : "";
    return `$ ${label}${duration}${exit}`;
  }

  return `${label}${duration}`;
}

export function fitActivityDescription(
  phase: Phase,
  agent: AgentId,
  activity: AgentActivity,
  width: number,
): string {
  const fixedWidth =
    (phase === "debate" ? 0 : displayWidth(`${PHASE_LABEL[phase]}  ·  `)) +
    displayWidth(
      activity.status === "running" ? "x " : activity.status === "success" ? "[ok] " : "[x] ",
    ) +
    displayWidth(`${AGENT_STYLE[agent].badge} `);
  return truncateEnd(describeActivity(activity), statusBarWidth(width) - fixedWidth);
}

/**
 * One line, never two. While an agent is active, its current action has priority
 * and is shortened before the prompt's right edge with an explicit `...`.
 */
export function StatusBar(props: {
  phase: Phase;
  thinkingAgent: AgentId | null;
  activity: AgentActivity | null;
  paused: boolean;
  width: number;
  suspensionReason?: SuspensionReason | null;
  lifecycleState?: "idle" | "closing" | "shutdown-failed" | "archive-failed";
}) {
  const {
    phase,
    thinkingAgent,
    activity,
    paused,
    width,
    suspensionReason = null,
    lifecycleState = "idle",
  } = props;
  const currentActivity = activity ?? { kind: "waiting", status: "running" as const };
  const fittedActivity = thinkingAgent
    ? fitActivityDescription(phase, thinkingAgent, currentActivity, width)
    : "";
  const idleState =
    lifecycleState !== "idle"
      ? lifecycleLabel(lifecycleState)
      : paused
        ? suspensionLabel(suspensionReason)
        : null;
  const showPhase = phase !== "debate";

  return (
    <Box width={statusBarWidth(width)}>
      <Text wrap="truncate-end">
        {thinkingAgent ? (
          <>
            {showPhase ? <Text dimColor>{PHASE_LABEL[phase]}  ·  </Text> : null}
            <Text color={AGENT_STYLE[thinkingAgent].color}>
              {currentActivity.status === "running" ? (
                <>
                  <Spinner type="dots" />{" "}
                </>
              ) : currentActivity.status === "success" ? (
                "[ok] "
              ) : (
                "[x] "
              )}
              {AGENT_STYLE[thinkingAgent].badge} {fittedActivity}
            </Text>
          </>
        ) : (
          <>
            {showPhase ? (
              <>
                <Text dimColor>{PHASE_LABEL[phase]}  ·  </Text>
                <Text color={AGENT_STYLE.claude.color}>{AGENT_STYLE.claude.badge}</Text>
                <Text dimColor>{" + "}</Text>
                <Text color={AGENT_STYLE.codex.color}>{AGENT_STYLE.codex.badge}</Text>
              </>
            ) : null}
            {idleState ? (
              <Text color="#f5c542">{`${showPhase ? "  ·  " : ""}${idleState}`}</Text>
            ) : null}
          </>
        )}
      </Text>
    </Box>
  );
}

function lifecycleLabel(state: "closing" | "shutdown-failed" | "archive-failed"): string {
  if (state === "closing") return "Fermeture quiescente en cours";
  if (state === "shutdown-failed") return "Arrêt incomplet · /retry";
  return "Archive en échec · /retry";
}

function suspensionLabel(reason: SuspensionReason | null): string {
  switch (reason) {
    case "waiting-human":
      return "Réponse humaine attendue";
    case "autonomy-exhausted":
      return "Fenêtre d'autonomie épuisée · /resume";
    case "protocol-error":
      return "Protocole invalide · /resume";
    case "failed":
      return "Tour en échec · /resume";
    case "cancelled":
      return "Tour annulé · /resume";
    default:
      return "[pause] En pause";
  }
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return ` · ${Math.max(0, Math.round(durationMs))} ms`;
  const seconds = durationMs / 1000;
  const digits = seconds < 10 ? 1 : 0;
  return ` · ${seconds.toFixed(digits).replace(".", ",")} s`;
}
