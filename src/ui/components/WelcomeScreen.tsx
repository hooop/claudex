import { Box, Text, useApp, useStdout } from "ink";
import { useState } from "react";
import type { CodingAgent } from "../../agents/types.js";
import { parseCommand } from "../../orchestrator/commands.js";
import type { AgentId } from "../../types.js";
import type { ProjectStatus } from "../../util/projectStatus.js";
import {
  cycleHeaderAnimation,
  HEADER_MAX_WIDTH,
  type HeaderAnimationId,
} from "../headerArt.js";
import { BRAND_COLOR } from "../theme.js";
import { AnimatedHeader } from "./AnimatedHeader.js";
import { WELCOME_COMMANDS } from "./CommandPalette.js";
import { InputBar } from "./InputBar.js";
import { MODEL_FOOTER_COLOR, ModelFooter } from "./ModelFooter.js";
import { ModelPicker } from "./ModelPicker.js";

export const WELCOME_MODELS_COLOR = MODEL_FOOTER_COLOR;
export const WELCOME_TAGLINE = "Argue first, ship better!";
export const WELCOME_TAGLINE_COLOR = "ansi256(138)";
export const WELCOME_MEMORY_COLOR = "ansi256(59)";

const FRENCH_SESSION_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "long",
  timeStyle: "short",
});

export function formatLastSession(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : FRENCH_SESSION_FORMATTER.format(date);
}

export function welcomeDivider(width: number): string {
  const columns = Number.isFinite(width) ? Math.floor(width) : 80;
  return "·".repeat(Math.max(1, Math.min(columns, HEADER_MAX_WIDTH)));
}

const WELCOME_HELP_LINES = [
  "Accueil : texte libre — démarre un débat · /model claude|codex <nom>",
  "Pendant un débat : texte libre · /claude <texte> · /codex <texte>",
  "/pause · /resume · /cancel · /save · /new",
  "/autonomy unbounded|starts N|time 5m [--remember]",
  "/decide <sujet> | <approche> · /limit <texte>",
  "/handoff · /implement [claude|codex] [précision]",
  "/retry · /help · /quit · Échap — pause · Ctrl+C — arrêt quiescent et archive",
] as const;

export function WelcomeScreen(props: {
  agents: Record<AgentId, CodingAgent>;
  status: ProjectStatus;
  headerAnimation: HeaderAnimationId;
  onHeaderAnimationChange: (animation: HeaderAnimationId) => void;
  onStart: (topic: string) => void;
}) {
  const { agents, status, headerAnimation, onHeaderAnimationChange, onStart } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows || 24;
  const memoryDivider = welcomeDivider(stdout?.columns ?? 80);
  const [, bump] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [modelPickerAgent, setModelPickerAgent] = useState<AgentId | null>(null);

  function handleSubmit(value: string) {
    const cmd = parseCommand(value);

    if (cmd.kind === "model") {
      setShowHelp(false);
      if (!cmd.model) {
        setModelPickerAgent(cmd.agent);
        return;
      }
      agents[cmd.agent].setModel(cmd.model);
      setNotice(null);
      bump((v) => v + 1); // re-render to reflect the new model
      return;
    }

    if (cmd.kind === "help") {
      setNotice(null);
      setShowHelp((visible) => !visible);
      return;
    }

    if (cmd.kind === "quit") {
      exit();
      return;
    }

    if (value.trim().startsWith("/")) {
      setShowHelp(false);
      setNotice("Pas de débat en cours. Tape un sujet, /model claude|codex <nom>, /help ou /quit.");
      return;
    }

    onStart(value);
  }

  return (
    <Box flexDirection="column" height={Math.max(1, rows - 1)}>
      <Box flexDirection="column" flexGrow={1}>
        <AnimatedHeader animation={headerAnimation} />

        <Box flexDirection="column">
          <Text color={WELCOME_MEMORY_COLOR}>{memoryDivider}</Text>
          <Text color={WELCOME_MEMORY_COLOR} wrap="truncate-end">
            Mémoire : {status.decisionsCount} décision{status.decisionsCount === 1 ? "" : "s"} actée
            {status.decisionsCount === 1 ? "" : "s"}
            {status.lastSession
              ? ` · dernière session : ${formatLastSession(status.lastSession)}`
              : " · aucune session précédente"}
          </Text>
          <Text color={WELCOME_MEMORY_COLOR}>{memoryDivider}</Text>
        </Box>

        <Box marginTop={1} marginBottom={1}>
          <Text color={WELCOME_TAGLINE_COLOR} wrap="truncate-end">
            {WELCOME_TAGLINE}
          </Text>
        </Box>

        {!commandPaletteOpen && notice && (
          <Box marginTop={1}>
            <Text color="#f5c542">{notice}</Text>
          </Box>
        )}

        {!commandPaletteOpen && showHelp && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={BRAND_COLOR}>
              Commandes
            </Text>
            {WELCOME_HELP_LINES.map((line) => (
              <Text key={line} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        )}
      </Box>

      {modelPickerAgent ? (
        <ModelPicker
          agent={modelPickerAgent}
          width={stdout?.columns ?? 80}
          onSelect={(model) => {
            agents[modelPickerAgent].setModel(model);
            setModelPickerAgent(null);
            bump((v) => v + 1);
          }}
          onCancel={() => setModelPickerAgent(null)}
        />
      ) : (
        <InputBar
          disabled={false}
          placeholder="Décrivez la problématique technique"
          commands={WELCOME_COMMANDS}
          onCommandPaletteChange={setCommandPaletteOpen}
          onSubmit={handleSubmit}
          onNavigate={(direction) =>
            onHeaderAnimationChange(cycleHeaderAnimation(headerAnimation, direction))
          }
        />
      )}

      <ModelFooter
        models={{
          claude: claudeModelLabel(agents.claude, status),
          codex: codexModelLabel(agents.codex, status),
        }}
      />
    </Box>
  );
}

function claudeModelLabel(agent: CodingAgent, status: ProjectStatus): string {
  if (agent.hasExplicitModel()) return agent.currentModel();
  if (status.claudeDefaultModel) return status.claudeDefaultModel;
  return "inconnu — détecté au premier message";
}

function codexModelLabel(agent: CodingAgent, status: ProjectStatus): string {
  if (agent.hasExplicitModel()) return agent.currentModel();
  if (status.codexDefaultModel) {
    return status.codexDefaultEffort
      ? `${status.codexDefaultModel}, effort ${status.codexDefaultEffort}`
      : status.codexDefaultModel;
  }
  return "inconnu — détecté au premier message";
}
