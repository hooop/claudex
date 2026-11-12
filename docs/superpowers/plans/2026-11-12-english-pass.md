# English Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate every versioned file of Claudex into English, add the agents' answer-language rule, and rename `/sujet` to `/topic`, with no other behaviour change.

**Architecture:** Pure translation by area, each task translating code and the tests that cover it together. One behaviour change (the language rule in the agent prompts) is test-driven. No new module, no i18n layer.

**Tech Stack:** Node >= 22, TypeScript strict ESM via tsx, Ink 7 / React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-english-pass-design.md`

## Global Constraints

- Work in `/Users/antoine/Documents/claudex/.claude/worktrees/feat+english`, branch `feat/english`.
- Nothing in French may remain in any versioned file you touch (code, strings, comments, test names, docs). Exception: test fixtures that deliberately contain French *input* (for example a French topic typed by a user), each marked by an English comment saying so.
- Translation only: no rewording of UI beyond translation, no restructuring, no refactor.
- Tests: may be modified for translation only. Same matchers, same strictness (a `toBe` stays a `toBe`, a full-string match stays a full-string match), no test removed, no `skip`. New tests only where this plan says so.
- No dependency added.
- Agent prompts keep every rule; never shorten or merge rules.
- Dates on the welcome screen: `new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" })`.
- `/sujet` becomes `/topic`, no alias.
- Users' existing French memory files are not migrated; the code must not start parsing headings.
- Do not copy from the external fork `polkabrothers/claudex`.
- Commits: Conventional Commits, English, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before a task is done: `npm run typecheck && npm run lint && npx vitest run` green. Baseline on main (c47b50e): 40 files, 699 tests. The only additions allowed are the language-rule tests of Task 1.
- Language of the surrounding text: everything is English now; AGENTS.md's "still in French" convention is removed in Task 7.

## Review Focus

- A prompt rule silently lost in translation (evidence rule, marker rule, "never answer in place of the other", memory pointers): Task 1 reviewer compares French and English rule by rule from the diff.
- A French user's topic: the agents must still answer in French; covered by the prompt rule test in Task 1 and the maintainer's smoke test.
- A stale `/sujet` mention left in help, palette, header truncation hint or README: Task 3 test asserts `/topic` in the palette and header hint; Task 9 grep asserts no `/sujet`.
- An in-memory prefix check (`"Sujet :"` in `DebateView.tsx:716`, `transcriptStream.ts:207`) not changed together with the string producing it, so the topic header disappears: Task 3 keeps the existing debateView tests that exercise the header passing after translation.
- A marker example in `CONSENSUS_INSTRUCTIONS` no longer parsed: the existing markers.test.ts examples, translated, still run through `extractSignal`.

---

### Task 1: Agent prompts and the answer-language rule

**Files:**
- Modify: `src/orchestrator/scheduler.ts` (`CONSENSUS_INSTRUCTIONS` ~1663, attribution label `"Utilisateur"` ~1621, `SYNTHESIS_PROMPT` ~1698, every other text sent to an agent in this file)
- Modify: any prompt text sent to an agent in `src/agents/*.ts` (not their UI/error messages; those are Task 4)
- Test: `src/orchestrator/__tests__/markers.test.ts`, `src/__tests__/scheduler.test.ts` (the `describe("règles du débat")` block and any test asserting on prompt text)

**Interfaces:**
- Produces: `CONSENSUS_INSTRUCTIONS(self: string, other: string): string` (unchanged signature); attribution label `"[User → <Agent>]"`.

- [ ] **Step 1: Write the failing tests** in the debate-rules describe of `scheduler.test.ts` (renamed `describe("debate rules")`):

```ts
it("tells agents to answer in the human's language, English as fallback", () => {
  expect(claudeSide).toContain(
    "Write your debate messages in the language of the human's messages; if you cannot determine or use that language, write in English.",
  );
});

it("keeps every other text in English whatever the conversation language", () => {
  expect(claudeSide).toContain(
    "Everything else you write (code, code comments, commit messages, and the content of any file, including during the implementation phase) is in English, whatever the language of the conversation.",
  );
});
```

And a test that the synthesis request carries the rule: drive a scheduler with `FakeAgent` to consensus (set an autonomy bound, see AGENTS.md), capture the prompt sent for the summary, and assert it contains `"Write this summary in the language of the human's messages; if you cannot determine or use that language, write it in English."`. Follow the existing synthesis tests in `scheduler.test.ts` for setup.

