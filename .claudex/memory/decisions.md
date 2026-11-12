# Decisions

Log of the decisions validated at the end of a Claude ↔ Codex debate.

## 2026-11-12 — Denser debate messages and evidence excerpts

**Nature:** maintainer arbitration (less verbose debate output). Design:
`docs/superpowers/specs/2026-11-12-less-verbose-output-design.md`.

**Measured baseline:** Claude's debate messages have a median of 321 words and a p90 of 988.

**Decision:** `CONSENSUS_INSTRUCTIONS` asks both agents, identically, for density: as briefly as
possible but as precisely as necessary, about 200 words as a target and not a limit, position or
main objection first, no introduction, no restating of the other's message, no empty recap, one or
two important arguments per message, headings or lists only when they help. Text written before a
tool call is declared a private working note: the message is written after the last tool call and
must stand on its own.

**Amendment to the evidence rule of 2026-08-17** ("exact command and raw output"): an excerpt is
now allowed instead of the whole output, provided that the exact command is given, the excerpt keeps
the context needed to read it, errors and meaningful exit codes are kept, and it never misrepresents
the overall result (for example quoting passing tests while others failed) and says what was left
out. The requirement of evidence and its symmetry are unchanged; full outputs stay available in the
diagnostic log when the adapter has them.

**Rejected:** a hard word limit or truncation of messages. It would cut the technical demonstrations
that need length, and a truncated message could drop the end marker or the very conclusion the other
agent must check. Density is asked for as a target instead.

**Files involved:** `src/orchestrator/scheduler.ts`, `src/orchestrator/__tests__/markers.test.ts`.

## 2026-11-11 — Claude has a sandboxed Bash during the debate (macOS); the execution asymmetry is reopened

**Nature:** the maintainer put the feature on the roadmap (2026-10-28) and delegated
all technical choices on 2026-11-11; decisions D1 to D9 are therefore Claude's, not the
maintainer's. Design: `docs/superpowers/specs/2026-11-11-sandboxed-bash-design.md`. Measurements in
`limits.md` (2026-11-11, sandboxed Bash).

