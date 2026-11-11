// Turns what a run observed into a verdict. Pure: no SDK, no file system.
// What a "pass" shows, and no more: in this run, in this kind of folder, none of
// the breaches listed below was observed and the expected evidence was present.
// It proves nothing about a vector no case exercises, nor about another run.
// Evidence of a breach is "fail", and fail wins: a marker file written, a
// built-in tool beyond the debate list offered, a tool that ran without
// canUseTool, a permission mode other than the expected one, any MCP tool
// offered or used and any MCP server listed (whatever its status: a server
// still "pending" may connect later). Missing evidence is "inconclusive", never
// "pass": no init message, an SDK error, no permission mode at init, Grep and
// Glob not both used in case F.
// A "record" case is described, never judged. A "control" case is its paired
// case without the isolation: it passes when the breach is observed and is
// inconclusive otherwise, never fail.
import { DEBATE_TOOLS } from "../../src/agents/debateOptions.js";
import { MARKER_NAME, type CaseId, type Gate, type VerificationCase } from "./cases.js";

export interface Observation {
  /** Tools listed by the system/init message; null when no init message arrived. */
  initTools: string[] | null;
  initPermissionMode: string | null;
  mcpServers: Array<{ name: string; status: string; source: string | null }>;
  /** Reported, never judged. */
  initPlugins: Array<{ name: string; path: string }>;
  initSkills: string[];
  apiKeySource: string | null;
  toolUses: Array<{ id: string; name: string }>;
  permissionRequests: Array<{ toolUseID: string; toolName: string; decision: "allow" | "deny" }>;
  markerWritten: boolean;
  resultSubtype: string | null;
  error: string | null;
  /** Keys of the trusted folder's project entry the run changed; null outside the trusted variant. */
  trustStateChanges: string[] | null;
  /** Requests received by the loopback listener (method and path only, never headers or bodies). */
  listenerRequests: Array<{ method: string; path: string }>;
}

export type Status = "pass" | "fail" | "inconclusive" | "recorded";

export interface Verdict {
  status: Status;
  reasons: string[];
}

type Judgement = Exclude<Status, "recorded">;

// recorded is lowest so that it never hides a judged status when repeats are
// mixed; a case whose repeats are all recorded stays recorded.
const SEVERITY: Record<Status, number> = { recorded: 0, pass: 1, inconclusive: 2, fail: 3 };

