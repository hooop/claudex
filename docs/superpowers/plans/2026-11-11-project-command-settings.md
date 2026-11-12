# Project command settings consent gate — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code never applies the analysed project's credential helpers or `env` settings without the human having seen them in Claudex first.

**Architecture:** A pure inspector (`src/agents/projectSettings.ts`) parses the project settings files without executing anything. `src/launch.ts` runs it before anything is written, and asks the human through an Ink consent screen when it finds something. `ClaudeAgent` calls a guard built from the approved findings before every `query()`, and refuses the turn if the findings changed.

**Tech Stack:** Node >= 22, TypeScript strict ESM through tsx, Ink 7 / React 19, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-11-project-command-settings-design.md` (read it first; decisions D1–D5 are referenced below).

## Global Constraints

- No new dependency. No change to `settingSources`, `DEBATE_ISOLATION` or `DEBATE_TOOLS`.
- Nothing is executed to inspect settings: read and `JSON.parse` only.
- Consent is never persisted: no file written for it, anywhere.
- A refused project is left untouched: no `.claudex/` created.
- UI strings (French at the time, matching the surrounding UI; translated in the English pass), code, comments, docs, commit messages in English.
- Keys: the consent screen uses `y` to continue, like `PermissionModal`; Enter, Escape, Ctrl+C, `n` and `q` quit. (The design said `o`; `y` is kept for consistency with the existing permission prompt, Claude's call.)
- Tests never call `claude`, `codex` or the network. `npm run check` must pass at the end of every task.
- Conventional Commits, each commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A settings file with a UTF-8 BOM, or with comments: `JSON.parse` fails, so it must surface as an "unreadable" finding (fail closed), never as "no finding". Test in Task 3.
2. A value that contains ANSI escapes, newlines or bidi override characters (U+202E) must be shown escaped, so the screen cannot hide the real command. Test in Task 3 (`formatSettingValue`) and Task 5 (rendered screen).
3. `.claude/settings.json` that is a symlink to a file outside the project: the engine follows it, so the inspector must too (plain `readFile`). Test in Task 3.
4. `cwd` launched in a subfolder of a git repository: covered by the result of Task 2 (L-parent). If the engine reads the root's file, Task 3 walks up. Test in Task 3 if applicable.
5. The guard throws (for example, permission error while reading): the turn must fail with the message, never proceed. Test in Task 4.

---

### Task 1: Measurement cases Lp, Ll and M

**Files:**
- Modify: `scripts/readonly-verification/cases.ts` (`CaseId`, `CaseContext`, `VerificationCase`, `CASES`)
- Modify: `scripts/readonly-verification/observe.ts` (`runIn`, `Observation` init and `emptyObservation`)
- Modify: `scripts/readonly-verification/verdict.ts` (`describeRecord`)
- Modify: `scripts/verify-claude-readonly.ts` (header comment only: name this design for the new cases)
- Test: `scripts/readonly-verification/__tests__/cases.test.ts`, `observe.test.ts`, `verdict.test.ts`

**Interfaces:**
- Produces: `CaseId` gains `"Lp" | "Ll" | "M"`. `VerificationCase` gains optional `cwdSubdir?: string` (query `cwd` is `join(dir, cwdSubdir)`, created by the runner; marker stays at `dir`) and optional `listener?: true`. `CaseContext` gains `listenerUrl: string | null`. `Observation` gains `listenerRequests: Array<{ method: string; path: string }>`.

- [ ] **Step 1: Write the failing tests**
  - `cases.test.ts`: `Lp` is `record`, uses `debateQueryOptions()`, `cwdSubdir: "sub"`, writes `.claude/settings.json` at the project root with `apiKeyHelper` = `touch <quoted markerPath>`, and writes a file inside `sub/` so the folder exists in git. `Ll` is `record`, writes the same helper to `.claude/settings.local.json` and no `.claude/settings.json`. `M` is `record`, `listener: true`, writes `.claude/settings.json` with `env: { ANTHROPIC_BASE_URL: ctx.listenerUrl }`, and its prompt is the same "Reply with the single word hello." as L.
  - `observe.test.ts` (with the fake `QueryFn` used there): for a case with `cwdSubdir`, the options passed to the query have `cwd === join(dir, "sub")` and the marker check still looks at `join(dir, MARKER_NAME)`. For a case with `listener: true`, `ctx.listenerUrl` matches `^http://127\.0\.0\.1:\d+$`; a fake query that sends `POST /v1/messages` with an `authorization` header and a body to that URL yields `listenerRequests` equal to `[{ method: "POST", path: "/v1/messages" }]`; the serialized observation contains neither the header value nor the body; the server is closed after the run (a second request is refused).
  - `verdict.test.ts`: a record observation with two listener requests adds the reason `listener requests: 2`; with none and no listener, the reason is absent.