**Reopening, stated as such:** the decision of 2026-08-17 ("The execution asymmetry stays as
it is") is reopened. New reason: on SDK 0.3.310, the engine's sandbox gives Claude's Bash
an operating-system guarantee (write refused, no network) that human
approval could not give. The reason that had ruled out "Bash under human approval" still holds
and is not reopened: the human is not the guarantee, the OS is. Added to this is the
maintainer's finding that Claude ran no command with the previous version.

**Decisions:**
- **D1: `sandbox` block** on debate turns only: `enabled`, `failIfUnavailable: true`,
  `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed: true`, network closed
  (`allowedDomains: []`, `strictAllowlist: true`), `denyWrite` on the real path of `cwd` (the relative
  `.` does not block, `/var` is a symbolic link). Path not resolved: the turn fails.
- **D2: macOS only**, decided by Claudex before the turn (`resolveDebateSandbox`). Elsewhere, the
  options of today, unchanged. Never Bash without a sandbox, never a retry without Bash.
- **D3: no per-command prompt** (`autoAllowBashIfSandboxed`), like Codex with `approvalPolicy:
  "never"`; commands that name a path outside the project still go through `canUseTool`.
- **D4: reading of secret stores denied** (`.ssh`, `.aws`, `.config/gh`, `.claude`, `.codex`,
  `.npmrc`, etc.), with the real paths of symbolic links added. `.gitconfig` is not denied (git
  breaks). `.npmrc` stays: `npm test` runs with it denied.
- **D4b: secret environment variables masked** (`sandbox.credentials.envVars`, `deny` mode)
  for any name containing KEY, SECRET, TOKEN, PASSWORD or CREDENTIAL. Heuristic.
- **D9: Claudex removes the empty directories the engine creates in the project** (`.claude/`,
  `.claude/.cc-writes/`) if they were absent before the turn: non-recursive `rmdir`, so content is never
  deleted (`src/agents/engineLeftovers.ts`).
- Rollback: `resolveDebateSandbox` returning `null` restores the previous options.

**Rejected:**
- Human approval per command: it is not a guarantee (2026-08-17) and makes the tool unusable.
- Denying the whole home directory: breaks git and the tools; a list is a mitigation,
  not a guarantee, and the README says so.
- Linux/WSL without measurement: the guarantee is the whole point; a separate branch with a Linux measurement.
- The shared `codex app-server` executor of 2026-08-17: unnecessary, each agent has its own sandboxed executor.

**What is not demonstrated:** a folder never trusted (only fresh and trusted folders under
a trusted `/` are measured); a single machine, a single account; see `limits.md`.

## 2026-11-11 — The repository's command-bearing settings require the human's consent

**Nature:** arbitration delegated by the maintainer ("most professional decisions", 2026-11-11, translated from French);
none of these decisions was taken by the maintainer. Design:
`docs/superpowers/specs/2026-11-11-project-command-settings-design.md`. Measurements in `limits.md`
(2026-11-11, consent).

**Decisions:**
- **D1: Claudex reads the project's settings itself, without ever running anything**
  (`src/agents/projectSettings.ts`). File read: `<cwd>/.claude/settings.json` only
  (`PROJECT_SETTINGS_FILES`), the only one the measurements show the engine reading (Lp and Ll negative).
  Flagged: the six helpers of `COMMAND_SETTING_KEYS` (`apiKeyHelper`, `awsAuthRefresh`,
  `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`, collected from
  the `Settings` interface of `sdk.d.ts`), any `env` entry and, added after the final review, the plugin
  marketplace declarations (`extraKnownMarketplaces` and its documented alias `additionalMarketplaces`),
  shown whole: they carry commands, URLs and helpers at several levels, which a list of
  fields would miss, and the guard thus reacts to any change (a moved URL). Not measured: whether
  the engine fetches or runs anything from a marketplace declared by the project. Not shown, recorded in
  `limits.md`: `statusLine.command`, `subagentStatusLine.command`, `fileSuggestion.command` and the
  repository's `permissions.allow` rules. The file is opened non-blocking and
  must be a regular file of 1 MiB at most; anything Claudex cannot read or parse
  (invalid JSON, comments, BOM, anything other than an object, top-level key `__proto__`,
  `constructor` or `prototype`, special file, too large, permission)
  gives an "unreadable" finding.
- **D2: consent at launch, before any write and before any agent** (`src/launch.ts`,
  `src/cli.tsx`, `src/ui/components/SettingsConsent.tsx`). No `.claudex/` for a refused project;
  neither Root nor Codex starts before the answer. The full list is printed as plain text in
  the normal screen (the terminal history keeps it, whatever its length), then a small
  Ink prompt: `y` continues (without Alt or Ctrl; pastes are ignored thanks to bracketed paste; the
  keys of the first 250 ms are ignored); `n`, `q`, Enter, Esc, Ctrl+C quit; quitting is
  the default. Key `y` and not `o` as the design said: consistency with the permission prompt.
  Any text coming from the repository is escaped (control, format, bidi, zero-width characters,
  displayed as `\uXXXX` / `\u{...}`).
- **An "unreadable" finding makes consent impossible** (only "quit" is offered):
  Claude Code can parse what Claudex cannot read (JSON with comments, BOM); approving it
  would amount to approving content nobody has seen. The design allowed consenting to it; tightened
  during the review. Cost: a project with JSONC settings cannot be debated until it is
  fixed.
- **D3: the guard re-reads the file before every Claude query** (debate and `/implement`,
  `createSettingsGuard`, called by `ClaudeAgent` before `query()`). No finding, or identical to
  the approval: the turn goes out. Otherwise the turn is not sent and fails with a message that
  asks to quit and relaunch. A guard that throws an error also refuses the turn.
- **Consent is never stored**: stored in the project, a repository could pre-fill it;
  elsewhere, Claudex would write outside `.claudex/`. The question comes back at every launch.
- **Gap accepted during an `/implement` turn** (see `limits.md`): not measured, not closed. The
  implementation phase is trusted by design (decision 2026-11-11, D4 of the isolation). Nothing
  guarantees that the human sees a write to `.claude/settings.json` before it happens: the
  `allow` rules (the user's, or the repository's `permissions.allow`, which the consent screen does not
  show) are resolved before `canUseTool` and can approve the write without a prompt (we have not
  measured whether Claude Code protects its own settings files against them); a write through Bash
  shows only the command; with `/implement codex`, Codex writes with `approvalPolicy: "never"`,
  without any prompt. The guard sees it only before the next Claude turn. Accepted knowingly,
  not because it would be small.
- **D4/D5:** cases L, Lp, Ll, M of `verify:readonly` measure the engine behaviour that makes the
  gate necessary; the gate itself is Claudex code, proven by the unit and
  interface tests, and checked by hand in a pty.

**Alternatives rejected:**
- Neutralising the helpers in the "flag" layer (`settings: { apiKeyHelper: "" }`): the meaning of an
  empty helper is not documented; cannot neutralise an arbitrary `env` entry; would overwrite in
  `/implement` a legitimate helper from the user's settings.
- Removing `"project"` from `settingSources`: loses the project's CLAUDE.md (decision of 2026-10-26), and
  `/implement` loads the project layer anyway.
- Refusing any project that declares a helper: blocks legitimate enterprise setups; the
  principle is to let the human decide.
- Warning without blocking: the command would already be running when the human reads the warning.
- Storing consent per project: see above.
- Asking for consent again mid-session: a new modal state of the scheduler for a rare case;
  relaunching reuses the launch screen, and the debate memory survives a relaunch.

**Files involved:** `src/agents/projectSettings.ts`, `src/agents/claudeAgent.ts`, `src/launch.ts`,
`src/cli.tsx`, `src/ui/Root.tsx`, `src/ui/components/SettingsConsent.tsx`,
`scripts/readonly-verification/`, `README.md`, `AGENTS.md`.

**How to apply:** do not reopen storing consent or consenting to an unreadable file
without a new reason. At every SDK upgrade, re-read `COMMAND_SETTING_KEYS` against `sdk.d.ts`
and rerun Lp and Ll to confirm `PROJECT_SETTINGS_FILES` (see `limits.md`).

---

## 2026-11-11 — Claude's debate runs no hook, no MCP server and no connector

**Nature:** arbitration delegated by the maintainer (design approved on 2026-10-28, "most
professional decisions", translated from French). Measurements in `limits.md` (2026-11-11).

**Decisions:**
- **D1: four settings, on debate turns only** (`DEBATE_ISOLATION` in
  `src/agents/debateOptions.ts`): `strictMcpConfig: true` without `mcpServers` (no MCP server, whatever
  its source), and `settings: { disableAllHooks, disableClaudeAiConnectors,
  disableSkillShellExecution }` all set to `true`. These settings go through the SDK's "flag" layer, the
  highest-priority of the user-modifiable layers: it overrides the settings of the analysed
  repository, including a `disableAllHooks: false` set by a hostile repository (measured, case J).
- **D4: the implementation phase keeps hooks, MCP servers and connectors.** `/implement` is the
  moment the human entrusts the repository to the agents with their usual tools (formatters, quality
  checks, MCP servers). This phase already writes by design; removing them would break what
  users expect for little gain. The README says that the repository's hooks and stdio servers
  run there as in Claude Code, but without its trust dialog.
- **Case L (the repository's `apiKeyHelper`) outside this branch** (direct human arbitration): no
  documented setting turns it off; it will get its own branch, and the README flags it as a known gap.

**Alternatives rejected:**
- `managedSettings` ("policy" layer): ignored by default on a machine that already has a layer
  managed by an administrator, and its `disableAllHooks` becomes `allowManagedHooksOnly` there. The
  "flag" layer applies on every machine.
- Measuring the connectors' approval path (former case I): impossible to conclude; removing them
  from the debate is simpler and verifiable.
- `settingSources: []` during the debate: would also cut off the project's CLAUDE.md, kept on purpose
  (decision of 2026-10-26).

**Files involved:** `src/agents/debateOptions.ts`, `src/agents/claudeAgent.ts`,
`scripts/readonly-verification/`, `scripts/verify-claude-readonly.ts`, `README.md`, `AGENTS.md`.

## 2026-10-27 — Claudex keeps the Claude Code engine bundled with the SDK, at an exact version

**Nature:** arbitration delegated by the maintainer, during the upgrade of the Claude Agent SDK from 0.1.77 to
0.3.310. The maintainer's first intuition was to use the user's `claude`; they delegated the technical
choice.

**Finding:** SDK 0.3.x no longer contains a `cli.js`: it launches a native Claude Code binary
(2.1.310), installed by an optional dependency specific to each platform (273 MB on disk
on darwin-arm64; full SDK install 331 MB against 92 MB for 0.1.77). The debate's read-only mode
was measured on a specific engine, see `limits.md` (2026-10-27).

**Decisions:**
- **D1: Claudex lets the SDK launch the engine it bundles.** No `pathToClaudeCodeExecutable`.
  The read-only guarantee is measured on an exact engine version: with the bundled binary,
  the version the user runs is the one that was tested. The binary is installed anyway
  (optional dependency of the SDK). Login does not change: the bundled binary reads the
  same Claude Code credentials.
- **D2: the SDK is pinned to an exact version** (`"@anthropic-ai/claude-agent-sdk": "0.3.310"`,
  without `^`). A version upgrade is a deliberate branch, which reruns `npm run verify:readonly`
  on the old and on the new version.

**Alternatives rejected:**
- The user's `claude` via `pathToClaudeCodeExecutable`: same download, weaker
  guarantee (the version run would be the one the user installed, older or more
  recent than anything that was measured, and the SDK speaks a versioned control protocol with its
  own binary), and extra failure modes (no `claude` in the `PATH`, wrong version).
- A range with `^`: an untested SDK version would reach users, whereas a
  version can change the read-only guarantee.

**Files involved:** `package.json`, `package-lock.json`, `scripts/verify-claude-readonly.ts`,
`AGENTS.md`, `README.md`.

## 2026-10-26 — Claudex no longer touches CLAUDE.md or AGENTS.md

**Nature:** direct human arbitration, before distribution on a marketplace.

**Finding:** at launch, Claudex created `CLAUDE.md` and `AGENTS.md`, or appended a memory
section to them. This text was read by every Claude Code or Codex session opened afterwards in
the repository, debate or not, including the instruction "debate until consensus before writing any
code" (translated from French). The section came back at the next launch if the user deleted it, and the template
pointed to `devlog.md`, which is not versioned.

**Decisions:**
- Claudex writes nothing outside `.claudex/`. `CLAUDE.md` and `AGENTS.md` belong to the user
  and are still read by the agents during the debate.
- The debate rules (`CONSENSUS_INSTRUCTIONS`), sent once to each agent through the same
  path, name `decisions.md` and `limits.md`. Named, not copied (token cost, see
  `limits.md`). The devlog is no longer referred to: it is a local index of sessions.
- Files produced by previous versions are not cleaned up automatically; the README
  says the section can be deleted.

**Alternatives rejected:** writing on consent at first launch (one more option to
maintain for a benefit limited to sessions outside Claudex);
keeping the generation while removing only the sentence about the pair (the file is still modified without
being asked).

**Files involved:** `src/memory/store.ts`, `src/orchestrator/scheduler.ts`, `README.md`.

## 2026-09-28 — The debate uses a full-screen viewport managed by Claudex

**Nature:** direct human arbitration after visual trials of the animated header.

**Finding:** the terminal's native scrollback necessarily moves the whole screen; it cannot
keep a fixed header and footer. Mixing a full-screen Ink frame with writes into
that scrollback hid short answers, duplicated some lines and made long
answers overlap the footer.

**Decisions:**
- Claudex uses the alternate screen provided by Ink 7, like `vim`, `less` or `htop`; a
  rewrite with curses is unnecessary.
- During a session, `DebateView` owns all the formatted lines and writes nothing
  behind its frame. Header, transcript and footer each have a bounded area.
- The transcript is scrolled with the mouse wheel (terminal mode 1007 when it is supported), the arrows,
  Page Up/Page Down and Home/End. The header and the footer never move.
- Native scrollback is not available in the alternate screen. The durable record remains the
  canonical transcript archived in `.claudex/memory/transcripts/` on normal exit.

**Files involved:** `src/cli.tsx`, `src/ui/DebateView.tsx`,
`src/ui/components/DynamicFooter.tsx`, `src/ui/stream/`, `README.md`.

## 2026-08-04 — Architecture C (delivery queue)

**Approach adopted:** Architecture C, validated by both agents.

**Items agreed:**
- Delivery queue per recipient
- Immutable snapshots built by the drain
- Intervention batches with a barrier
- Causal consensus only
- Read-only synthesis invalidatable by epoch
- Per-job acknowledgement on all paths
- Complete scheduler, closed over all its states

**Status when recorded:** no file modified, implementation not started — decision recovered manually following a consensus-detection bug (marker not recognised because of Markdown formatting), which prevented the synthesis from being generated automatically. The full detail of the debate's reasoning could not be archived automatically (`/save` command absent from this session's version); only this final decision, captured from the screen, could be preserved.

## 2026-08-06 — /handoff command to generate an implementation file

**Approach adopted:** Add a `/handoff` command, coexisting with `/implement`, that generates a self-contained Markdown file (project context + consensus synthesis) meant to be passed as is to a native `claude` or `codex` session for implementation. `/handoff` becomes the path recommended by default; `/implement` remains available to stay in Claudex for one-off changes.

**Agreements:**
- Function `saveHandoff(cwd, topic, summary)` in `store.ts` — "new file" semantics (like `saveTranscript()`), not "log" (like `appendDecision()`)
- Explicit guard on `session.implementationSummary?.trim()` before allowing `/handoff` (a guard that does not exist today on `/implement`)
- New public API `recordHandoffGenerated(path)` on `Scheduler` (calls the private `addEntry()`), delegated by `DebateSession` for the UI
- Structure of the generated file: intro + `## Project memory` (`readMemorySummary()` verbatim) + `## Agreed specification` (`implementationSummary`) + `## Execution instructions` (headings translated from French)
- Timestamp collision handling by numeric suffix (`-2`, `-3`, …), exclusive creation with retry only on `EEXIST`
- `SYNTHESIS_PROMPT` extended conditionally (files/components, interfaces, behaviours, tests — only if they come out of the debate, with no invented empty section)
- UX updated to recommend `/handoff`: post-consensus banner, input placeholder, `HelpPanel`, `README.md`
- No change to `/implement`, to the debate mechanics (Architecture C) or to the consensus criteria

**Files involved:**
- `src/orchestrator/commands.ts`
- `src/memory/store.ts`
- `src/orchestrator/scheduler.ts`
- `src/orchestrator/session.ts`
- `src/ui/DebateView.tsx`
- `README.md`
- `src/orchestrator/__tests__/commands.test.ts` (new)
- `src/memory/__tests__/store.test.ts` (new)

## 2026-08-11 — Autonomy is unbounded by default; consensus survives an intervention

**Nature:** direct human arbitration, outside a Claude ↔ Codex debate. Settles a question that the
handoff of 2026-08-10 explicitly left open ("Autonomy budget: metric; value;
persistence policy or interactive question", translated from French), and replaces the fail-closed behaviour that
had been implemented in the meantime.

**Context:** the two behaviours combined into a closed trap. With no autonomy policy
configured, no automatic turn could start; only human interventions
moved the debate forward; and turns born from an intervention were excluded from consensus. The
two agents could agree without the session ever being able to close.

**Decisions:**
- **No autonomy policy = unbounded.** The risk that a mandatory budget bounds is
  unsupervised runaway. Claudex has no unsupervised mode: `src/cli.tsx` refuses to
  start without a TTY, and Esc pauses from the keyboard even during a turn. Supervision is
  structural, not budgetary. So this is not an arbitrary default value: it is the
  finding that no bound is needed in the only mode that exists.
- `/autonomy starts N` and `/autonomy time <duration>` remain, as **optional** bounds, for
  those who plan to step away from the terminal. `unbounded` again means removing a bound.
- The `autonomy-required` suspension state is removed: it is no longer reachable.
- **Consensus depends on the epoch alone, no longer on the origin of the turn.** A turn that answers the
  latest intervention carries the epoch that this intervention created; two agents that agree
  right after a human question really agree. Any newer input already invalidates them
  via `incrementEpoch()`.
- At consensus, automatic deliveries still pending are dropped: otherwise a `/resume`
  after the synthesis would replay a turn queued before the agreement and reopen a closed debate. Only
  a real intervention should reopen it, through a new epoch.

**Files involved:** `src/orchestrator/scheduler.ts`, `src/types.ts`, `src/orchestrator/types.ts`,
`src/ui/DebateView.tsx`, `src/ui/components/StatusBar.tsx`, `src/__tests__/scheduler.test.ts`,
`src/ui/__tests__/root.test.tsx`, `README.md`.

**Note for tests:** fake agents that always answer `<<CONTINUE>>` are no longer
held back by anything. A fixture that needs a finished debate must set its own bound
(`root.test.tsx` does), not rely on a global block.

## 2026-08-17 — The debate rules no longer name any agent

**Nature:** human arbitration at the end of a Claude ↔ Codex exchange conducted outside Claudex, with measured
evidence in support. Corrects an asymmetry written into the prompt since the beginning.

**Measured finding:** across the 37 debate sessions found in `~/.claude/projects/`, Claude
makes no tool call at all after its first turn, and 55% of its turns open with explicit
agreement ("I confirm", "You are right", "I acknowledge"; translated from French). The occurrences of the word "objection"
are almost all negations ("I have no more objections", translated from French). The pattern is identical on Sonnet
4.5, Opus 4.5 and Sonnet 5: it comes from the harness, not from the model.

**Identified cause:** `CONSENSUS_INSTRUCTIONS` said "Claude has no execution tool and must
ask Codex to verify" (translated from French). Both agents received this sentence: it disqualified the only
capability of one and signalled to the other that its opponent could check nothing.

**Decisions:**
- No rule names an agent outside the `self` and `other` roles. Checked as a property:
  a test swaps the two names in the instructions and requires getting exactly the other's.
- The evidence rule becomes symmetric: whoever runs gives the exact command and its raw output;
  whoever cannot run asks for it and refuses an unsupported empirical claim. Demanding
  evidence is as much part of the role as providing it.
- Consensus requires having examined at least one serious alternative. Continuing required a
  *new* objection while agreeing required nothing: when in doubt, agreement was the cheapest
  valid move. Manufacturing disagreement is never asked for.
- The ban on Markdown markers is removed from both prompts. It is a display
  constraint, already applied by the renderer; imposing it on the model degraded the handoffs, which are,
  by the decision of 2026-08-06, self-contained Markdown documents.

**Files involved:** `src/orchestrator/scheduler.ts`, `src/__tests__/scheduler.test.ts`.

**What is not demonstrated:** a documented cause was removed, not the deference itself. To be
re-checked on the next sessions with the same measurements — tool calls after the first
turn, opening sentences, who produces the evidence. The 37 archived traces give the baseline.

## 2026-08-17 — The execution asymmetry stays as it is, pending measurement

**Nature:** sequencing decision, taken after the prompt fix above.

**Decision:** build nothing for now. The prompt fix has just removed the most
probable cause of the deference at zero cost; building a shared execution channel before
having measured its effect would mean paying scheduler complexity for a problem
perhaps already solved.

**Reopening condition:** if, over the next sessions, Claude keeps calling no
tool after its first turn and opening its answers with agreement, then the capability is indeed
at issue and the channel is justified.

**What would be built in that case — and what is rejected:**
- Adopted: a dedicated `codex app-server` thread in `readOnly` + `networkAccess: false`, separate from the
  debater thread, from which any agent requests a command and whose raw output goes into both
  transcripts. Same write guarantee as today, no new dependency.
- Rejected: giving Claude Bash under human approval. This replaces an operating-system
  guarantee with the human's attention, and the human cannot infer from `npm test` the files
  it writes. This is precisely the reasoning of `claudeAgent.ts`.
- On the unrestricted reads of `command/exec` (raised by Codex, checked in the v2 schema):
  this is not a new obstacle. The Codex debater thread already has exactly this exposure; it
  is documented in the README and accepted. A second read-only executor adds no
  class of risk.