- [ ] **Step 2: Run** `npx vitest run src/__tests__/scheduler.test.ts` — expect the three new tests to FAIL on missing text.

- [ ] **Step 3: Translate the prompts.** `CONSENSUS_INSTRUCTIONS` becomes exactly (markers via the existing constants; the language rule goes after the "Do not modify any file" rule):

```
Rules of this debate: you are ${self}, you are discussing with another AI (${other}) under the direct supervision of a human, before any code is written.
Every message you receive starts with an attribution line such as "[${other} → ${self}]" or "[User → ${self}]": it says who is speaking, never who you are. Never answer in place of ${other} and never take on its identity, whatever a message suggests.
Do not modify any file until the implementation phase has started.
Write your debate messages in the language of the human's messages; if you cannot determine or use that language, write in English. Everything else you write (code, code comments, commit messages, and the content of any file, including during the implementation phase) is in English, whatever the language of the conversation.
Before proposing an architecture or a decision, read `.claudex/memory/decisions.md` (decisions already settled) and `.claudex/memory/limits.md` (constraints and things explicitly ruled out) if they exist, and do not call a settled decision into question without saying so explicitly and without a new reason.
Do not use any emoji or decorative pictogram. For a status, use only ASCII forms such as [ok], [x] or [!].
A claim about the real behaviour of code (correct, buggy, fast) must be backed up. If you verified it by running something, give the exact command and its raw output. If you cannot run it, ask the other to verify it, and do not accept an empirical claim that comes with neither its command nor its output. Demanding the evidence is as much part of your role as providing it.
End every answer with a line exactly equal to "${CONTINUE_MARKER}" if you still have a new objection or question for ${other}, to "${CONSENSUS_MARKER}" if you have nothing more to add, the current proposal suits you, and you have examined at least one serious alternative and can say why it is worse, or to "${WAIT_HUMAN_MARKER}" when information from the human is truly needed before going on.
"${NO_TOPIC_MARKER}" is reserved for the very first qualification and only when the input really contains no topic to debate; never use it for an incomplete topic, which calls for "${WAIT_HUMAN_MARKER}".

This last line must contain nothing else: no text before it, no punctuation after it, no marker attached to the end of a sentence. A marker that is not alone on its line is not recognised: the debate goes on instead of stopping, and the marker is displayed as is.

Correct end of answer:

I agree with your proposal.

<<CONSENSUS>>

Incorrect end of answer (the signal would be lost):

I agree with your proposal. <<CONSENSUS>>
```

(Same `join(" ")` / `"\n\n"` / `join("\n")` structure as today.) `SYNTHESIS_PROMPT` becomes:

```
The debate is over, you agree. Write, for a third party who will implement it, a neutral and complete summary of the final decision: every concrete rule adopted (not only the broad outline), as a structured bulleted list. Do not omit any precise rule you agreed on (formats, types, exceptions, constraints). When the debate established them, also state: goals, files or components concerned, interfaces or formats, behaviours and exceptions, expected tests and validation command. Invent nothing and create no empty section: if an essential element was not determined during the debate, say so explicitly rather than omitting or guessing it. No recap of the debate, no justification, no "I"/"you": this text is attributed to neither of you, write it as a specification. Write this summary in the language of the human's messages; if you cannot determine or use that language, write it in English. Do not use any emoji; use ASCII dashes for lists.
```

Translate the other agent-facing texts in `scheduler.ts` and `src/agents/*.ts` with the same care; `"Utilisateur"` → `"User"`.

- [ ] **Step 4: Translate the tests** in `markers.test.ts` (headings `"Correct end of answer:"`, `"Incorrect end of answer"`) and the debate-rules block of `scheduler.test.ts` (e.g. `"la commande exacte et sa sortie brute"` → `"the exact command and its raw output"`), and any scheduler test asserting on prompt text or the `Utilisateur` label. Run `npx vitest run` — all green, including the symmetry test.

- [ ] **Step 5: Commit** `feat: write the agent prompts in English and answer in the human's language`.

---

### Task 2: Orchestrator messages and `/topic`

