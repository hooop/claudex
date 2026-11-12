# Less Verbose Debate Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Denser debate messages (rules), working notes moved out of the visible and delivered message into the footer and a diagnostic trace file.

**Architecture:** The debate rules gain density and evidence-excerpt sentences. Adapters split a turn into note and answer segments when the caller passes `onNote`, and report finished tools through `onTrace`. The scheduler keeps the visible entry equal to the delivered text, emits `onOutputReset` when a note is removed, and records a session trace that Root writes next to the transcript archive.

**Tech Stack:** Node >= 22, TypeScript strict ESM via tsx, Ink 7 / React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-less-verbose-output-design.md`

## Global Constraints

- Everything in English: code, comments, tests, prompts, docs.
- No new dependency.
- Do not modify, skip or weaken any existing test. New tests only. If an existing test seems to need a change, stop and report.
- Never truncate an agent's debate text in code. Only the trace file caps outputs, at `64 * 1024` bytes each.
- The debate rules name no agent outside the self/other roles; the symmetry test in `src/__tests__/scheduler.test.ts` must keep passing.
- Separation of notes is active only when `onNote` is passed; the scheduler passes it only for debate turns with `writeAccess: false`, never for implementation turns or the synthesis.
- Data, not presentation: new types carry raw text; formatting, truncation and styling stay in `src/ui/`.
- `npm run check` passes at the end of every task (`npm test` for the touched suites while iterating).
- Commits: Conventional Commits, ending with the session's attribution lines.

## Review Focus

- A Claude turn whose only text comes before its last tool call (answer empty) must still produce a non-empty message and its marker must still be recognised (fallback) — Task 4 test `falls back to every segment when the answer is empty`.
- A Codex turn made only of commentary items, ending with a marker inside commentary — Task 3 test `only-commentary turn keeps its marker`.
- A note arriving while a human intervention was interleaved into the running answer: the intervention must stay visible after the reset — Task 6 test `keeps interleaved lines after a reset`.
- A note whose text was never streamed (Codex `item/completed` without deltas) must not cut the live text — Task 5 test `ignores an unstreamed note when trimming the live text`.
- Trace outputs containing triple backticks must not break the Markdown file — Task 7 test `fences an output containing backticks`.

---

### Task 1: Debate rules — density and evidence excerpts

**Files:**
- Modify: `src/orchestrator/scheduler.ts` (`CONSENSUS_INSTRUCTIONS`, ~line 1663)
- Modify: `.claudex/memory/decisions.md` (new dated entry at the top of the entries, following the file's format)
- Test: `src/orchestrator/__tests__/markers.test.ts` (inside `describe("CONSENSUS_INSTRUCTIONS")`)

**Interfaces:** none.

- [ ] **Step 1: Write the failing tests** (new `it` blocks, `prompt = CONSENSUS_INSTRUCTIONS("Claude", "Codex")` already exists there):
  - `asks for density as a target, not a limit`: `prompt` contains `"as briefly as possible, but as precisely as necessary"`, contains `"200 words"`, and matches `/target, not a limit/`.
  - `asks for the position first and no restating`: contains `"position or main objection first"` and `/do not restate/i`.
  - `allows headings only when they help`: matches `/headings or lists only when they make the message easier to follow/i`.
  - `makes working notes private`: contains `"after your last tool call"` and `"private working note"`.
  - `allows evidence excerpts under conditions`: contains `"relevant lines"`, matches `/exit code/i`, `/misrepresent/i`, and `/say what you left out/i`; still contains `"exact command"`.
- [ ] **Step 2:** `npx vitest run src/orchestrator/__tests__/markers.test.ts` — the new tests FAIL on missing text.
- [ ] **Step 3: Implement.** Add the sentences of spec D1 and rewrite the evidence sentence per spec D2, using the exact phrases the tests assert. Keep the sentence about markers and the example block unchanged.
- [ ] **Step 4:** Run the same file plus `npx vitest run src/__tests__/scheduler.test.ts -t symmetr` — PASS.
- [ ] **Step 5:** Add the decisions.md entry `## 2026-11-12 — Denser debate messages and evidence excerpts`: Nature (maintainer arbitration), the measured baseline (Claude median 321 words, p90 988), the decision (density rules, 200 words as a target, headings allowed when useful, notes private), the amendment to the 2026-08-17 evidence rule (excerpt conditions verbatim from spec D2), rejected alternative (hard word limit / truncation, and why), files involved.
- [ ] **Step 6:** `npm run check` — PASS. Commit `feat: ask debaters for denser messages and allow evidence excerpts`.

