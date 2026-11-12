import { useApp, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClaudeAgent } from "../agents/claudeAgent.js";
import { CodexAgent } from "../agents/codexAgent.js";
import { resolveDebateSandbox } from "../agents/debateSandbox.js";
import { type SettingsFinding, createSettingsGuard } from "../agents/projectSettings.js";
import type { CodingAgent } from "../agents/types.js";
import {
  appendDevlog,
  rememberAutonomyBudget,
  saveTranscript,
  sessionTitle,
} from "../memory/store.js";
import { DebateSession } from "../orchestrator/session.js";
import type { AgentId, AutonomyBudget, TranscriptEntry } from "../types.js";
import { getProjectStatus } from "../util/projectStatus.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import { DebateView } from "./DebateView.js";
import { DEFAULT_HEADER_ANIMATION, type HeaderAnimationId } from "./headerArt.js";

export type TerminalDestination = "new" | "quit";

export type CoordinatorState =
  | { kind: "idle" }
  | { kind: "closing"; destination: TerminalDestination }
  | { kind: "shutdown-failed"; destination: TerminalDestination; message: string }
  | { kind: "archive-failed"; destination: TerminalDestination; message: string };

export type LifecycleRequest =
  | { kind: "save" }
  | { kind: "new" | "quit"; discard: boolean }
  | { kind: "retry" }
  | { kind: "emergency-exit" };

export interface CoordinatorResponse {
  ok: boolean;
  message: string;
}

interface PendingTerminal {
  session: DebateSession;
  topic: string;
  destination: TerminalDestination;
  archive: boolean;
  stage: "shutdown" | "archive";
  snapshot?: readonly TranscriptEntry[];
}

