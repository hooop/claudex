# Less verbose debate output — design

Date: 2026-11-12. Branch: `feat/less-verbose-output`.

## Why

The maintainer finds the debate hard to follow: "the answers are too long". They
delegated every choice ("the most professional choices"), so everything below that
is not quoted from them is the designer's call.

Measured on the 42 archived transcripts in `.claudex/memory/transcripts/` (turns of
more than 15 words, words split on whitespace):

| Agent  | Turns | Median | 90th percentile | Max   |
|--------|-------|--------|-----------------|-------|
| Claude | 137   | 321    | 988             | 4129  |
| Codex  | 162   | 58     | 876             | 3759  |

Reading a transcript shows two separate causes:

1. **Long answers by default.** Nothing in the debate rules asks for brevity. Claude
   writes report-style answers: headings, numbered sections, a closing recap,
   restating the other agent's position before answering it.
2. **Working notes glued into the answer.** Both adapters concatenate every text the
   model emits during a turn. Codex's progress notes ("I will first read the
   memory...", "First measurement: ...") arrive as separate `agentMessage` items
   with `phase: "commentary"` and are appended without even a line break
   (`...files.The memory confirms...`). Claude does the same with the text it
   writes before a tool call ("Let me look at the scheduler."). The human reads
   them in the transcript and the other agent receives them as part of the message.

Tool calls and commands are not a cause: they already go to the one-line footer
(`AgentActivity`), never to the transcript.

## Goals

- G1. Debate messages are short and get to the point: position first, one or two
  points per message, no restating, no headings, no closing recap.
- G2. Working notes no longer appear in the transcript body and are no longer
  delivered to the other agent. While the turn runs, the latest note is visible
  in the footer, like a tool call, so the human still sees that work is happening.
- G3. What the human reads in a message is exactly what the other agent receives.
  This is a supervision property: the human must be able to audit the exchange.

## Non-goals

- The consensus summary (`SYNTHESIS_PROMPT`) and `/handoff`: they must stay complete.
- Folding or collapsing long messages in the UI, a "show more", a summary line per
  message: layout belongs to the CLI redesign branch that follows this one.
- The `/implement` phase: the rules here are debate rules; implementation turns
  keep their current output (notes included), since the human watches work there.
- A configurable verbosity level or a new slash command.

## Anti-goals

- Truncating or cutting an agent's text in code. A hard cut would drop evidence or
  the protocol marker on the last line, and would show the human something the
  other agent did not receive (or the reverse). Brevity is asked for, not enforced.
- Losing information: a turn whose answer would be empty after removing notes must
  not become an empty message (see D4).
- Weakening the evidence rule. Claims about the real behaviour of code still need a
  command and its output; the change only allows quoting the relevant lines.

## Decisions

### D1. Concision rules in `CONSENSUS_INSTRUCTIONS`

Add to the debate rules (`src/orchestrator/scheduler.ts`), symmetric for both
agents (the existing symmetry test must keep passing; no agent named outside the
self/other roles):

- Keep each debate message short: about 200 words at most, not counting quoted
  command output, unless the human explicitly asks for more detail.
- Start with your position or your answer. Make one or two points per message,
  the most important first; keep the others for the next turns.
- Do not restate or summarise the other's message, do not repeat what is already
  agreed, do not end with a recap. No headings.
- When you quote command output as evidence, quote only the lines that matter and
  say what you left out.
- Write your message after your last tool call. Any text written before a tool
  call is a private working note: neither the human nor the other agent sees it in
  the debate, so the message must stand on its own.

Why 200 words: it is below Claude's current median (321) and roughly a screen of
text in a normal terminal; the exception for quoted output keeps the evidence rule
intact; the exception for the human's request keeps the human in charge. The exact
wording is left to the builder within these constraints, in English.

The evidence rule sentence changes from "give the exact command and its raw output"
to allow an excerpt: "give the exact command and the relevant lines of its raw
output". This touches a settled rule (decisions.md, 2026-08-17, evidence stated
symmetrically): the symmetry and the requirement are unchanged, only the quote may
be partial. Record it in decisions.md.

### D2. Adapters separate notes from the answer

`AgentSendOptions` gains one callback:

```ts
/**
 * The text streamed since the last boundary was a working note, not part of the
 * answer. Receivers drop it from the message and may show `note` as activity.
 */
onNote?: (note: string) => void;
```

and `AgentActivity` gains a `{ kind: "note"; status: "running"; label: string }`
variant shown in the footer (first line of the note, truncated like other labels,
sanitized like other agent text).