---

### Task 2: Shared types and the footer note

**Files:**
- Modify: `src/types.ts` (`AgentActivity`, new trace types)
- Modify: `src/agents/types.ts` (`AgentSendOptions`)
- Create: `src/agents/turnText.ts`
- Modify: `src/ui/components/StatusBar.tsx` (`describeActivity`)
- Test: `src/agents/__tests__/turnText.test.ts` (new), `src/ui/components/__tests__/statusBar.test.ts` (new `it` blocks only)

**Interfaces:**
- Produces in `src/types.ts`:
  ```ts
  | { kind: "note"; status: "running"; label: string }   // new AgentActivity member
  export interface ToolTraceEvent {
    kind: "tool";
    label: string;
    status: "success" | "failure";
    exitCode?: number | null;
    output?: string;
  }
  export type TraceEvent = { kind: "note"; text: string } | ToolTraceEvent;
  export interface TraceRecord { agent: AgentId; timestamp: number; event: TraceEvent }
  ```
- Produces in `AgentSendOptions`:
  ```ts
  /** Separation is active only when this is passed. `streamed` says whether the note's text already went through onTextDelta, as the suffix since the last boundary. */
  onNote?: (note: string, streamed: boolean) => void;
  /** A finished tool or command, with its full output when the adapter has it. */
  onTrace?: (event: ToolTraceEvent) => void;
  ```
- Produces in `src/agents/turnText.ts`:
  ```ts
  export interface TurnSegment { kind: "note" | "answer"; text: string }
  /** Answer segments joined as-is; if that holds nothing but whitespace or a protocol marker, every segment's text in order, trimmed, joined with "\n\n". */
  export function composeTurnText(segments: readonly TurnSegment[]): string;
  ```
  Uses `extractSignal` from `src/orchestrator/markers.ts` to detect "only a marker" (`cleanText.trim() === ""`).

- [ ] **Step 1: Write failing tests.**
  - `turnText.test.ts`: `returns the answer only` (`[note "a", answer "b"]` → `"b"`); `joins answer segments as-is` (`[answer "x", note "n", answer "y"]` → `"xy"`); `falls back to all segments when the answer is empty` (`[note "Reading.", answer ""]` → `"Reading."`); `falls back when the answer is only a marker` (`[note "Found it.", answer "\n<<CONSENSUS>>\n"]` → `"Found it.\n\n<<CONSENSUS>>"`); `returns an empty string for no segments`.
  - `statusBar.test.ts`: `describes a note by its flattened text` — `describeActivity({ kind: "note", status: "running", label: "Reading\n the  memory" })` → `"Reading the memory"`; `strips control sequences from a note` — label with `"\u001b[31m"` yields no `\u001b`.
- [ ] **Step 2:** Run both files — FAIL (missing module / wrong description).
- [ ] **Step 3: Implement** the types, `composeTurnText`, and the `note` branch of `describeActivity` (return `flattenActivityLabel(activity.label)`; fall back to `"working…"` when empty). Fix any exhaustive switch the compiler flags (`activitySignature` in scheduler handles `label` already via the default branch; check `DebateView`/`StatusBar` icons treat `running`).
- [ ] **Step 4:** Run both files — PASS. `npm run check` — PASS.
- [ ] **Step 5:** Commit `feat: add note activity, trace types and turn text composition`.

---

### Task 3: Codex adapter — commentary as notes, paragraph breaks, trace

**Files:**
- Modify: `src/agents/codexAgent.ts` (`performSend` notification handling, `itemOf`)
- Test: `src/agents/__tests__/codexAgent.test.ts` (new `describe("CodexAgent notes and trace")`, reuse `FakeAppServer` and the existing spawn mock)

**Interfaces:**
- Consumes: `onNote`, `onTrace`, `composeTurnText`, `TurnSegment` (Task 2).
- Produces: success `text` = `composeTurnText(segments)` when `onNote` is passed; today's text otherwise, except the paragraph break below, which applies always.

Behaviour (spec D4):
- Track segments per `agentMessage` item id. An item whose `phase` (from `item/started` or `item/completed`) is `"commentary"` is a note.
- If the phase is known as commentary at `item/started` and `onNote` is passed, do not forward that item's deltas to `onTextDelta`; on completion call `onNote(text, false)`.
- If deltas were already streamed, on `item/completed` with commentary call `onNote(text, true)`.
- Phase `null`, missing or any other value: answer.
- Before the first text of an answer item, if the answer text so far is non-empty, emit `"\n\n"` (to `onTextDelta` and the text).
- `commandExecution` completed: `onTrace({ kind: "tool", label: command, status, exitCode, output: aggregatedOutput ?? undefined })`. Other completed items with an activity (`activityForCodexItem`): `onTrace` with label and status, no output. Parse `aggregatedOutput` in `itemOf`.

