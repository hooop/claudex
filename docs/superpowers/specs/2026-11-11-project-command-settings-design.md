# Ask the human before Claude Code applies the project's command settings — design

Date: 2026-11-11. Branch: `fix/project-command-settings`. SDK: 0.3.310 (Claude Code 2.1.310).
All technical choices below were delegated to Claude by the maintainer ("décisions les plus
professionnelles", 2026-11-11); none of them was decided by the maintainer.

## Intent

Claudex promises a debate under direct human supervision, where nothing runs that the human did not
see. One measured exception remains (case L, `limits.md` 2026-11-11): an `apiKeyHelper` declared in
the analysed repository's `.claude/settings.json` is a shell command that Claude Code runs when a
session starts, without a prompt, during the debate as well as after `/implement`. No documented SDK
setting turns it off, and the debate isolation (PR #9) does not touch it.

The same project settings tier carries other values that act before any tool call, and that Claudex
cannot arbitrate through `canUseTool`:

- five other command-bearing credential helpers: `awsAuthRefresh`, `awsCredentialExport`,
  `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper` (read from 0.3.310's `sdk.d.ts`,
  `Settings` interface);
- `env`: "Environment variables to set for Claude Code sessions". A repository could set, for
  example, `ANTHROPIC_BASE_URL` and send the conversation (the code Claude read, and possibly the
  credential) to a server it controls. Not measured yet: this branch measures it (case M).

A credential helper is also a real enterprise feature: a company repository may legitimately name
one. So Claudex should neither silently allow nor silently refuse. It should show the human exactly
what the repository asks Claude Code to run or set, before anything runs, and let them decide.

## Goals

1. Before Claude's first session starts, Claudex reads the project settings itself (parse only,
   never execute) and, if they carry any of the values above, shows them to the human and waits
   for an explicit choice. Without that choice, no Claude session starts.
2. A value that appears or changes during the Claudex session (agents can write
   `.claude/settings.json` after `/implement`) never reaches Claude Code unseen.
3. The files Claudex reads are the files the engine reads as its project tier, established by
   measurement, not assumed.
4. README, `limits.md`, `decisions.md` and AGENTS.md say exactly what is closed and what is not.

## Non-goals

- Codex's own project configuration during a debate (unmeasured, listed in `limits.md`).
- Neutralising these values through SDK options (see rejected alternatives).
- Changing which setting sources each phase loads (`settingSources` stays as on main).
- The read-only Bash for Claude and the English pass (next branches on the roadmap).

## Anti-goals

- Claudex executing, evaluating or "testing" a helper command to judge it.
- Remembering a consent on disk. Anything stored in the project could be pre-seeded by the
  repository itself; storing it elsewhere would make Claudex write outside `.claudex/` and adds
  state to manage. The question is asked at every launch.
- A warning that shows while the command already runs. The check must come strictly before the
  `query()` call.
- Blocking a project because its settings file holds harmless keys (`permissions`, `model`,
  `outputStyle`...). Only the listed keys trigger the question.

## Decisions

### D1 — Claudex inspects the project settings itself

A pure function, in a new module `src/agents/projectSettings.ts` (no SDK import), takes the project
directory and returns a list of findings: for each settings file read, its path and the flagged
entries (key and exact value; for `env`, each variable name and value).

Flagged keys: the six credential helpers (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`,
`gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`) when present with any value, and `env`
when it is present with at least one key. The list lives in one exported constant with a comment
pointing at `sdk.d.ts` and at this design; it must be re-read at every SDK upgrade (added to the
upgrade checklist in AGENTS.md next to `verify:readonly`).

Added after the final branch review: one nested command-bearing key,
`extraKnownMarketplaces.<name>.source.headersHelper` (a command that prints HTTP headers for a
plugin marketplace), is flagged with its raw value, the marketplace name escaped like an `env`
name. A malformed `extraKnownMarketplaces`, entry or `source` is flagged raw rather than skipped.
A settings object with a top-level `__proto__`, `constructor` or `prototype` key is "cannot be
checked" ("unexpected key"). Not flagged, and recorded in `limits.md`: `statusLine.command`,
`subagentStatusLine.command` and `fileSuggestion.command` (interactive UI features), and the
repository's `permissions.allow` rules.

Fail closed:
- missing file: no finding;
- file present but unreadable, not valid JSON, or not a JSON object: one finding "cannot be
  checked", with the reason. Claudex does not guess what the engine would make of it;
- a flagged key whose value is not a string (helpers) or not an object (`env`): still flagged, the
  raw JSON value is shown.

Which files: at least `<cwd>/.claude/settings.json`. Whether the engine also reads a parent
directory's (git root's) `.claude/settings.json` or `.claude/settings.local.json` under the current
`settingSources` is measured in D4, and the function reads exactly the files the measurement shows
the engine reads. If the measurement shows a file the function cannot locate deterministically,
implementation stops and the maintainer is told.

### D2 — A consent prompt at launch, before the welcome screen

When D1 returns findings at launch, `src/cli.tsx` asks for consent before Root is rendered: the
list is printed as plain text to the normal screen, then a small Ink prompt (outside Root, not in
the alternate screen) waits for the key. This design first had Root show a full screen; see the
changes below. In French, like the rest of the UI for now. It shows:
- one sentence: this project's Claude Code settings ask Claude Code to run these commands or set
  these environment variables when each Claude session starts; Claudex cannot turn them off;
- per file: its path relative to the project, then each flagged entry with its exact value, not
  truncated (wrapped if long). Control characters in values are shown escaped, so a value cannot
  rewrite the terminal;
- two choices: continue with these settings, or quit. **Quit is the default** (Enter, Escape and
  Ctrl+C quit); continuing needs a distinct key (`y`), so a reflex Enter cannot consent.

Changes made during implementation, all Claude's calls (the first while building, the other two
raised by the code review):
- The key is `y`, not `o` as this design first said, for consistency with the permission prompt.
- A file Claudex cannot read or parse can no longer be consented to: only quit is offered, because
  Claude Code may parse what Claudex cannot (JSON with comments, a BOM), and approving it would
  approve content nobody saw. D1's "cannot be checked" finding still exists; it now blocks.
- The list and the prompt are split: the consent runs in `src/cli.tsx`, not in Root. The full list is
  printed as plain text to the normal screen, where the terminal's scrollback keeps it whatever its
  length, then a small Ink prompt (not in the alternate screen) asks for the key. A long list inside
  an Ink screen was lost when it overflowed the terminal.

Continue records an in-memory approval: the exact findings (canonical JSON of the list). Quit exits
Claudex with code 0 and a one-line message saying why nothing started.

Claude's call, raised by the design review: the check and the consent screen come before
`initMemoryScaffold`, which `src/cli.tsx` runs today before Ink renders. A refused project is left
exactly as it was: no `.claudex/` folder created. The builder chooses how (for example a small Ink
render for the consent alone in `cli.tsx`, then the scaffold, then Root). Codex is not started either:
Claudex is a two-agent debate, a debate without Claude is not a product mode.

When D1 returns no finding, nothing changes for the user: no screen, no extra delay worth noting
(two small file reads).

### D3 — The check runs again before every Claude session

`ClaudeAgent` receives a guard (injected through its constructor options, so tests use a fake) that
it calls immediately before every `query()` call, debate and implementation turns alike. The guard
re-runs D1 and compares with the approved findings:
- no finding: proceed (keys removed since launch need no consent);
- identical to the approval: proceed;
- anything else (a new key, a changed value, a new file, a file that became unreadable): `query()`
  is not called. The turn ends through the existing failure path with an explicit French message:
  the project settings changed during the session, the turn was not sent, quit and relaunch Claudex
  to review them. The scheduler already handles a failed turn; no new scheduler state.

Why not ask again in place: a mid-session consent needs a new modal state in the scheduler for a
rare case (the repository's settings changed under a running session, almost always by the agents
after `/implement`). Relaunching reuses D2 with nothing new to build, and the debate memory survives
a relaunch.

Known window: the file could change between the guard's read and the engine's own read at
`query()` start. During a debate nothing can write it (Claude has read-only tools, Codex a read-only
sandbox); after `/implement` the window is the time between two synchronous steps. Accepted and
written in `limits.md`.

Inside a running `/implement` turn (Claude's call, raised by the design review): Claude Code may
reload its settings while a session runs (it has a `ConfigChange` hook event, and re-runs
`apiKeyHelper` on a TTL). A helper or `env` value that an agent writes during that turn could then
apply before D3 runs again. This branch does not close or measure it, for a stated reason: the
threat this branch addresses is the analysed repository, reviewed at launch. A mid-turn change is
written by an agent during the implementation phase, which is trusted by design (decision
2026-11-11, D4 of the isolation branch). Nothing guarantees the human sees such a write first.
Claude's permission prompt (`canUseTool`) shows a write only when no allow rule has already
approved it: allow rules, the user's or the analysed repository's own `permissions.allow` (which the
consent screen does not show), are resolved before `canUseTool`, and whether Claude Code shields its
own settings files from them was not measured. A Bash write shows only the command, not the files it
changes. With `/implement codex`, Codex writes with `approvalPolicy: "never"`
(`src/agents/codexAgent.ts`): no prompt at all. In every case D3 catches the change only before the
next Claude turn. `limits.md` and the README state this gap plainly, without calling it small.

### D4 — Measure which files the engine reads, and the `env` vector

New `record` cases in `scripts/readonly-verification/cases.ts`, run with `npm run verify:readonly`
in fresh and trusted folders, twice each, by the main session only (as on the isolation branch):

| Case | Setup | Records |
| --- | --- | --- |
| L (existing) | `apiKeyHelper` touching the marker in `<cwd>/.claude/settings.json` | marker written? |
| L-parent | same helper in the `.claude/settings.json` of a git repository root; `cwd` is a subfolder of it | marker written? |
| L-local | same helper in `<cwd>/.claude/settings.local.json` | marker written? |
| M | `env: { ANTHROPIC_BASE_URL: <local listener URL> }` in `<cwd>/.claude/settings.json` | did the listener receive a request? |

For M, the listener is an HTTP server on `127.0.0.1` started by the script, which records only that
a request arrived (method and path) and answers with an error; it never logs headers or body,
which may carry the maintainer's credential. The run uses debate options (`settingSources:
["project"]`). The implementation options load `["project", "user"]`: the project files are the
same, so the D1 file list covers both phases; this is stated, not measured.

Results drive D1's file list and go into `limits.md`. Whatever the results, the consent gate ships:
an unmeasured or negative result for a key does not remove it from the list (the engine may read it
under conditions the run did not create, such as a Bedrock or Vertex setup).

### D5 — What the gate is measured by

The gate is Claudex code, not an SDK option: unit and UI tests prove it (see Tests). `verify:readonly`
cannot exercise the Ink screen; it records the engine's behaviour that makes the gate necessary.
The manual smoke test of the PR covers the screen once with a real helper.

## Alternatives rejected

- **Override the helpers in the flag tier** (`settings: { apiKeyHelper: "" }`): the meaning of an
  empty helper is undocumented; it cannot neutralise arbitrary `env` keys; during `/implement` it
  would also override a legitimate helper from the user's own settings.
- **Drop `"project"` from `settingSources`**: loses the project's CLAUDE.md, kept on purpose
  (decision 2026-10-26), and `/implement` loads the project tier anyway.
- **Refuse any project that declares a helper**: blocks legitimate enterprise setups; the product
  principle is to put the human in charge, not to decide for them.
- **Warn without blocking**: the command would already be running when the human reads the warning.
- **Remember the consent per project**: see anti-goals.

## Tests (written first)

- `projectSettings`: no file; empty object; harmless keys only; each of the six helpers; `env` empty
  (no finding) and non-empty; non-string helper value; `env` not an object; invalid JSON; JSON array
  or scalar at top level; unreadable file (permission denied, a directory in place of the file);
  every file of the measured list; canonical comparison is order-independent for object keys.
  Added after the final review: marketplace header helper present (exact key and value), absent,
  escaped name, malformed shapes; top-level `__proto__`, `constructor`, `prototype` keys.
- Consent prompt (as shipped: `formatConsentText` and the `SettingsConsent` Ink prompt rendered by
  `src/cli.tsx` outside Root, and `prepareLaunch` in `src/launch.ts`): findings shown with exact
  values, control characters escaped; Enter, Escape and Ctrl+C quit and no agent is ever called;
  `y` (changed from `o` during implementation, see D2) continues to the welcome screen; no findings
  means no prompt.
- `ClaudeAgent` (mocked `query`, as in the existing adapter tests): guard called before every
  `query()`, debate and implementation; a rejecting guard means `query()` never called and the turn
  fails with the message; an accepting guard leaves behaviour unchanged.
- Guard: identical findings pass; new key, changed value, new file, file became unreadable all
  reject; findings removed pass.
- `cases.ts`: unit tests for the new cases' setup (files written where expected, listener records
  no headers), under `scripts/**/__tests__` like the existing ones.

## Repository changes, in order

1. Measurement cases L-parent, L-local, M and their unit tests; run them; record results.
2. `projectSettings.ts` and its tests, file list from step 1.
3. Guard and `ClaudeAgent` wiring, with tests.
4. Consent prompt (planned in Root, shipped in `src/cli.tsx`, see D2), with tests.
5. Docs: README (known gap replaced by the consent behaviour, with what was measured), `limits.md`,
   `decisions.md` (this branch's decisions and rejected alternatives), AGENTS.md (constraint
   paragraph and the SDK-upgrade checklist).

Plan shape (Claude's call): one plan, approved once. Step 1 runs first, in the main session. D1
reads its file list from one constant; the plan writes the expected outcomes of step 1 (only the
`cwd` file; plus the local file; plus the git root's file, found by walking up to the nearest
directory containing `.git`) and the change each one implies. Any other outcome is a stop point.

## Rollback plan

The change is additive and stores nothing: no file written, no migration, no persisted consent.
Rolling back is reverting the PR's commits; Claudex then behaves as on main (helper runs unseen,
README's known-gap paragraph comes back with the revert). The measurement cases are independent of
the gate and can stay if only the gate is reverted.

## Stop points

- The maintainer approves this design, then the detailed plan, before any implementation (risky
  change: security behaviour).
- No new dependency is expected; if one seems needed, stop and ask.
- If D4 shows the engine reads a settings file D1 cannot locate deterministically, or reads
  settings from a place not in this document, stop and report.
- If M shows the engine sends the conversation to the listener, report it to the maintainer in the
  same message as the results, as a security finding, before continuing.

## Known gaps, out of scope (reported, not fixed here)

- Codex's project configuration during a debate: unmeasured.
- Folders never trusted by Claude Code: cannot be measured on the maintainer's machine (`/` is
  trusted there on purpose).
- Linux and Windows: unmeasured.
- The time window described in D3.

## Left to the builder

- Exact French wording of the screen and the failure message (short, plain, no jargon).
- Layout of the consent screen, within the existing theme.
- The canonical form used to compare findings.
- How the listener port is chosen in M (an ephemeral port is fine).
