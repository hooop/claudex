import { useApp, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClaudeAgent } from "../agents/claudeAgent.js";
import { CodexAgent } from "../agents/codexAgent.js";
import type { CodingAgent } from "../agents/types.js";
import {
  appendDevlog,
  rememberAutonomyBudget,
  saveTranscript,
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

export function Root(props: { cwd: string; initialTopic?: string }) {
  const { cwd, initialTopic } = props;
  const { exit } = useApp();

  const agentsRef = useRef<Record<AgentId, CodingAgent>>({
    claude: new ClaudeAgent(),
    codex: new CodexAgent(),
  });
  const [status] = useState(() => getProjectStatus(cwd));
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
      agentsRef.current.claude.resetSession();
      agentsRef.current.codex.resetSession();
      if (pending.destination === "quit") exit();
      else setSession(null);
    },
    [exit],
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
            const message = `Arrêt incomplet (${detail}). /retry retente l'arrêt sans perdre la session.`;
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
              `Arrêt terminé, mais archivage impossible (${detail}). ` +
              "/retry retente l'archive ; /new --discard ou /quit --discard l'abandonne explicitement.";
            setCoordinatorState({ kind: "archive-failed", destination: pending.destination, message });
            return { ok: false, message };
          }
        }

        finishTerminal(pending);
        return {
          ok: true,
          message: pending.archive ? "Session arrêtée et archivée." : "Entrée sans sujet refermée.",
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
              message: "--discard n'est autorisé qu'après un échec d'archivage.",
            });
          }
          finishTerminal(existing);
          return Promise.resolve({
            ok: true,
            message: "Archive abandonnée explicitement ; la session fermée a été réinitialisée.",
          });
        }

        return Promise.resolve({
          ok: false,
          message:
            existing.stage === "archive"
              ? "Archivage en échec : utilise /retry ou une commande --discard explicite."
              : "Arrêt en échec : utilise /retry.",
        });
      }

      if (discard) {
        return Promise.resolve({
          ok: false,
          message: "--discard n'est autorisé qu'après un échec d'archivage.",
        });
      }

      const current = sessionRef.current;
      if (!current) {
        if (destination === "quit") exit();
        return Promise.resolve({ ok: true, message: "Aucune session active." });
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
          message: "Sortie d'urgence demandée : la dernière session peut ne pas avoir été archivée.",
        };
      }

      if (request.kind === "retry") {
        const pending = pendingTerminalRef.current;
        if (!pending) return { ok: false, message: "Aucune opération à retenter." };
        return executeTerminal(pending);
      }

      if (request.kind === "save") {
        if (saveOperationRef.current) return saveOperationRef.current;
        const current = sessionRef.current;
        if (!current) return { ok: false, message: "Aucune session à enregistrer." };
        if (current.lifecycle !== "open" || coordinatorState.kind !== "idle") {
          return {
            ok: false,
            message: "Instantané refusé pendant une fermeture ; attends un état stable ou utilise /retry.",
          };
        }
        if (current.topicStatus !== "accepted") {
          return {
            ok: false,
            message: "Instantané refusé tant que le sujet n'a pas été validé.",
          };
        }
        if (current.isCancellationSettling()) {
          return {
            ok: false,
            message: "Instantané refusé pendant la stabilisation de l'annulation.",
          };
        }

        const snapshot = current.snapshot();
        const saveOperation = saveTranscript(cwd, topic, snapshot, { completeness: "partial" })
          .then<CoordinatorResponse, CoordinatorResponse>(
            (savedTo) => ({ ok: true, message: `Instantané partiel enregistré dans ${savedTo}` }),
            (error: unknown) => ({
              ok: false,
              message: `Échec de l'instantané : ${error instanceof Error ? error.message : String(error)}`,
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

  const closeRejectedTopic = useCallback(
    (rejectedSession: DebateSession, rejectedTopic: string) => {
      if (pendingTerminalRef.current) return;
      const pending: PendingTerminal = {
        session: rejectedSession,
        topic: rejectedTopic,
        destination: "new",
        archive: false,
        stage: "shutdown",
      };
      pendingTerminalRef.current = pending;
      // Let the qualifying turn finish its own callback stack before shutdown
      // invalidates run tokens; this prevents a duplicate completion event.
      queueMicrotask(() => {
        if (pendingTerminalRef.current === pending) {
          executeTerminal(pending).then(undefined, (error: unknown) => {
            setCoordinatorNotice(error instanceof Error ? error.message : String(error));
          });
        }
      });
    },
    [executeTerminal],
  );

  const startTopic = useCallback(
    (newTopic: string) => {
      const trimmed = newTopic.trim();
      if (!trimmed || sessionRef.current || pendingTerminalRef.current) return;
      agentsRef.current.claude.resetSession();
      agentsRef.current.codex.resetSession();
      const nextSession = new DebateSession(agentsRef.current, {
        cwd,
        starter: "claude",
        autonomyBudget: rememberedAutonomy,
      });
      let devlogWritten = false;
      nextSession.on("topic-accepted", () => {
        if (devlogWritten) return;
        devlogWritten = true;
        appendDevlog(cwd, `Session démarrée — sujet : ${trimmed}`).then(undefined, (error: unknown) => {
          setCoordinatorNotice(
            `Sujet validé, mais écriture du devlog impossible : ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      });
      nextSession.on("topic-rejected", () => closeRejectedTopic(nextSession, trimmed));
      setCoordinatorNotice(null);
      setTopic(trimmed);
      sessionRef.current = nextSession;
      setSession(nextSession);
    },
    [closeRejectedTopic, cwd, rememberedAutonomy],
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
        agents={agentsRef.current}
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
      headerAnimation={headerAnimation}
      coordinatorState={coordinatorState}
      coordinatorNotice={coordinatorNotice}
      onLifecycleRequest={handleLifecycleRequest}
      onAutonomySelected={handleAutonomySelected}
    />
  );
}
