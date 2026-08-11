import { Box, Text } from "ink";
import type { AgentId } from "../../types.js";
import { BRAND_COLOR } from "../theme.js";

export const MODEL_FOOTER_COLOR = "ansi256(66)";
export const MODEL_FOOTER_ROWS = 1;

/** Stable line below the prompt, shared by the welcome and debate screens. */
export function ModelFooter(props: { models: Record<AgentId, string> }) {
  return (
    <Box paddingX={1}>
      <Box flexGrow={1} flexShrink={1} marginRight={1}>
        <Text color={MODEL_FOOTER_COLOR} wrap="truncate-end">
          {props.models.claude} + {props.models.codex}
        </Text>
      </Box>
      <Text color={BRAND_COLOR}>/help</Text>
    </Box>
  );
}
