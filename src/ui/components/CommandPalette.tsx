import {
  SELECTION_PALETTE_ROWS,
  SelectionPalette,
} from "./SelectionPalette.js";

export interface CommandSuggestion {
  /** Text inserted by Tab. A trailing space leaves the cursor ready for arguments. */
  completion: string;
  /** Compact usage shown in the palette. */
  usage: string;
  description: string;
}

export const COMMAND_PALETTE_ROWS = SELECTION_PALETTE_ROWS;

export const WELCOME_COMMANDS: readonly CommandSuggestion[] = [
  {
    completion: "/model claude ",
    usage: "/model claude <name>",
    description: "choose the Claude model",
  },
  {
    completion: "/model codex ",
    usage: "/model codex <name>",
    description: "choose the Codex model",
  },
  { completion: "/decisions", usage: "/decisions", description: "read the settled decisions" },
  { completion: "/help", usage: "/help", description: "show all commands" },
  { completion: "/quit", usage: "/quit", description: "quit Claudex" },
] as const;

export const DEBATE_COMMANDS: readonly CommandSuggestion[] = [
  { completion: "/topic", usage: "/topic", description: "show the full topic" },
  { completion: "/decisions", usage: "/decisions", description: "read the settled decisions" },
  {
    completion: "/claude ",
    usage: "/claude <text>",
    description: "write to Claude only",
  },
  { completion: "/codex ", usage: "/codex <text>", description: "write to Codex only" },
  { completion: "/pause", usage: "/pause", description: "stop after the current turn" },
  { completion: "/resume", usage: "/resume", description: "resume the automatic debate" },
  { completion: "/cancel", usage: "/cancel", description: "cancel the active turn, without losing the session" },
  {
    completion: "/autonomy ",
    usage: "/autonomy unbounded|starts N|time 5m [--remember]",
    description: "set the automatic window explicitly",
  },
  {
    completion: "/accept-topic",
    usage: "/accept-topic",
    description: "manually accept a topic after a protocol error",
  },
  {
    completion: "/model claude ",
    usage: "/model claude <name>",
    description: "change the Claude model",
  },
  {
    completion: "/model codex ",
    usage: "/model codex <name>",
    description: "change the Codex model",
  },
  {
    completion: "/handoff",
    usage: "/handoff",
    description: "generate the implementation prompt",
  },
  {
    completion: "/implement ",
    usage: "/implement [agent] [details]",
    description: "move on to implementation",
  },
  {
    completion: "/decide ",
    usage: "/decide <subject> | <approach>",
    description: "remember a decision",
  },
  { completion: "/limit ", usage: "/limit <text>", description: "remember a limit" },
  { completion: "/save", usage: "/save", description: "save the transcript" },
  { completion: "/new", usage: "/new", description: "open a new topic" },
  { completion: "/retry", usage: "/retry", description: "retry a failed shutdown or archive" },
  { completion: "/help", usage: "/help", description: "show all commands" },
  { completion: "/quit", usage: "/quit", description: "save and quit" },
  {
    completion: "/emergency-exit",
    usage: "/emergency-exit",
    description: "quit without an archive guarantee",
  },
] as const;

export function matchingCommands(
  commands: readonly CommandSuggestion[],
  value: string,
): readonly CommandSuggestion[] {
  if (!value.startsWith("/")) return [];
  const query = value.toLowerCase();
  return commands.filter((command) => command.completion.toLowerCase().startsWith(query));
}

/** Keep an explicit no-result state for a command name, then close once arguments begin. */
export function isCommandPaletteEligible(
  value: string,
  matches: readonly CommandSuggestion[],
): boolean {
  return value.startsWith("/") && (matches.length > 0 || !/\s/.test(value));
}

export function CommandPalette(props: {
  commands: readonly CommandSuggestion[];
  selectedIndex: number;
  width: number;
}) {
  return (
    <SelectionPalette
      items={props.commands.map((command) => ({
        key: command.completion,
        label: command.usage,
        description: command.description,
      }))}
      selectedIndex={props.selectedIndex}
      width={props.width}
      actionLabel="Tab complete"
      emptyLabel="No matching command"
    />
  );
}
