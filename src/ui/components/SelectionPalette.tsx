import { Box, Text } from "ink";
import { displayWidth } from "../stream/lineBuffer.js";

export interface SelectionPaletteItem {
  key: string;
  label: string;
  description?: string;
}

export const SELECTION_PALETTE_VISIBLE_ITEMS = 3;
/** Three choices, one breathing row, then the navigation hints. */
export const SELECTION_PALETTE_ROWS = SELECTION_PALETTE_VISIBLE_ITEMS + 2;

const SELECTED_RAIL_COLOR = "ansi256(220)";
const SELECTED_LABEL_COLOR = "ansi256(195)";
const LABEL_COLOR = "ansi256(66)";
const MUTED_COLOR = "ansi256(237)";

/** Shared keyboard palette used by commands and model selection. */
export function SelectionPalette(props: {
  items: readonly SelectionPaletteItem[];
  selectedIndex: number;
  width: number;
  actionLabel: string;
  emptyLabel: string;
}) {
  const { items, width } = props;
  const selectedIndex =
    items.length === 0 ? 0 : Math.max(0, Math.min(props.selectedIndex, items.length - 1));
  const maxStart = Math.max(0, items.length - SELECTION_PALETTE_VISIBLE_ITEMS);
  const firstVisible = Math.min(
    maxStart,
    Math.max(0, selectedIndex - Math.floor(SELECTION_PALETTE_VISIBLE_ITEMS / 2)),
  );
  const visible = items.slice(firstVisible, firstVisible + SELECTION_PALETTE_VISIBLE_ITEMS);
  const labelWidth = visible.reduce(
    (widest, item) => Math.max(widest, displayWidth(item.label)),
    0,
  );
  const position = items.length === 0 ? "0/0" : `${selectedIndex + 1}/${items.length}`;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={SELECTION_PALETTE_ROWS}
      paddingLeft={1}
      overflow="hidden"
    >
      {Array.from({ length: SELECTION_PALETTE_VISIBLE_ITEMS }, (_, row) => {
        const item = visible[row];
        if (!item) {
          return row === 0 && items.length === 0 ? (
            <Text key="empty" color={MUTED_COLOR} wrap="truncate-end">
              › {props.emptyLabel}
            </Text>
          ) : (
            <Text key={`empty-${row}`}> </Text>
          );
        }

        const index = firstVisible + row;
        const selected = index === selectedIndex;
        return (
          <Text key={item.key} wrap="truncate-end">
            <Text color={selected ? SELECTED_RAIL_COLOR : MUTED_COLOR}>
              {selected ? "› " : "  "}
            </Text>
            <Text color={selected ? SELECTED_LABEL_COLOR : LABEL_COLOR} bold={selected}>
              {item.label}
            </Text>
            {item.description ? (
              <Text color={MUTED_COLOR}>
                {" ".repeat(Math.max(0, labelWidth - displayWidth(item.label)))} — {item.description}
              </Text>
            ) : null}
          </Text>
        );
      })}
      <Text> </Text>
      <Text color={MUTED_COLOR} wrap="truncate-end">
        ↑↓ {position} · {props.actionLabel} · Échap fermer
      </Text>
    </Box>
  );
}
