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
import { displayWidth, truncateEnd } from "../stream/lineBuffer.js";
import { AnimatedHeader } from "./AnimatedHeader.js";
import { WELCOME_COMMANDS } from "./CommandPalette.js";
import { DecisionViewer } from "./DecisionViewer.js";
import { inputBarWidth, InputBar } from "./InputBar.js";
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

export function welcomeMemoryLine(
  status: Pick<ProjectStatus, "decisionsCount" | "lastSession">,
  width: number,
): string {
  const columns = Math.max(
    1,
    Math.min(Number.isFinite(width) ? Math.floor(width) : 80, HEADER_MAX_WIDTH),
  );
  const decisions =
    `Mémoire : ${status.decisionsCount} décision${status.decisionsCount === 1 ? "" : "s"} actée` +
    (status.decisionsCount === 1 ? "" : "s");
  const lastSession = status.lastSession
    ? `dernière session : ${formatLastSession(status.lastSession)}`
    : "aucune session précédente";
  const lastSessionWidth = displayWidth(lastSession);

  if (lastSessionWidth >= columns) return truncateEnd(lastSession, columns);

  const visibleDecisions = truncateEnd(decisions, columns - lastSessionWidth - 1);
  const gap = " ".repeat(columns - displayWidth(visibleDecisions) - lastSessionWidth);
  return `${visibleDecisions}${gap}${lastSession}`;
}

const WELCOME_HELP_LINES = [
  "Accueil : texte libre — démarre un débat · /model claude|codex <nom>",
  "Pendant un débat : texte libre · /claude <texte> · /codex <texte>",
  "/pause · /resume · /cancel · /save · /new",
  "/autonomy unbounded|starts N|time 5m [--remember]",
  "/decide <sujet> | <approche> · /limit <texte>",
  "/decisions — consulter les décisions actées",
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
  const memoryWidth = Math.max(1, Math.min(stdout?.columns ?? 80, HEADER_MAX_WIDTH));
  const memoryDivider = welcomeDivider(memoryWidth);
  const memoryLine = welcomeMemoryLine(status, memoryWidth);
  const [, bump] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [decisionViewerOpen, setDecisionViewerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [modelPickerAgent, setModelPickerAgent] = useState<AgentId | null>(null);
  const selectionPaletteOpen = commandPaletteOpen || modelPickerAgent !== null;

  function handleSubmit(value: string) {
    const cmd = parseCommand(value);

    if (cmd.kind === "model") {
      setDecisionViewerOpen(false);
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
      setDecisionViewerOpen(false);
      setNotice(null);
      setShowHelp((visible) => !visible);
      return;
    }

    if (cmd.kind === "quit") {
      exit();
      return;
    }

    if (cmd.kind === "decisions") {
      setShowHelp(false);
      if (!status.decisionsText) {
        setNotice("Aucune mémoire de décisions n'est disponible pour ce projet.");
        return;
      }
      setNotice(null);
      setDecisionViewerOpen(true);
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
        {decisionViewerOpen && status.decisionsText ? (
          <DecisionViewer
            markdown={status.decisionsText}
            width={stdout?.columns ?? 80}
            height={Math.max(3, rows - 5)}
            onClose={() => setDecisionViewerOpen(false)}
          />
        ) : (
          <>
            <AnimatedHeader animation={headerAnimation} />

            <Box flexDirection="column">
              <Text color={WELCOME_MEMORY_COLOR}>{memoryDivider}</Text>
              <Text color={WELCOME_MEMORY_COLOR}>{memoryLine}</Text>
              <Text color={WELCOME_MEMORY_COLOR}>{memoryDivider}</Text>
            </Box>

            <Box marginTop={1} marginBottom={1}>
              <Text color={WELCOME_TAGLINE_COLOR} wrap="truncate-end">
                {WELCOME_TAGLINE}
              </Text>
            </Box>

            {!selectionPaletteOpen && notice && (
              <Box marginTop={1}>
                <Text color="#f5c542">{notice}</Text>
              </Box>
            )}

            {!selectionPaletteOpen && showHelp && (
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
          </>
        )}
      </Box>

      {modelPickerAgent && (
        <ModelPicker
          key={modelPickerAgent}
          agent={modelPickerAgent}
          width={inputBarWidth(stdout?.columns ?? 80)}
          onSelect={(model) => {
            agents[modelPickerAgent].setModel(model);
            setModelPickerAgent(null);
            bump((v) => v + 1);
          }}
          onCancel={() => setModelPickerAgent(null)}
        />
      )}

      <InputBar
        disabled={false}
        inputActive={modelPickerAgent === null && !decisionViewerOpen}
        placeholder="Décrivez la problématique technique"
        commands={WELCOME_COMMANDS}
        onCommandPaletteChange={setCommandPaletteOpen}
        onSubmit={handleSubmit}
        onNavigate={(direction) =>
          onHeaderAnimationChange(cycleHeaderAnimation(headerAnimation, direction))
        }
      />

      <ModelFooter
        models={{
          claude: agents.claude.currentModel(),
          codex: agents.codex.currentModel(),
        }}
      />
    </Box>
  );
}