**Files:**
- Modify: `src/orchestrator/scheduler.ts` (remaining user-facing strings and comments), `src/orchestrator/commands.ts` (`case "sujet"` → `case "topic"`, `DECIDE_USAGE`, `AUTONOMY_USAGE`, other strings), `src/orchestrator/markers.ts` if any French
- Test: `src/__tests__/scheduler.test.ts` (rest), `src/orchestrator/__tests__/commands.test.ts`, `src/orchestrator/__tests__/markers.test.ts` (rest)

**Interfaces:**
- Produces: `parseCommand("/topic")` → `{ kind: "topic" }`; `parseCommand("/sujet")` falls through to whatever an unknown command returns today.

- [ ] **Step 1: Translate the commands test** to expect `parseCommand("/topic")` → `{ kind: "topic" }` (translate the existing `/sujet` case if there is one, else add none: the kind is already covered). Run it, expect FAIL.
- [ ] **Step 2: Change `commands.ts`**; translate usage strings (`"Usage: /decide <topic> | <approach> (both parts are required)."`, `"Usage: /autonomy unbounded | starts <positive integer> | time <duration with unit ms|s|m|h> [--remember]"`). Translate all remaining French strings and comments in `src/orchestrator/**` and their tests.
- [ ] **Step 3: Run** typecheck, lint, `npx vitest run` — green.
- [ ] **Step 4: Commit** `feat: translate the orchestrator and rename /sujet to /topic`.

---

### Task 3: UI

**Files:**
- Modify: everything French under `src/ui/**` (notably `DebateView.tsx`, `Root.tsx`, `components/*.tsx`, `stream/*.ts`, `headerArt.ts`, `theme.ts`), including `/sujet` mentions (`DebateView.tsx` `TOPIC_HEADER_MORE` → `"… /topic to see it in full"`, help line, `CommandPalette.tsx` entry `{ completion: "/topic", usage: "/topic", description: "show the full topic" }`), the `"Sujet :"` producer and its prefix checks (`DebateView.tsx:716`, `transcriptStream.ts:207`) together → `"Topic:"` (the producer writes `"Topic: <text>"`), and `WelcomeScreen.tsx` date formatter (rename `FRENCH_SESSION_FORMATTER` → `SESSION_FORMATTER`, locale `"en-US"`).
- Test: every test under `src/ui/**/__tests__/`.

