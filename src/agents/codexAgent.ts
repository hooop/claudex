import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import type { AgentResult } from "../orchestrator/types.js";
import type { AgentActivity } from "../types.js";
import { AUTO_MODEL_LABEL, type AgentSendOptions, type CodingAgent } from "./types.js";

type RpcId = number | string;

interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  phase?: string | null;
  command?: string;
  cwd?: string;
  status?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: Array<{ path: string; kind: string }>;
  server?: string;
  tool?: string;
  namespace?: string | null;
  query?: string;
  path?: string;
}

interface CodexTurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

interface CodexTurn {
  id: string;
  status: string;
  error?: CodexTurnError | null;
}

interface TurnCompletion {
  threadId: string;
  turn: CodexTurn;
}

export class CodexProtocolError extends Error {
  constructor(message: string) {
    super(`Protocole Codex invalide : ${message}`);
    this.name = "CodexProtocolError";
  }
}

interface RunningCommand {
  label: string;
  startedAt: number;
}

interface CloseInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

type ToolActivity = Extract<AgentActivity, { kind: "command" | "tool" }>;

/**
 * Codex's non-interactive JSONL protocol only guarantees completed agent
 * messages. App-server exposes the actual item/agentMessage/delta stream, so a
 * short-lived stdio server is used for each turn while the persisted thread id
 * keeps conversation continuity between turns.
 */
export class CodexAgent implements CodingAgent {
  readonly id = "codex" as const;
  readonly label = "Codex";

  private model: string | undefined;
  private resolvedModel: string | undefined;
  private readonly initialDisplayModel: string | undefined;
  private threadId: string | undefined;
  private activeConnection: CodexAppServerConnection | null = null;
  private cancelled = false;
  private activeSend: Promise<AgentResult> | null = null;

  constructor(model?: string, initialDisplayModel?: string) {
    this.model = model;
    this.initialDisplayModel = initialDisplayModel;
  }

  currentModel(): string {
    return this.resolvedModel ?? this.model ?? this.initialDisplayModel ?? AUTO_MODEL_LABEL;
  }

  hasExplicitModel(): boolean {
    return this.model !== undefined;
  }

  setModel(model: string): void {
    this.model = model;
    this.resolvedModel = undefined;
  }

  resetSession(): void {
    if (this.activeSend) throw new Error("Impossible de réinitialiser Codex pendant un tour actif.");
    this.threadId = undefined;
    this.resolvedModel = undefined;
  }

  send(message: string, options: AgentSendOptions): Promise<AgentResult> {
    if (this.activeSend) {
      return Promise.resolve({ kind: "error", message: "Un tour Codex est déjà actif." });
    }
    const operation = this.performSend(message, options);
    const tracked = operation.finally(() => {
      if (this.activeSend === tracked) this.activeSend = null;
    });
    this.activeSend = tracked;
    return tracked;
  }

