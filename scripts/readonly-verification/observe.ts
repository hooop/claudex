// Runs one case: builds a throwaway git project, makes one query() call
// against it and reports what the stream and canUseTool showed. The SDK is
// injected (QueryFn) so that tests never start a real engine.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { MARKER_NAME, decide, type CaseContext, type VerificationCase } from "./cases.js";
import type { Observation } from "./verdict.js";

const execFileAsync = promisify(execFile);

/** The part of the SDK's query() that the runner uses. */
export type QueryFn = (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>;

export interface RunSettings {
  model: string;
  maxTurns: number;
  timeoutMs: number;
  evilServerPath: string;
  probeTool?: string;
}

export const DEFAULT_MAX_TURNS = 6;
export const DEFAULT_TIMEOUT_MS = 180_000;

// Both files hold the word that case F greps for.
const SHARED_FILES: Record<string, string> = {
  "README.md": "# Throwaway project\n\nBuilt by the read-only verification. claudex-marker\n",
  "notes.md": "Notes of the throwaway project.\nclaudex-marker appears here too.\n",
};

const DENIAL_MESSAGE = "Denied by the read-only verification policy.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyObservation(): Observation {
  return {
    initTools: null,
    initPermissionMode: null,
    mcpServers: [],
    toolUses: [],
    permissionRequests: [],
    markerWritten: false,
    resultSubtype: null,
    error: null,
  };
}

// The stream is untrusted input from a version of the SDK we are measuring:
// every field is checked rather than assumed.
function record(observation: Observation, message: unknown): void {
  if (!isRecord(message)) return;

  if (message.type === "system" && message.subtype === "init") {
    if (Array.isArray(message.tools)) {
      observation.initTools = message.tools.filter((tool): tool is string => typeof tool === "string");
    }
    if (typeof message.permissionMode === "string") observation.initPermissionMode = message.permissionMode;
    if (Array.isArray(message.mcp_servers)) {
      observation.mcpServers = message.mcp_servers.flatMap((server: unknown) =>
        isRecord(server) && typeof server.name === "string" && typeof server.status === "string"
          ? [{ name: server.name, status: server.status }]
          : [],
      );
    }
  } else if (message.type === "assistant") {
    const content = isRecord(message.message) ? message.message.content : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content as unknown[]) {
      if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        observation.toolUses.push({ id: block.id, name: block.name });
      }
    }
  } else if (message.type === "result" && typeof message.subtype === "string") {
    observation.resultSubtype = message.subtype;
  }
}

async function writeProjectFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(dir, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

export async function runCase(query: QueryFn, c: VerificationCase, settings: RunSettings): Promise<Observation> {
  const dir = await mkdtemp(join(tmpdir(), "claudex-readonly-"));
  try {
    const markerPath = join(dir, MARKER_NAME);
    const ctx: CaseContext = { markerPath, evilServerPath: settings.evilServerPath, probeTool: settings.probeTool };

    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await writeProjectFiles(dir, { ...SHARED_FILES, ...c.projectFiles(ctx) });
    const prompt = c.prompt(ctx);

    const observation = emptyObservation();
    const abortController = new AbortController();
    // Once the run has ended, a straggling stream must not alter what we return.
    let closed = false;

    const policy = c.policy;
    const canUseTool =
      policy === "none"
        ? undefined
        : (toolName: string, input: Record<string, unknown>, options: { toolUseID: string }) => {
            const decision = decide(policy, toolName);
            if (!closed) observation.permissionRequests.push({ toolUseID: options.toolUseID, toolName, decision });
            // 0.1.77 requires updatedInput on allow: hand the received input back.
            return Promise.resolve(
              decision === "allow"
                ? { behavior: "allow" as const, updatedInput: input }
                : { behavior: "deny" as const, message: DENIAL_MESSAGE },
            );
          };

    const queryOptions: Record<string, unknown> = {
      ...c.options,
      cwd: dir,
      model: settings.model,
      maxTurns: settings.maxTurns,
      abortController,
      ...(canUseTool ? { canUseTool } : {}),
    };

    const timeoutMessage = `timed out after ${settings.timeoutMs} ms`;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        resolve();
      }, settings.timeoutMs);
    });

    const consumption = (async () => {
      for await (const message of query({ prompt, options: queryOptions })) {
        if (closed) break;
        record(observation, message);
      }
    })();
    // The outcome is read through the race below. This only keeps a rejection
    // that arrives after a timeout from becoming an unhandled one.
    consumption.catch(() => undefined);

    try {
      // Racing the timeout, rather than only aborting, bounds the run even if
      // the SDK ignores the abort.
      await Promise.race([consumption, timeout]);
    } catch (error) {
      if (!timedOut) observation.error = describeError(error);
    } finally {
      clearTimeout(timer);
      closed = true;
    }
    if (timedOut) observation.error = timeoutMessage;

    observation.markerWritten = existsSync(markerPath);
    return observation;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
