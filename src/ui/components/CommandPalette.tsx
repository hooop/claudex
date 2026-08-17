import {
  SELECTION_PALETTE_ROWS,
  SELECTION_PALETTE_VISIBLE_ITEMS,
  SelectionPalette,
} from "./SelectionPalette.js";

export interface CommandSuggestion {
  /** Text inserted by Tab. A trailing space leaves the cursor ready for arguments. */
  completion: string;
  /** Compact usage shown in the palette. */
  usage: string;
  description: string;
}

export const COMMAND_PALETTE_VISIBLE_ITEMS = SELECTION_PALETTE_VISIBLE_ITEMS;
export const COMMAND_PALETTE_ROWS = SELECTION_PALETTE_ROWS;

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
  { completion: "/decisions", usage: "/decisions", description: "consulter les décisions actées" },
  { completion: "/help", usage: "/help", description: "afficher toutes les commandes" },
  { completion: "/quit", usage: "/quit", description: "quitter Claudex" },
] as const;

export const DEBATE_COMMANDS: readonly CommandSuggestion[] = [
  { completion: "/sujet", usage: "/sujet", description: "afficher le sujet complet" },
  { completion: "/decisions", usage: "/decisions", description: "consulter les décisions actées" },
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
  return (
    <SelectionPalette
      items={props.commands.map((command) => ({
        key: command.completion,
        label: command.usage,
        description: command.description,
      }))}
      selectedIndex={props.selectedIndex}
      width={props.width}
      actionLabel="Tab compléter"
      emptyLabel="Aucune commande correspondante"
    />
  );
}