- [ ] **Step 2: Run them, confirm they fail on the missing cases and fields**

Run: `npx vitest run scripts/readonly-verification`
Expected: FAIL (unknown case ids, missing `listenerRequests`).

- [ ] **Step 3: Implement**

The listener is `node:http` `createServer` on `127.0.0.1`, port 0, started in `runIn` before `c.prompt(ctx)` only when `c.listener` is set. It records `{ method, path }` (path without query string), drains the body without storing it, and answers `503` with an empty body. Closed in `runIn`'s `finally`. `describeRecord` adds `listener requests: N` when `N > 0`.

- [ ] **Step 4: Run tests and `npm run check`**

Expected: PASS.

- [ ] **Step 5: Commit** — `chore: record where the engine reads project credential helpers and env`

---

### Task 2: Run the measurement (main session only, not a subagent)

The maintainer's account runs these real queries, as on the isolation branch.

- [ ] **Step 1:** `npm run verify:readonly -- --model claude-sonnet-5-5 --cases L,Lp,Ll,M --out <scratchpad>/fresh.json`
- [ ] **Step 2:** same with `--trusted-dir ~/claudex-trusted-probe --out <scratchpad>/trusted.json`
- [ ] **Step 3: Decide the file list from the results:**

| Result | `PROJECT_SETTINGS_FILES` for Task 3 |
| --- | --- |
| Only L writes the marker | `[".claude/settings.json"]` relative to `cwd` |
| L and Ll write it | add `.claude/settings.local.json` |
| Lp writes it | also the git root's `.claude/settings.json`, git root = nearest ancestor of `cwd` (inclusive) containing a `.git` entry (file or directory) |

Any other result (for example Lp writes it in a way a nearest-`.git` walk does not explain): **stop and report to the maintainer**.

- [ ] **Step 4:** If M shows `listener requests` > 0: **report it to the maintainer as a security finding before Task 3** (D4 stop point), then continue unless told otherwise. `env` stays flagged either way.
- [ ] **Step 5:** Keep both JSON reports in the scratchpad for Task 6. Nothing is committed in this task.

---

### Task 3: The settings inspector

**Files:**
- Create: `src/agents/projectSettings.ts`
- Test: `src/agents/__tests__/projectSettings.test.ts`

**Interfaces:**
- Produces:
  - `export const COMMAND_SETTING_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper", "proxyAuthHelper"] as const;` (comment: from 0.3.310 `sdk.d.ts` `Settings`; re-read at every SDK upgrade)
  - `export type SettingsFinding = { file: string; kind: "entries"; entries: Array<{ key: string; value: unknown }> } | { file: string; kind: "unreadable"; reason: string };` `file` is relative to `projectDir`, with `/` separators (`../` allowed for a git root above `cwd`). `env` produces one entry per variable, key `env.<NAME>`; a non-object `env` produces one entry with key `env` and the raw value.
  - `export async function inspectProjectSettings(projectDir: string): Promise<SettingsFinding[]>` — one finding per file that has something to show, in the order of the file list; files with nothing flagged produce none.
  - `export function sameFindings(a: readonly SettingsFinding[], b: readonly SettingsFinding[]): boolean` — canonical: findings sorted by file, entries by key, object keys inside values sorted.
  - `export function formatSettingValue(value: unknown): string` — `JSON.stringify(value)` (so strings show quoted with `\n`, `\u001b` escaped), then every remaining char in U+007F–U+009F, U+2028–U+2029, U+202A–U+202E, U+2066–U+2069, U+200E–U+200F replaced by `\uXXXX`.

