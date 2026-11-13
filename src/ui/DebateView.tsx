import { spawn } from "node:child_process";
import { Box, Text, useInput, useStdout } from "ink";
import chalk from "chalk";
import { useCallback, useEffect, useRef, useState } from "react";
import { appendDecision, appendLimit, readDecisions, saveHandoff } from "../memory/store.js";
import { decideUsageError, parseCommand, type Command } from "../orchestrator/commands.js";
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
  type FooterSurfaces,
} from "./components/DynamicFooter.js";
import { DEBATE_COMMANDS } from "./components/CommandPalette.js";
import { INPUT_BAR_MIN_ROWS, inputBarWidth, InputBar } from "./components/InputBar.js";
import { ModelFooter, isContextLow } from "./components/ModelFooter.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { PermissionModal } from "./components/PermissionModal.js";
import { StatusBar, statusBarWidth } from "./components/StatusBar.js";
import { PULSE_WIDTH, ThinkingPulse, pulseShown } from "./components/ThinkingPulse.js";
import { DEBATE_HEADER_ROWS, DebateHeader } from "./components/DebateHeader.js";
import {
  INITIAL_STATUS,
  reduceStatus,
  roundForStart,
  type DebateStatus,
  type StatusEvent,
} from "./debateStatus.js";
import { BRAND_COLOR, GLYPH, contentWidthFor, isTooSmall } from "./theme.js";
import { line, type TranscriptLine } from "./stream/streamController.js";
import { TranscriptStream, type TailView } from "./stream/transcriptStream.js";
import { asciiSymbolsForDisplay } from "./stream/asciiSymbols.js";
import { wrapAll } from "./stream/lineBuffer.js";
import { sanitizeForDisplay } from "./stream/sanitize.js";
import { markdownToPlainText } from "./markdown.js";
import { setMouseReporting } from "./terminal.js";
import { FittedScreen } from "./screenVisibility.js";
import { useTerminalSize } from "./useTerminalSize.js";
import { useMouse } from "./mouse/MouseContext.js";
import { copyNotice, copyToClipboard } from "./mouse/clipboard.js";
import type { MouseEvent } from "./mouse/mouseInput.js";
import {
  WHEEL_LINES,
  dragSelection,
  highlightColumns,
  screenToCell,
  selectedColumns,
  selectedText,
  type Drag,
  type Selection,
} from "./mouse/selection.js";
import type { ProjectStatus } from "../util/projectStatus.js";

const INITIAL_TRANSCRIPT_LINES: readonly TranscriptLine[] = [line("")];

/**
 * The debate screen.
 *
 * The debate owns one full-screen viewport: a fixed animated header, a bounded
 * scrollable transcript, and a fixed input footer. Nothing is written behind
 * that frame while the session is open, so a long answer cannot collide with
 * the footer and scrolling the transcript never moves the header.
 */
