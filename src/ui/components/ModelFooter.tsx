import { Box, Text } from "ink";
import type { AgentContextUsage, AgentId } from "../../types.js";
import { BRAND_COLOR } from "../theme.js";

export const MODEL_FOOTER_COLOR = "ansi256(66)";
export const MODEL_FOOTER_ROWS = 1;

/**
 * `null` means unmeasured, which is not the same as empty. `/model` clears the
 * reading because the window size may change, but neither agent resets its
 * session: the next turn replays the whole conversation. Claiming `100% libre`
 * there would retract the pressure warning exactly when the operator is acting
 * on it.
 */
export function contextRemainingPercent(
  usage: AgentContextUsage | null | undefined,
): string | null {
  if (!usage || usage.contextWindow <= 0) return null;
  const percent = Math.round(
    ((usage.contextWindow - usage.usedTokens) / usage.contextWindow) * 100,
  );
  return `${Math.max(0, Math.min(100, percent))}%`;
}

/** Stable line below the prompt, shared by the welcome and debate screens. */
export function ModelFooter(props: {
  models: Record<AgentId, string>;
  contextUsage?: Partial<Record<AgentId, AgentContextUsage | null>>;
}) {
  const showContext = props.contextUsage !== undefined;
  const modelLabel = (agent: AgentId) => {
    if (!showContext) return props.models[agent];

    const remaining = contextRemainingPercent(props.contextUsage?.[agent]);
    return remaining === null
      ? `${props.models[agent]} · ctx —`
      : `${props.models[agent]} · ctx ${remaining} libre`;
  };

  return (
    <Box paddingX={1}>
      <Box flexGrow={1} flexShrink={1} marginRight={1}>
        <Text color={MODEL_FOOTER_COLOR} wrap="truncate-end">
          {modelLabel("claude")} + {modelLabel("codex")}
        </Text>
      </Box>
      <Text color={BRAND_COLOR}>/help</Text>
    </Box>
  );
}
