# English pass — design

Date: 2026-11-12. Branch: `feat/english`.

## Intent

Claudex will be distributed as open source and possibly on a specialised
marketplace. The maintainer decided on 2026-10-26 that nothing in French may
remain in any versioned file: UI, slash commands, agent prompts, scaffolded
files, tests, comments, contributor docs, and this repository's own project
memory. The only exception is the git history, which is not rewritten.

This pass comes before two other roadmap items (less verbose output, CLI
redesign) so that those are written in English directly and no string is
translated twice.

## Goals

- Every versioned file is in English, except the git history and the binary
  demo GIF, which is regenerated from its English source instead.
- Behaviour is unchanged apart from language: same commands (except the one
  renamed below), same markers, same scheduler logic, same files written.
- The agent prompts keep their exact meaning. They are carefully worded
  rules (consensus, evidence, marker placement); the translation must keep
  every rule, not paraphrase it shorter.
- `npm run check` passes; the test suite keeps the same number of tests and
  the same assertions, only translated.

## Non-goals

- No internationalisation layer (no i18n library, no locale switch, no
  string catalogue). One language, English. Adding a dependency is out.
- No rewording beyond translation: UI copy is not redesigned here (that is
  the CLI redesign branch). Where a French string is awkward, translate it
  plainly; do not restructure the UI.
- No change to the less-verbose-output or CLI-redesign topics.
- No history rewrite, no change to past commit messages.
- Old memory files in users' projects are not migrated (see below).

## Anti-goals

- A translation that silently drops or softens a rule in an agent prompt.
- A test whose assertion is weakened while being translated (for example a
  full-string match turned into a substring match).
- Copying the translation from the external fork `polkabrothers/claudex`:
  it is unreviewed third-party work. The translation here is our own; the
  fork may be glanced at only to spot files we missed.

## Scope, by area

Measured on main (c47b50e) with a grep for accented letters and common
French words: about 65 tracked files.

1. **Agent prompts** (`src/orchestrator/scheduler.ts`: `CONSENSUS_INSTRUCTIONS`,
   `SYNTHESIS_PROMPT`, the attribution label `Utilisateur` → `User`, and any
   other prompt text sent to an agent; `src/agents/*` for prompts sent by the
   adapters). Translate rule by rule. The worked example at the end of
   `CONSENSUS_INSTRUCTIONS` stays (marker alone on the last line).
2. **Language of the agents' answers.** Today the prompts are in French, so
   the agents answer in French. With English prompts they would answer in
   English even when the human writes French. Decision: add one rule to
   `CONSENSUS_INSTRUCTIONS` and to `SYNTHESIS_PROMPT`: write in the language
   of the human's messages (the topic). Prompts are English, the debate
   follows the human. The rule covers the debate messages and the consensus
   summary only: it states explicitly that code, code comments, commit
   messages and files written after `/implement` follow the project's own
   conventions, not the language of the conversation (the rules stay in the
   agent's context during `/implement`). A new test pins the rule (strict
   TDD: written first). The symmetry test on `CONSENSUS_INSTRUCTIONS` must
   still pass. *(Maintainer to confirm, see "Open question".)*
3. **UI strings** (`src/ui/**`, `src/cli.tsx`, `src/launch.ts`, `bin/claudex.mjs`,
   error and usage messages in `src/orchestrator/**`, `src/agents/**`,
   `src/memory/**`, `src/util/**`).
4. **Slash command** `/sujet` becomes `/topic`. No French alias is kept:
   Claudex has no released users, and an alias would be French left in the
   code. Help text, command palette and README updated.
5. **Dates.** `WelcomeScreen.tsx` formats the last session with
   `Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" })`.
   It becomes `"en-US"` with the same options (fixed locale, so the output
   is deterministic in tests and consistent with an English UI).
6. **Files Claudex writes in the user's project** (`src/memory/store.ts`):
   the `.claudex/.gitignore` scaffold (`CLAUDEX_GITIGNORE`, also fix its
   wording that overclaims, noted 2026-10-26: it says decisions.md and
   limits.md are "re-read by both agents at the start of every debate";
   in fact the debate rules only point the agents at them. New wording:
   "the debate rules point both agents at them". The whitelist claim about
   future files is true and stays), the `# Décisions` header of a
   new `decisions.md`, the handoff section headings (`## Mémoire projet`,
   `## Spécification consensuelle`, `## Consigne d'exécution`), transcript
   labels. Nothing in the code parses these headings back (checked: memory
   is read as whole files), so existing French files in users' projects keep
   working; they are not rewritten, and a mixed-language file is acceptable.
   Whether an existing `.claudex/.gitignore` is resynced is unchanged
   behaviour: keep whatever `ensureMemory` does today.
