import { Box, Text } from "ink";
import { CLAUDEX_VERSION } from "../../version.js";
import { stageOf, statusLine, type DebateStatus } from "../debateStatus.js";
import { displayWidth, truncateEnd } from "../stream/lineBuffer.js";
import { BRAND_COLOR, GLYPH, NARROW_COLUMNS, contentWidthFor } from "../theme.js";
import type { ProjectStatus } from "../../util/projectStatus.js";
import { welcomeMemoryLine } from "./WelcomeScreen.js";

// Defined with the other frame constants, which derive the minimum size from it.
export { DEBATE_HEADER_ROWS } from "../theme.js";

const TOPIC_LABEL = "Topic  ";
const MEMORY_LABEL = "Memory ";
const TOPIC_MORE = "… /topic";

/**
 * The fixed top of the debate: name, version, stage and protocol status, then
 * the topic and the project memory, each on one row. The topic is flattened and
 * truncated because the header never scrolls; `/topic` prints it in full.
 */
export function DebateHeader(props: {
  columns: number;
  topic: string;
  status: DebateStatus;
  memory: Pick<ProjectStatus, "decisionsCount" | "lastSession">;
}) {
  const { columns, topic, status, memory } = props;
  // The transcript's width, so the header's rule and right edge line up with the turns below.
  const width = Math.max(1, Math.min(columns, contentWidthFor(columns)));
  const meta = ` ${CLAUDEX_VERSION} ${GLYPH.dot} ${stageOf(status)}`;
  const segments = statusLine(status);
  const statusWidth = segments.reduce((sum, { text }) => sum + displayWidth(text), 0);
  const leftWidth = displayWidth("CLAUDEX") + displayWidth(meta);
  // The status is dropped, never wrapped, when it does not fit beside the title.
  const gap = width - leftWidth - statusWidth;
  const showStatus = columns >= NARROW_COLUMNS && gap >= 2;

  const flatTopic = topic.trim().replace(/\s+/gu, " ");
  const topicText = truncateEnd(flatTopic, Math.max(1, width - TOPIC_LABEL.length), TOPIC_MORE);
  const memoryText = memoryRow(memory, Math.max(1, width - MEMORY_LABEL.length));

  return (
    // Never squeezed: the transcript is the only region that gives up rows.
    <Box flexDirection="column" width={columns} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text bold color={BRAND_COLOR}>
          CLAUDEX
        </Text>
        <Text dimColor>{meta}</Text>
        {showStatus && (
          <>
            <Text>{" ".repeat(gap)}</Text>
            {segments.map((segment, index) => (
              <Text key={index} color={segment.color}>
                {segment.text}
              </Text>
            ))}
          </>
        )}
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>{TOPIC_LABEL}</Text>
        {topicText}
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>{MEMORY_LABEL}</Text>
        {memoryText}
      </Text>
      <Text dimColor>{GLYPH.ruleHeavy.repeat(width)}</Text>
    </Box>
  );
}

const MEMORY_PREFIX = "Memory: ";

/**
 * welcomeMemoryLine counts its own "Memory: " prefix in the width and is capped
 * at the header maximum. Ask for the prefix on top, strip it, and give the
 * capped difference back to the gap so the row still ends at `width`.
 */
function memoryRow(memory: Pick<ProjectStatus, "decisionsCount" | "lastSession">, width: number): string {
  const line = welcomeMemoryLine(memory, width + MEMORY_PREFIX.length).replace(MEMORY_PREFIX, "");
  // Too narrow for the prefix: welcomeMemoryLine kept only the last session, at the wider width.
  if (displayWidth(line) > width) return truncateEnd(line, width);
  const missing = width - displayWidth(line);
  if (missing <= 0) return line;
  return line.replace(/ +(?=last session: |no previous session$)/u, (gap) => gap + " ".repeat(missing));
}
