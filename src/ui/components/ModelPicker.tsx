import { useInput } from "ink";
import { useState } from "react";
import { useScreenVisible } from "../screenVisibility.js";
import type { AgentId } from "../../types.js";
import {
  SELECTION_PALETTE_ROWS,
  SelectionPalette,
  type SelectionPaletteItem,
} from "./SelectionPalette.js";

/**
 * Only models with real evidence behind them: Claude's aliases are
 * documented in `claude --help` (fable/opus/sonnet, haiku by the same
 * pattern). Codex's are read from this account's own ~/.codex/config.toml
 * (configured default + availability history) — nothing invented, since a
 * wrong guess here would just fail at the API.
 */
interface ModelOption extends SelectionPaletteItem {
  value: string;
}

const OPTIONS: Record<AgentId, ModelOption[]> = {
  claude: [
    { key: "opus", label: "Opus 5", description: "most capable, slower", value: "opus" },
    {
      key: "sonnet",
      label: "Sonnet 5",
      description: "balanced (recommended)",
      value: "sonnet",
    },
    { key: "haiku", label: "Haiku 4.5", description: "fast and light", value: "haiku" },
    { key: "fable", label: "Fable 5", value: "fable" },
  ],
  codex: [
    {
      key: "gpt-5.6-sol",
      label: "gpt-5.6-sol, effort max",
      description: "configured default",
      value: "gpt-5.6-sol",
    },
    { key: "gpt-5.5", label: "gpt-5.5", value: "gpt-5.5" },
  ],
};

/** Same fixed viewport as commands: three choices, one gap, then the controls. */
export const MODEL_PICKER_ROWS = SELECTION_PALETTE_ROWS;

/**
 * Opens in the same fixed slot as command completion, immediately above the
 * prompt. The parent keeps the prompt visible but routes keyboard input here.
 */
export function ModelPicker(props: {
  agent: AgentId;
  onSelect: (model: string) => void;
  onCancel: () => void;
  width: number;
}) {
  const { agent, onSelect, onCancel, width } = props;
  const options = OPTIONS[agent];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const safeSelectedIndex = Math.min(selectedIndex, options.length - 1);
  const visible = useScreenVisible();

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      setSelectedIndex((current) => (current + delta + options.length) % options.length);
      return;
    }
    // Enter as much as Tab: the input bar is inactive while the picker is
    // open, so Enter would do nothing else, and it is the universal reflex
    // after highlighting a choice with the arrows.
    if (key.tab || key.return) {
      const option = options[safeSelectedIndex];
      if (option) onSelect(option.value);
    }
  }, { isActive: visible });

  return (
    <SelectionPalette
      items={options}
      selectedIndex={safeSelectedIndex}
      width={width}
      actionLabel="Tab or Enter to choose"
      emptyLabel="No model available"
    />
  );
}
