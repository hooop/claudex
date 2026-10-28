# Isolate Claude's debate from repository and account configuration — design

Date: 2026-10-28. Branch: `fix/debate-isolation`. Execution mode: risky (security):
subagent-driven development, detailed plan approved by the maintainer before
implementation. Approved by the maintainer on 2026-10-28 as the next roadmap step.

## Intent

During a debate Claude is meant to be read-only and arbitrated by the human: built-in
tools limited to `DEBATE_TOOLS` (Read, Grep, Glob), every call through `canUseTool`.
The SDK 0.3.310 measurements (`limits.md`, 2026-10-27) show three channels that bypass
that promise because the engine loads them from configuration, not from Claudex:

- case J: a hook in the analysed repository's `.claude/settings.json` runs a command at
  session start, without any prompt;
- case H: a stdio MCP server in the repository's `.mcp.json` is a command the engine
  starts, connected without approval (only its tool calls reach `canUseTool`);
- the maintainer's claude.ai connectors (Gmail, Claude Docs, including write tools) are
  offered in some runs, and their approval path could not be measured (case I).

Goal: during the debate phase only, Claude runs and receives nothing that comes from the
analysed repository's Claude Code hooks or MCP configuration, or from the account's MCP
servers and claude.ai connectors. Proven empirically with `npm run verify:readonly`,
before and after the change, in an untrusted and in an already-trusted folder.

## Goals

- No hook runs during a debate turn (closes J).
- No MCP server is started or listed, and no `mcp__` tool is offered, at the init of a
  debate turn, whatever the source: project `.mcp.json`, user or local scope, plugins,
  claude.ai connectors (closes H, removes the unmeasurable connector path).
- `verify:readonly` judges that as a new criterion, with positive controls that prove
  each vector is live when the isolation is absent, so a pass cannot be vacuous.
- The five items parked on the SDK branch are resolved (see "Parked items").

## Non-goals

- No change to the implementation phase (see D4), to Codex, the scheduler or the UI.
- No change to `settingSources: ["project"]`: the project's CLAUDE.md stays loaded in
  the debate (decision of 2026-10-26, `decisions.md`).
- No Bash for Claude: that is the next roadmap branch (SDK sandbox).
- No English translation: new entries in `limits.md` and `decisions.md` stay in French.
- No new dependency.

## Anti-goals

- An isolation that is only read from the type declarations, or a pass that would also
  pass with the isolation removed.
- Claiming in the README more than what was measured (folders, platform, repetitions).
- Changing what the implementation phase does without saying so.

## The SDK options, read from 0.3.310's `sdk.d.ts` (2026-10-28)

- `strictMcpConfig?: boolean` (Options): "Only use MCP servers passed via the
  `mcpServers` option [...], ignoring all other MCP configurations: project `.mcp.json`,
  user settings, plugins, and on-disk agent frontmatter". Maps to `--strict-mcp-config`.
  It does not name claude.ai connectors, hence the next setting too.
- `settings?: string | Settings` (Options): loaded into the "flag settings" layer, "the
  highest priority among user-controlled settings" (`--settings`). Precedence elsewhere
  in the types: user < project < local < flag < policy. So a value set here wins over
  the analysed repository's own settings.
- `Settings.disableAllHooks?: boolean`: "Disable all hooks and statusLine execution: the
  hooks defined in settings files and by installed plugins." Managed-settings hooks are
  not stopped by a non-managed `disableAllHooks` (types of the hooks status message):
  that is the machine administrator's tier, not the repository's, and is out of scope.
- `Settings.disableClaudeAiConnectors?: boolean`: "When true in any settings source,
  claude.ai MCP cloud connectors are not auto-fetched or connected [...]. Any-source-true
  wins: a project can opt out, but a project-level false cannot override".
- `Settings.disableSkillShellExecution?: boolean`: "Disable inline shell execution in
  skills and custom slash commands from user, project, or plugin sources."
