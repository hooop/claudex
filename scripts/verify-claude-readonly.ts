// Measures whether Claude stays read-only under a given version of the Claude
// Agent SDK. It makes REAL queries: it uses the maintainer's Claude account and
// quota. Protocol and threat model: docs/superpowers/specs/2026-10-26-sdk-upgrade-design.md;
// cases and verdict after the debate isolation: docs/superpowers/specs/2026-10-28-debate-isolation-design.md;
// cases Lp, Ll and M (where the engine reads project credential helpers and env):
// docs/superpowers/specs/2026-11-11-project-command-settings-design.md, section D4;
// cases S, Sc, Sh, Sn, Snc, Sr, Src, Se, Sec, Sd, Shr, Shn, She, Shu and Shuc (the sandboxed Bash of a debate turn, built
// at run time with a fake home): docs/superpowers/specs/2026-11-11-sandboxed-bash-design.md, section D7.
//
//   npm run verify:readonly -- --model <id> [--sdk-dir <dir>] [--cases E,F,G]
//     [--repeat <n>] [--out <file.json>] [--trusted-dir <dir>]
//
// --trusted-dir runs every case in that empty, already trusted folder instead of
// a fresh temporary one (see D3 of the debate isolation design).
//
// Each case runs twice by default (--repeat): one clean run is not evidence
// when the model is free to behave differently the next time.
//
// Exit codes: 0 every absolute case and every control that ran passed, 1 one did not, 2 the run could not
// be made (bad arguments, SDK not found).
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ALL_CASES, claudeSessionEnvKeys, type CaseId, type Gate, type VerificationCase } from "./readonly-verification/cases.js";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  runCase,
  type QueryFn,
  type RunSettings,
} from "./readonly-verification/observe.js";
import { TrustedDirError, claudeConfigFile, resolveTrustedDir } from "./readonly-verification/trustedDir.js";
import { SdkLoadError, loadSdk } from "./readonly-verification/sdk.js";
import { aggregate, aggregateControl, blockingRows, evaluate, formatMarkdown, type Observation, type Verdict } from "./readonly-verification/verdict.js";

const DEFAULT_REPEAT = 2;
const USAGE =
  "Usage: npm run verify:readonly -- --model <id> [--sdk-dir <dir>] [--cases E,F,G] [--repeat <n>] [--out <file.json>] [--trusted-dir <dir>]\n" +
  `Each case runs ${DEFAULT_REPEAT} times unless --repeat says otherwise.`;

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
  out: string | undefined;
  trustedDir: string | undefined;
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
        out: { type: "string" },
        "trusted-dir": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    throw new CommandError(`${describeError(error)}\n${USAGE}`);
  }

  if (values.model === undefined || values.model === "") throw new CommandError(`--model is required\n${USAGE}`);

  const repeatText = values.repeat ?? String(DEFAULT_REPEAT);
  if (!/^[1-9]\d*$/.test(repeatText)) throw new CommandError(`--repeat must be a positive integer, got "${repeatText}"`);

  let cases = [...ALL_CASES];
  if (values.cases !== undefined) {
    const wanted = new Set(values.cases.split(",").map((id) => id.trim().toLowerCase()));
    const unknown = [...wanted].filter((id) => !ALL_CASES.some((c) => c.id.toLowerCase() === id));
    if (unknown.length > 0) {
      throw new CommandError(`unknown case(s): ${unknown.join(", ")} (known: ${ALL_CASES.map((c) => c.id).join(", ")})`);
    }
    cases = ALL_CASES.filter((c) => wanted.has(c.id.toLowerCase()));
  }

  return {
    model: values.model,
    sdkDir: resolve(values["sdk-dir"] ?? repositoryRoot),
    cases,
    repeat: Number(repeatText),
    out: values.out === undefined ? undefined : resolve(values.out),
    trustedDir: values["trusted-dir"],
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

async function runAll(
  query: QueryFn,
  options: Options,
  cases: VerificationCase[],
  trusted: RunSettings["trusted"],
  rows: Row[],
): Promise<void> {
  const settings: RunSettings = {
    model: options.model,
    maxTurns: DEFAULT_MAX_TURNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    evilServerPath,
    ...(trusted ? { trusted } : {}),
  };

  for (const c of cases) {
    const observations: Observation[] = [];
    const verdicts: Verdict[] = [];
    for (let run = 1; run <= options.repeat; run++) {
      console.error(`Case ${c.id}: run ${run}/${options.repeat}`);
      const observation = await runCase(query, c, settings);
      observations.push(observation);
      verdicts.push(evaluate(c, observation));
    }
    rows.push({ id: c.id, gate: c.gate, observations, verdicts, verdict: c.gate === "control" ? aggregateControl(verdicts) : aggregate(verdicts) });
  }
}

async function main(argv: string[]): Promise<number> {
  const options = parseOptions(argv);

  if (options.cases.length === 0) throw new CommandError("no case to run");

  // Checked before anything starts: a folder that is not trusted would only
  // make every case stop at the trust dialog.
  let trusted: RunSettings["trusted"];
  let trustedBy: string | undefined;
  if (options.trustedDir !== undefined) {
    const configFile = claudeConfigFile(process.env, homedir());
    const resolved = await resolveTrustedDir(options.trustedDir, configFile);
    trusted = { dir: resolved.dir, configFile };
    trustedBy = resolved.trustedBy;
  }

  stripClaudeSessionEnv();
  const sdk = await loadSdk(options.sdkDir);
  console.error(`SDK ${sdk.version} (Claude Code ${sdk.claudeCodeVersion ?? "unknown"}) from ${sdk.entry}`);

  // Filled case by case, so that a series stopped by the trusted folder still
  // reports the cases that finished.
  const rows: Row[] = [];
  let stopped: TrustedDirError | undefined;
  try {
    await runAll(sdk.query, options, options.cases, trusted, rows);
  } catch (error) {
    if (!(error instanceof TrustedDirError)) throw error;
    stopped = error;
  }

  const header = {
    sdkVersion: sdk.version,
    claudeCodeVersion: sdk.claudeCodeVersion,
    model: options.model,
    folder:
      (trusted
        ? `trusted folder ${trusted.dir}` + (trustedBy !== trusted.dir ? ` (trust from ${trustedBy})` : "")
        : "fresh temporary folder") +
      (stopped ? ` (series stopped after ${rows.length} finished case(s): ${stopped.message})` : ""),
  };
  const report = formatMarkdown(rows, header);
  await new Promise<void>((done) => process.stdout.write(report, () => done()));

  if (options.out !== undefined) {
    const json = {
      ...header,
      sdkEntry: sdk.entry,
      repeat: options.repeat,
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

  if (stopped) throw stopped;

  const blocking = blockingRows(rows);
  if (blocking.length > 0) {
    console.error(`Absolute case(s) or control(s) not passing: ${blocking.map((row) => `${row.id} (${row.verdict.status})`).join(", ")}`);
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
  console.error(error instanceof CommandError || error instanceof SdkLoadError || error instanceof TrustedDirError ? error.message : error);
  exit(2);
});
