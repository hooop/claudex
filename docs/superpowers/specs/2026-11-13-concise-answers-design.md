# Concise answers everywhere — design

Date: 2026-11-13. Branch: `feat/concise-answers`. Technical choices are Claude's
(the maintainer delegated them); the maintainer approves this document and the PR.

## Why

The maintainer, after the 2026-11-12 density work: "even an answer to a simple
question must be less verbose". Their sample (transcript
`2026-11-13T09-20-03-942Z-bonjour.md`, question "how claudex works ?") is a
300-word sectioned explainer: a meta preamble ("This is a question about how
Claudex works, not a decision to debate. Here is a short answer, taken from…"),
three bold headings, a twelve-item walkthrough, and an unsolicited closing
relance ("What do you want to debate next? For example: …"). Earlier sessions
also showed meta lines about the reply language and what had or had not been
read, and speculation from the git branch name.

The model line under the prompt (`Opus 5 · ctx 82% free + gpt-5.5 · ctx 90%
free`) is noise during the debate: it changes only on `/model` and matters only
when a context runs low.

## Root causes (verified in code)

1. **The brevity rule only covers arguing.** `CONSENSUS_INSTRUCTIONS`
   (`src/orchestrator/scheduler.ts`) asks for density "to argue"; nothing governs
   an answer to a question, a qualification reply or a reply to the human.
2. **The qualification has no case for a plain question.** The prompt built in
   `enqueueProvisionalValidation` offers three exits: no topic (and "invite the
   human to give a topic"), WAIT_HUMAN, or start the analysis. A question about
   the project is none of them, so the model improvises: it explains that it is
   not a debate topic, answers at length, then invites a topic.
3. **The rules are one run-on paragraph glued to the first user message.**
   `pendingInstructions` prepends them to whatever the first delivery is, the
   human's text included. The model reads them as part of the request and echoes
   them ("I will answer in French…"). They also sit in the conversation, not in
   a system channel, so a context compaction can summarise them away in a long
   debate.

## Goals

- G1. Every agent message, debate turn or not, is short by default: the answer
  or position first, then only what the reader needs.
- G2. A plain question gets a plain answer, without becoming a debate and
  without boilerplate around it.
- G3. The rules reach each agent through its system-level channel, once per
  session, and survive compaction.
- G4. The model line is hidden during the debate unless it carries a warning.

## Non-goals

- The consensus summary (`SYNTHESIS_PROMPT`) and `/handoff`: they stay complete.
- The `/implement` phase output.
- A verbosity setting or a new command.
- Any other UI change (that is the redesign branch).

## Anti-goals

- Truncating text in code (decisions.md 2026-11-12, rejected; not reopened).
- Weakening the evidence rule or its symmetry, or naming an agent outside the
  self/other roles.
- A change that silently alters what else the agents receive in their system
  prompt (base prompt, tools, cost) beyond the rules themselves.

## Decisions

### D1. One response style for every message

Reopens the 2026-11-12 decision "about 200 words, to argue", stated as such.
New reason: maintainer feedback that the target was too high and its scope too
narrow (it never covered plain answers).

The rules are rewritten as short sections with plain labels, in this order:
**Role** (who you are, attribution lines, no file changes before
implementation, language), **Project memory**, **Response style**,
**Evidence**, **Working notes**, **End marker** (with the existing correct and
incorrect examples, unchanged). Each section is a few short sentences or a
short list.

The **Response style** section, for every message:

- Answer or position first, in the first sentence.
- Aim for about 120 words; a target, not a limit. Go longer only for a
  technical demonstration or when the human asks for detail.
- No preamble or meta commentary: do not announce the language you use, what
  you read or have not read, or what you are about to do.
- No headings unless the human asks for a document; a short list only when
  the content is a real list.
- Do not restate the other's message, do not repeat what is agreed, no closing
  recap, no closing question or offer unless you need an answer to go on.
- Answer what was asked; do not speculate about intentions, plans or context
  that the conversation and the code do not establish.
- In a debate turn: one or two important arguments per message, keep the
  others for later.

**Scope of the style (Claude's call).** With D3 the rules live in the session's
system prompt, and the consensus summary (`SYNTHESIS_PROMPT`, sent in the same
session) and the implementation turns resume that session. The section therefore
states its own scope: it governs debate turns and answers to the human; when a
message asks for a summary, a specification or implementation work, that
message's own instructions on length and structure win. Without this, the
summary that feeds `/handoff` could come out truncated, against the non-goals.
`SYNTHESIS_PROMPT` itself is not changed.

The exact wording is the builder's, in English, within these constraints.

### D2. A plain question is answered, not debated

The qualification prompt gets a fourth case, worded as a sequence:

1. no topic at all (a greeting, an empty message): answer in one sentence and
   end with `NO_TOPIC`;
2. a question or request that does not call for a debate between the two
   agents (how something works, where something is): answer it directly,
   following the response style, and end with `NO_TOPIC`;
3. a topic that needs information from the human first: ask, end with
   `WAIT_HUMAN`;
4. otherwise start the analysis.

No new marker: the `NO_TOPIC` path already keeps the session open, shows the
answer and lets the next message replace the subject (scheduler, "Not a
debatable subject — but the conversation stays open"). Only the prompt
changes. The "invite the human to give a topic" sentence goes: the prompt
already says what to type.

The `NO_TOPIC` line in the rules is updated to match ("no topic to debate",
including a plain question).

### D3. The rules move to each agent's system channel

- **Claude:** `systemPrompt: { type: "custom", prompt: rules, snapshot: true }`
  on debate turns and on implementation turns. Not the `claude_code` preset:
  measured below, an omitted `systemPrompt` is an empty one today, and the
  preset would add about 2 200 tokens of instructions to every call. The SDK
  records the prompt on a session's first request and reuses it on resume.
- **Codex:** `developerInstructions` on `thread/start`, and the same value on
  `thread/resume`.
- `pendingInstructions`, the `instructed` state and the first-delivery
  prepending are removed. The rules now arrive with the session, so the case
  they handled (a failed first turn must not lose the rules) no longer exists.
- `AgentSendOptions` gets a required `instructions: string`: the scheduler,
  which already builds the rules from the self/other names, passes them on
  every `send` (debate turns, synthesis, implementation). Each adapter maps
  them to its system channel. Passing them every time costs nothing (both
  channels are recorded per session) and keeps one source of truth, with no
  per-agent "already instructed" state.

**Measured on 2026-11-13, before writing the plan** (scripts in the session
scratchpad, debate options, model `sonnet`; first-response
`input_tokens + cache_creation + cache_read`, method of limits.md 2026-08-17):

| Claude `systemPrompt` | Tokens |
| --- | --- |
| omitted | 3 219 – 3 242 |
| `[]` | 3 219 |
| `"Reply in lowercase."` | 3 228 |
| `{ type: "preset", preset: "claude_code" }` | 5 469 |

- A custom prompt "End every reply with a last line exactly equal to BANANA."
  was applied on turn 1, on a resume that passed it again, and on a resume
  that did not pass it (recorded with the session).
- Codex 0.167.2: `developerInstructions` and `baseInstructions` are both in the
  generated `ThreadStartParams` and `ThreadResumeParams`. `developerInstructions`
  (not `baseInstructions`, which replaces Codex's own base prompt) with the same
  BANANA instruction was applied on `thread/start`, on a `thread/resume` that
  passed it again, and on one that did not.

Recorded in limits.md by the plan's last task.

### D4. The model line during the debate

The footer row stays reserved (the frame layout from PR #17 depends on a fixed
footer height; collapsing the row would reopen that work for no gain). During
the debate it shows only `/help` on the right, unless one agent has less than
25 % of its context free: then it shows the full line as today, so the warning
is visible. The welcome screen keeps the full line. `/model` already shows the
model picker, which lists the choices.

The 25 % threshold is a named constant next to `contextRemainingPercent`. An
unmeasured context (`null`) is not low.

## Approaches considered

- **A. Wording only, rules stay in the first message.** Smallest diff, but it
  keeps cause 3: the rules stay mixed with the human's text and exposed to
  compaction. Rejected.
- **B. Rules in the system channel plus the new style (chosen).** Fixes all
  three causes and removes the `instructed` bookkeeping. Costs a measurement
  step and an interface change.
- **C. Rules resent on every turn.** Survives compaction without touching the
  system prompt, but adds about 800 tokens per turn and repeats them in the
  conversation. Rejected.
- **Hard word limit or truncation.** Already rejected 2026-11-12; not reopened.

## Tests

Prompt quality cannot be unit-tested; the tests pin structure and delivery.

- `CONSENSUS_INSTRUCTIONS`: section labels present, the response-style
  constraints present (answer first, about 120 words, target not limit, no
  meta, no headings unless asked, no closing question), the scope exception
  for summaries, specifications and implementation work, symmetry unchanged,
  end-marker examples still parsed by `extractSignal`.
- Qualification prompt: the plain-question case and its `NO_TOPIC` exit.
- Claude adapter (mocked `query`): debate and implementation turns pass
  `systemPrompt: { type: "custom", prompt: rules, snapshot: true }`.
- Codex adapter (mocked spawn): `developerInstructions` on start and resume.
- Scheduler: no delivery carries the rules.
- Footer: `/help` only during the debate; full line when one context is
  under 25 %; full line on the welcome screen; `null` usage not low.

**Existing tests this changes (maintainer approval asked with this design):**

- `src/orchestrator/__tests__/markers.test.ts`: "asks for density…" (expects
  "200 words") and "allows headings only when they help" (old wording) are
  rewritten for D1.
- `src/__tests__/scheduler.test.ts` around lines 678–725: the three tests on
  resending the rules after a failed first turn are removed, since D3 removes
  the mechanism they cover; the comment at line 231 is updated.
- `src/ui/__tests__/debateView.test.tsx`: assertions that expect the model line
  during the debate are updated for D4.

## Acceptance

- `npm run check` passes.
- Manual check by the maintainer: "how claudex works ?" gets a direct answer of
  about 120 words, no preamble, no headings, no closing offer; a real debate
  still reaches consensus with valid markers.
- decisions.md: entry recording D1 (reopening of 2026-11-12) and D3.

## Rollback

Each decision is its own commit. Reverting D3 brings back the first-message
delivery with the new wording; D1, D2 and D4 are wording and UI only.