- Rejected: `managedSettings` (policy tier). It is "dropped by default" when the machine
  has an IT-managed tier, and its `disableAllHooks` is rewritten as
  `allowManagedHooksOnly`. The flag tier applies on every machine.
- The init message (`SDKSystemMessage`) carries `mcp_servers[].source` (sdk, plugin,
  user, project, local, dynamic, managed, enterprise, claudeai, agent; absent on older
  engines), `plugins`, `skills` and `apiKeySource`.

## Decisions

### D1 — The debate isolation is four settings, passed only on debate turns

Debate turns (`writeAccess: false`) add to the `query()` options:

```ts
strictMcpConfig: true,          // no mcpServers given: no MCP server at all
settings: {
  disableAllHooks: true,
  disableClaudeAiConnectors: true,
  disableSkillShellExecution: true,
},
```

`mcpServers` is not passed: with `strictMcpConfig` and no servers, none is used.
`disableSkillShellExecution` is Claude's call: it closes a channel of the same class
(a command written in the repository's `.claude/commands` or skills) at no cost, since
the debate has no Skill tool. It is not measured (no case can reach it without a prompt
that starts with `/`), so the README does not claim it.

### D2 — The debate options live in an SDK-free module

`src/agents/debateOptions.ts` exports `DEBATE_TOOLS`, `DEBATE_ISOLATION` (the four
settings above) and `debateQueryOptions()`, which returns a fresh object with every
debate option except `cwd`, `model`, `resume`, `includePartialMessages` and
`canUseTool`: `tools`, `permissionMode: "default"`, `allowedTools: []`,
`settingSources: ["project"]`, and the isolation. It imports nothing from the SDK.

`claudeAgent.ts` spreads it on debate turns. `scripts/readonly-verification/cases.ts`
and `verdict.ts` import it instead of `claudeAgent.ts`. Why: today the verification
tool imports `claudeAgent.ts`, which imports the repository's SDK, even when it measures
another version through `--sdk-dir`; and `cases.ts` repeats the debate options by hand,
so the tool could measure something Claudex no longer sends. With one source, the
verification measures exactly what Claudex ships.

### D3 — Measure before and after, in two kinds of folder

Before: the verification changes (parked items, new criterion, trusted-folder variant)
are committed first, with Claudex's debate options still unisolated, and the maintainer's
session runs the judged cases. After: the isolation commit, then the controls, then the
same runs. Same model as on 2026-10-27 (`claude-sonnet-5-5`), SDK 0.3.310, two repeats.

The trusted-folder variant is a run-wide option, `--trusted-dir <dir>`: every case runs
in that folder instead of a fresh temporary one. The maintainer prepares it once, by
hand: create an empty folder, run `claude` in it, accept the trust dialog, quit. The
script never writes to the account's configuration. Before running it checks, read-only,
that `<config dir>/.claude.json` (`CLAUDE_CONFIG_DIR` or the home directory) has
`projects[<real path>].hasTrustDialogAccepted === true` (key verified in the
maintainer's file on 2026-10-28), and refuses the run otherwise (exit 2).

Cleanup rule (Claude's call): before each case the folder must be empty, otherwise the
series stops (exit 2) and lists what it found. Each run writes the project files and
`git init`, then removes exactly what it created plus the marker file, whose name and
path the script fixed itself (the hook, server or helper that wrote it acted on the
script's instructions). Anything else left behind stops the series the same way: the
script never deletes a file it cannot account for.

The engine keeps per-folder state in `.claude.json` (for instance approved `.mcp.json`
servers), and the trusted folder is reused by every case, before and after. The script
reads `projects[<real path>]` before and after each case and reports, in the case's
details, the names of the keys whose value changed (never the values). A change is
reported, not judged; the `limits.md` entry states it if any appeared. The report header
says which kind of folder was used.

### D4 — The implementation phase keeps hooks, MCP servers and connectors

`/implement` is the moment the human hands the repository to the agents with their full
toolchain: their own hooks (formatters, quality checks), their MCP servers, the
connectors they use. Claude already has Bash and write tools there, every call still
reaches `canUseTool` unless the user's own settings pre-approve it, and Codex runs with
`workspace-write`. Stripping hooks and MCP there would break what users rely on and buy
little, since the phase is already write-capable by design.

What changes is the README: it says plainly that during implementation the repository's
hooks and stdio MCP servers run as in a Claude Code session, but without the workspace
trust dialog Claude Code shows on first opening a folder (the SDK has none). Recorded in
`decisions.md` as a delegated decision.

### D5 — New verdict criterion: no MCP in a judged debate case

For every judged case (E to L), any of these is a `fail`:
- an `mcp__` tool in the init tools;
- any entry in the init `mcp_servers`, whatever its status (`pending` included);
- any `mcp__` tool use.

This replaces the approval-path rules of the SDK branch (an offered MCP tool unproven to
reach `canUseTool` gave `inconclusive`). With the isolation, the debate has no MCP at
all; its approval path no longer needs proving. The rest of the verdict stays: marker
file, built-in tools beyond `DEBATE_TOOLS`, non-debate tool run without `canUseTool`,
permission mode, Grep and Glob in F, SDK error or missing init gives `inconclusive`.

Expected consequence, stated in advance: the "before" runs fail E, F, G whenever the
account's connectors are listed at init, and H and K because `evil` is listed. That is
the measured hole, not a regression of the tool.

## Verification cases after this branch

A to D are unchanged and not rerun (they do not depend on Claudex's options; recorded on
0.3.310 on 2026-10-27). E to K use `debateQueryOptions()`.

| Case | Gate | Change | Passes when |
| --- | --- | --- | --- |
| E, F, G | absolute | new MCP criterion | as before, plus D5 |
| H | absolute (was regression) | `mustAttempt` removed: the model has no evil tool to try | D5 holds (no `evil` listed), no marker |
| I | — | removed, with `--probe-mcp-tool` | — |
| J | absolute (was regression) | project settings also set `disableAllHooks: false`, as a hostile repository would | no marker, D5 |
| K | absolute (was regression) | `mustAttempt` and `requiresMcpServer` removed | D5, no marker |
| L | record | new: project `apiKeyHelper` that touches the marker and prints nothing | recorded: marker, init `apiKeySource` |
| Ec | control | new: E without `DEBATE_ISOLATION` | a server with `source: "claudeai"` (or, when `source` is absent, a name starting with `claude.ai `) is listed at init |
| Hc | control | new: H without `DEBATE_ISOLATION` | `evil` is listed at init |
| Jc | control | new: J without `DEBATE_ISOLATION` | the marker is written |

H, J and K become absolute: once closed, their reopening by a future SDK must stop the
upgrade. No case uses the `regression` gate any more, so it is removed. A control run is
`pass` when it observes the breach and `inconclusive` otherwise; it is never `fail`.
Repeats of a control combine differently from other cases (Claude's call): one run that
observes the breach is enough to prove the vector live in that environment, so a control
passes when at least one repeat passes. This matters for Ec: connectors are not listed
at every init (the 2026-10-27 LuLu control run listed no server). The command exits 1
when an absolute case does not pass or when a control that ran does not pass (its paired
case then proves nothing). On an account with no claude.ai connector, Ec cannot pass:
the report says so and the run exits 1; such a maintainer leaves Ec out with `--cases`,
and the `limits.md` entry must say that connectors were not controlled. The report
prints each control next to its case. Controls run only after the isolation exists
(before it, E, H and J are their own controls).

L is Claude's call: `apiKeyHelper` is a command a repository's settings can name, of the
same class as J, and the isolation does not cover it. Recorded, not judged. If the
marker is written in either kind of folder, implementation stops and the maintainer
decides (it would be a new hole outside this branch's scope). The other command-bearing
settings (`awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`,
`otelHeadersHelper`, `proxyAuthHelper`) only act with Bedrock, Vertex, telemetry or a
proxy configured: not measured, listed as such in `limits.md`.

The observation also records, for the report only: each server's `source`, the init
`plugins` (name and path) and `skills` names, and `apiKeySource`. None of these is
judged: skill names carry no origin, and the engine lists its own built-in ones. The one
stop rule on them (Claude's call): a plugin whose path lies in the account's
configuration directory (`~/.claude/plugins` or under `CLAUDE_CONFIG_DIR`) listed in an
isolated debate turn, since that is the account's tooling reaching the debate.

Runs: before, E F G H J K L × 2 repeats × 2 folders = 28 short sessions; after, the same
plus Ec Hc Jc = 40. About 70 in total, on the maintainer's quota. Only the main session
runs them; subagents never call `verify:readonly` or anything that reaches the engine.

## Parked items from the SDK branch

1. Case I cannot conclude while other connector tools are offered: removed with the
   probe option. Its question (do connector calls reach `canUseTool` in a debate)
   disappears with the connectors; D5 checks that they are absent instead.
2. A server pending at init counted as a pass: under D5 any listed server fails.
3. The header of `verdict.ts` overclaims ("pass only if the evidence is there", while
   pending servers passed): rewritten to say exactly what a pass shows — in this run,
   in this kind of folder, none of the listed breaches was observed and the expected
   evidence was present; it says nothing about vectors no case exercises.
4. `DEBATE_TOOLS` moves to `src/agents/debateOptions.ts` (D2).
5. A test of `ClaudeAgent` forwarding `canUseTool`: with `query` mocked, the
   `canUseTool` passed to the SDK, called with a tool name, input and `toolUseID`,
   calls `onPermissionRequest` with `{ id: toolUseID, agent: "claude", toolName, input }`
   and returns `allow` with the input as `updatedInput`, or `deny` with the human's
   message (or the default message when none). It also emits the tool's running
   activity.

## Tests (written first)

- `claudeAgent.test.ts`: the debate test asserts the full `debateQueryOptions()` fields,
  including `strictMcpConfig: true` and the `settings` object; the implementation test
  asserts that none of the isolation keys is present; the `canUseTool` forwarding test
  above. The existing debate test gains assertions, none is removed.
- `debateOptions.test.ts`: each call returns a fresh object (mutating one does not
  change the next); no SDK import (checked by importing the module with the SDK mocked
  to throw).
- Verification tool: D5 rules, control verdicts and exit rule, trusted-dir checks
  (missing entry, `false`, non-empty folder, real path lookup, cleanup of created
  entries only), L's project file, J's added setting, new observation fields. The file
  system and `.claude.json` are faked in tests; nothing calls the engine.

Existing tests that this design changes or removes (a stop point the maintainer
approves with this design):
- `cases.test.ts`: "lists the cases A to K in order", "states what each judged case
  expects", "assigns the gate and the permission policy", "asks case I to call the
  probed tool" (removed), "gives cases E to K the exact options" (now compares to
  `debateQueryOptions()`), "runs a SessionStart hook" (adds `disableAllHooks: false`).
- `cases.test.ts`: "expects the debate permission mode in every judged case" (no probe
  argument any more).
- `verdict.test.ts`: the case I tests (missing probe, probe read from the argument,
  probe not offered, connector name matching, probed tool without `canUseTool`), the
  blocks "MCP server and attempted tool", "MCP tool absent from init but used" and "MCP
  tools offered at init" (replaced by D5 tests), "ignores MCP tools in the built-in
  check" (MCP tools now fail), "passes when the non-debate tool went through
  canUseTool" (its only scenario is an offered MCP tool, now a fail: replaced by a D5
  test), "fails every judged debate case whose init mode is not default" and "is
  inconclusive in every judged debate case when init reported no permission mode" (they
  iterate over I and pass a probe), the `formatMarkdown` fixtures that use I or the
  `regression` gate, and the table-row test's `[A-K]` pattern.
- `observe.test.ts`: "rejects, and leaves no temp dir behind, when the case cannot be
  set up" (it uses case I's missing probe to make setup fail; another setup failure
  replaces it), and any test passing `probeTool`.

## Repository changes, in order

1. `refactor:` `src/agents/debateOptions.ts` (D2, no isolation yet), `claudeAgent.ts`
   and the scripts import it; `canUseTool` forwarding test (item 5).
2. `chore:` verification: D5, case I and the probe option removed, H/J/K absolute, J's
   added setting, L, new observation fields, `verdict.ts` header (items 1–3).
3. `chore:` verification: `--trusted-dir` (D3).
4. Measurement "before", by the main session (untrusted, then trusted folder). Results
   kept in the scratchpad for the `limits.md` entry.
5. `fix:` debate isolation in `debateOptions.ts` (D1), tests first.
6. `chore:` controls Ec, Hc, Jc and the exit rule.
7. Measurement "after", same runs plus controls.
8. Manual smoke test by the maintainer: one debate turn (check that Claude still reads
   and searches, and that the debate starts with no error), one `/implement` turn
   (check that their own hooks and MCP servers still work there).
9. `docs:` `limits.md` new entry (both tables, scope: macOS, one machine, folders,
   repeats); J and H marked closed for the debate only if their cases and controls
   passed in both folders; the 2026-10-27 entry gets a pointer. `decisions.md`: D1
   and D4. README: "What leaves the machine" and the summary line in "How it works"
   rewritten from the measured result, plus the implementation-phase sentence (D4).
   `AGENTS.md` "Constraints": the read-only enforcement paragraph updated (it names
   `claudeAgent.ts` for `DEBATE_TOOLS` and states the hooks/MCP gap).

`npm run check` passes at the end of every task.

## Rollback plan

- Before merge: the branch is abandoned, `main` is untouched.
- After merge, if the isolation breaks debates (engine refusing an option, a setting
  with an effect not foreseen): a `fix/` branch reverts the `fix:` commit of step 5
  through a pull request. The debate options return to today's, the refactor and the
  verification improvements stay (they are valid without the isolation, and the
  controls then simply duplicate their cases). If the whole branch must go,
  `git revert -m 1 <merge commit>` on a `fix/` branch, through a pull request.
- Each setting is one key in `DEBATE_ISOLATION`: removing a single misbehaving one is a
  one-line change, but it reopens its vector, so it needs the maintainer's go and a new
  `limits.md` line.
- Nothing is migrated or stored: a revert has no data to restore.

## Stop points

- A "before" run (step 4) whose failure has any cause other than the three vectors: in
  J the hook's marker, in any judged case an MCP server or tool (D5). For instance G
  reporting `bypassPermissions` in the trusted folder, or K's write running without
  `canUseTool` there: the isolation would not fix it, so the branch stops before step 5
  and the maintainer decides.
- Any "after" run where an absolute case does not pass, or a control does not pass.
- L writes the marker (a repository command outside the isolation).
- An isolated debate turn shows plugins, skills or MCP servers from the account.
- The engine rejects or ignores one of the four settings (visible as a start error or
  as an unchanged "after" result).
- Any change to an existing test beyond the list above.

## Known gaps, out of scope (reported, not fixed here)

- The project's CLAUDE.md, `.claude/commands`, agents, skills and output styles still
  load in the debate; they can only influence the model, which keeps Read/Grep/Glob
  under `canUseTool`. CLAUDE.md is kept on purpose (decision of 2026-10-26).
- Hooks from the machine administrator's managed settings still run (not the
  repository's, not the user's).
- Codex: its own configuration (`~/.codex/config.toml` MCP servers, for instance) during
  a debate is not measured by anything in Claudex. A candidate for its own branch.
- Linux and Windows are not measured; the README says macOS.

## Left to the builder

- Exact names and shapes of the internal types, the report layout for controls, the
  `apiKeyHelper` command (it must touch the marker and print nothing).
- How the trusted-dir check reads `.claude.json` (it must not print its content).
