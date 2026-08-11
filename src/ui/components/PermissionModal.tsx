import { Box, Text, useInput } from "ink";
import type { PermissionRequest } from "../../types.js";
import { formatToolInput } from "../../util/formatToolInput.js";
import { AGENT_STYLE } from "../theme.js";

/**
 * Two lines, replacing the status bar and the prompt while a decision is owed.
 *
 * The request itself is also written into the permanent transcript by the
 * scheduler, so this only has to carry the question and the keys — it doesn't
 * need to be the record of what was asked.
 */
export function PermissionModal(props: {
  request: PermissionRequest;
  onDecide: (allow: boolean) => void;
  width: number;
}) {
  const { request, onDecide, width } = props;

  useInput((input) => {
    // Explicit y/n required — Enter alone does not approve
    if (input.toLowerCase() === "y") onDecide(true);
    if (input.toLowerCase() === "n") onDecide(false);
  });

  const style = AGENT_STYLE[request.agent];
  const preview = formatToolInput(request.input);

  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate-end">
        <Text color={style.color} bold>
          {style.badge}
        </Text>
        <Text> demande une autorisation : </Text>
        <Text bold>{request.toolName}</Text>
        {preview ? <Text dimColor> — {preview}</Text> : null}
      </Text>
      <Text wrap="truncate-end">
        <Text color="greenBright">[y]</Text> autoriser · <Text color="redBright">[n]</Text> refuser
      </Text>
    </Box>
  );
}