  private async performSend(message: string, options: AgentSendOptions): Promise<AgentResult> {
    if (options.signal?.aborted) return { kind: "cancelled" };

    this.cancelled = false;
    let text = "";
    let resolvedModel: string | undefined;
    let terminalError: CodexTurnError | null = null;
    const streamedItems = new Set<string>();
    const activeCommands = new Map<string, RunningCommand>();

    let expectedThreadId: string | null = null;
    let expectedTurnId: string | null = null;
    let earlyCompletion: RpcMessage | null = null;
    let turnSettled = false;
    let resolveTurn!: (completion: TurnCompletion) => void;
    let rejectTurn!: (error: Error) => void;
    const turnCompleted = new Promise<TurnCompletion>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    const rejectProtocol = (message: string) => {
      if (turnSettled) return;
      turnSettled = true;
      rejectTurn(new CodexProtocolError(message));
    };

    const processTurnCompletion = (notification: RpcMessage) => {
      if (turnSettled) return;
      const parsed = terminalTurnCompletionOf(notification.params);
      if (parsed instanceof Error) {
        rejectProtocol(parsed.message);
        return;
      }
      if (parsed.threadId !== expectedThreadId) {
        rejectProtocol(
          `turn/completed associé au thread ${parsed.threadId}, attendu ${expectedThreadId ?? "inconnu"}`,
        );
        return;
      }
      if (parsed.turn.id !== expectedTurnId) {
        rejectProtocol(
          `turn/completed associé au tour ${parsed.turn.id}, attendu ${expectedTurnId ?? "inconnu"}`,
        );
        return;
      }
      turnSettled = true;
      resolveTurn(parsed);
    };

    const emitLatestCommand = () => {
      const latest = [...activeCommands.values()].at(-1);
      if (!latest) return;
      options.onActivity?.({
        kind: "command",
        status: "running",
        label: latest.label,
        activeCount: activeCommands.size,
      });
    };

    const restoreCommandOrEmit = (activity: ToolActivity) => {
      if (activeCommands.size > 0) emitLatestCommand();
      else options.onActivity?.(activity);
    };

    const onNotification = (notification: RpcMessage) => {
      const params = asRecord(notification.params);

      switch (notification.method) {
        case "thread/tokenUsage/updated": {
          const threadId = stringOf(params.threadId);
          const turnId = stringOf(params.turnId);
          if (expectedThreadId && threadId && threadId !== expectedThreadId) return;
          if (expectedTurnId && turnId && turnId !== expectedTurnId) return;

          const tokenUsage = asRecord(params.tokenUsage);
          const lastUsage = asRecord(tokenUsage.last);
          const totalTokens = numberOf(lastUsage.totalTokens);
          const reasoningTokens = numberOf(lastUsage.reasoningOutputTokens) ?? 0;
          const contextWindow = numberOf(tokenUsage.modelContextWindow);
          if (
            totalTokens !== undefined &&
            Number.isFinite(totalTokens) &&
            totalTokens >= 0 &&
            Number.isFinite(reasoningTokens) &&
            reasoningTokens >= 0 &&
            contextWindow !== undefined &&
            Number.isFinite(contextWindow) &&
            contextWindow > 0
          ) {
            // Matches Codex's own context gauge: prior reasoning output is not
            // retained in the model-visible context window.
            options.onContextUsage?.({
              usedTokens: Math.max(0, totalTokens - reasoningTokens),
              contextWindow,
            });
          }
          return;
        }

        case "item/agentMessage/delta": {
          const delta = stringOf(params.delta);
          const itemId = stringOf(params.itemId);
          if (!delta) return;
          if (itemId) streamedItems.add(itemId);
          text += delta;
          options.onTextDelta?.(delta);
          return;
        }

        case "item/started": {
          const item = itemOf(params.item);
          if (!item) return;

          if (item.type === "commandExecution") {
            activeCommands.delete(item.id);
            activeCommands.set(item.id, {
              label: item.command || "commande",
              startedAt: numberOf(params.startedAtMs) ?? Date.now(),
            });
            emitLatestCommand();
            return;
          }

          const activity = activityForCodexItem(item, "running");
          if (activity) options.onActivity?.(activity);
          return;
        }

        case "item/completed": {
          const item = itemOf(params.item);
          if (!item) return;

          if (item.type === "agentMessage" && item.text && !streamedItems.has(item.id)) {
            text += item.text;
            options.onTextDelta?.(item.text);
            return;
          }

          if (item.type === "commandExecution") {
            const running = activeCommands.get(item.id);
            activeCommands.delete(item.id);
            const failed = item.status === "failed" || item.status === "declined" || (item.exitCode ?? 0) !== 0;
            const durationMs =
              item.durationMs ?? (running ? Math.max(0, Date.now() - running.startedAt) : undefined);
            restoreCommandOrEmit({
              kind: "command",
              status: failed ? "failure" : "success",
              label: item.command || running?.label || "commande",
              durationMs: durationMs ?? undefined,
              exitCode: item.exitCode,
            });
            return;
          }

          const failed = item.status === "failed" || item.status === "declined";
          const activity = activityForCodexItem(item, failed ? "failure" : "success");
          if (activity) restoreCommandOrEmit(activity);
          return;
        }

        case "error": {
          const error = turnErrorOf(params.error);
          if (error && params.willRetry !== true) terminalError = error;
          return;
        }

        case "turn/completed": {
          if (!expectedTurnId) {
            if (earlyCompletion) rejectProtocol("plusieurs notifications turn/completed précoces");
            else earlyCompletion = notification;
            return;
          }
          processTurnCompletion(notification);
          return;
        }
      }
    };

    const connection = new CodexAppServerConnection(options.cwd, onNotification);
    this.activeConnection = connection;

    const abortHandler = () => {
      this.cancelled = true;
      connection.close().then(undefined, () => undefined);
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      await connection.request("initialize", {
        clientInfo: { name: "claudex", title: "Claudex", version: "0.1.0" },
        capabilities: null,
      });
      connection.notify("initialized");

      const sandbox = options.writeAccess ? "workspace-write" : "read-only";
      const threadParams: Record<string, unknown> = {
        cwd: options.cwd,
        approvalPolicy: "never",
        sandbox,
      };
      if (this.model) threadParams.model = this.model;

      const threadResponse = asRecord(
        this.threadId
          ? await connection.request("thread/resume", { ...threadParams, threadId: this.threadId })
          : await connection.request("thread/start", { ...threadParams, serviceName: "claudex" }),
      );
      const thread = asRecord(threadResponse.thread);
      const nextThreadId = stringOf(thread.id);
      if (!nextThreadId) throw new Error("Codex app-server n'a pas renvoyé d'identifiant de thread.");
      this.threadId = nextThreadId;
      expectedThreadId = nextThreadId;
      resolvedModel = stringOf(threadResponse.model) || undefined;
      if (resolvedModel) this.resolvedModel = resolvedModel;

      const turnResponse = asRecord(await connection.request("turn/start", {
        threadId: nextThreadId,
        input: [{ type: "text", text: message }],
        cwd: options.cwd,
        approvalPolicy: "never",
        sandboxPolicy: sandboxPolicy(options.writeAccess, options.cwd),
        ...(this.model ? { model: this.model } : {}),
      }));
      const startedTurn = startedTurnOf(turnResponse.turn);
      if (startedTurn instanceof Error) throw new CodexProtocolError(startedTurn.message);
      expectedTurnId = startedTurn.id;
      if (earlyCompletion) processTurnCompletion(earlyCompletion);

      const completion = await Promise.race([
        turnCompleted,
        connection.closed.then((info) => {
          throw connectionClosedError(info, connection.stderrSummary);
        }),
      ]);

      if (this.cancelled || options.signal?.aborted || completion.turn.status === "interrupted") {
        return { kind: "cancelled", partialText: text || undefined };
      }

      const turnError = completion.turn.error ?? terminalError;
      if (completion.turn.status === "failed" || turnError) {
        return {
          kind: "error",
          message: describeCodexError(turnError ?? { message: "Tour Codex échoué." }),
          partialText: text || undefined,
        };
      }

      return { kind: "success", text, resolvedModel };
    } catch (error) {
      if (this.cancelled || options.signal?.aborted) {
        return { kind: "cancelled", partialText: text || undefined };
      }
      return {
        kind: "error",
        message: describeCodexThrownError(error),
        partialText: text || undefined,
      };
    } finally {
      options.signal?.removeEventListener("abort", abortHandler);
      await connection.close();
      if (this.activeConnection === connection) this.activeConnection = null;
    }
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    await this.activeConnection?.close();
    await this.activeSend;
    this.activeConnection = null;
  }
}

class CodexAppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lineReader: readline.Interface;
  private readonly pending = new Map<
    RpcId,
    { method: string; resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private stderr = "";
  private closedInfo: CloseInfo | null = null;
  private resolveClosed!: (info: CloseInfo) => void;
  readonly closed: Promise<CloseInfo>;

  constructor(
    cwd: string,
    private readonly onNotification: (message: RpcMessage) => void,
  ) {
    this.child = spawn("codex", ["app-server", "--stdio"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });

    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on("line", (line) => this.handleLine(line));

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") this.rejectPending(error);
    });
    this.child.on("error", (error) => this.finishClose({ code: null, signal: null, error }));
    this.child.on("close", (code, signal) => this.finishClose({ code, signal }));
  }

  get stderrSummary(): string {
    return this.stderr.trim();
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closedInfo) return Promise.reject(connectionClosedError(this.closedInfo, this.stderrSummary));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string): void {
    this.send({ method });
  }

  async close(): Promise<void> {
    if (this.closedInfo) return;
    this.child.kill("SIGTERM");
    await this.closed;
  }

  private send(message: RpcMessage): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("La connexion stdio de Codex app-server est fermée.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && message.method) {
      this.answerServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `Codex app-server (${pending.method}) : ${message.error.message ?? `erreur ${message.error.code ?? "inconnue"}`}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) this.onNotification(message);
  }

  private answerServerRequest(message: RpcMessage): void {
    if (message.id === undefined) return;
    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.send({ id: message.id, result: { decision: "decline" } });
        return;
      case "item/tool/requestUserInput":
        this.send({ id: message.id, result: { answers: {} } });
        return;
      default:
        this.send({
          id: message.id,
          error: { code: -32601, message: `Requête app-server non prise en charge par Claudex : ${message.method}` },
        });
    }
  }

  private finishClose(info: CloseInfo): void {
    if (this.closedInfo) return;
    this.closedInfo = info;
    this.lineReader.close();
    this.rejectPending(connectionClosedError(info, this.stderrSummary));
    this.resolveClosed(info);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

function sandboxPolicy(writeAccess: boolean, cwd: string): Record<string, unknown> {
  if (!writeAccess) return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function activityForCodexItem(
  item: CodexItem,
  status: ToolActivity["status"],
): ToolActivity | null {
  const durationMs = item.durationMs ?? undefined;
  switch (item.type) {
    case "fileChange": {
      const paths = item.changes?.map((change) => change.path).filter(Boolean) ?? [];
      const label = paths.length === 1 ? `modifie ${paths[0]}` : `modifie ${paths.length || "des"} fichiers`;
      return { kind: "tool", status, label, durationMs };
    }
    case "mcpToolCall":
      return {
        kind: "tool",
        status,
        label: `utilise ${[item.server, item.tool].filter(Boolean).join("/") || "un outil MCP"}`,
        durationMs,
      };
    case "dynamicToolCall":
      return {
        kind: "tool",
        status,
        label: `utilise ${[item.namespace, item.tool].filter(Boolean).join("/") || "un outil"}`,
        durationMs,
      };
    case "webSearch":
      return { kind: "tool", status, label: `recherche sur le web : ${item.query || "requête"}`, durationMs };
    case "imageView":
      return { kind: "tool", status, label: `inspecte ${item.path || "une image"}`, durationMs };
    case "plan":
      return { kind: "tool", status, label: "prépare son plan", durationMs };
    case "contextCompaction":
      return { kind: "tool", status, label: "compacte le contexte", durationMs };
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function itemOf(value: unknown): CodexItem | null {
  const item = asRecord(value);
  const id = stringOf(item.id);
  const type = stringOf(item.type);
  if (!id || !type) return null;
  const changes = Array.isArray(item.changes)
    ? item.changes.flatMap((value): Array<{ path: string; kind: string }> => {
        const change = asRecord(value);
        const path = stringOf(change.path);
        const kind = stringOf(change.kind);
        return path && kind ? [{ path, kind }] : [];
      })
    : undefined;
  return {
    id,
    type,
    text: optionalString(item.text),
    phase: item.phase === null ? null : optionalString(item.phase),
    command: optionalString(item.command),
    cwd: optionalString(item.cwd),
    status: optionalString(item.status),
    exitCode: item.exitCode === null ? null : numberOf(item.exitCode),
    durationMs: item.durationMs === null ? null : numberOf(item.durationMs),
    changes,
    server: optionalString(item.server),
    tool: optionalString(item.tool),
    namespace: item.namespace === null ? null : optionalString(item.namespace),
    query: optionalString(item.query),
    path: optionalString(item.path),
  };
}

function startedTurnOf(value: unknown): Pick<CodexTurn, "id" | "status"> | Error {
  const turn = asRecord(value);
  const id = stringOf(turn.id);
  const status = stringOf(turn.status);
  if (!id) return new Error("turn/start sans identifiant de tour");
  if (status !== "inProgress") {
    return new Error(`turn/start avec statut ${status || "absent"}, attendu inProgress`);
  }
  return { id, status };
}

function terminalTurnCompletionOf(value: unknown): TurnCompletion | Error {
  const params = asRecord(value);
  const threadId = stringOf(params.threadId);
  if (!threadId) return new Error("turn/completed sans threadId");

  const rawTurn = asRecord(params.turn);
  const id = stringOf(rawTurn.id);
  if (!id) return new Error("turn/completed sans turn.id");
  const status = stringOf(rawTurn.status);
  if (status !== "completed" && status !== "failed" && status !== "interrupted") {
    return new Error(`turn/completed avec statut terminal invalide : ${status || "absent"}`);
  }

  let error: CodexTurnError | null | undefined;
  if (rawTurn.error === null || rawTurn.error === undefined) {
    error = rawTurn.error === null ? null : undefined;
  } else {
    error = turnErrorOf(rawTurn.error);
    if (!error) return new Error("turn/completed contient une erreur mal formée");
  }
  return { threadId, turn: { id, status, error } };
}

function turnErrorOf(value: unknown): CodexTurnError | null {
  const error = asRecord(value);
  const message = stringOf(error.message);
  if (!message) return null;
  return {
    message,
    codexErrorInfo: error.codexErrorInfo,
    additionalDetails:
      error.additionalDetails === null ? null : optionalString(error.additionalDetails),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function describeCodexError(error: CodexTurnError): string {
  const detail = error.additionalDetails ? `${error.message} — ${error.additionalDetails}` : error.message;
  if (isCodexLimit(error.codexErrorInfo) || looksLikeUsageLimit(detail)) {
    return `Limite Codex atteinte — reprends avec /resume après la réinitialisation (${detail}).`;
  }
  return detail;
}

function describeCodexThrownError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (looksLikeUsageLimit(message)) {
    return `Limite Codex atteinte — reprends avec /resume après la réinitialisation (${message}).`;
  }
  return message;
}

function isCodexLimit(info: unknown): boolean {
  return info === "usageLimitExceeded" || info === "sessionBudgetExceeded";
}

function looksLikeUsageLimit(message: string): boolean {
  return /(usage limit|session budget|rate.?limit|credit|quota|resets?\s)/iu.test(message);
}

function connectionClosedError(info: CloseInfo, stderr: string): Error {
  if (info.error) return info.error;
  const reason = info.signal ? `signal ${info.signal}` : `code ${info.code ?? "inconnu"}`;
  return new Error(`Codex app-server s'est arrêté (${reason})${stderr ? ` : ${stderr}` : ""}`);
}
