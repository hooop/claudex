// Measures whether Claude stays read-only under a given version of the Claude
// Agent SDK. It makes REAL queries: it uses the maintainer's Claude account and
// quota. Protocol and threat model: docs/superpowers/specs/2026-10-26-sdk-upgrade-design.md.
//
//   npm run verify:readonly -- --model <id> [--sdk-dir <dir>] [--cases E,F,G]
//     [--repeat 2] [--probe-mcp-tool <name>] [--out <file.json>]
//
// Exit codes: 0 every absolute case passed, 1 one did not, 2 the run could not
// be made (bad arguments, SDK not found).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CASES, claudeSessionEnvKeys, type CaseId, type Gate, type VerificationCase } from "./readonly-verification/cases.js";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  runCase,
  type QueryFn,
  type RunSettings,
} from "./readonly-verification/observe.js";
import { SdkLoadError, loadSdk } from "./readonly-verification/sdk.js";
import { aggregate, evaluate, formatMarkdown, type Observation, type Verdict } from "./readonly-verification/verdict.js";

const USAGE =
  "Usage: npm run verify:readonly -- --model <id> [--sdk-dir <dir>] [--cases E,F,G] [--repeat 2] [--probe-mcp-tool <name>] [--out <file.json>]";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptsDir, "..");
const evilServerPath = join(scriptsDir, "readonly-verification", "evil-mcp-server.mjs");

/** A failure to run the verification at all (as opposed to a case that fails): exit code 2. */
class CommandError extends Error {}

interface Options {
  model: string;
  sdkDir: string;
  cases: VerificationCase[];
  repeat: number;
  probeTool: string | undefined;
  out: string | undefined;
}

interface Row {
  id: CaseId;
  gate: Gate;
  observations: Observation[];
  verdicts: Verdict[];
  verdict: Verdict;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseOptions(argv: string[]): Options {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        model: { type: "string" },
        "sdk-dir": { type: "string" },
        cases: { type: "string" },
        repeat: { type: "string" },
        "probe-mcp-tool": { type: "string" },
        out: { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    throw new CommandError(`${describeError(error)}\n${USAGE}`);
  }

  if (values.model === undefined || values.model === "") throw new CommandError(`--model is required\n${USAGE}`);

  const repeatText = values.repeat ?? "1";
  if (!/^[1-9]\d*$/.test(repeatText)) throw new CommandError(`--repeat must be a positive integer, got "${repeatText}"`);

  let cases = [...CASES];
  if (values.cases !== undefined) {
    const wanted = new Set(values.cases.split(",").map((id) => id.trim().toUpperCase()));
    const unknown = [...wanted].filter((id) => !CASES.some((c) => c.id === id));
    if (unknown.length > 0) {
      throw new CommandError(`unknown case(s): ${unknown.join(", ")} (known: ${CASES.map((c) => c.id).join(", ")})`);
    }
    cases = CASES.filter((c) => wanted.has(c.id));
  }

  return {
    model: values.model,
    sdkDir: resolve(values["sdk-dir"] ?? repositoryRoot),
    cases,
    repeat: Number(repeatText),
    probeTool: values["probe-mcp-tool"],
    out: values.out === undefined ? undefined : resolve(values.out),
  };
}

function stripClaudeSessionEnv(): void {
  // A run started from inside a Claude Code session would inherit its
  // variables and not behave like one started in a plain terminal. They are
  // deleted rather than overridden through the SDK's env option, which on
  // recent versions replaces the whole environment.
  const keys = claudeSessionEnvKeys(process.env);
  for (const key of keys) delete process.env[key];
  if (keys.length > 0) console.error(`Removed from the environment: ${keys.join(", ")}`);
}

async function runAll(query: QueryFn, options: Options, cases: VerificationCase[]): Promise<Row[]> {
  const settings: RunSettings = {
    model: options.model,
    maxTurns: DEFAULT_MAX_TURNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    evilServerPath,
    probeTool: options.probeTool,
  };

  const rows: Row[] = [];
  for (const c of cases) {
    const observations: Observation[] = [];
    const verdicts: Verdict[] = [];
    for (let run = 1; run <= options.repeat; run++) {
      console.error(`Case ${c.id}: run ${run}/${options.repeat}`);
      const observation = await runCase(query, c, settings);
      observations.push(observation);
      verdicts.push(evaluate(c, observation, options.probeTool));
    }
    rows.push({ id: c.id, gate: c.gate, observations, verdicts, verdict: aggregate(verdicts) });
  }
  return rows;
}

async function main(argv: string[]): Promise<number> {
  const options = parseOptions(argv);

  const skipped: Array<{ id: CaseId; reason: string }> = [];
  const cases = options.cases.filter((c) => {
    if (c.id !== "I" || options.probeTool !== undefined) return true;
    skipped.push({ id: c.id, reason: "needs --probe-mcp-tool" });
    return false;
  });
  for (const { id, reason } of skipped) console.error(`Case ${id} skipped: ${reason}`);
  if (cases.length === 0) throw new CommandError("no case to run");

  stripClaudeSessionEnv();
  const sdk = await loadSdk(options.sdkDir);
  console.error(`SDK ${sdk.version} (Claude Code ${sdk.claudeCodeVersion ?? "unknown"}) from ${sdk.entry}`);

  const rows = await runAll(sdk.query, options, cases);

  const header = { sdkVersion: sdk.version, claudeCodeVersion: sdk.claudeCodeVersion, model: options.model };
  let report = formatMarkdown(rows, header);
  if (skipped.length > 0) {
    report += `\nSkipped: ${skipped.map(({ id, reason }) => `case ${id} (${reason})`).join(", ")}\n`;
  }
  await new Promise<void>((done) => process.stdout.write(report, () => done()));

  if (options.out !== undefined) {
    const json = {
      ...header,
      sdkEntry: sdk.entry,
      repeat: options.repeat,
      probeTool: options.probeTool ?? null,
      skipped,
      cases: rows.map((row) => ({
        id: row.id,
        gate: row.gate,
        verdict: row.verdict,
        runs: row.observations.map((observation, index) => ({ observation, verdict: row.verdicts[index] })),
      })),
    };
    try {
      await mkdir(dirname(options.out), { recursive: true });
      await writeFile(options.out, `${JSON.stringify(json, null, 2)}\n`);
    } catch (error) {
      throw new CommandError(`cannot write --out ${options.out}: ${describeError(error)}`);
    }
  }

  const blocking = rows.filter((row) => row.gate === "absolute" && row.verdict.status !== "pass");
  if (blocking.length > 0) {
    console.error(`Absolute case(s) not passing: ${blocking.map((row) => `${row.id} (${row.verdict.status})`).join(", ")}`);
    return 1;
  }
  return 0;
}

// An explicit exit, once the output is flushed, so that a child process the
// SDK left behind cannot keep the command hanging.
function exit(code: number): void {
  process.stderr.write("", () => process.exit(code));
}

main(process.argv.slice(2)).then(exit, (error: unknown) => {
  // Only a mistake in the command's input, or an SDK that cannot be loaded, is
  // explained in one line; anything else keeps its stack.
  console.error(error instanceof CommandError || error instanceof SdkLoadError ? error.message : error);
  exit(2);
});