- [ ] **Step 1: Write failing tests:**
  - `moves a commentary item out of the answer` — commentary item streamed (`"Reading memory."`) then completed with `phase: "commentary"`, then answer item `"Use X.\n\n<<CONTINUE>>"` with `phase: "final_answer"`: result text `"Use X.\n\n<<CONTINUE>>"`; `onNote` called once with `("Reading memory.", true)`.
  - `holds back deltas of an item started as commentary` — `item/started` carries `phase: "commentary"`: `onTextDelta` never receives its text; `onNote(text, false)`.
  - `keeps an item with unknown phase as answer` — `phase: null` and phase absent: text kept, `onNote` not called.
  - `separates two answer items with a blank line` — without `onNote`: result `"First.\n\nSecond."` and the deltas include `"\n\n"`.
  - `only-commentary turn keeps its marker` — single commentary item `"Checked.\n\n<<CONSENSUS>>"`: result text `"Checked.\n\n<<CONSENSUS>>"`.
  - `keeps notes in the text without onNote` — commentary item, no `onNote` passed: text contains it.
  - `reports a finished command with its full output` — `commandExecution` completed with `aggregatedOutput: "ok\n"`, `exitCode: 0`: `onTrace` receives `{ kind: "tool", label: <command>, status: "success", exitCode: 0, output: "ok\n" }`.
- [ ] **Step 2:** `npx vitest run src/agents/__tests__/codexAgent.test.ts` — new tests FAIL on behaviour, existing pass.
- [ ] **Step 3: Implement** as described.
- [ ] **Step 4:** Same command — all PASS. `npm run check` — PASS.
- [ ] **Step 5:** Commit `feat: separate Codex working notes from its answer`.

---

### Task 4: Claude adapter — text before a tool use as notes, trace