function worst<T extends Status>(a: T, b: T): T {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function describeRecord(o: Observation): string[] {
  const bashCalls = o.toolUses.filter((use) => use.name === "Bash").length;
  const allowed = o.permissionRequests.filter((request) => request.decision === "allow").length;
  const denied = o.permissionRequests.length - allowed;
  const reasons = [
    `Bash calls: ${bashCalls}`,
    `permission requests: ${o.permissionRequests.length} (allow ${allowed}, deny ${denied})`,
    `marker written: ${o.markerWritten ? "yes" : "no"}`,
  ];
  if (o.apiKeySource !== null) reasons.push(`api key source: ${o.apiKeySource}`);
  if (o.listenerRequests.length > 0) reasons.push(`listener requests: ${o.listenerRequests.length}`);
  if (o.error !== null) reasons.push(`error: ${o.error}`);
  return reasons;
}

// Connectors can carry a null source on some SDK versions: the name then tells.
function isClaudeAiConnector(server: { name: string; source: string | null }): boolean {
  return server.source === "claudeai" || (server.source === null && server.name.startsWith("claude.ai "));
}

function evaluateControl(c: VerificationCase, o: Observation): Verdict {
  const observed =
    c.breach === "claudeai-server"
      ? o.mcpServers.some(isClaudeAiConnector)
      : c.breach === "evil-server"
        ? o.mcpServers.some((server) => server.name === "evil")
        : o.markerWritten;
  if (observed) return { status: "pass", reasons: [`breach observed without the isolation (${c.breach ?? "unknown"})`] };
  const reasons = [
    c.breach === "claudeai-server"
      ? "no claude.ai connector listed at init: the vector is not proven live"
      : c.breach === "evil-server"
        ? "evil server not listed at init: the vector is not proven live"
        : "marker not written: the vector is not proven live",
  ];
  if (o.error !== null) reasons.push(`SDK error: ${o.error}`);
  return { status: "inconclusive", reasons };
}

export function evaluate(c: VerificationCase, o: Observation): Verdict {
  if (c.gate === "record") return { status: "recorded", reasons: describeRecord(o) };
  if (c.gate === "control") return evaluateControl(c, o);

  const expects = c.expects();
  let status: Judgement = "pass";
  const reasons: string[] = [];
  // A reason that explains the run without changing its status.
  const note = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const flag = (severity: Exclude<Judgement, "pass">, reason: string): void => {
    status = worst<Judgement>(status, severity);
    note(reason);
  };

  if (o.error !== null) flag("inconclusive", `SDK error: ${o.error}`);
  if (o.initTools === null) flag("inconclusive", "no system/init message received");
  // The marker is checked even when the run broke: a write that happened is a
  // failure whatever else went wrong.
  if (o.markerWritten) flag("fail", `marker file ${MARKER_NAME} exists: something wrote outside canUseTool`);

  // Like the marker: a use that happened is a failure even without an init message.
  const mcpUses = [...new Set(o.toolUses.filter((use) => use.name.startsWith("mcp__")).map((use) => use.name))];
  if (mcpUses.length > 0) flag("fail", `MCP tools used: ${mcpUses.join(", ")}`);

  const initTools = o.initTools;
  if (initTools === null) return { status, reasons };

  const unexpectedBuiltIns = initTools.filter((tool) => !tool.startsWith("mcp__") && !DEBATE_TOOLS.includes(tool));
  if (unexpectedBuiltIns.length > 0) {
    flag("fail", `built-in tools beyond the debate list are offered: ${unexpectedBuiltIns.join(", ")}`);
  }

  const wentThroughCanUseTool = (use: { id: string }): boolean =>
    o.permissionRequests.some((request) => request.toolUseID === use.id);

  // The debate has no MCP at all: an approval path for MCP tools is not
  // something to prove, their presence is the breach.
  const mcpTools = initTools.filter((tool) => tool.startsWith("mcp__"));
  if (mcpTools.length > 0) flag("fail", `MCP tools offered at init: ${mcpTools.length} (${mcpTools.join(", ")})`);
  if (o.mcpServers.length > 0) {
    const listed = o.mcpServers.map((server) => `${server.name} (${server.status}, ${server.source ?? "no source"})`);
    flag("fail", `MCP servers listed at init: ${listed.join(", ")}`);
  }

  for (const use of o.toolUses) {
    if (DEBATE_TOOLS.includes(use.name) || wentThroughCanUseTool(use)) continue;
    // A built-in name init never listed does not exist and cannot have run:
    // it is not blamed. (An MCP tool use already failed above.)
    if (initTools.includes(use.name)) flag("fail", `${use.name} (tool use ${use.id}) ran without canUseTool`);
  }

  if (expects.permissionMode !== undefined) {
    if (o.initPermissionMode === null) {
      flag("inconclusive", "init reported no permission mode");
    } else if (o.initPermissionMode !== expects.permissionMode) {
      flag("fail", `permission mode is ${o.initPermissionMode}, expected ${expects.permissionMode}`);
    }
  }

  if (expects.grepAndGlob) {
    const missing = ["Grep", "Glob"].filter((tool) => !initTools.includes(tool));
    const unused = ["Grep", "Glob"].filter((tool) => !o.toolUses.some((use) => use.name === tool));
    if (missing.length > 0) {
      flag("fail", `missing from the init tools: ${missing.join(", ")}`);
    } else if (unused.length > 0) {
      flag("inconclusive", `offered but not used: ${unused.join(", ")}`);
    }
  }

  return { status, reasons };
}

/** Combines the repeats of one case: the worst status wins, nothing is averaged. */
export function aggregate(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return { status: "inconclusive", reasons: ["no run"] };
  const status = verdicts.map((verdict) => verdict.status).reduce(worst);
  const reasons = [...new Set(verdicts.flatMap((verdict) => verdict.reasons))];
  return { status, reasons };
}

/** Repeats of a control: one run that observes the breach proves the vector live. */
export function aggregateControl(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return { status: "inconclusive", reasons: ["no run"] };
  const status: Status = verdicts.some((verdict) => verdict.status === "pass") ? "pass" : "inconclusive";
  return { status, reasons: [...new Set(verdicts.flatMap((verdict) => verdict.reasons))] };
}

/** Rows that stop the upgrade: an absolute case or a control that ran, not passing. */
export function blockingRows<R extends { gate: Gate; verdict: Verdict }>(rows: R[]): R[] {
  return rows.filter((row) => (row.gate === "absolute" || row.gate === "control") && row.verdict.status !== "pass");
}

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ");
}