export function DebateView(props: {
  session: DebateSession;
  topic: string;
  cwd: string;
  status: ProjectStatus;
  coordinatorState: CoordinatorState;
  coordinatorNotice: string | null;
  onLifecycleRequest: (request: LifecycleRequest) => Promise<CoordinatorResponse>;
  onAutonomySelected: (budget: AutonomyBudget, remember: boolean) => Promise<void>;
  /** Observes the text of a finished mouse selection, which is copied to the clipboard regardless. */
  onCopy?: (text: string) => void;
}) {
  const {
    session,
    topic,
    cwd,
    status,
    coordinatorState,
    coordinatorNotice,
    onLifecycleRequest,
    onAutonomySelected,
    onCopy,
  } = props;
  const { stdout, write } = useStdout();

  const [transcriptLines, setTranscriptLines] = useState<readonly TranscriptLine[]>(INITIAL_TRANSCRIPT_LINES);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [selection, setSelection] = useState<Drag | null>(null);
  const [tail, setTail] = useState<TailView | null>(null);
  const [debateStatus, setDebateStatus] = useState<DebateStatus>(INITIAL_STATUS);
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

  // The round of a turn is read when its header is written, which can be before
  // React re-renders, so the latest status also lives in a ref.
  const debateStatusRef = useRef<DebateStatus>(INITIAL_STATUS);
  const streamRef = useRef<TranscriptStream | null>(null);
  const transcriptLinesRef = useRef<readonly TranscriptLine[]>(INITIAL_TRANSCRIPT_LINES);
  const transcriptRowsRef = useRef(1);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set right before sending an /implement instruction to a specific agent,
  // so we can flag clearly when THAT turn (not just any turn) finishes —
  // otherwise a long implementation turn ends with no visible "done" signal
  // distinct from the ambient phase banner.
  const awaitingImplementFor = useRef<AgentId | null>(null);
  // Mouse events can arrive faster than React renders: a press and its release
  // in one stdin chunk must see each other, so the selection also lives in a ref.
  const selectionRef = useRef<Drag | null>(null);
  const draggingRef = useRef(false);

  const updateSelection = useCallback((next: Drag | null) => {
    selectionRef.current = next;
    if (next === null) draggingRef.current = false;
    setSelection(next);
  }, []);

  // A resize moves every cell, so a selection would no longer cover its text.
  const { columns, rows: terminalRows } = useTerminalSize(() => updateSelection(null));
  // The view provides the visibility context to its children, so it reads its own here.
  const visible = !isTooSmall(columns, terminalRows);

  const flash = useCallback((text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(asciiSymbolsForDisplay(text));
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const copySelection = useCallback(
    (text: string) => {
      onCopy?.(text);
      // Ink's write keeps its frame bookkeeping intact when OSC 52 is emitted.
      copyToClipboard(text, {
        platform: process.platform,
        env: process.env,
        spawn,
        writeTerminal: write,
      }).then(
        (result) => flash(copyNotice(result, [...text].length)),
        (error: unknown) => flash(copyNotice({ kind: "failed", message: String(error) }, 0)),
      );
    },
    [flash, onCopy, write],
  );

  const appendTranscript = useCallback(
    (incoming: readonly TranscriptLine[]) => {
      if (incoming.length === 0) return;

      const next = [...transcriptLinesRef.current, ...incoming];
      transcriptLinesRef.current = next;
      setTranscriptLines(next);
      setScrollOffset((current) => (current === 0 ? 0 : current + incoming.length));
    },
    [],
  );

  // A working note removed from the running message: drop the lines after
  // `toLength` so the renderer can write the body again.
  const rewindTranscript = useCallback((toLength: number) => {
    const current = transcriptLinesRef.current;
    const removed = current.length - toLength;
    if (removed <= 0) return;

    const next = current.slice(0, toLength);
    transcriptLinesRef.current = next;
    setTranscriptLines(next);
    // The lines a selection pointed at are gone or about to be rewritten.
    updateSelection(null);
    // Mirror of `appendTranscript`: a reader scrolled up keeps the same lines in view.
    setScrollOffset((offset) => (offset === 0 ? 0 : Math.max(0, offset - removed)));
  }, [updateSelection]);

  const applyStatus = useCallback((event: StatusEvent) => {
    const next = reduceStatus(debateStatusRef.current, event);
    debateStatusRef.current = next;
    setDebateStatus(next);
  }, []);

  // Only the debate screen uses the mouse: the welcome screen keeps the
  // terminal's own selection, and leaving the debate (/new, quit) gives it back.
  useEffect(() => {
    setMouseReporting(stdout, true);
    return () => setMouseReporting(stdout, false);
  }, [stdout]);


  useEffect(() => {
    // The width getter is read per line, so a resize applies to new output
    // immediately without ever reflowing what has already been written.
    const stream = new TranscriptStream({
      write: appendTranscript,
      width: () => contentWidthFor(stdout?.columns ?? 80),
      onTail: setTail,
      length: () => transcriptLinesRef.current.length,
      rewind: rewindTranscript,
      round: (entry) =>
        (entry.from === "claude" || entry.from === "codex") && entry.kind === "message"
          ? roundForStart(debateStatusRef.current, entry.from)
          : null,
    });
    streamRef.current = stream;

    // `entry-completed` only carries an id; remember who authored each running entry.
    const authors = new Map<string, TranscriptEntry["from"]>();
    const onEntry = (entry: TranscriptEntry) => {
      applyStatus({ kind: "entry", entry });
      if (!isTopicEntry(entry)) stream.entry(entry);
    };
    const onEntryStarted = (entry: TranscriptEntry) => {
      authors.set(entry.id, entry.from);
      stream.entryStarted(entry);
    };
    const onChunk = (id: string, delta: string) => stream.chunk(id, delta);
    const onOutputReset = (id: string, text: string) => stream.reset(id, text);
    const onEntryCompleted = (id: string, outcome: EntryOutcome) => {
      const agent = authors.get(id);
      authors.delete(id);
      if (agent) applyStatus({ kind: "completed", agent, outcome });
      stream.entryCompleted(id, outcome);
    };
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
        flash(`[ok] ${label} finished this turn — check the modified files (git status / git diff).`);
      }
    };
    const onTurnError = () => {
      setThinkingAgent(null);
      setActivity(null);
    };
    const onActivity = (_agent: AgentId, nextActivity: AgentActivity) => setActivity(nextActivity);
    const onContextUsage = (agent: AgentId, usage: AgentContextUsage) =>
      setContextUsage((current) => ({ ...current, [agent]: usage }));
    const onPhase = (p: Phase) => {
      applyStatus({ kind: "phase", phase: p });
      setPhase(p);
    };
    const onPausedChanged = (p: boolean) => setPaused(p);
    const onSuspensionChanged = (reason: SuspensionReason | null) => setSuspensionReason(reason);
    const onPermissionRequest = (req: PermissionRequest) => {
      setCommandPaletteOpen(false);
      setPendingPermission(req);
    };
    const onPermissionCancelled = (reqId: string) =>
      setPendingPermission((current) => (current?.id === reqId ? null : current));
    const onConsensusReached = () => {
      applyStatus({ kind: "consensus-reached" });
      setConsensusReached(true);
      setImplementationSummary(null);
    };
    const onConsensusInvalidated = () => {
      applyStatus({ kind: "consensus-invalidated" });
      setConsensusReached(false);
      setImplementationSummary(null);
    };
    const onSynthesisReady = (summary: string) => setImplementationSummary(summary);

    session.on("entry", onEntry);
    session.on("entry-started", onEntryStarted);
    session.on("output-chunk", onChunk);
    session.on("output-reset", onOutputReset);
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
      flash(`Cannot start the session: ${error instanceof Error ? error.message : String(error)}`);
    });

    return () => {
      session.off("entry", onEntry);
      session.off("entry-started", onEntryStarted);
      session.off("output-chunk", onChunk);
      session.off("output-reset", onOutputReset);
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
      stream.dispose();
      streamRef.current = null;
    };
    // `write` and `stdout` are stable for the lifetime of the Ink instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, topic, appendTranscript, applyStatus]);

  useEffect(() => {
    if (coordinatorNotice) flash(coordinatorNotice);
  }, [coordinatorNotice, flash]);

  useEffect(() => {
    if (coordinatorState.kind === "idle") return;
    setCommandPaletteOpen(false);
    setModelPickerAgent(null);
  }, [coordinatorState.kind]);

  const busy = thinkingAgent !== null;

  const mouseActive =
    visible && !commandPaletteOpen && modelPickerAgent === null && pendingPermission === null;

  useInput((_input, key) => {
    // Clearing never consumes the key: the input bar still receives it.
    if (selectionRef.current) updateSelection(null);

    if (!commandPaletteOpen && modelPickerAgent === null && pendingPermission === null) {
      const page = Math.max(1, transcriptRowsRef.current - 1);
      const maximum = Math.max(0, transcriptLinesRef.current.length - transcriptRowsRef.current);

      if (key.upArrow || key.pageUp || key.home) {
        setScrollOffset((current) =>
          Math.min(maximum, key.home ? maximum : current + (key.pageUp ? page : 1)),
        );
        return;
      }
      if (key.downArrow || key.pageDown || key.end) {
        setScrollOffset((current) =>
          key.end ? 0 : Math.max(0, current - (key.pageDown ? page : 1)),
        );
        return;
      }
    }

    // A single keypress, always caught — unlike /pause typed into the input
    // bar, which can't win a race against turns that chain faster than a human
    // can type six characters and hit enter.
    if (key.escape && !commandPaletteOpen && modelPickerAgent === null) {
      if (session.lifecycle !== "open") return;
      session.pause();
      flash("Pause requested (Esc) — the debate will stop after the current turn.");
    }
  }, { isActive: visible });

  async function handleSubmit(raw: string, options?: { literal: true }) {
    setCommandPaletteOpen(false);
    const cmd: Command = options?.literal
      ? { kind: "intervene", target: "both", text: raw.trim() }
      : parseCommand(raw);
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
      flash("Session closed or lifecycle operation in progress: no new task is accepted.");
      return;
    }
    switch (cmd.kind) {
      case "intervene":
        if (!cmd.text) return;
        if (!session.intervene(cmd.text, cmd.target)) {
          flash(
            session.lifecycle !== "open"
              ? "Session is closing: no new message is accepted."
              : "While the topic is being accepted, clarifications must be addressed to both agents.",
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
            ? `Implement what was decided:\n\n${implementationSummary}\n\nIf a specific detail is missing or seems ambiguous, reread the previous exchange in this conversation before coding — do not assume anything.`
            : "Implement what was just decided in the debate above. Reread the previous exchange if a detail is missing.";
          const instruction = cmd.extra ? `${base}\n\n${cmd.extra}` : base;
          awaitingImplementFor.current = cmd.agent;
          session.intervene(instruction, cmd.agent);
        }
        return;
      }
      case "handoff": {
        const summary = implementationSummary?.trim();
        if (!summary) {
          flash("No consensus reached — /handoff requires both agents to have signalled <<CONSENSUS>>.");
          return;
        }
        try {
          const savedTo = await saveHandoff(cwd, topic, summary);
          session.recordHandoffGenerated(savedTo);
          flash(`Handoff generated: ${savedTo} — to pass to a native claude/codex session.`);
        } catch (err) {
          flash(`Handoff generation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case "topic":
        streamRef.current?.raw(documentLines("Full topic", topic, contentWidthFor(columns), false));
        return;
      case "decisions": {
        try {
          const decisions = await readDecisions(cwd);
          if (!decisions) {
            flash("No decision memory is available for this project.");
            return;
          }
          streamRef.current?.raw(
            documentLines("Settled decisions", decisions, contentWidthFor(columns), true),
          );
        } catch (error) {
          flash(
            `Cannot read the decisions: ${error instanceof Error ? error.message : String(error)}`,
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
                ? "A human answer is awaited: just type your clarification."
                : result.reason === "cancelling"
                  ? "The cancellation is still in progress; wait for it to settle before /resume."
                  : result.reason === "session-closed"
                    ? "The session is no longer open."
                    : "The debate is already active.";
            flash(message);
          }
        }
        return;
      case "pause":
        session.pause();
        flash("The debate will stop after the current turn.");
        return;
      case "cancel":
        flash(
          session.cancel()
            ? "Cancellation requested; the partial text will be kept and /resume will allow retrying."
            : "No active turn to cancel.",
        );
        return;
      case "accept-topic":
        flash(
          session.acceptTopic()
            ? "Topic accepted manually."
            : "No invalid qualification answer can currently be accepted.",
        );
        return;
      case "autonomy":
        if (!cmd.budget || cmd.error) {
          flash(cmd.error ?? "Invalid autonomy policy.");
          return;
        }
        session.setAutonomyBudget(cmd.budget);
        await onAutonomySelected(cmd.budget, cmd.remember);
        flash(
          `Autonomy policy applied${cmd.remember ? " and remembered for this project" : " for this session"}.`,
        );
        return;
      case "decide": {
        const usageError = decideUsageError(cmd);
        if (usageError) {
          flash(usageError);
          return;
        }
        await appendDecision(cwd, { topic: cmd.topic, chosenApproach: cmd.approach, agreements: [] });
        flash("Decision saved to .claudex/memory/decisions.md");
        return;
      }
      case "limit":
        if (!cmd.text) return;
        await appendLimit(cwd, cmd.text);
        flash("Limit saved to .claudex/memory/limits.md");
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
  const showTail = !paletteVisible && scrollOffset === 0 && tail !== null;

  const footerSurfaces: FooterSurfaces = {
    tail: showTail,
    banner: !paletteVisible && visibleBanner !== null,
    notice: !paletteVisible && showNotice,
    modal,
    selectionPalette: paletteVisible,
    inputRows,
  };
  const maxInputRows = inputBarMaxRows(footerSurfaces);
  const rows = footerRows(footerSurfaces);
  const preferredFooterHeight = Math.max(1, terminalRows - 1);
  const transcriptRows = Math.max(0, preferredFooterHeight - DEBATE_HEADER_ROWS - 1 - rows);
  transcriptRowsRef.current = transcriptRows;
  const maximumScrollOffset = Math.max(0, transcriptLines.length - transcriptRows);
  const visibleScrollOffset = Math.min(scrollOffset, maximumScrollOffset);

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, maximumScrollOffset));
  }, [maximumScrollOffset]);

  useMouse((event: MouseEvent) => {
    if (event.kind === "wheel") {
      setScrollOffset((current) =>
        event.direction === "up"
          ? Math.min(maximumScrollOffset, current + WHEEL_LINES)
          : Math.max(0, current - WHEEL_LINES),
      );
      return;
    }

    const viewport = { top: DEBATE_HEADER_ROWS, height: transcriptRows, firstLine: firstVisibleLine(transcriptLines.length, transcriptRows, visibleScrollOffset) };
    if (event.kind === "press") {
      const cell = screenToCell(event.y, event.x, viewport);
      updateSelection(cell ? { anchor: cell, focus: cell, moved: false } : null);
      draggingRef.current = cell !== null;
      return;
    }

    const current = selectionRef.current;
    if (!draggingRef.current || !current || transcriptRows <= 0) return;

    // Holding the pointer on the first or last row scrolls one line per event,
    // so a selection can reach text outside the viewport.
    let offset = visibleScrollOffset;
    if (event.kind === "drag") {
      if (event.y <= viewport.top) offset = Math.min(maximumScrollOffset, offset + 1);
      else if (event.y >= viewport.top + transcriptRows - 1) offset = Math.max(0, offset - 1);
      if (offset !== visibleScrollOffset) setScrollOffset(offset);
    }
    const y = Math.min(Math.max(event.y, viewport.top), viewport.top + transcriptRows - 1);
    const focus = screenToCell(y, event.x, {
      ...viewport,
      firstLine: firstVisibleLine(transcriptLines.length, transcriptRows, offset),
    });
    const next = focus
      ? {
          anchor: current.anchor,
          focus,
          moved: current.moved || focus.line !== current.anchor.line || focus.col !== current.anchor.col,
        }
      : current;
    updateSelection(next);

    if (event.kind === "release") {
      draggingRef.current = false;
      const covered = dragSelection(transcriptLinesRef.current, next);
      const text = covered ? selectedText(transcriptLinesRef.current, covered) : "";
      if (text !== "") copySelection(text);
    }
  }, mouseActive);

  return (
    <FittedScreen columns={columns} rows={terminalRows}>
      <DynamicFooter
          columns={columns}
          terminalRows={terminalRows}
          rows={rows}
          preferredHeight={preferredFooterHeight}
        >
          <DebateHeader columns={columns} topic={topic} status={debateStatus} memory={status} />

          <TranscriptViewport
            lines={transcriptLines}
            height={transcriptRows}
            columns={columns}
            scrollOffset={visibleScrollOffset}
            selection={selection ? dragSelection(transcriptLines, selection) : null}
          />

          {showTail && tail && (
            <Box width={columns}>
              <Text wrap="truncate-end">
                {tail.rail ? <Text color={tail.color}>{`${GLYPH.rail} `}</Text> : null}
                <Text dimColor>{tail.text}</Text>
              </Text>
            </Box>
          )}

          <Box flexGrow={1} />

          {/* Never squeezed: the transcript viewport is sized to leave exactly this room. */}
          <Box flexDirection="column" flexShrink={0}>
            {/* The one row of the frame budget that the header animation used to pay for. */}
            <Text dimColor>{GLYPH.rule.repeat(Math.min(columns, contentWidthFor(columns)))}</Text>

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
                  <Box width={statusBarWidth(columns)}>
                    <StatusBar
                      phase={phase}
                      thinkingAgent={thinkingAgent}
                      activity={activity}
                      paused={paused}
                      suspensionReason={suspensionReason}
                      lifecycleState={coordinatorState.kind}
                      width={columns}
                      trailing={pulseShown(thinkingAgent, columns) ? PULSE_WIDTH + 1 : 0}
                    />
                    {pulseShown(thinkingAgent, columns) && (
                      <Box marginLeft={1}>
                        <ThinkingPulse agent={thinkingAgent} columns={columns} />
                      </Box>
                    )}
                  </Box>
                )}
                <InputBar
                  disabled={false} // Input is now always active — interventions are queued
                  inputActive={modelPickerAgent === null}
                  width={columns}
                  maxRows={maxInputRows}
                  commands={DEBATE_COMMANDS}
                  placeholder={
                    busy
                      ? "message queued (handled after the current turn)"
                      : "message (→ both), /claude, /codex, /model, /handoff, /implement, /save, /new, /help"
                  }
                  onCommandPaletteChange={setCommandPaletteOpen}
                  onRowsChange={setInputRows}
                  onSubmit={handleSubmit}
                  onSubmitError={(error) =>
                    flash(`Command failed: ${error instanceof Error ? error.message : String(error)}`)
                  }
                />
              </>
            )}

            {!paletteVisible && (
              <ModelFooter
                models={{ claude: session.modelOf("claude"), codex: session.modelOf("codex") }}
                contextUsage={contextUsage}
                showModels={isContextLow(contextUsage?.claude) || isContextLow(contextUsage?.codex)}
              />
            )}
          </Box>
      </DynamicFooter>
    </FittedScreen>
  );
}

export function transcriptBlockLines(data: string): string[] {
  if (data === "") return [];
  const withoutFinalNewline = data.endsWith("\n") ? data.slice(0, -1) : data;
  return withoutFinalNewline.split("\n");
}

/**
 * Absolute index of the transcript line drawn on the viewport's first row. The
 * renderer and the mouse both use it, so a click always maps to the line drawn.
 */
export function firstVisibleLine(length: number, height: number, scrollOffset: number): number {
  return Math.max(0, length - Math.max(0, height) - Math.max(0, scrollOffset));
}

export function transcriptWindow<T>(
  lines: readonly T[],
  height: number,
  scrollOffset: number,
): readonly T[] {
  const start = firstVisibleLine(lines.length, height, scrollOffset);
  return lines.slice(start, start + Math.max(0, height));
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
          text: "[ok] Consensus — /handoff to generate an implementation prompt (recommended), or /implement to stay in Claudex",
          color: "greenBright",
        }
      : { text: "[ok] Consensus — summarizing what will be implemented…", color: "greenBright" };
  }
  if (phase === "implementation" && !busy) {
    return {
      text: "[edit] Implementation: pick who codes with /claude <instruction> or /codex <instruction> · /new to start over",
      color: BRAND_COLOR,
    };
  }
  return null;
}

function isTopicEntry(entry: TranscriptEntry): boolean {
  return entry.from === "system" && entry.kind === "system" && entry.text.startsWith("Topic:");
}

function TranscriptViewport(props: {
  lines: readonly TranscriptLine[];
  height: number;
  columns: number;
  scrollOffset: number;
  selection: Selection | null;
}) {
  const { lines, height, columns, scrollOffset, selection } = props;
  if (height <= 0) return null;

  const firstLine = firstVisibleLine(lines.length, height, scrollOffset);
  const visible = transcriptWindow(lines, height, scrollOffset);
  return (
    <Box flexDirection="column" width={columns} height={height} overflow="hidden">
      {Array.from({ length: height }, (_, index) => {
        const source = visible[index]?.styled ?? "";
        const columnsSelected =
          selection && index < visible.length ? selectedColumns(selection, firstLine + index, columns) : null;
        // Selected cells are drawn inverted over plain text: the line's own colours
        // would fight the inverse and hide which cells will be copied.
        const styled = columnsSelected ? highlightColumns(source, columnsSelected) : source;
        return (
          <Text key={index} wrap="truncate-end">
            {styled === "" ? " " : styled}
          </Text>
        );
      })}
    </Box>
  );
}

function helpLines(): string[] {
  const key = (k: string) => chalk.hex("#f5c542")(k);
  const pad = "  ";
  return [
    "",
    chalk.bold("Commands"),
    `${pad}${key("↑/↓")} — scroll the transcript · ${key("PgUp/PgDn")} — one page · ${key("Home/End")} — start/end`,
    `${pad}${key("mouse wheel")} — scrolls the transcript · ${key("drag")} — selects text and copies it on release`,
    `${pad}hold ${key("Fn")} or ${key("Option")} on macOS (depending on the terminal), ${key("Shift")} in most Linux`,
    `${pad}  terminals — native terminal selection`,
    `${pad}${key("Esc")} — emergency pause, works even during a turn`,
    `${pad}${key("Ctrl+C")} — requests a quiescent shutdown then archives; never forces abandonment`,
    `${pad}${key("free text")} — message sent to both agents`,
    `${pad}${key("/topic")} — shows the full topic again in the transcript`,
    `${pad}${key("/decisions")} — shows the settled decisions from the project memory`,
    `${pad}${key("/claude")} or ${key("/codex")} text — targeted message`,
    `${pad}${key("/model claude|codex name")} — changes the model during the session`,
    `${pad}${key("/handoff")} — after consensus, generates a self-contained markdown file (project context +`,
    `${pad}  specification) to pass to a native claude/codex session — recommended path`,
    `${pad}${key("/implement")} — grants write access, moves to the implementation phase (stays in Claudex)`,
    `${pad}${key("/implement claude|codex [details]")} — implementation AND launches the chosen agent on what was`,
    `${pad}  just decided (no need to rewrite the plan)`,
    `${pad}${key("/autonomy starts N")} — limits the debate to N automatic turns per window`,
    `${pad}${key("/autonomy time 5m")} — limits new starts over time (ms, s, m or h)`,
    `${pad}${key("/autonomy unbounded")} — removes a set limit; this is also the default behavior`,
    `${pad}  the debate chains on its own while no limit is set · ${key("--remember")} remembers it here`,
    `${pad}${key("/resume")} — retries a failure or opens a new window with the same policy`,
    `${pad}${key("/pause")} — stops the automatic chaining after the current turn`,
    `${pad}${key("/cancel")} — cancels the active turn, keeps the partial text and makes /resume possible`,
    `${pad}${key("/accept-topic")} — manually accepts a topic after an answer without a marker`,
    `${pad}${key("/decide subject | approach")} — saves a decision in the project memory`,
    `${pad}${key("/limit text")} — saves a known constraint/limit`,
    `${pad}${key("/save")} — captures an immutable partial snapshot, without closing the session`,
    `${pad}${key("/new")} — archives this debate, resets both agents, back to the welcome screen`,
    `${pad}${key("/retry")} — retries a failed shutdown or archive`,
    `${pad}${key("/new --discard")} / ${key("/quit --discard")} — only after an archive failure`,
    `${pad}${key("/emergency-exit")} — quits explicitly without an archive guarantee`,
    `${pad}${key("/help")} — shows this help again · ${key("/quit")} — stops, archives and quits`,
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
