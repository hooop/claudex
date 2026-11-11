import { Box, Text, useInput } from "ink";
import { formatSettingValue, type SettingsFinding } from "../../agents/projectSettings.js";
import { BRAND_COLOR } from "../theme.js";

const QUIT_KEYS = new Set(["n", "q"]);

/**
 * Shown before anything starts when the project's Claude Code settings carry
 * commands or environment variables the engine applies on every Claude
 * session. Keys and reasons arrive already escaped; values go through
 * formatSettingValue so a value cannot rewrite the terminal. Values wrap and
 * are never truncated: the human must see exactly what they accept.
 */
export function SettingsConsent(props: {
  findings: readonly SettingsFinding[];
  onDecide: (accept: boolean) => void;
}) {
  const { findings, onDecide } = props;

  useInput((input, key) => {
    // Quitting is the default: Enter, Escape and Ctrl+C refuse, so a reflex
    // keystroke can never consent. RENDER_OPTIONS disables Ink's own Ctrl+C.
    if (input === "y" || input === "Y") onDecide(true);
    else if (QUIT_KEYS.has(input) || key.return || key.escape || (key.ctrl && input === "c")) onDecide(false);
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="wrap" color={BRAND_COLOR} bold>
        Les réglages Claude Code de ce projet demandent à Claude Code d'exécuter ces commandes ou de définir ces
        variables d'environnement au démarrage de chaque session Claude. Claudex ne peut pas les désactiver.
      </Text>
      {findings.map((finding) => (
        <Box key={finding.file} flexDirection="column" marginTop={1}>
          <Text bold>{finding.file}</Text>
          {finding.kind === "entries" ? (
            finding.entries.map((entry) => (
              <Text key={entry.key} wrap="wrap">
                {"  "}
                {entry.key} = {formatSettingValue(entry.value)}
              </Text>
            ))
          ) : (
            <Text wrap="wrap">  illisible : {finding.reason}</Text>
          )}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text wrap="wrap">
          <Text color="greenBright">[y]</Text> continuer avec ces réglages · <Text color="redBright">[n]</Text> quitter
        </Text>
      </Box>
    </Box>
  );
}
