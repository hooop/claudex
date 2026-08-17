import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentResult } from "../orchestrator/types.js";
import type { AgentActivity } from "../types.js";
import { formatClaudeModel } from "../util/projectStatus.js";
import { AUTO_MODEL_LABEL, type AgentSendOptions, type CodingAgent } from "./types.js";

/**
 * Strictly read-only tools for debate phase.
 * Bash is explicitly excluded — it can write even with "read-only" intent,
 * and a permissive rule or distracted human approval could violate the invariant.
 */
const DEBATE_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Full tool access for implementation phase.
 */
const FULL_TOOLS = { type: "preset" as const, preset: "claude_code" as const };

export class ClaudeAgent implements CodingAgent {
  readonly id = "claude" as const;
  readonly label = "Claude Code";

  private model: string | undefined;
  private resolvedModel: string | undefined;
  private readonly initialDisplayModel: string | undefined;
  private sessionId: string | undefined;
  private abortController: AbortController | null = null;
  private activeSend: Promise<AgentResult> | null = null;

  constructor(model?: string, initialDisplayModel?: string) {
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
    if (this.activeSend) throw new Error("Impossible de réinitialiser Claude pendant un tour actif.");
    this.sessionId = undefined;
    this.resolvedModel = undefined;
  }

  send(message: string, options: AgentSendOptions): Promise<AgentResult> {
    if (this.activeSend) {
      return Promise.resolve({ kind: "error", message: "Un tour Claude est déjà actif." });
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
    let resolvedModel: string | undefined;
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

    try {
      const stream = query({
        prompt: message,
        options: {
          model: this.model,
          cwd: options.cwd,
          resume: this.sessionId,
          settingSources: ["project", "user"],
          // Deliberately always "default", never "plan": plan mode carries its own
          // built-in ritual (present a plan, call ExitPlanMode) that conflicts with
          // the debate's own instructions and has been observed to confuse the model
          // about which protocol to follow. Read-only enforcement during the debate
          // comes from `tools` (real availability restriction) below.
          permissionMode: "default",
          includePartialMessages: true,
          tools: options.writeAccess ? FULL_TOOLS : DEBATE_TOOLS,
          // No auto-approved tools in debate — everything requires human approval
          allowedTools: options.writeAccess ? undefined : [],
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
          const usedModel = modelUsage && Object.keys(modelUsage)[0];
          if (usedModel) {
            resolvedModel = usedModel;
            this.resolvedModel = usedModel;
          }

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
      return { kind: "success", text, resolvedModel };
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
      return { kind: "command", label: stringField("command") || "commande" };
    case "Read":
      return { kind: "tool", label: `lit ${stringField("file_path") || "un fichier"}` };
    case "Grep": {
      const pattern = stringField("pattern");
      return { kind: "tool", label: pattern ? `recherche « ${pattern} »` : "recherche dans le code" };
    }
    case "Glob":
      return { kind: "tool", label: `parcourt ${stringField("pattern") || "les fichiers"}` };
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return { kind: "tool", label: `modifie ${stringField("file_path") || "un fichier"}` };
    case "WebSearch":
      return { kind: "tool", label: `recherche sur le web : ${stringField("query") || "requête"}` };
    case "TodoWrite":
      return { kind: "tool", label: "met à jour son plan" };
    default:
      return { kind: "tool", label: `utilise ${name}` };
  }
}

function describeClaudeResultError(
  result: { subtype?: string; errors?: string[] },
  assistantError?: string,
): string {
  const detail = result.errors?.filter(Boolean).join(" · ") || assistantError || "";

  if (result.subtype === "error_max_budget_usd") {
    return "Limite de budget Claude atteinte — reprends avec /resume après avoir augmenté ou réinitialisé le budget.";
  }
  if (looksLikeUsageLimit(detail) || assistantError === "rate_limit") {
    return `Limite Claude Code atteinte — reprends avec /resume après la réinitialisation${detail ? ` (${detail})` : ""}.`;
  }
  if (result.subtype === "error_max_turns") {
    return `Nombre maximal de tours Claude atteint${detail ? ` : ${detail}` : "."}`;
  }
  return detail || `Erreur Claude Code (${result.subtype ?? "inconnue"})`;
}

function describeClaudeThrownError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (looksLikeUsageLimit(message)) {
    return `Limite Claude Code atteinte — reprends avec /resume après la réinitialisation (${message}).`;
  }
  return message;
}

function looksLikeUsageLimit(message: string): boolean {
  return /(session limit|usage limit|rate.?limit|credit|quota|resets?\s)/iu.test(message);
}
