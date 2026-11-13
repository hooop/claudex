# Concise Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Short answers by default for every agent message, plain questions answered without a debate, the rules delivered through each agent's system channel, and the model line hidden during the debate unless a context runs low.

**Architecture:** The rules (`CONSENSUS_INSTRUCTIONS`) are rewritten into short sections with a universal response style. The scheduler passes them on every `send` as a new required `instructions` option; the Claude adapter maps it to a custom `systemPrompt`, the Codex adapter to `developerInstructions`. The first-message prepending and its `instructed` bookkeeping go. `ModelFooter` gains a `showModels` switch that `DebateView` drives from a low-context check.

**Tech Stack:** TypeScript (strict, ESM, tsx), Ink 7 / React 19, Vitest, `@anthropic-ai/claude-agent-sdk` 0.3.310, `codex app-server` 0.167.2.

**Spec:** `docs/superpowers/specs/2026-11-13-concise-answers-design.md`

## Global Constraints

- Everything in English: code, comments, prompts, tests, commits.
- No agent named in `CONSENSUS_INSTRUCTIONS` outside the `self`/`other` roles; the symmetry test in `src/__tests__/scheduler.test.ts` (~line 1163) must keep passing unchanged.
- No truncation of agent text in code. `SYNTHESIS_PROMPT` is not changed.
- No new dependency. No new marker.
- Claude: `systemPrompt: { type: "custom", prompt: <rules>, snapshot: true }` — never the `claude_code` preset (measured +2 200 tokens per call).
- Codex: `developerInstructions` — never `baseInstructions` (it replaces Codex's base prompt).
- Tests never call `claude`, `codex` or the network.
- `npm run check` passes at the end of every task; commit at the end of each task (Conventional Commits, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

## Review Focus

1. A `/new` or a new topic after a debate (Root calls `resetSession`): the next session must get the rules again. Covered because rules are passed on every `send` — Task 3 pins it per adapter (start of a fresh thread/session carries them).
2. The synthesis turn (`SYNTHESIS_PROMPT`) and implementation turns carry the same instructions as debate turns, so the recorded prompt never differs within a session — Task 3 pins both scheduler call sites.
3. A failed first turn followed by an intervention: the next delivery carries no rules text in the message, and the rules still reach the agent through `instructions` — Task 3 pins it.
4. The end-marker examples still parse after the rewrite (a marker trailing a sentence is ignored) — Task 1 keeps the two existing example tests.
5. Footer with one context unmeasured (`null`) and the other at 10 % free: the line shows (one low context is enough), and `null` alone never shows it — Task 4 pins both.

---

### Task 1: Rewrite the rules with a universal response style

**Files:**
- Modify: `src/orchestrator/scheduler.ts` (`CONSENSUS_INSTRUCTIONS`, ~line 1749, and its doc comment)
- Test: `src/orchestrator/__tests__/markers.test.ts` (`describe("CONSENSUS_INSTRUCTIONS")`)

**Interfaces:**
- Produces: `CONSENSUS_INSTRUCTIONS(self: string, other: string): string` — same signature, new text.

- [ ] **Step 1: Update the rule tests.** In `markers.test.ts`, replace "asks for density as a target, not a limit" and "allows headings only when they help" (they pin the old wording — the design authorises rewriting them) and add the new ones. Keep the other tests of the block unchanged.

```ts
it("is organised in labelled sections", () => {
  for (const label of ["Role", "Project memory", "Response style", "Evidence", "Working notes", "End marker"]) {
    expect(prompt).toContain(`${label}:`);
  }
});

it("asks for a short answer first, as a target", () => {
  expect(prompt).toMatch(/answer or position first/i);
  expect(prompt).toContain("120 words");
  expect(prompt).toMatch(/target, not a limit/);
});

it("rules out meta commentary, unasked headings and closing offers", () => {
  expect(prompt).toMatch(/do not announce the language/i);
  expect(prompt).toMatch(/no headings unless the human asks/i);
  expect(prompt).toMatch(/no closing question or offer/i);
  expect(prompt).toMatch(/do not speculate/i);
});

it("lets a summary, specification or implementation request set its own length", () => {
  expect(prompt).toMatch(/summary, a specification or implementation work/i);
});

it("keeps one or two arguments per debate turn and no restating", () => {
  expect(prompt).toMatch(/one or two important arguments/i);
  expect(prompt).toMatch(/do not restate/i);
});
```

The existing "asks for the position first and no restating" test expects the literal `position or main objection first`: drop that test, its content is now covered by the two above.

- [ ] **Step 2: Run** `npx vitest run src/orchestrator/__tests__/markers.test.ts` — Expected: the new tests FAIL on missing text; the example-parsing tests still pass.

- [ ] **Step 3: Rewrite `CONSENSUS_INSTRUCTIONS`.** Sections in this order, each starting with its label followed by a colon on its own paragraph, joined with blank lines: **Role** (identity with self/other, attribution lines, no file changes before implementation, language rule as today), **Project memory** (as today), **Response style** (the seven constraints of design D1, plus its scope sentence: it governs debate turns and answers to the human; a message asking for a summary, a specification or implementation work sets its own length and structure), **Evidence** (today's evidence rule, unchanged in substance), **Working notes** (today's sentence), **End marker** (today's marker sentence, the NO_TOPIC sentence updated to "no topic to debate, including a plain question or request that needs no debate", then the existing correct/incorrect example block unchanged). Keep "Do not use any emoji…" in Response style. Update the doc comment: keep its symmetry and example rationale, add one paragraph on why the sections and the universal style (design "Root causes").

- [ ] **Step 4: Run** `npx vitest run src/orchestrator/__tests__/markers.test.ts src/__tests__/scheduler.test.ts` — Expected: PASS (symmetry test included).

- [ ] **Step 5: Run** `npm run check`, then commit: `feat: give every agent message one short response style`.

---

### Task 2: Answer plain questions during qualification

**Files:**
- Modify: `src/orchestrator/scheduler.ts` (`enqueueProvisionalValidation`, ~line 1180)
- Test: `src/__tests__/scheduler.test.ts` (qualification describe block)

- [ ] **Step 1: Write the failing test** `it("offers a plain-question exit in the qualification prompt")`: start the scheduler with `"how does it work ?"`, wait for `agents.claude.isPending()`, then assert on `agents.claude.lastMessage`:

```ts
expect(msg).toMatch(/question or request that does not call for a debate/i);
expect(msg).toMatch(/answer it directly/i);
expect(msg).not.toMatch(/invite the human to give a topic/i);
// The four cases appear in this order.
const order = ["contains no topic", "does not call for a debate", "essential before debating", "start the analysis"]
  .map((s) => msg.indexOf(s));
expect(order.every((i, k) => i > -1 && (k === 0 || i > order[k - 1]))).toBe(true);
```

Add a second test `it("keeps the session open after a plain answer")`: the agent completes `"It works like this.\n\n<<NO_TOPIC>>"`; assert the scheduler waits for the human (same assertions the existing NO_TOPIC test uses — reuse its helper/expectations) and that a following `intervene("Real topic", "both")` becomes the new provisional topic.

- [ ] **Step 2: Run** `npx vitest run src/__tests__/scheduler.test.ts -t "plain"` — Expected: the first FAILS on missing text; the second may already pass (it pins existing behaviour that D2 relies on).

- [ ] **Step 3: Rewrite the third paragraph of the qualification text** as the four numbered cases of design D2, with these exact phrases so the test matches: "contains no topic" (answer in one sentence, end with NO_TOPIC), "a question or request that does not call for a debate between the two agents … answer it directly, following the response style, then end with NO_TOPIC", "information from the human is essential before debating" (ask, end with WAIT_HUMAN), "Otherwise start the analysis and use the appropriate normal marker".

- [ ] **Step 4: Run** the two tests — Expected: PASS. Then `npm run check`, commit: `feat: answer plain questions without starting a debate`.

---

### Task 3: Deliver the rules through each agent's system channel

**Files:**
- Modify: `src/agents/types.ts` (`AgentSendOptions`)
- Modify: `src/orchestrator/scheduler.ts` (both `send` call sites ~885 and ~1441; remove `instructed` ~132 and ~950, `pendingInstructions` ~1684, and its use ~838)
- Modify: `src/agents/claudeAgent.ts` (query options ~199)
- Modify: `src/agents/codexAgent.ts` (`threadParams` ~407)
- Modify: any other caller of `send` that stops compiling (`npm run typecheck` lists them; expected: tests and `docs/demo/claudex-session.tsx` only if it calls `send`)
- Test: `src/__tests__/scheduler.test.ts`, `src/agents/__tests__/claudeAgent.test.ts`, `src/agents/__tests__/codexAgent.test.ts`

**Interfaces:**
- Consumes: `CONSENSUS_INSTRUCTIONS` from Task 1.
- Produces: `AgentSendOptions.instructions: string` (required) — "The debate rules for this agent. Adapters send them through the system channel; they are identical for every send of a session."

- [ ] **Step 1: Scheduler tests.**
  - Give `FakeAgent` a public `lastOptions: AgentSendOptions | null` set in `send`.
  - Remove the three tests "should send the debate rules again when a failed first qualification is replaced", "should send the debate rules with an intervention that follows a failed first turn", "should not repeat the debate rules when a failed turn is retried after a delivered one" (the mechanism they cover is removed by design D3; authorised).
  - In "should name the writer and the reader on every delivered block", replace `expect(agents.claude.lastMessage).toContain("you are Claude")` with `expect(agents.claude.lastOptions?.instructions).toBe(CONSENSUS_INSTRUCTIONS("Claude", "Codex"))`, and update the comment above it (rules now reach the agent with the session, not the first turn).
  - Add `it("passes the rules on every send and never in the message")`: run qualification → Codex turn → a failed Codex turn → `intervene("Use the default model", "codex")`; for every send of both fakes assert `instructions` equals `CONSENSUS_INSTRUCTIONS(self, other)` and the message does not contain `"Rules of this debate"` nor `"Role:"`.
  - Add `it("passes the rules to the synthesis turn")`: reach consensus (both `<<CONSENSUS>>`, with an autonomy bound as AGENTS.md requires), and assert the synthesis send (message `=== SYNTHESIS_PROMPT`, export it if not exported) has the same `instructions`.

- [ ] **Step 2: Adapter tests.**
  - `claudeAgent.test.ts`: `it("sends the rules as a recorded custom system prompt")` — debate turn and `writeAccess: true` turn both get `options.systemPrompt` equal to `{ type: "custom", prompt: "RULES", snapshot: true }`.
  - `codexAgent.test.ts`: `it("sends the rules as developer instructions on start and resume")` — the `thread/start` params and, on a second send, the `thread/resume` params both contain `developerInstructions: "RULES"` and no `baseInstructions`.
  - Add `instructions: "RULES"` to the existing calls in those files as typecheck requires.

- [ ] **Step 3: Run** the three test files — Expected: new tests FAIL (missing option / prompt still in message); removed tests gone.

- [ ] **Step 4: Implement.** Add the field; scheduler builds `CONSENSUS_INSTRUCTIONS(AGENT_NAME[agent], AGENT_NAME[this.other(agent)])` at both call sites and drops the prepending and the `instructed` state with its comments; Claude adapter adds `systemPrompt` next to `resume` for both branches, with a one-line comment pointing to limits.md 2026-11-13 (why custom, not preset); Codex adapter adds `developerInstructions` to `threadParams` with a one-line comment (why not `baseInstructions`).

- [ ] **Step 5: Run** `npm run check` — Expected: PASS. Commit: `feat: send the debate rules through each agent's system channel`.

---

### Task 4: Hide the model line during the debate unless a context runs low

**Files:**
- Modify: `src/ui/components/ModelFooter.tsx`
- Modify: `src/ui/DebateView.tsx` (~line 775)
- Test: `src/ui/components/__tests__/modelFooter.test.ts`, `src/ui/__tests__/debateView.test.tsx`

**Interfaces:**
- Produces: `export const LOW_CONTEXT_FREE_PERCENT = 25;` and `export function isContextLow(usage: AgentContextUsage | null | undefined): boolean` (true when measured and free share `< 25 %`, using the same rounding as `contextRemainingPercent`); `ModelFooter` prop `showModels?: boolean` (default `true`; when `false` only `/help` is drawn, right-aligned, same single row).

- [ ] **Step 1: Unit tests** in `modelFooter.test.ts`: `isContextLow` → `false` for `null`, `undefined`, `contextWindow: 0`, exactly 25 % free; `true` for 24 % and 0 %. Render test: `showModels={false}` output contains `/help` and not the model names.

- [ ] **Step 2: DebateView tests.** Add: during a debate with both contexts at 75 % free (or unmeasured), the footer shows `/help` and not `fake-model`; with Claude at 10 % free and Codex `null`, it shows `fake-model · ctx 10% free + fake-model · ctx —`. Update the existing assertions at ~lines 506–513 and ~606 that expect the model line during the debate: keep each test's purpose (the footer stays on the last row; the reading follows usage updates) by driving the context under 25 % where the test is about the reading, or by asserting on `/help` where it is about position. Welcome-screen tests stay unchanged and must pass.

- [ ] **Step 3: Run** both files — Expected: new tests FAIL.

- [ ] **Step 4: Implement.** `DebateView` passes `showModels={isContextLow(contextUsage?.claude) || isContextLow(contextUsage?.codex)}`. The row count (`MODEL_FOOTER_ROWS`) does not change.

- [ ] **Step 5: Run** `npm run check` — Expected: PASS. Commit: `feat: show the model line during a debate only when a context runs low`.

---

### Task 5: Record the decisions and measurements

**Files:**
- Modify: `.claudex/memory/decisions.md` (new entry at the top, format of the 2026-11-12 entry)
- Modify: `.claudex/memory/limits.md` (new entry, format of 2026-08-17)
- Modify: `README.md` only if it describes the footer during the debate (line ~156 covers the welcome screen only; check the "Debate" section)

- [ ] **Step 1:** decisions.md entry "2026-11-13 — One short response style for every message; rules in the system channel": nature (maintainer feedback, Claude's technical calls), reopening of 2026-11-12 stated with the new reason, D1–D4 in one line each, rejected approaches A and C with their reason, files involved.
- [ ] **Step 2:** limits.md entry "2026-11-13 — System channels for the debate rules, measured": the token table and the BANANA results from the design's D3, the finding that an omitted `systemPrompt` is empty on SDK 0.3.310, and "How to apply: re-measure at every SDK or Codex upgrade; never switch to the preset or `baseInstructions` without measuring".
- [ ] **Step 3:** `npm run check`, commit: `docs: record the concise-answers decisions and measurements`.
