// Runs one case: builds a throwaway git project, makes one query() call
// against it and reports what the stream and canUseTool showed. The SDK is
// injected (QueryFn) so that tests never start a real engine.
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { TrustedDirError, assertEmptyDir, changedKeys, cleanupToSnapshot, readProjectEntry, snapshotTree, type TreeSnapshot } from "./trustedDir.js";
import { debateQueryOptions } from "../../src/agents/debateOptions.js";
import { resolveDebateSandbox } from "../../src/agents/debateSandbox.js";
import {
  MARKER_NAME,
  SECRET_ENV_NAME,
  SECRET_FILE_NAME,
  claudeSessionEnvKeys,
  decide,
  type CaseContext,
  type VerificationCase,
} from "./cases.js";
import type { Observation } from "./verdict.js";

const execFileAsync = promisify(execFile);

/** The part of the SDK's query() that the runner uses. */
export type QueryFn = (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>;

export interface RunSettings {
  model: string;
  maxTurns: number;
  timeoutMs: number;
  evilServerPath: string;
  /** Run in this already trusted folder (`dir` is a real path) instead of a fresh temporary one. */
  trusted?: { dir: string; configFile: string };
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
    initPlugins: [],
    initSkills: [],
    apiKeySource: null,
    toolUses: [],
    permissionRequests: [],
    markerWritten: false,
    resultSubtype: null,
    error: null,
    trustStateChanges: null,
    listenerRequests: [],
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
    // Never dropped: an entry this code cannot read is still a listed server,
    // and dropping it would let a shape change in the SDK pass the verdict.
    if (Array.isArray(message.mcp_servers)) {
      observation.mcpServers = (message.mcp_servers as unknown[]).map((server) => {
        const entry = isRecord(server) ? server : {};
        return {
          name: typeof entry.name === "string" ? entry.name : "(unparsed)",
          status: typeof entry.status === "string" ? entry.status : "unknown",
          source: typeof entry.source === "string" ? entry.source : null,
        };
      });
    } else if (message.mcp_servers !== undefined) {
      observation.mcpServers = [{ name: "(unparsed mcp_servers)", status: "unknown", source: null }];
    }
    if (Array.isArray(message.plugins)) {
      observation.initPlugins = message.plugins.flatMap((plugin: unknown) =>
        isRecord(plugin) && typeof plugin.name === "string" && typeof plugin.path === "string"
          ? [{ name: plugin.name, path: plugin.path }]
          : [],
      );
    }
    if (Array.isArray(message.skills)) {
      observation.initSkills = message.skills.filter((skill): skill is string => typeof skill === "string");
    }
    if (typeof message.apiKeySource === "string") observation.apiKeySource = message.apiKeySource;
  } else if (message.type === "assistant") {
    const content = isRecord(message.message) ? message.message.content : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content as unknown[]) {
      if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        observation.toolUses.push({ id: block.id, name: block.name });
      }
    }
  } else if (message.type === "result") {
    const subtype = typeof message.subtype === "string" ? message.subtype : null;
    if (subtype !== null) observation.resultSubtype = subtype;
    // Running out of turns is a result flagged as an error too, but the model
    // did run: its observation is kept as it is. The subtype alone is enough
    // to call a result an error, as in the adapter (src/agents/claudeAgent.ts).
    const isError = message.is_error === true || (subtype?.startsWith("error_") ?? false);
    if (isError && subtype !== "error_max_turns") {
      observation.error = describeErrorResult(subtype, message);
    }
  }
}

// A failed engine (rejected model, lost login, API error) still ends the
// stream with a result message. Its details sit in `errors` on the error
// subtypes and in `result` on an error flagged as a "success" subtype.
function describeErrorResult(subtype: string | null, message: Record<string, unknown>): string {
  const details = [
    ...(Array.isArray(message.errors) ? (message.errors as unknown[]) : []),
    message.result,
  ].filter((detail): detail is string => typeof detail === "string" && detail !== "");
  return `engine returned an error result (subtype ${subtype ?? "unknown"})${details.length > 0 ? `: ${details.join("; ")}` : ""}`;
}