export function Root(props: {
  cwd: string;
  initialTopic?: string;
  approvedSettings?: readonly SettingsFinding[];
}) {
  const { cwd, initialTopic, approvedSettings = [] } = props;
  const { exit } = useApp();

  const [status, setStatus] = useState(() => getProjectStatus(cwd));
  const [agents] = useState<Record<AgentId, CodingAgent>>(() => ({
    claude: new ClaudeAgent(
      status.claudeConfiguredModel ?? undefined,
      status.claudeDefaultModel ?? undefined,
      createSettingsGuard(approvedSettings),
      (claudeCwd) => resolveDebateSandbox(claudeCwd),
    ),
    codex: new CodexAgent(undefined, codexInitialModelLabel(status)),
  }));
  const [rememberedAutonomy, setRememberedAutonomy] = useState<AutonomyBudget | undefined>(
    status.autonomyBudget ?? undefined,
  );
  const [session, setSession] = useState<DebateSession | null>(null);
  const sessionRef = useRef<DebateSession | null>(null);
  const [topic, setTopic] = useState("");
  const [headerAnimation, setHeaderAnimation] = useState<HeaderAnimationId>(DEFAULT_HEADER_ANIMATION);
  const [coordinatorState, setCoordinatorState] = useState<CoordinatorState>({ kind: "idle" });
  const [coordinatorNotice, setCoordinatorNotice] = useState<string | null>(null);
  const pendingTerminalRef = useRef<PendingTerminal | null>(null);
  const terminalOperationRef = useRef<Promise<CoordinatorResponse> | null>(null);
  const saveOperationRef = useRef<Promise<CoordinatorResponse> | null>(null);

  const finishTerminal = useCallback(
    (pending: PendingTerminal) => {
      pendingTerminalRef.current = null;
      setCoordinatorState({ kind: "idle" });
      sessionRef.current = null;
      agents.claude.resetSession();
      agents.codex.resetSession();
      if (pending.destination === "quit") exit();
      else {
        // The session that just ended may have written to the project memory
        // (/decide, /handoff). Without this reread, the welcome screen and its
        // /decisions show the disk state as of Claudex's launch.
        setStatus(getProjectStatus(cwd));
        setSession(null);
      }
    },
    [agents, cwd, exit],
  );

  const executeTerminal = useCallback(
    (pending: PendingTerminal): Promise<CoordinatorResponse> => {
      if (terminalOperationRef.current) return terminalOperationRef.current;

      const operation = (async (): Promise<CoordinatorResponse> => {
        setCoordinatorState({ kind: "closing", destination: pending.destination });

        if (pending.stage === "shutdown") {
          const shutdown = await pending.session.shutdown();
          if (!shutdown.ok) {
            const detail = Object.entries(shutdown.errors)
              .map(([component, message]) => `${component}: ${message}`)
              .join(" · ");
            pending.stage = "shutdown";
            const message = `Incomplete shutdown (${detail}). /retry retries the shutdown without losing the session.`;
            setCoordinatorState({ kind: "shutdown-failed", destination: pending.destination, message });
            return { ok: false, message };
          }
          pending.snapshot = shutdown.transcript;
          pending.stage = "archive";
        }

        if (pending.archive) {
          try {
            await saveTranscript(cwd, pending.topic, pending.snapshot ?? [], { completeness: "stable" });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const message =
              `Shutdown complete, but archiving failed (${detail}). ` +
              "/retry retries the archive; /new --discard or /quit --discard explicitly abandons it.";
            setCoordinatorState({ kind: "archive-failed", destination: pending.destination, message });
            return { ok: false, message };
          }
        }

        finishTerminal(pending);
        return {
          ok: true,
          message: pending.archive ? "Session stopped and archived." : "Entry without a topic closed.",
        };
      })().finally(() => {
        terminalOperationRef.current = null;
      });

      terminalOperationRef.current = operation;
      return operation;
    },
    [cwd, finishTerminal],
  );

  const requestTerminal = useCallback(
    (destination: TerminalDestination, discard: boolean): Promise<CoordinatorResponse> => {
      const saveInFlight = saveOperationRef.current;
      if (saveInFlight) {
        setCoordinatorState({ kind: "closing", destination });
        return saveInFlight.then(() => requestTerminal(destination, discard));
      }

      const existing = pendingTerminalRef.current;
      if (existing) {
        if (destination === "quit") existing.destination = "quit";

        if (terminalOperationRef.current) return terminalOperationRef.current;

        if (discard) {
          if (existing.stage !== "archive") {
            return Promise.resolve({
              ok: false,
              message: "--discard is only allowed after an archive failure.",
            });
          }
          finishTerminal(existing);
          return Promise.resolve({
            ok: true,
            message: "Archive explicitly abandoned; the closed session has been reset.",
          });
        }

        return Promise.resolve({
          ok: false,
          message:
            existing.stage === "archive"
              ? "Archiving failed: use /retry or an explicit --discard command."
              : "Shutdown failed: use /retry.",
        });
      }

      if (discard) {
        return Promise.resolve({
          ok: false,
          message: "--discard is only allowed after an archive failure.",
        });
      }

      const current = sessionRef.current;
      if (!current) {
        if (destination === "quit") exit();
        return Promise.resolve({ ok: true, message: "No active session." });
      }

      const pending: PendingTerminal = {
        session: current,
        topic,
        destination,
        archive: true,
        stage: "shutdown",
      };
      pendingTerminalRef.current = pending;
      return executeTerminal(pending);
    },
    [executeTerminal, exit, finishTerminal, topic],
  );

  const handleLifecycleRequest = useCallback(
    async (request: LifecycleRequest): Promise<CoordinatorResponse> => {
      if (request.kind === "emergency-exit") {
        exit();
        return {
          ok: true,
          message: "Emergency exit requested: the last session may not have been archived.",
        };
      }

      if (request.kind === "retry") {
        const pending = pendingTerminalRef.current;
        if (!pending) return { ok: false, message: "No operation to retry." };
        return executeTerminal(pending);
      }

      if (request.kind === "save") {
        if (saveOperationRef.current) return saveOperationRef.current;
        const current = sessionRef.current;
        if (!current) return { ok: false, message: "No session to save." };
        if (current.lifecycle !== "open" || coordinatorState.kind !== "idle") {
          return {
            ok: false,
            message: "Snapshot refused during a shutdown; wait for a stable state or use /retry.",
          };
        }
        if (current.topicStatus !== "accepted") {
          return {
            ok: false,
            message: "Snapshot refused until the topic has been accepted.",
          };
        }
        if (current.isCancellationSettling()) {
          return {
            ok: false,
            message: "Snapshot refused while the cancellation settles.",
          };
        }

        const snapshot = current.snapshot();
        const saveOperation = saveTranscript(cwd, topic, snapshot, { completeness: "partial" })
          .then<CoordinatorResponse, CoordinatorResponse>(
            (savedTo) => ({ ok: true, message: `Partial snapshot saved to ${savedTo}` }),
            (error: unknown) => ({
              ok: false,
              message: `Snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
          )
          .finally(() => {
            if (saveOperationRef.current === saveOperation) saveOperationRef.current = null;
          });
        saveOperationRef.current = saveOperation;
        return saveOperation;
      }

      return requestTerminal(request.kind, request.discard);
    },
    [coordinatorState.kind, cwd, executeTerminal, exit, requestTerminal, topic],
  );

  const startTopic = useCallback(
    (newTopic: string) => {
      const trimmed = newTopic.trim();
      if (!trimmed || sessionRef.current || pendingTerminalRef.current) return;
      agents.claude.resetSession();
      agents.codex.resetSession();
      const nextSession = new DebateSession(agents, {
        cwd,
        starter: "claude",
        autonomyBudget: rememberedAutonomy,
      });
      let devlogWritten = false;
      nextSession.on("topic-accepted", () => {
        if (devlogWritten) return;
        devlogWritten = true;
        appendDevlog(cwd, `Session started — topic: ${sessionTitle(trimmed)}`).then(undefined, (error: unknown) => {
          setCoordinatorNotice(
            `Topic accepted, but writing the devlog failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      });
      setCoordinatorNotice(null);
      setTopic(trimmed);
      sessionRef.current = nextSession;
      setSession(nextSession);
    },
    [agents, cwd, rememberedAutonomy],
  );

  const handleAutonomySelected = useCallback(
    async (budget: AutonomyBudget, remember: boolean) => {
      if (!remember) return;
      await rememberAutonomyBudget(cwd, budget);
      setRememberedAutonomy(budget);
    },
    [cwd],
  );

  useEffect(() => {
    if (initialTopic) startTopic(initialTopic);
  }, [initialTopic, startTopic]);

  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    if (!sessionRef.current) exit();
    else {
      requestTerminal("quit", false).then(undefined, (error: unknown) => {
        setCoordinatorNotice(error instanceof Error ? error.message : String(error));
      });
    }
  });

  if (!session) {
    return (
      <WelcomeScreen
        agents={agents}
        status={status}
        headerAnimation={headerAnimation}
        onHeaderAnimationChange={setHeaderAnimation}
        onStart={startTopic}
      />
    );
  }

  return (
    <DebateView
      session={session}
      topic={topic}
      cwd={cwd}
      status={status}
      headerAnimation={headerAnimation}
      coordinatorState={coordinatorState}
      coordinatorNotice={coordinatorNotice}
      onLifecycleRequest={handleLifecycleRequest}
      onAutonomySelected={handleAutonomySelected}
    />
  );
}

function codexInitialModelLabel(status: ReturnType<typeof getProjectStatus>): string | undefined {
  if (!status.codexDefaultModel) return undefined;
  return status.codexDefaultEffort
    ? `${status.codexDefaultModel}, effort ${status.codexDefaultEffort}`
    : status.codexDefaultModel;
}
