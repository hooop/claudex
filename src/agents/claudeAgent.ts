import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentResult } from "../orchestrator/types.js";
import type { AgentActivity } from "../types.js";
import { formatClaudeModel } from "../util/projectStatus.js";
import { type DebateSandbox, debateQueryOptions } from "./debateOptions.js";
import { removeEngineLeftovers, snapshotEngineLeftovers } from "./engineLeftovers.js";
import { SETTINGS_CHANGED_MESSAGE, type SessionGuard } from "./projectSettings.js";
import { AUTO_MODEL_LABEL, type AgentSendOptions, type CodingAgent } from "./types.js";

/**
 * Full tool access for implementation phase.
 */
const FULL_TOOLS = { type: "preset" as const, preset: "claude_code" as const };

export type SandboxResolver = (cwd: string) => Promise<DebateSandbox | null>;

export interface EngineLeftoverCleanup {
  snapshot: (cwd: string) => Promise<ReadonlySet<string>>;
  remove: (cwd: string, before: ReadonlySet<string>) => Promise<unknown>;
}

export const DEBATE_SANDBOX_ERROR =
  "The debate sandbox could not be prepared (project folder not found). Turn cancelled.";

export class ClaudeAgent implements CodingAgent {
  readonly id = "claude" as const;
  readonly label = "Claude Code";

  private model: string | undefined;
  private resolvedModel: string | undefined;
  private readonly initialDisplayModel: string | undefined;
  private sessionId: string | undefined;
  private abortController: AbortController | null = null;
  private activeSend: Promise<AgentResult> | null = null;

  private readonly guard: SessionGuard | undefined;

  private readonly resolveSandbox: SandboxResolver;
  private readonly leftovers: EngineLeftoverCleanup;

  constructor(
    model?: string,
    initialDisplayModel?: string,
    guard?: SessionGuard,
    resolveSandbox: SandboxResolver = () => Promise.resolve(null),
    leftovers: EngineLeftoverCleanup = { snapshot: snapshotEngineLeftovers, remove: removeEngineLeftovers },
  ) {
    this.leftovers = leftovers;
    this.guard = guard;
    this.resolveSandbox = resolveSandbox;
    this.model = model;
    this.initialDisplayModel = initialDisplayModel;
  }

  currentModel(): string {
    const model = this.resolvedModel ?? this.model;
    return model
      ? formatClaudeModel(model)
      : this.initialDisplayModel ?? AUTO_MODEL_LABEL;
  }

  hasExplicitModel(): boolean {
    return this.model !== undefined;
  }

  setModel(model: string): void {
    this.model = model;
    this.resolvedModel = undefined;
  }

  resetSession(): void {
    if (this.activeSend) throw new Error("Cannot reset Claude during an active turn.");
    this.sessionId = undefined;
    this.resolvedModel = undefined;
  }

  send(message: string, options: AgentSendOptions): Promise<AgentResult> {
    if (this.activeSend) {
      return Promise.resolve({ kind: "error", message: "A Claude turn is already active." });
    }
    const operation = this.performSend(message, options);
    const tracked = operation.finally(() => {
      if (this.activeSend === tracked) this.activeSend = null;
    });
    this.activeSend = tracked;
    return tracked;
  }

