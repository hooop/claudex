import { Box, Static, Text, useInput, useStdout } from "ink";
import chalk from "chalk";
import { useCallback, useEffect, useRef, useState } from "react";
import wrapAnsi from "wrap-ansi";
import { appendDecision, appendLimit, readDecisions, saveHandoff } from "../memory/store.js";
import { decideUsageError, parseCommand } from "../orchestrator/commands.js";
import type { DebateSession } from "../orchestrator/session.js";
import type { EntryOutcome } from "../orchestrator/types.js";
import type {
  AgentActivity,
  AgentContextUsage,
  AgentId,
  AutonomyBudget,
  PermissionRequest,
  Phase,
  SuspensionReason,
  TranscriptEntry,
} from "../types.js";
import type {
  CoordinatorState,
  CoordinatorResponse,
  LifecycleRequest,
} from "./Root.js";
import {
  DynamicFooter,
  footerRows,
  inputBarMaxRows,
  pinnedFooterHeight,
  type FooterSurfaces,
} from "./components/DynamicFooter.js";
import { DEBATE_COMMANDS } from "./components/CommandPalette.js";
import { INPUT_BAR_MIN_ROWS, inputBarWidth, InputBar } from "./components/InputBar.js";
import { ModelFooter } from "./components/ModelFooter.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { PermissionModal } from "./components/PermissionModal.js";
import { StatusBar } from "./components/StatusBar.js";
import {
  DEFAULT_HEADER_ANIMATION,
  getHeaderAnimation,
  headerFrame,
  type HeaderAnimationId,
} from "./headerArt.js";
import { BRAND_COLOR, MAX_STANDARD_DYNAMIC_ROWS, contentWidthFor } from "./theme.js";
import { TranscriptStream, type TailView } from "./stream/transcriptStream.js";
import { asciiSymbolsForDisplay } from "./stream/asciiSymbols.js";
import { wrapAll } from "./stream/lineBuffer.js";
import { sanitizeForDisplay } from "./stream/sanitize.js";
import { markdownToPlainText } from "./markdown.js";

/**
 * The debate screen.
 *
 * Everything permanent — the header, every message, every intervention, notes,
 * permissions, errors, the help panel, the consensus synthesis — is written once
 * into the terminal's own scrollback by `TranscriptStream` and never touched
 * again. What React renders here is only the handful of lines that genuinely
 * change: the incomplete line of the answer being typed out, one status line, the
 * bounded growing prompt, and whichever transient notice or modal is up.
 *
 * That split is the whole design. Scrolling, selection and copy stay the
 * terminal's, and a fifty-round debate costs no more to render than the first
 * one. Only the empty space before the first screen fills is temporarily part
 * of Ink's frame; afterwards the live area is seven rows again.
 */