**Files:**
- Modify: `src/agents/claudeAgent.ts` (`performSend`, `extractToolResults`)
- Test: `src/agents/__tests__/claudeAgent.test.ts` (new `describe("ClaudeAgent notes and trace")`, reuse the file's mocked `query`)

**Interfaces:**
- Consumes: `onNote`, `onTrace`, `composeTurnText` (Task 2).
- Produces: success `text` = `composeTurnText(segments)` when `onNote` is passed; unchanged otherwise.

Behaviour (spec D4):
- Segment boundary: start of turn and each tool use. Streamed path: on `content_block_start` of type `tool_use`, if the current segment holds text and `onNote` is passed, mark it a note and call `onNote(segment, true)`.
- Non-streamed path (`assistant` message without prior stream events): for content holding a `tool_use`, text blocks before it are a note; do not pass them to `onTextDelta`; call `onNote(text, false)`. Text blocks after the last `tool_use` of the turn are answer and stream as today.
- Tool results: `extractToolResults` also returns the text of `content` (string, or joined `text` blocks); `completeTool` calls `onTrace({ kind: "tool", label: <activity label>, status, output })`.
- `partialText` for cancelled and error results stays all text so far, notes included.

- [ ] **Step 1: Write failing tests:**
  - `turns text before a tool use into a note` (stream events: text `"Let me check."`, tool_use, tool result, text `"It is safe.\n\n<<CONSENSUS>>"`): result `"It is safe.\n\n<<CONSENSUS>>"`; `onNote` called with `("Let me check.", true)`.
  - `applies the rule to non-streamed assistant messages`: `onTextDelta` never receives `"Let me check."`; `onNote("Let me check.", false)`.
  - `leaves a turn without tools unchanged`: text identical to today, `onNote` not called.
  - `falls back to every segment when the answer is empty` (text, tool_use, result, then nothing but `"<<CONTINUE>>"`): result `"Let me check.\n\n<<CONTINUE>>"`.
  - `keeps notes without onNote`: same stream as the first test, no `onNote` → text contains `"Let me check."`.
  - `keeps notes in the partial text of a cancelled turn`.
  - `reports a tool result with its output`: `onTrace` receives `status: "success"` and `output` equal to the result text; `is_error: true` → `status: "failure"`.
- [ ] **Step 2:** Run `npx vitest run src/agents/__tests__/claudeAgent.test.ts` — new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Same command — PASS. `npm run check` — PASS.
- [ ] **Step 5:** Commit `feat: separate Claude working notes from its answer`.

---

### Task 5: Scheduler — live reset, note activity, session trace

**Files:**
- Modify: `src/orchestrator/scheduler.ts` (`SchedulerCallbacks`, `runJob` ~line 818, `handleJobResult`, new `trace()` accessor)
- Create: `src/orchestrator/trace.ts`
- Modify: `src/orchestrator/session.ts` and `src/orchestrator/types.ts` (`SessionEvents`: `"output-reset": (entryId: string, text: string) => void`; `trace()` getter delegating to the scheduler)
- Test: `src/__tests__/scheduler.test.ts` (new `describe("working notes and trace")`; extend `FakeAgent` only by adding methods that expose `sendOptions` callbacks — do not change existing methods), `src/orchestrator/__tests__/trace.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 types.
- Produces:
  - `SchedulerCallbacks.onOutputReset: (entryId: string, text: string) => void`
  - `Scheduler.trace(): readonly TraceRecord[]` (frozen copy), `DebateSession.trace()` same.
  - `src/orchestrator/trace.ts`: `export const TRACE_OUTPUT_LIMIT_BYTES = 64 * 1024; export function capTraceOutput(output: string): string` — returns `output` when its UTF-8 size is within the limit; otherwise the longest prefix within the limit that does not split a code point, plus `\n[... N bytes omitted]`.

Behaviour:
- `runJob` passes `onNote` only when `this.phase === "debate"` (writeAccess false). Synthesis sends (~line 1371) pass no `onNote`.
- `onNote(note, streamed)`: record `{ kind: "note", text: note }`; if `streamed` and `liveText.endsWith(note)`, drop that suffix, set `entry.text`, call `onOutputReset(entry.id, liveText)` and `onEntryUpdate(entry)`; emit activity `{ kind: "note", status: "running", label: note }`.
- `onTrace(event)`: record with `output` passed through `capTraceOutput`. Recorded in both phases.
- Success path: before `extractSignal`, if `result.text !== liveText`, call `onOutputReset(entry.id, result.text)`.
- Trace records are kept for the session's life (cleared exactly when the transcript is), stamped with `agent` and `Date.now()`.

- [ ] **Step 1: Write failing tests** (fake agent drives `sendOptions.onTextDelta`, `onNote`, `onTrace`, then resolves):
  - `delivers and shows only the answer` — Claude fake streams `"Looking."`, `onNote("Looking.", true)`, streams `"Answer."`, resolves `"Answer.\n\n<<CONTINUE>>"`: the Claude entry text is `"Answer."`, and the Codex fake's next `lastMessage` contains `"Answer."` and not `"Looking."`.
  - `delivered text equals entry text for both agents` — same for a Codex-started debate (symmetry).
  - `resets the live output when a note is removed` — `onOutputReset` called with `(entryId, "")` after the note.
  - `ignores an unstreamed note when trimming the live text` — `onNote("x", false)` after streaming `"Answer"`: no reset with a cut text; entry keeps `"Answer"`.
  - `emits the note as activity`.
  - `keeps the signal after notes` — consensus is reached when both fakes answer with notes then `<<CONSENSUS>>`.
  - `does not pass onNote in the implementation phase or the synthesis`.
  - `resets to the result text when it differs from the stream` (fallback case).
  - `records notes and tools in the trace` — `trace()` holds both, with agent stamps; output over the limit is capped.
  - `trace.test.ts`: `keeps a short output`, `caps at the byte limit and states the omitted bytes`, `does not split a multi-byte character`.
- [ ] **Step 2:** Run both files — FAIL.
- [ ] **Step 3: Implement**, wiring `onOutputReset` through `DebateSession` as the `"output-reset"` event.
- [ ] **Step 4:** Run both files — PASS. `npm run check` — PASS.
- [ ] **Step 5:** Commit `feat: keep working notes out of the delivered message and record a session trace`.

---

### Task 6: Renderer — rewind and re-render the running entry

**Files:**
- Modify: `src/ui/stream/transcriptStream.ts` (`TranscriptStreamOptions`, `TranscriptStream`)
- Modify: `src/ui/DebateView.tsx` (writer, `output-reset` listener)
- Test: `src/ui/stream/__tests__/transcriptStream.test.ts` (new `describe("reset")` only), `src/ui/__tests__/debateView.test.tsx` (new `it` only)

**Interfaces:**
- Consumes: `"output-reset"` session event (Task 5).
- Produces:
  - `TranscriptStreamOptions` gains `length?: () => number` and `rewind?: (toLength: number) => void` (optional so existing tests and callers compile unchanged).
  - `TranscriptStream.reset(id: string, text: string): void`.

Behaviour:
- At `entryStarted`, after flushing the header, remember `bodyStart = length()`. Every permanent block written by `raw`/`entry` while that entry is active is also remembered (the formatted lines, in order).
- `reset(id, text)`: ignore if `id` is not active or `length`/`rewind` are missing. Flush, `rewind(bodyStart)`, create a fresh `EntryPipeline` for the entry, push `text`, then — if interleaved blocks exist — commit the open line (`interrupt`) and re-push those blocks; flush.
- `DebateView`: `rewind` truncates `transcriptLinesRef.current` to `toLength`, sets state, and keeps the user's scroll position stable (when scrolled up, reduce the offset by the removed line count, never below 0); `length` returns `transcriptLinesRef.current.length`. Listen to `"output-reset"` → `stream.reset`.

- [ ] **Step 1: Write failing tests** (use an in-memory writer with `length`/`rewind` over an array of lines):
  - `removes a note from the running entry` — start, chunk `"Looking around.\nStill looking"`, reset `""`, chunk `"Answer."`, complete: plain output has the header and `"Answer."`, not `"Looking around."`.
  - `keeps interleaved lines after a reset` — start, chunk `"Note line\n"`, `entry()` of a human intervention, reset `""`, chunk `"Answer.\n"`, complete: the intervention text appears exactly once, after the header, and `"Note line"` is absent.
  - `ignores a reset for an inactive entry`.
  - `does nothing without a rewinding writer` — writer without `length`/`rewind`: output identical to not calling reset.
  - `debateView.test.tsx`: `drops a removed note from the viewport` — fake session emits `entry-started`, `output-chunk "Looking."`, `output-reset ""`, `output-chunk "Answer."`, `entry-completed`: the rendered frame contains `"Answer."`, not `"Looking."`.
- [ ] **Step 2:** Run both files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run both files — PASS, existing tests untouched and passing. `npm run check` — PASS.
- [ ] **Step 5:** Commit `feat: rewind the running message when a working note is removed`.

---

### Task 7: Trace file next to the transcript archive, README

**Files:**
- Modify: `src/memory/store.ts` (new `saveTrace`)
- Modify: `src/ui/Root.tsx` (after each `saveTranscript`: lines ~123 and ~252)
- Modify: `README.md` (where transcripts are described)
- Test: `src/memory/__tests__/store.test.ts` (new `describe("saveTrace")`), `src/ui/__tests__/root.test.tsx` (new `it` only, if Root's save flow is already covered there)

**Interfaces:**
- Consumes: `TraceRecord` (Task 2), `DebateSession.trace()` (Task 5).
- Produces: `export async function saveTrace(cwd: string, transcriptPath: string, records: readonly TraceRecord[]): Promise<string | null>` — `transcriptPath` is the relative path `saveTranscript` returned; writes `<same path without .md>.trace.md` exclusively (`flag: "wx"`), returns its relative path, or `null` without writing when `records` is empty.

File layout: `# Diagnostic trace`, one line naming the transcript file and saying it holds working notes and tool output, local, not part of the debate; then per record `## <ISO time> · <CLAUDE|CODEX> · note` or `· tool [ok]|[x] <label>` plus ` (exit N)` when known, then the text or output in a fenced block whose fence is one backtick longer than the longest backtick run in the content (minimum 3).

Root: after a successful `saveTranscript`, call `saveTrace` with the session's `trace()`. A trace failure does not undo or fail the transcript save; the existing notice gains ` (trace not saved: <reason>)`.

- [ ] **Step 1: Write failing tests:**
  - `writes the trace next to the transcript` — file exists at `<base>.trace.md`, contains `CODEX · note` and the note text.
  - `writes nothing for an empty trace` — returns `null`, no file.
  - `fences an output containing backticks` — output `"a\n```\nb"`: the fence used is 4 backticks and the whole output is inside one block.
  - `marks a failed tool with its exit code` — contains `[x]` and `(exit 2)`.
  - Root (if feasible with the existing harness): `saves the trace on quit`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** `saveTrace` and the Root calls. README: one short paragraph — each archived transcript may have a `.trace.md` diagnostic file with the agents' working notes and full tool output, local and git-ignored, which can contain project data the agents read.
- [ ] **Step 4:** Run — PASS. `npm run check` — PASS.
- [ ] **Step 5:** Commit `feat: archive the working notes and tool output in a diagnostic trace`.
