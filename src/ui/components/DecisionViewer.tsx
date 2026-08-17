import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { markdownToPlainText } from "../markdown.js";
import { asciiSymbolsForDisplay } from "../stream/asciiSymbols.js";
import { wrapAll } from "../stream/lineBuffer.js";
import { BRAND_COLOR } from "../theme.js";

const MUTED_COLOR = "ansi256(66)";

/** Bounded, keyboard-scrollable reader used on the welcome screen. */
export function DecisionViewer(props: {
  markdown: string;
  width: number;
  height: number;
  onClose: () => void;
}) {
  const { markdown, width, height, onClose } = props;
  const [offset, setOffset] = useState(0);
  const bodyRows = Math.max(1, height - 2);
  const contentWidth = Math.max(8, width - 2);
  const lines = useMemo(
    () =>
      asciiSymbolsForDisplay(markdownToPlainText(markdown))
        .split("\n")
        .flatMap((line) => wrapAll(line, contentWidth)),
    [contentWidth, markdown],
  );
  const maximumOffset = Math.max(0, lines.length - bodyRows);
  const visibleOffset = Math.min(offset, maximumOffset);
  const visibleLines = lines.slice(visibleOffset, visibleOffset + bodyRows);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      setOffset((current) => Math.max(0, Math.min(maximumOffset, current + delta)));
      return;
    }
    if (key.pageUp || key.pageDown) {
      const delta = key.pageUp ? -bodyRows : bodyRows;
      setOffset((current) => Math.max(0, Math.min(maximumOffset, current + delta)));
    }
  });

  const first = lines.length === 0 ? 0 : visibleOffset + 1;
  const last = Math.min(lines.length, visibleOffset + bodyRows);

  return (
    <Box flexDirection="column" height={Math.max(3, height)} paddingX={1} overflow="hidden">
      <Text bold color={BRAND_COLOR} wrap="truncate-end">
        Décisions actées
      </Text>
      {Array.from({ length: bodyRows }, (_, index) => (
        <Text key={`${visibleOffset}-${index}`} wrap="truncate-end">
          {visibleLines[index] ?? " "}
        </Text>
      ))}
      <Text color={MUTED_COLOR} wrap="truncate-end">
        ↑↓ défiler · PgUp/PgDn page · Échap fermer · {first}-{last}/{lines.length}
      </Text>
    </Box>
  );
}