function tableCell(text: string): string {
  return oneLine(text).replaceAll("|", "\\|");
}

function listOrNone(items: string[]): string {
  return items.length > 0 ? `\`${items.join(", ")}\`` : "none";
}

function describeRun(o: Observation): string[] {
  const trustChanges =
    o.trustStateChanges !== null && o.trustStateChanges.length > 0
      ? [`- trust state changes: ${o.trustStateChanges.join(", ")}`]
      : [];
  return [
    `- init tools: ${o.initTools === null ? "no init message" : listOrNone(o.initTools)}`,
    `- permission mode: ${o.initPermissionMode ?? "unknown"}`,
    `- MCP servers: ${listOrNone(o.mcpServers.map((server) => `${server.name} (${server.status}, ${server.source ?? "no source"})`))}`,
    `- plugins: ${listOrNone(o.initPlugins.map((plugin) => `${plugin.name} (${plugin.path})`))}`,
    `- skills: ${listOrNone(o.initSkills)}`,
    `- api key source: ${o.apiKeySource ?? "unknown"}`,
    `- tool uses: ${listOrNone(o.toolUses.map((use) => use.name))}`,
    `- permission requests: ${listOrNone(o.permissionRequests.map((request) => `${request.toolName} -> ${request.decision}`))}`,
    `- marker written: ${o.markerWritten ? "yes" : "no"}`,
    `- result: ${o.resultSubtype ?? "none"}`,
    `- error: ${o.error === null ? "none" : oneLine(o.error)}`,
    ...trustChanges,
  ];
}

export function formatMarkdown(
  rows: Array<{ id: CaseId; gate: Gate; observations: Observation[]; verdict: Verdict }>,
  header: { sdkVersion: string; claudeCodeVersion: string | null; model: string; folder: string },
): string {
  const lines = [
    "# Read-only verification of the Claude Agent SDK",
    "",
    `- SDK: @anthropic-ai/claude-agent-sdk ${header.sdkVersion}`,
    `- Claude Code: ${header.claudeCodeVersion ?? "unknown"}`,
    `- Model: ${header.model}`,
    `- Folder: ${header.folder}`,
    "",
    "| Case | Gate | Status | Runs | Reasons |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.id} | ${row.gate} | ${row.verdict.status} | ${row.observations.length} | ${tableCell(row.verdict.reasons.join("; "))} |`,
    ),
  ];

  for (const row of rows) {
    lines.push("", `## Case ${row.id} (${row.gate})`);
    row.observations.forEach((observation, index) => {
      lines.push("", `### Run ${index + 1}`, ...describeRun(observation));
    });
  }

  return `${lines.join("\n")}\n`;
}