- [ ] **Step 1: Write the failing tests** (temp dirs with `mkdtemp`, real files):
  - no `.claude` directory → `[]`; `{}` → `[]`; `{ "permissions": {...}, "model": "x" }` → `[]`;
  - each key of `COMMAND_SETTING_KEYS` with a string → one `entries` finding with that key and exact value (`it.each`);
  - `apiKeyHelper: 42` → flagged with value `42`;
  - `env: {}` → `[]`; `env: { "ANTHROPIC_BASE_URL": "http://x", "FOO": "1" }` → entries `env.ANTHROPIC_BASE_URL` and `env.FOO`; `env: "x"` → entry `env` value `"x"`;
  - invalid JSON, JSON with a leading BOM, JSON with a `//` comment, top-level array, top-level `"string"`, a directory named `settings.json`, a file with mode `000` (skip that one when running as root) → one `unreadable` finding with a non-empty reason;
  - symlinked `settings.json` pointing outside the project → read through;
  - every file in `PROJECT_SETTINGS_FILES` from Task 2 is read (and, if Task 2 kept the git-root walk: launched from `repo/sub`, the root's file is reported as `../.claude/settings.json`; no `.git` above → only `cwd` files);
  - `sameFindings`: same content with entries and object keys in another order → `true`; a changed value, an added entry, an added file, `entries` vs `unreadable` → `false`; `[]` vs `[]` → `true`;
  - `formatSettingValue("a\u001b[2Jb\n")` → `"\"a\\u001b[2Jb\\n\""`; `formatSettingValue("x‮y")` → `"\"x\\u202ey\""`; `formatSettingValue({ b: 1 })` → `"{\"b\":1}"`.
- [ ] **Step 2:** `npx vitest run src/agents/__tests__/projectSettings.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement with `node:fs/promises` `readFile` (`ENOENT` → no finding; any other error → `unreadable` with `error.code ?? message`). No SDK import in this module.
- [ ] **Step 4:** tests and `npm run check` → PASS.
- [ ] **Step 5: Commit** — `feat: inspect the project's credential helpers and env settings`

---

### Task 4: Guard every Claude session

**Files:**
- Modify: `src/agents/projectSettings.ts` (add guard)
- Modify: `src/agents/claudeAgent.ts` (constructor, `performSend` before `query()`)
- Modify: `src/ui/Root.tsx` (prop `approvedSettings`, construction of `ClaudeAgent`)
- Test: `src/agents/__tests__/projectSettings.test.ts`, `src/agents/__tests__/claudeAgent.test.ts`, `src/ui/__tests__/root.test.tsx`

**Interfaces:**
- Consumes: `inspectProjectSettings`, `sameFindings`, `SettingsFinding` (Task 3).
- Produces:
  - `export type SessionGuard = (cwd: string) => Promise<string | null>;` — `null` means proceed, a string is the refusal message.
  - `export const SETTINGS_CHANGED_MESSAGE: string` — says the project's Claude Code settings changed during the session, the turn was not sent, and to quit and relaunch Claudex to review them.
  - `export function createSettingsGuard(approved: readonly SettingsFinding[], inspect?: (dir: string) => Promise<SettingsFinding[]>): SessionGuard` — proceeds when the current findings are `[]` or `sameFindings(current, approved)`; returns the message otherwise, and also when `inspect` throws.
  - `ClaudeAgent` constructor: `constructor(model?: string, initialDisplayModel?: string, guard?: SessionGuard)`.
  - `Root` props: `approvedSettings?: readonly SettingsFinding[]` (default `[]`); Root passes `createSettingsGuard(approvedSettings)` to `ClaudeAgent`.

- [ ] **Step 1: Write the failing tests**
  - guard: `[]` approved and `[]` now → `null`; approved X, now X reordered → `null`; approved X, now `[]` → `null`; approved X, now X with a changed value / an added key / an added file / unreadable → `SETTINGS_CHANGED_MESSAGE`; approved `[]`, now X → message; `inspect` rejects → message.
  - `claudeAgent.test.ts` (mocked `query`): a guard returning a message → `send` resolves `{ kind: "error", message: SETTINGS_CHANGED_MESSAGE }` and `queryMock` was not called, for `writeAccess` false and true; a guard returning `null` → `query` called once with the same options as today; guard called with `options.cwd`; no guard → behaviour unchanged (existing tests keep passing untouched).
  - `root.test.tsx`: the mocked `ClaudeAgent` receives a third constructor argument that is a function.
- [ ] **Step 2:** run the three files → FAIL.
- [ ] **Step 3:** Implement. In `performSend`, the guard runs after the abort setup and before `query()`; a cancelled signal still returns `cancelled` first.
- [ ] **Step 4:** tests and `npm run check` → PASS.
- [ ] **Step 5: Commit** — `feat: refuse a Claude turn when the project's command settings changed`

---

### Task 5: Consent screen and launch order

**Files:**
- Create: `src/ui/components/SettingsConsent.tsx`
- Create: `src/launch.ts`
- Modify: `src/cli.tsx`
- Test: `src/ui/components/__tests__/settingsConsent.test.tsx`, `src/__tests__/launch.test.ts`

**Interfaces:**
- Consumes: `inspectProjectSettings`, `formatSettingValue`, `SettingsFinding` (Task 3); `Root`'s `approvedSettings` (Task 4).
- Produces:
  - `export function SettingsConsent(props: { findings: readonly SettingsFinding[]; onDecide: (accept: boolean) => void }): JSX.Element` — title sentence (D2), then per finding the file path and each entry as `key = formatSettingValue(value)` with `wrap="wrap"` (never truncated), or the unreadable reason; then the keys line `[y] continue with these settings · [n] quit`. `y`/`Y` → `onDecide(true)`; `n`, `q`, Enter, Escape, Ctrl+C → `onDecide(false)`; any other key does nothing.
  - `export type LaunchDecision = { kind: "start"; approved: SettingsFinding[]; created: string[] } | { kind: "refused" };`
  - `export async function prepareLaunch(cwd: string, ask: (findings: SettingsFinding[]) => Promise<boolean>, deps?: { inspect?: typeof inspectProjectSettings; scaffold?: typeof initMemoryScaffold }): Promise<LaunchDecision>` — inspect; if findings, `ask`; refused → `{ kind: "refused" }` without calling `scaffold`; otherwise scaffold and return `start`. `ask` is never called when there is no finding.
  - `export const SETTINGS_REFUSED_MESSAGE: string` — one line: Claudex did not start because the project's Claude Code settings were not accepted.

- [ ] **Step 1: Write the failing tests**
  - `settingsConsent.test.tsx` (Ink `render` as in `root.test.tsx`): output contains the file path, `apiKeyHelper`, and the full value of a 300-character command; a value `"a\u001b[2Jb"` appears as `\u001b[2J` text and the raw ESC byte appears nowhere in the frame; `unreadable` shows its reason; `y` → `onDecide(true)` once; each of `n`, `q`, `\r`, `\u001b`, `\u0003` → `onDecide(false)`; `x` → not called.
  - `launch.test.ts` (real temp dir, real `initMemoryScaffold`): no settings → `ask` not called, `.claudex/` exists, `kind: "start"`, `approved: []`; helper present + ask resolves `false` → `{ kind: "refused" }` and `.claudex/` does not exist; helper present + ask `true` → `start` with the finding and `.claudex/` exists; `inspect` rejects → the rejection propagates and `.claudex/` does not exist.
- [ ] **Step 2:** run them → FAIL.
- [ ] **Step 3:** Implement. `cli.tsx`: after the TTY check, `prepareLaunch(cwd, askInInk)`, where `askInInk` renders `<SettingsConsent>` with `RENDER_OPTIONS`, resolves on `onDecide`, unmounts and awaits `waitUntilExit()` before resolving. `refused` → `console.log(SETTINGS_REFUSED_MESSAGE)` and exit code 0. `start` → existing "Project memory initialised" log from `created`, then render `Root` with `approvedSettings={decision.approved}`. The mode 1007 write keeps wrapping only the Root render.
- [ ] **Step 4:** tests and `npm run check` → PASS.
- [ ] **Step 5: Manual check** (main session): in a scratch git repo with `.claude/settings.json` = `{ "apiKeyHelper": "touch /tmp/should-not-exist" }`, run `node <worktree>/bin/claudex.mjs`; the screen shows the command; `n` quits, no `.claudex/`, no marker. Report to the maintainer that the interactive check needs their terminal if the session cannot drive a TTY.
- [ ] **Step 6: Commit** — `feat: ask the human before Claude Code applies the project's command settings`

---

### Task 6: Documentation

**Files:**
- Modify: `README.md` (lines 23 and 55: replace the known-gap sentences with the consent behaviour, what was measured in Task 2, and the mid-`/implement` gap from D3, stated plainly)
- Modify: `.claudex/memory/limits.md` (new dated entry 2026-11-11 with Task 2's tables, like the file; update the "Remaining gap" paragraph and the SDK-upgrade instruction to include Lp, Ll, M)
- Modify: `.claudex/memory/decisions.md` (new dated entry: D1–D5, consent never persisted, `y` key, alternatives rejected)
- Modify: `AGENTS.md` (Constraints: replace "The analysed project's `apiKeyHelper` still runs..." with the consent gate; SDK-upgrade checklist: re-read `COMMAND_SETTING_KEYS` against `sdk.d.ts`)

- [ ] **Step 1:** Write the changes; claims say no more than Task 2 measured (macOS, one machine, fresh and trusted folders, twice per case).
- [ ] **Step 2:** `npm run check` → PASS.
- [ ] **Step 3: Commit** — `docs: document the consent gate for the project's command settings`

---

## After the last task

Whole-branch review, `npm run check`, then PR (`fix: ask before Claude Code applies the project's command settings`) with summary, measurements, decisions, and what to review first: `prepareLaunch` order and the guard in `performSend`.
