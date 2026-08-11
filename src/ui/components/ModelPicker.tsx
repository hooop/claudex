import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import type { AgentId } from "../../types.js";
import { AGENT_STYLE } from "../theme.js";

/**
 * Only models with real evidence behind them: Claude's aliases are
 * documented in `claude --help` (fable/opus/sonnet, haiku by the same
 * pattern). Codex's are read from this account's own ~/.codex/config.toml
 * (configured default + availability history) — nothing invented, since a
 * wrong guess here would just fail at the API.
 */
const OPTIONS: Record<AgentId, { label: string; value: string }[]> = {
  claude: [
    { label: "Opus 5 — le plus puissant, plus lent", value: "opus" },
    { label: "Sonnet 5 — équilibré (recommandé)", value: "sonnet" },
    { label: "Haiku 4.5 — rapide et léger", value: "haiku" },
    { label: "Fable 5", value: "fable" },
  ],
  codex: [
    { label: "gpt-5.6-sol, effort max — défaut configuré", value: "gpt-5.6-sol" },
    { label: "gpt-5.5", value: "gpt-5.5" },
  ],
};

/** Rows the picker is allowed to occupy: one title plus the longest option list. */
export const MODEL_PICKER_ROWS = 1 + Math.max(...Object.values(OPTIONS).map((o) => o.length));

/**
 * Replaces the status bar and prompt while open. Height is pinned and overflow
 * clipped: a label that wraps on a narrow terminal must not push the dynamic
 * zone past the height Ink can erase cleanly.
 */
export function ModelPicker(props: {
  agent: AgentId;
  onSelect: (model: string) => void;
  onCancel: () => void;
  width: number;
}) {
  const { agent, onSelect, onCancel, width } = props;
  const style = AGENT_STYLE[agent];
  const rows = 1 + OPTIONS[agent].length;

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" width={width} height={rows} overflow="hidden">
      <Text color={style.color} bold wrap="truncate-end">
        Modèle pour {style.badge} — ↑↓ puis Entrée · Échap pour annuler
      </Text>
      <SelectInput items={OPTIONS[agent]} onSelect={(item) => onSelect(item.value)} />
    </Box>
  );
}