The answer (`AgentResult` success text) contains only the answer segments.

- **Codex** (`src/agents/codexAgent.ts`): an `agentMessage` item whose `phase` is
  `"commentary"` is a note. Its deltas stream as today (the phase may not be known
  before `item/completed`); on `item/completed` with `phase: "commentary"`, the
  adapter removes that item's text from the turn text and calls `onNote(text)`.
  Any other phase, including `null` or missing (older Codex versions), stays an
  answer, so behaviour on an older Codex is today's. Between two answer items the
  adapter inserts a paragraph break (`\n\n`) instead of nothing, which fixes the
  glued sentences.
- **Claude** (`src/agents/claudeAgent.ts`): text streamed since the last boundary
  becomes a note when a `tool_use` content block starts after it within the same
  turn. The boundary is the start of the turn or the previous tool use. Text after
  the last tool use is the answer. The non-streamed path (an `assistant` message
  without prior stream events) applies the same rule to its content blocks.

Builder's check: whether Codex's `item/started` carries `phase` for agent messages
is not known (Codex 0.167.2 installed here). The design works without it. If the
builder finds it does, holding the deltas of a known commentary item back from
`onTextDelta` is allowed (it avoids text appearing then disappearing), but not
required. Tests cover both orders with mocked `child_process.spawn`.

### D3. Scheduler and UI drop the note from the live entry

In `runJob` (`src/orchestrator/scheduler.ts`), `onNote` removes the note from
`liveText` (it is always the suffix streamed since the last boundary), updates the
entry and tells the UI to reset that entry's streamed body, then emits the `note`
activity. The UI stream path (`src/ui/stream/`) needs a way to replace an entry's
streamed body; the debate view owns all its lines (decisions.md, 2026-09-28), so a
reset is possible. The builder picks the mechanism (for example a new
`onOutputReset(entryId, text)` callback next to `onOutputChunk`).

The final entry text, the text delivered to the other agent, and the archived
transcript all come from the answer only. Notes are ephemeral, like tool activity:
they are not archived. The `responding` activity replaces the note when answer text
streams again.

### D4. Fallback when the answer is empty

If, at the end of a successful turn, the answer is empty or holds nothing but a
protocol marker, the turn text becomes all segments in order (notes and answer,
separated by blank lines), and the entry shows that. The adapter builds this text
(it knows the segments); the scheduler, at the end of the turn, resets the entry's
body to the result text whenever it differs from what was streamed. Nothing the agent wrote is
lost; a misbehaving turn is merely as verbose as today. The marker is still read
from the last line by `extractSignal`, unchanged.

Cancelled and failed turns keep their current `partialText` behaviour (all text so
far), since the human needs to see what happened.

### D5. Implementation phase unchanged

During `/implement` (`writeAccess: true`) the adapters do not call `onNote`: notes
stay in the message as today. The rules in D1 are part of the debate rules, which
are sent only during the debate.

## Tests (written first)

- Rules: the new sentences are present for both agents, and the symmetry test
  still passes; the evidence rule mentions the relevant lines.
- Codex adapter: commentary item removed from the result and passed to `onNote`;
  `phase` null/missing kept as answer; two answer items separated by `\n\n`;
  commentary arriving before and after deltas; empty-answer fallback.
- Claude adapter: text before a tool use becomes a note (streamed and non-streamed
  paths); text after the last tool use is the answer; a turn with no tool use is
  unchanged; a turn ending on a tool use with no text after falls back (D4);
  `writeAccess: true` never calls `onNote`.
- Scheduler (fake agent emitting notes): the delivered text and transcript entry
  exclude notes; the `note` activity is emitted; the empty-answer fallback.
- UI: a reset entry shows only the answer; the footer shows the note label.

`npm run check` must pass.

## Success

- The maintainer's manual smoke test (one debate in French, one in English) finds
  the debate easy to follow.
- Optional measurement: the same word-count script over new transcripts. Expected:
  Claude's median well under 200 words and no more glued Codex notes. Models do not
  always comply with length rules; that is accepted (anti-goal: no truncation).

## Rollback

Each part reverts on its own: D1 is prompt text; D2–D4 are adapter and scheduler
changes behind a new optional callback. Reverting the branch's merge commit
restores today's behaviour; no stored data changes format.

## Left to the builder

The exact wording of the rules, the UI reset mechanism, footer truncation of the
note, and the module organisation, within the constraints above.
