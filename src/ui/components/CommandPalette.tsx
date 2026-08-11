import { Box, Text } from "ink";

export interface CommandSuggestion {
  /** Text inserted by Tab. A trailing space leaves the cursor ready for arguments. */
  completion: string;
  /** Compact usage shown in the palette. */
  usage: string;
  description: string;
}

export const COMMAND_PALETTE_VISIBLE_ITEMS = 3;
export const COMMAND_PALETTE_ROWS = COMMAND_PALETTE_VISIBLE_ITEMS + 1;

const SELECTED_RAIL_COLOR = "ansi256(220)";
const SELECTED_COMMAND_COLOR = "ansi256(195)";
const COMMAND_COLOR = "ansi256(66)";
const MUTED_COLOR = "ansi256(237)";

export const WELCOME_COMMANDS: readonly CommandSuggestion[] = [
  {
    completion: "/model claude ",
    usage: "/model claude <nom>",
    description: "choisir le modèle Claude",
  },
  {
    completion: "/model codex ",
    usage: "/model codex <nom>",
    description: "choisir le modèle Codex",
  },
  { completion: "/help", usage: "/help", description: "afficher toutes les commandes" },
  { completion: "/quit", usage: "/quit", description: "quitter Claudex" },
] as const;

export const DEBATE_COMMANDS: readonly CommandSuggestion[] = [
  {
    completion: "/claude ",
    usage: "/claude <texte>",
    description: "écrire seulement à Claude",
  },
  { completion: "/codex ", usage: "/codex <texte>", description: "écrire seulement à Codex" },
  { completion: "/pause", usage: "/pause", description: "arrêter après le tour en cours" },
  { completion: "/resume", usage: "/resume", description: "reprendre le débat automatique" },
  { completion: "/cancel", usage: "/cancel", description: "annuler le tour actif, sans perdre la session" },
  {
    completion: "/autonomy ",
    usage: "/autonomy unbounded|starts N|time 5m [--remember]",
    description: "définir explicitement la fenêtre automatique",
  },
  {
    completion: "/accept-topic",
    usage: "/accept-topic",
    description: "valider manuellement un sujet après erreur de protocole",
  },
  {
    completion: "/model claude ",
    usage: "/model claude <nom>",
    description: "changer le modèle Claude",
  },
  {
    completion: "/model codex ",
    usage: "/model codex <nom>",
    description: "changer le modèle Codex",
  },
  {
    completion: "/handoff",
    usage: "/handoff",
    description: "générer le prompt d’implémentation",
  },
  {
    completion: "/implement ",
    usage: "/implement [agent] [précision]",
    description: "passer à l’implémentation",
  },
  {
    completion: "/decide ",
    usage: "/decide <sujet> | <approche>",
    description: "mémoriser une décision",
  },
  { completion: "/limit ", usage: "/limit <texte>", description: "mémoriser une limite" },
  { completion: "/save", usage: "/save", description: "enregistrer la trace" },
  { completion: "/new", usage: "/new", description: "ouvrir un nouveau sujet" },
  { completion: "/retry", usage: "/retry", description: "retenter un arrêt ou un archivage échoué" },
  { completion: "/help", usage: "/help", description: "afficher toutes les commandes" },
  { completion: "/quit", usage: "/quit", description: "sauvegarder et quitter" },
  {
    completion: "/emergency-exit",
    usage: "/emergency-exit",
    description: "quitter sans garantie d'archive",
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
  const { commands, width } = props;
  const selectedIndex =
    commands.length === 0 ? 0 : Math.min(props.selectedIndex, commands.length - 1);
  const maxStart = Math.max(0, commands.length - COMMAND_PALETTE_VISIBLE_ITEMS);
  const firstVisible = Math.min(
    maxStart,
    Math.max(0, selectedIndex - Math.floor(COMMAND_PALETTE_VISIBLE_ITEMS / 2)),
  );
  const visible = commands.slice(firstVisible, firstVisible + COMMAND_PALETTE_VISIBLE_ITEMS);
  const position = commands.length === 0 ? "0/0" : `${selectedIndex + 1}/${commands.length}`;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={COMMAND_PALETTE_ROWS}
      paddingLeft={1}
      overflow="hidden"
    >
      {Array.from({ length: COMMAND_PALETTE_VISIBLE_ITEMS }, (_, row) => {
        const command = visible[row];
        if (!command) {
          return row === 0 && commands.length === 0 ? (
            <Text key="empty" color={MUTED_COLOR} wrap="truncate-end">
              › Aucune commande correspondante
            </Text>
          ) : (
            <Text key={`empty-${row}`}> </Text>
          );
        }

        const index = firstVisible + row;
        const selected = index === selectedIndex;
        return (
          <Text key={command.completion} wrap="truncate-end">
            <Text color={selected ? SELECTED_RAIL_COLOR : MUTED_COLOR}>
              {selected ? "› " : "  "}
            </Text>
            <Text color={selected ? SELECTED_COMMAND_COLOR : COMMAND_COLOR} bold={selected}>
              {command.usage}
            </Text>
            <Text color={MUTED_COLOR}> — {command.description}</Text>
          </Text>
        );
      })}
      <Text color={MUTED_COLOR} wrap="truncate-end">
        ↑↓ {position} · Tab compléter · Échap fermer
      </Text>
    </Box>
  );
}