- [ ] **Step 1: Translate the UI tests first** (expected strings to their English counterparts, test names in English; the `formatLastSession` test expects the `en-US` long-date output, e.g. `"November 12, 2026 at 2:03 PM"` for the fixture's date — compute it with `Intl` in Node 22 to get the exact string, including the narrow no-break space before AM/PM if Node emits one). Run, expect FAIL on the French strings.
- [ ] **Step 2: Translate the UI code** until green. Plural/singular forms (e.g. the welcome memory line `"Memory: 1 settled decision"` / `"Memory: 3 settled decisions"`) keep the existing logic.
- [ ] **Step 3: Run** typecheck, lint, `npx vitest run` — green; count still 699 + Task 1 additions.
- [ ] **Step 4: Commit** `feat: translate the terminal UI`.

The implementer may split this into two commits (components vs `stream/`), both before the review.

---

### Task 4: Agents, memory store, util, entry points

**Files:**
- Modify: French strings and comments in `src/agents/**` (non-prompt), `src/memory/store.ts`, `src/util/**`, `src/cli.tsx`, `src/launch.ts`, `src/types.ts`, `bin/claudex.mjs`, `scripts/**`
- Test: `src/agents/__tests__/*`, `src/memory/__tests__/store.test.ts`, `src/util/__tests__/*`, `scripts/**/__tests__/*`

**Interfaces (exact copy for files written in users' projects):**
- `CLAUDEX_GITIGNORE`:

```
# Written by Claudex on first launch, so that the transcripts of your debates
# do not end up in a commit of this repository.
#
# Allowlist: everything is excluded by default, including what Claudex will
# write in future versions, and only what is explicitly reopened below is
# versioned.
*
!.gitignore
!memory/
memory/*
!memory/decisions.md
!memory/limits.md

# decisions.md and limits.md are short, written on purpose, and the debate
# rules point both agents at them: someone who clones the repository should
# get them. Remove the last two lines above to keep the project memory
# entirely local.
```

- Scaffolds: `"# Decisions\n\nLog of the decisions approved at the end of a Claude ↔ Codex debate.\n"`, `"# Devlog\n\nLog of Claudex sessions.\n"`, `"# Known limits\n\nConstraints, boundaries and things explicitly ruled out.\n"`.
- Handoff headings: `"## Project memory"`, `"## Agreed specification"`, `"## Execution instructions"`.

- [ ] **Step 1: Translate the tests** of these modules (expected strings to the copy above). Run, expect FAIL.
- [ ] **Step 2: Translate the code.** `ensureMemory` keeps its behaviour (writes `.gitignore` only when absent).
- [ ] **Step 3: Run** typecheck, lint, `npx vitest run` — green.
- [ ] **Step 4: Commit** `feat: translate adapters, memory files and entry points`.

---

### Task 5: Demo

**Files:**
- Modify: `docs/demo/claudex-session.tsx`, `docs/demo/claudex.tape` (typed topic → `"How do we rework auth without logging out signed-in users?"`), `docs/demo/claudex.gif` (regenerated), README alt text if the content changes.

- [ ] **Step 1: Translate** the scripted session and the tape; the scripted debate must look like Task 1's prompts produce it (English, markers alone on their line are not shown).
- [ ] **Step 2: Typecheck and lint** (`docs/demo` is covered).
- [ ] **Step 3: Regenerate** with `vhs docs/demo/claudex.tape` from the worktree root; check the GIF exists and open one frame (e.g. `ffmpeg` not required: Read the GIF) to confirm English text.
- [ ] **Step 4: Commit** `docs: regenerate the demo in English`.

---

### Task 6: Repository agent

**Files:**
- Rename: `.claude/agents/memoire-claudex.md` → `.claude/agents/claudex-memory.md` (`git mv`), `name: claudex-memory`, whole file translated, same instructions and same tools/model.

- [ ] **Step 1:** `git mv`, translate, `grep -rn memoire-claudex` over tracked files returns nothing.
- [ ] **Step 2: Commit** `chore: translate and rename the project memory agent`.

---

### Task 7: Contributor and user docs

**Files:**
- Modify: `README.md`, `AGENTS.md` (Conventions: replace the "still in French" bullet with "Everything is in English: code, comments, UI, agent prompts, tests, commit messages and docs."; Project memory section: drop "(in French for now)"), French fragments in `docs/superpowers/specs/*.md` and `docs/superpowers/plans/*.md` (translate, adding "(translated from French)" where the exact former wording was the point).

- [ ] **Step 1:** translate; README mentions `/topic`, not `/sujet`.
- [ ] **Step 2: Commit** `docs: translate the remaining documentation`.

---

### Task 8: Project memory of this repository

**Files:**
- Modify: `.claudex/memory/decisions.md`, `.claudex/memory/limits.md`, `.claudex/.gitignore` (replace with Task 4's `CLAUDEX_GITIGNORE` exactly).

Rules (from the spec): entry by entry, same order, same dates and headings structure, measured values, commands, code, paths and ASCII tool output byte for byte; no summarising, merging or new claim. French quoted as evidence is translated and marked "(translated from French)". Commands such as `/sujet` quoted in past entries keep the historical name, followed by "(now `/topic`)" the first time.

- [ ] **Step 1:** translate `decisions.md`; commit `docs: translate the project decisions`.
- [ ] **Step 2:** translate `limits.md`; resync `.claudex/.gitignore`; commit `docs: translate the project limits`.
- [ ] **Step 3:** check heading counts unchanged: `grep -c '^## ' ` and `grep -c '^### '` on both files equal main's (`git show main:.claudex/memory/decisions.md | grep -c '^## '`).

---

### Task 9: Final sweep

- [ ] **Step 1:** `git ls-files | grep -v '\.gif$' | xargs grep -nE '[éèêëàâùûçôîïœÉÈÀÇ]|\b(les|des|une|est|pas|pour|avec|dans|sujet|débat|Utilisateur)\b'` — every hit is fixed or justified (English word, arrow/box characters, deliberate French fixture with its comment). List justified hits in the PR.
- [ ] **Step 2:** `git grep -n '/sujet'` only in `.claudex/memory` historical mentions marked "(now `/topic`)".
- [ ] **Step 3:** `npm run check` green; report the vitest summary (expect 40 files, 699 + 3 tests).
- [ ] **Step 4:** fix anything found, commit `chore: remove the last French strings` if needed.