async function writeProjectFiles(dir: string, files: Record<string, string>): Promise<void> {
  // A case file must stay inside the folder, and the trusted-folder cleanup
  // relies on the paths being plain relative ones.
  for (const relativePath of Object.keys(files)) {
    if (isAbsolute(relativePath) || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`invalid case file path: ${JSON.stringify(relativePath)}`);
    }
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(dir, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/**
 * What the sandbox cases need besides the project: a fake home whose .ssh is a
 * symlink to a decoy, a folder outside the project, and the per-run token. All
 * of it lives in its own temporary root, never in the project folder: in a
 * trusted folder the cleanup there removes only the paths of its snapshot.
 */
interface SandboxFixture {
  root: string;
  fakeHome: string;
  outsideMarkerPath: string;
  secretPath: string;
  /** Kept by the runner only: it is never written to an observation or a report. */
  token: string;
}

async function createSandboxFixture(): Promise<SandboxFixture> {
  // Real path: the sandbox's rules apply to resolved paths (/var is a link to /private/var on macOS).
  const root = await realpath(await mkdtemp(join(tmpdir(), "claudex-readonly-sandbox-")));
  try {
    const token = randomBytes(16).toString("hex");
    const fakeHome = join(root, "home");
    const dotfiles = join(root, "dotfiles-ssh");
    const outside = join(root, "outside");
    await Promise.all([mkdir(fakeHome), mkdir(dotfiles), mkdir(outside)]);
    await writeFile(join(dotfiles, SECRET_FILE_NAME), `${token}\n`);
    // The decoy is reached through a symlink, as a real ~/.ssh may be: this
    // proves the deny list covers the link's target too.
    await symlink(dotfiles, join(fakeHome, ".ssh"));
    return {
      root,
      fakeHome,
      outsideMarkerPath: join(outside, MARKER_NAME),
      secretPath: join(fakeHome, ".ssh", SECRET_FILE_NAME),
      token,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function runCase(query: QueryFn, c: VerificationCase, settings: RunSettings): Promise<Observation> {
  const fixture = c.sandbox ? await createSandboxFixture() : undefined;
  try {
    const trusted = settings.trusted;
    if (trusted) return await runInTrustedDir(query, c, settings, trusted, fixture);
    const dir = await mkdtemp(join(tmpdir(), "claudex-readonly-"));
    try {
      return await runIn(dir, query, c, settings, undefined, fixture);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
  }
}

// The folder is the maintainer's, trusted once by hand: it must start empty.
// Right after the setup a snapshot lists every path the run created; the
// cleanup removes exactly those plus the marker. Anything else present (a file
// the engine wrote, even inside .claude or .git) is not ours to delete, so the
// series stops and the folder is left as it is.
async function runInTrustedDir(
  query: QueryFn,
  c: VerificationCase,
  settings: RunSettings,
  trusted: { dir: string; configFile: string },
  fixture: SandboxFixture | undefined,
): Promise<Observation> {
  const { dir, configFile } = trusted;
  await assertEmptyDir(dir);
  const before = await readProjectEntry(configFile, dir);
  let snapshot: TreeSnapshot | undefined;
  let observation: Observation | undefined;
  let runError: Error | undefined;
  try {
    observation = await runIn(
      dir,
      query,
      c,
      settings,
      async () => {
        snapshot = await snapshotTree(dir);
      },
      fixture,
    );
  } catch (error) {
    runError = error instanceof Error ? error : new Error(describeError(error));
  }
  if (snapshot === undefined) {
    // Setup failed before the engine ran: the folder was empty, so whatever is
    // there now was written by the setup alone.
    await rm(join(dir, MARKER_NAME), { force: true });
    for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
    throw runError ?? new Error("setup did not complete");
  }
  const { unaccounted } = await cleanupToSnapshot(dir, snapshot, MARKER_NAME);
  if (unaccounted.length > 0) {
    throw new TrustedDirError(
      `the run left what it cannot account for in ${dir}, nothing deleted but the marker: ${unaccounted.join(", ")}` +
        (await describeTrustChanges(configFile, dir, before)) +
        (runError ? `; the run itself failed: ${runError.message}` : ""),
    );
  }
  await assertEmptyDir(dir);
  if (runError !== undefined) throw runError;
  if (observation === undefined) throw new Error("no observation");
  observation.trustStateChanges = changedKeys(before, await readProjectEntry(configFile, dir));
  return observation;
}

// Names only, never values; unreadable configuration just adds nothing.
async function describeTrustChanges(
  configFile: string,
  dir: string,
  before: Record<string, unknown> | null,
): Promise<string> {
  try {
    const keys = changedKeys(before, await readProjectEntry(configFile, dir));
    return keys.length > 0 ? `; project entry keys changed: ${keys.join(", ")}` : "";
  } catch {
    return "";
  }
}

async function runIn(
  dir: string,
  query: QueryFn,
  c: VerificationCase,
  settings: RunSettings,
  afterSetup?: () => Promise<void>,
  fixture?: SandboxFixture,
): Promise<Observation> {
  const observation = emptyObservation();
  const listener = c.listener ? await startListener(observation) : null;
  try {
    return await runWith(dir, query, c, settings, observation, listener?.url ?? null, afterSetup, fixture);
  } finally {
    await listener?.close();
  }
}

// Serves the loopback URL a case points the engine at. Only the method and the
// path (without query string) are kept: a request may carry the maintainer's
// credential, so headers and bodies are drained and never stored or printed.
async function startListener(observation: Observation): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    observation.listenerRequests.push({ method: request.method ?? "", path });
    request.resume();
    response.statusCode = 503;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // Keep-alive connections would hold close() open until they time out.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function runWith(
  dir: string,
  query: QueryFn,
  c: VerificationCase,
  settings: RunSettings,
  observation: Observation,
  listenerUrl: string | null,
  afterSetup?: () => Promise<void>,
  fixture?: SandboxFixture,
): Promise<Observation> {
  const markerPath = join(dir, MARKER_NAME);
  const ctx: CaseContext = {
    markerPath,
    evilServerPath: settings.evilServerPath,
    listenerUrl,
    ...(fixture ? { outsideMarkerPath: fixture.outsideMarkerPath, secretPath: fixture.secretPath } : {}),
  };

  if (fixture) {
    observation.extraMarkersWritten = [];
    observation.secretSeen = false;
  }

  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await writeProjectFiles(dir, { ...SHARED_FILES, ...c.projectFiles(ctx) });
  const cwd = c.cwdSubdir === undefined ? dir : join(dir, c.cwdSubdir);
  await mkdir(cwd, { recursive: true });
  const prompt = c.prompt(ctx);
  await afterSetup?.();

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

  // A case env replaces the engine's whole environment on recent SDK versions,
  // so it starts from this process's, minus the variables of a Claude Code
  // session (the entry point already removes them; this keeps the runner safe alone).
  const caseEnv: NodeJS.ProcessEnv | undefined =
    fixture && c.secretEnv ? withoutSessionVariables({ ...process.env, [SECRET_ENV_NAME]: fixture.token }) : undefined;
  const baseOptions = fixture && c.sandbox ? await sandboxOptions(c.sandbox, cwd, fixture, caseEnv ?? process.env) : c.options;

  const queryOptions: Record<string, unknown> = {
    ...baseOptions,
    ...(caseEnv ? { env: caseEnv } : {}),
    cwd,
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
      if (fixture && !observation.secretSeen && mentions(message, fixture.token)) observation.secretSeen = true;
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
  if (fixture) {
    const extras: Array<[string, string]> = [
      ["sub", join(dir, "sub", MARKER_NAME)],
      [".git", join(dir, ".git", MARKER_NAME)],
      ["outside", fixture.outsideMarkerPath],
    ];
    observation.extraMarkersWritten = extras.filter(([, path]) => existsSync(path)).map(([label]) => label);
    // Not part of the trusted-folder snapshot, so the cleanup there would
    // report them as unaccounted; the fixture root is removed whole.
    for (const [, path] of extras) if (path.startsWith(dir)) await rm(path, { force: true });
  }
  return observation;
}

function withoutSessionVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const key of claudeSessionEnvKeys(kept)) delete kept[key];
  return kept;
}

// The options Claudex ships, built the way the adapter builds them: through
// the resolver with the run's real cwd, the fake home and the case's env. The
// control deletes the sandbox, nothing else.
async function sandboxOptions(
  mode: "shipped" | "stripped",
  cwd: string,
  fixture: SandboxFixture,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const sandbox = await resolveDebateSandbox(cwd, "darwin", fixture.fakeHome, env);
  const options: Record<string, unknown> = { ...debateQueryOptions(sandbox) };
  if (mode === "stripped") delete options.sandbox;
  return options;
}

// Tool results and assistant text are what the model, and so the human, see.
// Compared on the serialized block so that string and array contents both count.
function mentions(message: unknown, token: string): boolean {
  if (!isRecord(message) || (message.type !== "user" && message.type !== "assistant")) return false;
  const content = isRecord(message.message) ? message.message.content : undefined;
  if (typeof content === "string") return content.includes(token);
  if (!Array.isArray(content)) return false;
  return (content as unknown[]).some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === "text") return typeof block.text === "string" && block.text.includes(token);
    if (block.type === "tool_result") return JSON.stringify(block.content ?? null).includes(token);
    return false;
  });
}