  private async performSend(message: string, options: AgentSendOptions): Promise<AgentResult> {
    this.abortController = new AbortController();
    const abortController = this.abortController;
    const externalAbort = () => abortController.abort();

    if (options.signal) {
      if (options.signal.aborted) {
        return { kind: "cancelled" };
      }
      options.signal.addEventListener("abort", externalAbort, { once: true });
    }

    let text = "";
    let latestAssistantContext: AssistantContext | null = null;
    let streamedSinceAssistant = false;
    let assistantError: string | undefined;
    const activeTools = new Map<string, RunningTool>();
    const pendingToolInputs = new Map<number, PendingToolInput>();

    const emitLatestRunningTool = () => {
      const latest = [...activeTools.values()].at(-1);
      if (!latest) return;
      options.onActivity?.({
        ...latest.activity,
        status: "running",
        activeCount: activeTools.size,
      });
    };

    const startTool = (id: string, name: string, input: unknown) => {
      activeTools.delete(id);
      activeTools.set(id, {
        activity: describeClaudeTool(name, input),
        startedAt: Date.now(),
      });
      emitLatestRunningTool();
    };

    const completeTool = (id: string, failed: boolean) => {
      const completed = activeTools.get(id);
      if (!completed) return;
      activeTools.delete(id);

      if (activeTools.size > 0) {
        emitLatestRunningTool();
        return;
      }

      options.onActivity?.({
        ...completed.activity,
        status: failed ? "failure" : "success",
        durationMs: Date.now() - completed.startedAt,
      });
    };

    let cleanupLeftovers: (() => Promise<void>) | undefined;

    try {
      if (this.guard) {
        // Fail closed: a guard that throws must not let the turn through.
        const refusal = await this.guard(options.cwd).catch(() => SETTINGS_CHANGED_MESSAGE);
        if (abortController.signal.aborted) return { kind: "cancelled" };
        if (refusal !== null) return { kind: "error", message: refusal };
      }

      let sandbox: DebateSandbox | null = null;
      if (!options.writeAccess) {
        try {
          sandbox = await this.resolveSandbox(options.cwd);
        } catch {
          // Fail closed: without a sandbox the turn must not run.
          return { kind: "error", message: DEBATE_SANDBOX_ERROR };
        }
        if (abortController.signal.aborted) return { kind: "cancelled" };
      }

      if (sandbox) {
        // The sandboxed engine leaves empty directories in the project. Best
        // effort only: a failure here must never change the turn's result, and
        // without a snapshot nothing is removed.
        try {
          const before = await this.leftovers.snapshot(options.cwd);
          cleanupLeftovers = async () => {
            await this.leftovers.remove(options.cwd, before);
          };
        } catch {
          cleanupLeftovers = undefined;
        }
      }

      const stream = query({
        prompt: message,
        options: {
          model: this.model,
          cwd: options.cwd,
          resume: this.sessionId,
          ...(options.writeAccess
            ? {
                // The user's own settings apply when the agent implements.
                settingSources: ["project" as const, "user" as const],
                permissionMode: "default" as const,
                tools: FULL_TOOLS,
              }
            : debateQueryOptions(sandbox)),
          includePartialMessages: true,
          canUseTool: options.onPermissionRequest
            ? async (
                toolName: string,
                input: unknown,
                opts?: { toolUseID: string; signal?: AbortSignal },
              ) => {
                // Use SDK-provided toolUseID when available, fallback to generated id
                const id =
                  opts?.toolUseID ?? `${this.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                startTool(id, toolName, input);
                const decision = await options.onPermissionRequest!({
                  id,
                  agent: this.id,
                  toolName,
                  input,
                });
                return decision.behavior === "allow"
                  ? { behavior: "allow" as const, updatedInput: input as Record<string, unknown> }
                  : { behavior: "deny" as const, message: decision.message ?? "Refused by user" };
              }
            : undefined,
        },
      });

      for await (const msg of stream) {
        if (abortController.signal.aborted) {
          return { kind: "cancelled", partialText: text || undefined };
        }

        const sessionId = (msg as { session_id?: string }).session_id;
        if (sessionId) this.sessionId = sessionId;

        if (msg.type === "stream_event") {
          const event = (msg as { event?: ClaudeStreamEvent }).event;
          const delta = textDeltaOf(event);
          if (delta) {
            streamedSinceAssistant = true;
            text += delta;
            options.onTextDelta?.(delta);
          }

          if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
            const tool = event.content_block;
            pendingToolInputs.set(event.index, {
              id: tool.id,
              name: tool.name,
              json: hasKeys(tool.input) ? JSON.stringify(tool.input) : "",
            });
            startTool(tool.id, tool.name, tool.input);
          } else if (event?.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
            const pending = pendingToolInputs.get(event.index);
            if (pending) pending.json += event.delta.partial_json ?? "";
          } else if (event?.type === "content_block_stop") {
            const pending = pendingToolInputs.get(event.index);
            if (pending) {
              pendingToolInputs.delete(event.index);
              startTool(pending.id, pending.name, parseToolInput(pending.json));
            }
          }
        }

        if (msg.type === "assistant") {
          latestAssistantContext = assistantContextOf(msg) ?? latestAssistantContext;
          const fullText = extractAssistantText(msg);
          if (fullText && !streamedSinceAssistant) {
            text += fullText;
            options.onTextDelta?.(fullText);
          }
          streamedSinceAssistant = false;

          for (const tool of extractAssistantToolUses(msg)) {
            if (!activeTools.has(tool.id)) startTool(tool.id, tool.name, tool.input);
          }

          const error = (msg as { error?: string }).error;
          if (error) assistantError = error;
        }

        if (msg.type === "user") {
          for (const result of extractToolResults(msg)) completeTool(result.id, result.failed);
        }

        if (msg.type === "result") {
          const resultMsg = msg as {
            session_id?: string;
            modelUsage?: Record<string, unknown>;
            subtype?: string;
            is_error?: boolean;
            errors?: string[];
          };

          const modelUsage = resultMsg.modelUsage;
          // modelUsage also counts the engine's background model (Haiku on SDK
          // 0.3.310) and lists it first, so only the assistant messages name
          // the model that answered.
          const usedModel = latestAssistantContext?.model;
          if (usedModel) this.resolvedModel = usedModel;

          const contextWindow = modelContextWindowOf(modelUsage, latestAssistantContext?.model);
          if (latestAssistantContext && contextWindow !== null) {
            options.onContextUsage?.({
              usedTokens: latestAssistantContext.usedTokens,
              contextWindow,
            });
          }

          if (resultMsg.is_error === true || resultMsg.subtype?.startsWith("error_")) {
            return {
              kind: "error",
              message: describeClaudeResultError(resultMsg, assistantError),
              partialText: text || undefined,
            };
          }
        }
      }

      // Success: complete text with no errors
      return { kind: "success", text };
    } catch (err) {
      if (abortController.signal.aborted) {
        return { kind: "cancelled", partialText: text || undefined };
      }

      return {
        kind: "error",
        message: describeClaudeThrownError(err),
        partialText: text || undefined,
      };
    } finally {
      await cleanupLeftovers?.().catch(() => undefined);
      options.signal?.removeEventListener("abort", externalAbort);
      this.abortController = null;
    }
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    await this.activeSend;
  }
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

type ToolActivity = Extract<AgentActivity, { kind: "command" | "tool" }>;

interface RunningTool {
  activity: Omit<ToolActivity, "status">;
  startedAt: number;
}

interface PendingToolInput {
  id: string;
  name: string;
  json: string;
}

interface AssistantContext {
  model?: string;
  usedTokens: number;
}

/**
 * Claude's result-level modelUsage is cumulative across tool calls. The latest
 * assistant message instead carries the prompt occupancy of the actual model
 * call, which is the number relevant to context-window pressure.
 */
function assistantContextOf(value: unknown): AssistantContext | null {
  const message = asRecord(asRecord(value).message);
  const usage = asRecord(message.usage);
  const fields = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
    usage.output_tokens,
  ];
  const numeric = fields.filter((field): field is number =>
    typeof field === "number" && Number.isFinite(field) && field >= 0,
  );
  if (numeric.length === 0) return null;
  const model = typeof message.model === "string" ? message.model : undefined;
  return { model, usedTokens: numeric.reduce((total, field) => total + field, 0) };
}

function modelContextWindowOf(
  modelUsage: Record<string, unknown> | undefined,
  preferredModel: string | undefined,
): number | null {
  if (!modelUsage) return null;
  const candidates = preferredModel && preferredModel in modelUsage
    ? [modelUsage[preferredModel], ...Object.values(modelUsage)]
    : Object.values(modelUsage);
  for (const candidate of candidates) {
    const contextWindow = asRecord(candidate).contextWindow;
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      return contextWindow;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

interface ClaudeStreamEvent {
  type: string;
  index: number;
  content_block?: {
    type: string;
    id: string;
    name: string;
    input?: unknown;
  };
  delta?: {
    type: string;
    text?: string;
    partial_json?: string;
  };
}

function extractAssistantText(msg: unknown): string {
  const message = (msg as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

function textDeltaOf(event: ClaudeStreamEvent | undefined): string {
  if (event?.type !== "content_block_delta" || event.delta?.type !== "text_delta") return "";
  return event.delta.text ?? "";
}

function extractAssistantToolUses(msg: unknown): Array<{ id: string; name: string; input: unknown }> {
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).flatMap((block) =>
    block.type === "tool_use" && block.id && block.name
      ? [{ id: block.id, name: block.name, input: block.input }]
      : [],
  );
}

function extractToolResults(msg: unknown): Array<{ id: string; failed: boolean }> {
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).flatMap((block) =>
    block.type === "tool_result" && block.tool_use_id
      ? [{ id: block.tool_use_id, failed: block.is_error === true }]
      : [],
  );
}

function hasKeys(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function parseToolInput(json: string): unknown {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function describeClaudeTool(name: string, input: unknown): Omit<ToolActivity, "status"> {
  const data = hasKeys(input) ? input : {};
  const stringField = (key: string) => (typeof data[key] === "string" ? data[key] : "");

  switch (name) {
    case "Bash":
      return { kind: "command", label: stringField("command") || "command" };
    case "Read":
      return { kind: "tool", label: `reads ${stringField("file_path") || "a file"}` };
    case "Grep": {
      const pattern = stringField("pattern");
      return { kind: "tool", label: pattern ? `searches "${pattern}"` : "searches the code" };
    }
    case "Glob":
      return { kind: "tool", label: `browses ${stringField("pattern") || "the files"}` };
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return { kind: "tool", label: `edits ${stringField("file_path") || "a file"}` };
    case "WebSearch":
      return { kind: "tool", label: `searches the web: ${stringField("query") || "query"}` };
    case "TodoWrite":
      return { kind: "tool", label: "updates its plan" };
    default:
      return { kind: "tool", label: `uses ${name}` };
  }
}

function describeClaudeResultError(
  result: { subtype?: string; errors?: string[] },
  assistantError?: string,
): string {
  const detail = result.errors?.filter(Boolean).join(" · ") || assistantError || "";

  if (result.subtype === "error_max_budget_usd") {
    return "Claude budget limit reached — resume with /resume after raising or resetting the budget.";
  }
  if (looksLikeUsageLimit(detail) || assistantError === "rate_limit") {
    return `Claude Code limit reached — resume with /resume after the reset${detail ? ` (${detail})` : ""}.`;
  }
  if (result.subtype === "error_max_turns") {
    return `Maximum number of Claude turns reached${detail ? `: ${detail}` : "."}`;
  }
  return detail || `Erreur Claude Code (${result.subtype ?? "inconnue"})`;
}

function describeClaudeThrownError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (looksLikeUsageLimit(message)) {
    return `Claude Code limit reached — resume with /resume after the reset (${message}).`;
  }
  return message;
}

function looksLikeUsageLimit(message: string): boolean {
  return /(session limit|usage limit|rate.?limit|credit|quota|resets?\s)/iu.test(message);
}