7. **Tests**: test names, comments, and expected strings follow the
   translated code. This modifies existing tests, which needs the
   maintainer's explicit permission (asked with this design). Rule: only
   language changes; same number of tests, same matchers, same strictness.
   Tests that assert on a French string assert on its English counterpart.
   Exception: new tests for the language rule (item 2), added on purpose;
   the count is compared against main (c47b50e) and each added test is
   named in the PR. The in-memory `"Sujet :"` prefix check in
   `transcriptStream.ts` changes together with the string that produces it.
8. **Code comments** in French anywhere in `src`, `bin`, `scripts`,
   `docs/demo`.
9. **Docs**: README (two French lines), AGENTS.md (remove the "still in
   French" convention and replace it with "everything is in English"),
   `docs/superpowers/specs` and `plans` (a few French fragments, mostly
   quoted UI strings of the time: translate them and mark them as quotes of
   the former French UI where the meaning depends on it).
10. **Project memory of this repository**: `.claudex/memory/decisions.md`
    (~275 French lines) and `limits.md` (~416). Faithful translation, entry
    by entry: dates, headings order, measured values, commands and outputs
    unchanged; no summarising, no merging of entries, no new claims.
    French text quoted as evidence (former prompts, former UI strings,
    agents' French replies captured during a measurement) is translated
    too and marked "(translated from French)" where the exact wording was
    the evidence. Commands, code, file paths and ASCII tool output are
    kept byte for byte. Same rule for the historical specs and plans, so
    the final grep can come out clean.
    `.claudex/.gitignore` of this repository resynced with the new scaffold.
11. **Repository agent** `.claude/agents/memoire-claudex.md`: translated and
    renamed `claudex-memory` (file and `name:`), since the name itself is
    French. AGENTS.md/CLAUDE.md mention it nowhere; nothing else refers to it.
12. **Demo**: `docs/demo/claudex-session.tsx` (scripted session) and
    `docs/demo/claudex.tape` (typed topic) translated, then
    `docs/demo/claudex.gif` regenerated with `vhs docs/demo/claudex.tape`
    (vhs is installed locally; it is a maintainer tool, not a project
    dependency). The README alt text is updated if the content changes.
    Same tape settings; reducing the GIF size is not in scope.

## Verification

- `npm run check` green.
- Test count: main's count plus only the new language-rule tests
  (`npx vitest run` summary on both).
- A final grep over all tracked files for accented letters and frequent
  French words (`le|la|les|des|une|est|pas|pour|avec|dans|sur|sujet|débat`),
  each remaining hit justified (for example a word that is also English, or
  a test fixture that deliberately contains French input, such as a topic
  typed by a French user to check the language rule).
- Prompt review: a reviewer compares each French prompt with its English
  version, rule by rule, from the diff.
- Manual smoke test by the maintainer: launch, start a debate in French
  and one in English, check the agents answer in the human's language, check
  `/topic`, `/help`, the welcome screen date, a handoff file.

## Execution

Larger change over many modules: subagent-driven development, one task per
area (prompts; UI and messages; memory scaffold and handoff; tests follow
each code task; docs and AGENTS.md; repository memory; agent file; demo),
with a review after each task. The prompts task gets a dedicated
rule-by-rule review.

## Decisions taken (by Claude, delegated)

- One language, no i18n layer: simplest, no dependency, matches "nothing in
  French". Rejected: a locale switch (dependency or home-made catalogue,
  extra surface, not asked).
- Agents answer in the human's language: keeps Claudex usable by
  non-English speakers, including the maintainer, at the cost of one prompt
  rule. Rejected: English-only answers (hostile to non-English users);
  keeping French prompts (contradicts the goal).
- `/sujet` → `/topic` without alias. Rejected: keeping an alias (French
  left in the code, no users to protect).
- Fixed `en-US` date locale. Rejected: the system locale (mixes languages in
  an English UI, non-deterministic tests).
- Users' existing French memory files are left as they are. Rejected: a
  migration (writes in the user's project for no functional gain).
- Our own translation, not the fork's.
- The language rule does not reach code written after `/implement`.
- French evidence in the memory and in old specs/plans is translated and
  marked, not kept verbatim: the goal is "nothing in French", and the git
  history keeps the originals.

## Open question for the maintainer

1. Agents answer in the language of the human's messages (recommended), or
   always in English?
2. Permission to modify existing tests for translation only, under the rule
   in item 7.