export function DebateView(props: {
  session: DebateSession;
  topic: string;
  cwd: string;
  headerAnimation?: HeaderAnimationId;
  coordinatorState: CoordinatorState;
  coordinatorNotice: string | null;
  onLifecycleRequest: (request: LifecycleRequest) => Promise<CoordinatorResponse>;
  onAutonomySelected: (budget: AutonomyBudget, remember: boolean) => Promise<void>;
}) {
  const {
    session,
    topic,
    cwd,
    headerAnimation = DEFAULT_HEADER_ANIMATION,
    coordinatorState,
    coordinatorNotice,
    onLifecycleRequest,
    onAutonomySelected,
  } = props;
  const { stdout, write } = useStdout();

  const [{ columns, terminalRows }, setTerminalSize] = useState(() => ({
    columns: stdout?.columns ?? 80,
    terminalRows: stdout?.rows ?? 24,
  }));
  const [{ permanentRows, staticBlocks }, setPinnedFrame] = useState<PinnedFrame>(() => ({
    permanentRows: 0,
    staticBlocks: [],
  }));
  const [pinnedOutput, setPinnedOutput] = useState(true);
  const [tail, setTail] = useState<TailView | null>(null);
  const [phase, setPhase] = useState<Phase>(session.phase);
  const [thinkingAgent, setThinkingAgent] = useState<AgentId | null>(null);
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [contextUsage, setContextUsage] = useState<
    Partial<Record<AgentId, AgentContextUsage>>
  >({});
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [consensusReached, setConsensusReached] = useState(false);
  const [implementationSummary, setImplementationSummary] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelPickerAgent, setModelPickerAgent] = useState<AgentId | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [inputRows, setInputRows] = useState(INPUT_BAR_MIN_ROWS);
  // Explicit paused state — never derived from !busy
  const [paused, setPaused] = useState(false);
  const [suspensionReason, setSuspensionReason] = useState<SuspensionReason | null>(
    session.suspensionReason,
  );

  const streamRef = useRef<TranscriptStream | null>(null);
  const permanentRowsRef = useRef(0);
  const pinnedOutputRef = useRef(true);
  const staticBlockIdRef = useRef(0);
  const disposingRef = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set right before sending an /implement instruction to a specific agent,
  // so we can flag clearly when THAT turn (not just any turn) finishes —
  // otherwise a long implementation turn ends with no visible "done" signal
  // distinct from the ambient phase banner.
  const awaitingImplementFor = useRef<AgentId | null>(null);

  const flash = useCallback((text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(asciiSymbolsForDisplay(text));
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  /**
   * Ink's Static output is used only while the transcript is shorter than the
   * viewport. It lets permanent lines advance from the top while the shrinking
   * live area keeps the prompt at the bottom. Once the first screen is full,
   * writes go straight back to Ink's stdout bridge and retain the original
   * append-only, six-row renderer.
   */
  const writePermanent = useCallback(
    (data: string) => {
      const addedRows = outputRows(data, stdout?.columns ?? 80);
      if (addedRows === 0) return;

      const wasPinned = pinnedOutputRef.current && !disposingRef.current;
      const nextRows = permanentRowsRef.current + addedRows;
      permanentRowsRef.current = nextRows;

      if (wasPinned) {
        const block = {
          id: staticBlockIdRef.current++,
          text: staticBlockText(data),
        };
        // One state update keeps the new Static block and the matching spacer
        // retraction in the same Ink commit.
        setPinnedFrame((frame) => ({
          permanentRows: nextRows,
          staticBlocks: [...frame.staticBlocks, block],
        }));
        return;
      }

      write(data);
    },
    [stdout, write],
  );

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setTerminalSize({
        columns: stdout.columns ?? 80,
        terminalRows: stdout.rows ?? 24,
      });
    };

    // Ink registered its own listener before this component mounted. Running
    // ours first lets React synchronously shrink the legacy Ink tree before
    // Ink measures it; otherwise a resize during the tall startup frame can
    // enter Ink's `clearTerminal` path, whose 3J sequence erases scrollback.
    stdout.prependListener("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    if (!pinnedOutput || permanentRows < pinningThreshold(terminalRows)) return;

    // Static children are flushed synchronously by Ink during the commit which
    // triggered this effect. Switching the writer afterwards preserves ordering
    // between the last bootstrapped block and the first direct append.
    pinnedOutputRef.current = false;
    setPinnedOutput(false);
  }, [permanentRows, pinnedOutput, terminalRows]);

  useEffect(() => {
    disposingRef.current = false;
    // The width getter is read per line, so a resize applies to new output
    // immediately without ever reflowing what has already been written.
    const stream = new TranscriptStream({
      write: writePermanent,
      width: () => contentWidthFor(stdout?.columns ?? 80),
      onTail: setTail,
    });
    streamRef.current = stream;
    stream.raw(bannerLines(stdout?.columns ?? 80, headerAnimation));

    const onEntry = (entry: TranscriptEntry) => stream.entry(entry);
    const onEntryStarted = (entry: TranscriptEntry) => stream.entryStarted(entry);
    const onChunk = (id: string, delta: string) => stream.chunk(id, delta);
    const onEntryCompleted = (id: string, outcome: EntryOutcome) => stream.entryCompleted(id, outcome);
    const onTurnStart = (agent: AgentId) => {
      setThinkingAgent(agent);
      setActivity({ kind: "waiting", status: "running" });
    };
    const onTurnEnd = (agent: AgentId) => {
      setThinkingAgent(null);
      setActivity(null);
      if (awaitingImplementFor.current === agent) {
        awaitingImplementFor.current = null;
        const label = agent === "claude" ? "Claude" : "Codex";
        flash(`[ok] ${label} a terminé ce tour — vérifie les fichiers modifiés (git status / git diff).`);
      }
    };
    const onTurnError = () => {
      setThinkingAgent(null);
      setActivity(null);
    };
    const onActivity = (_agent: AgentId, nextActivity: AgentActivity) => setActivity(nextActivity);
    const onContextUsage = (agent: AgentId, usage: AgentContextUsage) =>
      setContextUsage((current) => ({ ...current, [agent]: usage }));
    const onPhase = (p: Phase) => setPhase(p);
    const onPausedChanged = (p: boolean) => setPaused(p);
    const onSuspensionChanged = (reason: SuspensionReason | null) => setSuspensionReason(reason);
    const onPermissionRequest = (req: PermissionRequest) => {
      setCommandPaletteOpen(false);
      setPendingPermission(req);
    };
    const onPermissionCancelled = (reqId: string) =>
      setPendingPermission((current) => (current?.id === reqId ? null : current));
    const onConsensusReached = () => {
      setConsensusReached(true);
      setImplementationSummary(null);
    };
    const onConsensusInvalidated = () => {
      setConsensusReached(false);
      setImplementationSummary(null);
    };
    const onSynthesisReady = (summary: string) => setImplementationSummary(summary);

    session.on("entry", onEntry);
    session.on("entry-started", onEntryStarted);
    session.on("output-chunk", onChunk);
    session.on("entry-completed", onEntryCompleted);
    session.on("turn-start", onTurnStart);
    session.on("turn-end", onTurnEnd);
    session.on("turn-error", onTurnError);
    session.on("activity", onActivity);
    session.on("context-usage", onContextUsage);
    session.on("phase", onPhase);
    session.on("paused-changed", onPausedChanged);
    session.on("suspension-changed", onSuspensionChanged);
    session.on("permission-request", onPermissionRequest);
    session.on("permission-cancelled", onPermissionCancelled);
    session.on("consensus-reached", onConsensusReached);
    session.on("consensus-invalidated", onConsensusInvalidated);
    session.on("synthesis-ready", onSynthesisReady);

    void session.start(topic).catch((error: unknown) => {
      flash(`Impossible de démarrer la session : ${error instanceof Error ? error.message : String(error)}`);
    });

    return () => {
      session.off("entry", onEntry);
      session.off("entry-started", onEntryStarted);
      session.off("output-chunk", onChunk);
      session.off("entry-completed", onEntryCompleted);
      session.off("turn-start", onTurnStart);
      session.off("turn-end", onTurnEnd);
      session.off("turn-error", onTurnError);
      session.off("activity", onActivity);
      session.off("context-usage", onContextUsage);
      session.off("phase", onPhase);
      session.off("paused-changed", onPausedChanged);
      session.off("suspension-changed", onSuspensionChanged);
      session.off("permission-request", onPermissionRequest);
      session.off("permission-cancelled", onPermissionCancelled);
      session.off("consensus-reached", onConsensusReached);
      session.off("consensus-invalidated", onConsensusInvalidated);
      session.off("synthesis-ready", onSynthesisReady);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      disposingRef.current = true;
      stream.dispose();
      streamRef.current = null;
    };
    // `write` and `stdout` are stable for the lifetime of the Ink instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, topic, headerAnimation, writePermanent]);

  useEffect(() => {
    if (coordinatorNotice) flash(coordinatorNotice);
  }, [coordinatorNotice, flash]);

  useEffect(() => {
    if (coordinatorState.kind === "idle") return;
    setCommandPaletteOpen(false);
    setModelPickerAgent(null);
  }, [coordinatorState.kind]);

  const busy = thinkingAgent !== null;

  // A single keypress, always caught — unlike /pause typed into the input
  // bar, which can't win a race against turns that chain faster than a human
  // can type six characters and hit enter.
  useInput((_input, key) => {
    if (key.escape && !commandPaletteOpen && modelPickerAgent === null) {
      if (session.lifecycle !== "open") return;
      session.pause();
      flash("Pause demandée (Échap) — le débat s'arrêtera après le tour en cours.");
    }
  });

  async function handleSubmit(raw: string) {
    setCommandPaletteOpen(false);
    const cmd = parseCommand(raw);
    if (
      (session.lifecycle !== "open" || coordinatorState.kind !== "idle") &&
      cmd.kind !== "new" &&
      cmd.kind !== "quit" &&
      cmd.kind !== "save" &&
      cmd.kind !== "retry" &&
      cmd.kind !== "emergency-exit" &&
      cmd.kind !== "help" &&
      cmd.kind !== "topic" &&
      cmd.kind !== "decisions"
    ) {
      flash("Session fermée ou opération de cycle de vie en cours : aucune nouvelle tâche n'est acceptée.");
      return;
    }
    switch (cmd.kind) {
      case "intervene":
        if (!cmd.text) return;
        if (!session.intervene(cmd.text, cmd.target)) {
          flash(
            session.lifecycle !== "open"
              ? "Session en cours de fermeture : aucun nouveau message n'est accepté."
              : "Pendant la validation du sujet, les précisions doivent être adressées aux deux agents.",
          );
        }
        return;
      case "model":
        if (!cmd.model) {
          setCommandPaletteOpen(false);
          setModelPickerAgent(cmd.agent);
          return;
        }
        session.setModel(cmd.agent, cmd.model);
        setContextUsage((current) => ({ ...current, [cmd.agent]: undefined }));
        return;
      case "implement": {
        const alreadyImplementing = phase === "implementation";
        if (!alreadyImplementing) session.beginImplementation();
        if (cmd.agent) {
          const base = implementationSummary
            ? `Implémente ce qui a été décidé :\n\n${implementationSummary}\n\nSi un détail précis te manque ou te semble ambigu, relis l'échange précédent dans cette conversation avant de coder — ne suppose rien.`
            : "Implémente ce qui vient d'être décidé dans le débat ci-dessus. Relis l'échange précédent si un détail te manque.";
          const instruction = cmd.extra ? `${base}\n\n${cmd.extra}` : base;
          awaitingImplementFor.current = cmd.agent;
          session.intervene(instruction, cmd.agent);
        }
        return;
      }
      case "handoff": {
        const summary = implementationSummary?.trim();
        if (!summary) {
          flash("Aucun consensus atteint — /handoff nécessite que les deux agents aient signalé <<CONSENSUS>>.");
          return;
        }
        try {
          const savedTo = await saveHandoff(cwd, topic, summary);
          session.recordHandoffGenerated(savedTo);
          flash(`Handoff généré : ${savedTo} — à transmettre à une session claude/codex native.`);
        } catch (err) {
          flash(`Échec de la génération du handoff : ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case "topic":
        streamRef.current?.raw(documentLines("Sujet complet", topic, contentWidthFor(columns), false));
        return;
      case "decisions": {
        try {
          const decisions = await readDecisions(cwd);
          if (!decisions) {
            flash("Aucune mémoire de décisions n'est disponible pour ce projet.");
            return;
          }
          streamRef.current?.raw(
            documentLines("Décisions actées", decisions, contentWidthFor(columns), true),
          );
        } catch (error) {
          flash(
            `Impossible de lire les décisions : ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      case "resume":
        {
          const result = session.resume();
          if (!result.ok) {
            const message =
              result.reason === "waiting-human"
                ? "Une réponse humaine est attendue : tape simplement ta précision."
                : result.reason === "cancelling"
                  ? "L'annulation est encore en cours ; attends sa stabilisation avant /resume."
                  : result.reason === "session-closed"
                    ? "La session n'est plus ouverte."
                    : "Le débat est déjà actif.";
            flash(message);
          }
        }
        return;
      case "pause":
        session.pause();
        flash("Le débat s'arrêtera après le tour en cours.");
        return;
      case "cancel":
        flash(
          session.cancel()
            ? "Annulation demandée ; le texte partiel sera conservé et /resume permettra de retenter."
            : "Aucun tour actif à annuler.",
        );
        return;
      case "accept-topic":
        flash(
          session.acceptTopic()
            ? "Sujet validé manuellement."
            : "Aucune réponse de qualification invalide ne peut être acceptée actuellement.",
        );
        return;
      case "autonomy":
        if (!cmd.budget || cmd.error) {
          flash(cmd.error ?? "Politique d'autonomie invalide.");
          return;
        }
        session.setAutonomyBudget(cmd.budget);
        await onAutonomySelected(cmd.budget, cmd.remember);
        flash(
          `Politique d'autonomie appliquée${cmd.remember ? " et mémorisée pour ce projet" : " pour cette session"}.`,
        );
        return;
      case "decide": {
        const usageError = decideUsageError(cmd);
        if (usageError) {
          flash(usageError);
          return;
        }
        await appendDecision(cwd, { topic: cmd.topic, chosenApproach: cmd.approach, agreements: [] });
        flash("Décision enregistrée dans .claudex/memory/decisions.md");
        return;
      }
      case "limit":
        if (!cmd.text) return;
        await appendLimit(cwd, cmd.text);
        flash("Limite enregistrée dans .claudex/memory/limits.md");
        return;
      case "save": {
        const response = await onLifecycleRequest({ kind: "save" });
        flash(response.message);
        return;
      }
      case "new": {
        const response = await onLifecycleRequest({ kind: "new", discard: cmd.discard });
        if (!response.ok) flash(response.message);
        return;
      }
      case "retry": {
        const response = await onLifecycleRequest({ kind: "retry" });
        flash(response.message);
        return;
      }
      case "emergency-exit":
        await onLifecycleRequest({ kind: "emergency-exit" });
        return;
      case "help":
        // Long, and it never changes: it belongs in the scrollback with
        // everything else, not in a panel Ink has to keep redrawing.
        streamRef.current?.raw(helpLines());
        return;
      case "quit":
        {
          const response = await onLifecycleRequest({ kind: "quit", discard: cmd.discard });
          if (!response.ok) flash(response.message);
        }
        return;
      default:
        return;
    }
  }

  const modal = pendingPermission ? "permission" : null;
  const modelPaletteVisible = modal === null && modelPickerAgent !== null;
  const paletteVisible = modal === null && (commandPaletteOpen || modelPaletteVisible);
  const banner = modal ? null : bannerFor(consensusReached, implementationSummary, phase, busy);
  const showNotice = !modal && notice !== null;
  // A notice temporarily takes the single accessory slot and the persistent
  // banner returns as soon as it expires. This keeps the standard footer within 7 rows.
  const visibleBanner = showNotice ? null : banner;

  const footerSurfaces: FooterSurfaces = {
    tail: !paletteVisible && tail !== null,
    banner: !paletteVisible && visibleBanner !== null,
    notice: !paletteVisible && showNotice,
    modal,
    selectionPalette: paletteVisible,
    inputRows,
  };
  const maxInputRows = inputBarMaxRows(footerSurfaces);
  const rows = footerRows(footerSurfaces);
  const preferredFooterHeight = pinnedOutput
    ? pinnedFooterHeight(terminalRows, permanentRows)
    : Math.min(MAX_STANDARD_DYNAMIC_ROWS, Math.max(1, terminalRows - 1));

  return (
    <>
      <Static items={staticBlocks}>
        {(block) => <Text key={block.id}>{block.text}</Text>}
      </Static>

      <DynamicFooter
        columns={columns}
        terminalRows={terminalRows}
        rows={rows}
        preferredHeight={preferredFooterHeight}
      >
        {!paletteVisible && tail && (
          <Box width={columns}>
            <Text wrap="truncate-end">
              {tail.rail ? <Text color={tail.color}>{"│ "}</Text> : null}
              <Text dimColor>{tail.text}</Text>
            </Text>
          </Box>
        )}

        <Box flexGrow={1} />

        {!paletteVisible && visibleBanner && (
          <Box width={columns}>
            <Text color={visibleBanner.color} wrap="truncate-end">
              {visibleBanner.text}
            </Text>
          </Box>
        )}

        {!paletteVisible && showNotice && (
          <Box width={columns}>
            <Text color="#f5c542" wrap="truncate-end">
              {notice}
            </Text>
          </Box>
        )}

        {pendingPermission ? (
          <PermissionModal
            request={pendingPermission}
            width={columns}
            onDecide={(allow) => {
              session.answerPermission(
                pendingPermission.id,
                allow ? { behavior: "allow" } : { behavior: "deny" },
              );
              setPendingPermission(null);
            }}
          />
        ) : (
          <>
            {modelPickerAgent && (
              <ModelPicker
                key={modelPickerAgent}
                agent={modelPickerAgent}
                width={inputBarWidth(columns)}
                onSelect={(model) => {
                  session.setModel(modelPickerAgent, model);
                  setContextUsage((current) => ({ ...current, [modelPickerAgent]: undefined }));
                  setModelPickerAgent(null);
                }}
                onCancel={() => setModelPickerAgent(null)}
              />
            )}
            {!paletteVisible && (
              <StatusBar
                phase={phase}
                thinkingAgent={thinkingAgent}
                activity={activity}
                paused={paused}
                suspensionReason={suspensionReason}
                lifecycleState={coordinatorState.kind}
                width={columns}
              />
            )}
            <InputBar
              disabled={false} // Input is now always active — interventions are queued
              inputActive={modelPickerAgent === null}
              width={columns}
              maxRows={maxInputRows}
              commands={DEBATE_COMMANDS}
              placeholder={
                busy
                  ? "message en attente (traité après le tour en cours)"
                  : "message (→ les deux), /claude, /codex, /model, /handoff, /implement, /save, /new, /help"
              }
              onCommandPaletteChange={setCommandPaletteOpen}
              onRowsChange={setInputRows}
              onSubmit={handleSubmit}
              onSubmitError={(error) =>
                flash(`Commande échouée : ${error instanceof Error ? error.message : String(error)}`)
              }
            />
          </>
        )}

        {!paletteVisible && (
          <ModelFooter
            models={{ claude: session.modelOf("claude"), codex: session.modelOf("codex") }}
            contextUsage={contextUsage}
          />
        )}
      </DynamicFooter>
    </>
  );
}

interface StaticBlock {
  id: number;
  text: string;
}

interface PinnedFrame {
  permanentRows: number;
  staticBlocks: StaticBlock[];
}

/** Number of physical terminal rows represented by a writer block. */
export function outputRows(data: string, columns: number): number {
  if (data === "") return 0;
  const body = data.endsWith("\n") ? data.slice(0, -1) : data;
  const safeColumns = Math.max(1, columns);

  return body
    .split("\n")
    .reduce(
      (rows, line) =>
        rows + Math.max(1, wrapAnsi(line, safeColumns, { hard: true, trim: false }).split("\n").length),
      0,
    );
}

const ZERO_WIDTH_SPACE = "\u200b";

/** Text handed to Ink Static, preserving even a block containing one blank row. */
export function staticBlockText(data: string): string {
  const withoutFinalNewline = data.endsWith("\n") ? data.slice(0, -1) : data;
  // Ink trims spaces from every rendered row and deliberately ignores a Static
  // output equal to "\n". U+200B survives that trim without occupying a column.
  return withoutFinalNewline === "" ? ZERO_WIDTH_SPACE : withoutFinalNewline;
}

function pinningThreshold(terminalRows: number): number {
  return Math.max(0, terminalRows - 1 - MAX_STANDARD_DYNAMIC_ROWS);
}

function bannerFor(
  consensusReached: boolean,
  summary: string | null,
  phase: Phase,
  busy: boolean,
): { text: string; color: string } | null {
  if (consensusReached && phase === "debate") {
    return summary
      ? {
          text: "[ok] Consensus — /handoff pour générer un prompt d'implémentation (recommandé), ou /implement pour rester dans Claudex",
          color: "greenBright",
        }
      : { text: "[ok] Consensus — synthèse de ce qui sera implémenté en cours…", color: "greenBright" };
  }
  if (phase === "implementation" && !busy) {
    return {
      text: "[edit] Implémentation : désigne qui code avec /claude <instruction> ou /codex <instruction> · /new pour repartir",
      color: BRAND_COLOR,
    };
  }
  return null;
}

/** The frozen header, written once. It scrolls away like any other content. */
export function bannerLines(
  columns: number,
  animation: HeaderAnimationId = DEFAULT_HEADER_ANIMATION,
): string[] {
  const art = headerFrame(columns, getHeaderAnimation(animation).staticT, animation).map((bands) =>
    bands.map((band) => chalk.hex(band.color)(band.chars)).join(""),
  );
  return [...art, ""];
}

function helpLines(): string[] {
  const key = (k: string) => chalk.hex("#f5c542")(k);
  const pad = "  ";
  return [
    "",
    chalk.bold("Commandes"),
    `${pad}${key("Échap")} — pause d'urgence, marche même pendant un tour`,
    `${pad}${key("Ctrl+C")} — demande un arrêt quiescent puis archive ; ne force jamais l'abandon`,
    `${pad}${key("texte libre")} — message envoyé aux deux agents`,
    `${pad}${key("/sujet")} — réaffiche le sujet complet du débat dans le scrollback`,
    `${pad}${key("/decisions")} — affiche les décisions actées de la mémoire du projet`,
    `${pad}${key("/claude")} ou ${key("/codex")} texte — message ciblé`,
    `${pad}${key("/model claude|codex nom")} — change le modèle en cours de session`,
    `${pad}${key("/handoff")} — après consensus, génère un fichier markdown autoportant (contexte projet +`,
    `${pad}  spécification) à transmettre à une session claude/codex native — chemin recommandé`,
    `${pad}${key("/implement")} — accorde l'accès en écriture, passe en phase d'implémentation (reste dans Claudex)`,
    `${pad}${key("/implement claude|codex [précision]")} — implémentation ET lance l'agent choisi sur ce qui vient`,
    `${pad}  d'être décidé (pas besoin de réécrire le plan)`,
    `${pad}${key("/autonomy starts N")} — borne le débat à N tours automatiques par fenêtre`,
    `${pad}${key("/autonomy time 5m")} — borne les nouveaux départs dans le temps (ms, s, m ou h)`,
    `${pad}${key("/autonomy unbounded")} — retire une borne posée ; c'est aussi le comportement par défaut`,
    `${pad}  le débat s'enchaîne seul tant qu'aucune borne n'est posée · ${key("--remember")} la mémorise ici`,
    `${pad}${key("/resume")} — retente un échec ou ouvre une nouvelle fenêtre avec la même politique`,
    `${pad}${key("/pause")} — arrête l'enchaînement automatique après le tour en cours`,
    `${pad}${key("/cancel")} — annule le tour actif, conserve le partiel et rend /resume possible`,
    `${pad}${key("/accept-topic")} — valide manuellement un sujet après une réponse sans marqueur`,
    `${pad}${key("/decide sujet | approche")} — enregistre une décision dans la mémoire du projet`,
    `${pad}${key("/limit texte")} — enregistre une contrainte/limite connue`,
    `${pad}${key("/save")} — capture un instantané partiel immuable, sans fermer la session`,
    `${pad}${key("/new")} — archive ce débat, réinitialise les deux agents, retour à l'accueil`,
    `${pad}${key("/retry")} — retente un arrêt ou archivage échoué`,
    `${pad}${key("/new --discard")} / ${key("/quit --discard")} — après échec d'archive seulement`,
    `${pad}${key("/emergency-exit")} — quitte explicitement sans garantie d'archive`,
    `${pad}${key("/help")} — réaffiche cette aide · ${key("/quit")} — arrête, archive et quitte`,
    "",
  ];
}

function documentLines(
  title: string,
  source: string,
  width: number,
  markdown: boolean,
): string[] {
  const clean = sanitizeForDisplay(
    markdown ? asciiSymbolsForDisplay(markdownToPlainText(source)) : source,
  );
  const body = clean.split("\n").flatMap((line) => wrapAll(line, Math.max(8, width - 2)));
  return ["", chalk.bold(title), "", ...body, ""];
}
