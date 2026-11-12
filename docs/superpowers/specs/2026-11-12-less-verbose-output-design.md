# Less verbose debate output — design

Date: 2026-11-12. Branch: `feat/less-verbose-output`. Approved by the maintainer on
2026-11-12 with adjustments (sections 1 to 4 of their answer), integrated below.

## Why

The maintainer finds the debate hard to follow: "the answers are too long". Their
principle for this branch: **argue as briefly as possible, but as precisely as
necessary**. The goal is information density, not a lower word count.

Measured on the 42 archived transcripts in `.claudex/memory/transcripts/` (turns of
more than 15 words, words split on whitespace):

| Agent  | Turns | Median | 90th percentile | Max   |
|--------|-------|--------|-----------------|-------|
| Claude | 137   | 321    | 988             | 4129  |
| Codex  | 162   | 58     | 876             | 3759  |

Reading the transcripts shows two separate causes:

1. **Long answers by default.** Nothing in the debate rules asks for brevity. Claude
   writes report-style answers: introductions, restating the other agent's position
   before answering it, a closing recap.
2. **Working notes glued into the answer.** Both adapters concatenate every text the
   model emits during a turn. Codex's progress notes ("I will first read the
   memory...") arrive as separate `agentMessage` items with `phase: "commentary"`
   (the app-server schema of Codex 0.167.2 defines it as "mid-turn assistant text,
   for example preamble/progress narration") and are appended without even a line
   break (`...files.The memory confirms...`). Claude does the same with the text it
   writes before a tool call ("Let me look at the scheduler."). The human reads them
   in the transcript and the other agent receives them as part of the message.

Tool calls and commands are not a cause: they already go to the one-line footer
(`AgentActivity`), never to the transcript.

## Goals

- G1. Debate messages are dense and direct: the position or main objection comes
  first, one or two important arguments per message, no needless introduction,
  restating or recap. A message may still develop an argument when a technical
  demonstration needs it.
- G2. Working notes no longer appear in the visible transcript and are no longer
  delivered to the other agent. While the turn runs, the latest note shows in the
  footer, like a command.
- G3. The visible transcript is exactly the debate content exchanged between the
  agents. Protocol metadata stays distinct from it (see D3).
- G4. Nothing is lost for diagnosis: notes, and the full output of commands and
  tools when the adapter has it, are written to a diagnostic log (D6).
- G5. The separation removes nothing needed to understand an argument or check a
  conclusion: the agent is told notes are private, so the message must stand on its
  own (D1), and a turn that would be empty falls back to its full text (D4).

## Non-goals

- The consensus summary (`SYNTHESIS_PROMPT`) and `/handoff`: they must stay complete.
- Any visual change: folding long messages, new layout, colours, a debate status
  block. That is the CLI redesign, a separate branch (see "Compatibility with the
  redesign").
- The `/implement` phase output (D5).
- A configurable verbosity level or a new slash command.

## Anti-goals

- Truncating or cutting an agent's text in code. A cut would drop evidence or the
  protocol marker, and would show the human something the other agent did not
  receive (or the reverse). Brevity is asked for, never enforced.
- A turn that becomes empty, or that breaks the protocol, because its text was
  classified as notes (D4).
- Weakening the evidence requirement, or treating the two agents differently.

## Decisions

### D1. Debate rules: density, not a word limit

Add to `CONSENSUS_INSTRUCTIONS` (`src/orchestrator/scheduler.ts`), identical for both
agents (no agent named outside the self/other roles; the symmetry test must pass):

- Argue as briefly as possible, but as precisely as necessary. Aim for about 200
  words; this is a target, not a limit: go further when a technical demonstration
  needs it.
- Put your position or main objection first. Skip introductions, do not restate or
  summarise the other's message, do not repeat what is already agreed, do not end
  with a recap that adds nothing.
- Prefer one or two important arguments per message; keep the others for later
  turns.
- Use headings or lists only when they make the message easier to follow.
- Write your message after your last tool call. Text written before a tool call is
  a private working note that neither the human nor the other agent sees in the
  debate, so your message must contain everything needed to understand your
  argument and check your conclusions.

The exact wording is left to the builder within these constraints, in English.

### D2. Evidence: excerpts allowed, under conditions

The evidence rule keeps its requirement and its symmetry. It now allows an excerpt
instead of the whole raw output, provided that:

- the command that was run is given exactly;
- the excerpt keeps the context needed to read it;
- errors and meaningful exit codes are kept;
- the excerpt never misrepresents the overall result (for example, quoting passing
  tests while others failed), and says what was left out.

Full outputs stay available in the diagnostic log when the adapter has them (D6).
This amends the evidence rule of 2026-08-17 (decisions.md): record the amendment and
its reason there.

### D3. What the visible transcript contains

The visible body of an agent message is exactly the text delivered to the other
agent, apart from the protocol metadata Claudex already handles outside the body:
the attribution line (`[Claude → Codex]`) that Claudex adds on delivery, and the end
marker, which `extractSignal` already removes from the body. This is today's
behaviour; it is pinned by a regression test (delivered text == entry text, for both
agents).

### D4. Adapters separate notes from the answer

`AgentSendOptions` gains:

```ts
/**
 * The text streamed since the last boundary was a working note, not part of the
 * answer. Receivers drop it from the live message.
 */
onNote?: (note: string) => void;
```

`AgentActivity` gains `{ kind: "note"; status: "running"; label: string }` for the
footer. The label is raw data (the note's first line); truncation and styling stay
in the UI, like other activity labels.

The success text of `AgentResult` contains only the answer.

- **Codex** (`src/agents/codexAgent.ts`): an `agentMessage` item with
  `phase: "commentary"` is a note. On `item/completed` with that phase, the adapter
  removes the item's text from the turn text and calls `onNote`. Any other phase,
  including `null` or missing (the schema says providers do not emit it
  consistently), stays an answer: an unknown phase behaves as today. If
  `item/started` carries the phase, the adapter may hold a commentary item's deltas
  back from `onTextDelta` instead of streaming then removing them. Between two answer
  items the adapter inserts a paragraph break (`\n\n`) instead of nothing.
- **Claude** (`src/agents/claudeAgent.ts`): text streamed since the last boundary
  becomes a note when a `tool_use` block starts after it in the same turn. Boundaries
  are the start of the turn and each tool use. Text after the last tool use is the
  answer. The non-streamed path (an `assistant` message without prior stream events)
  applies the same rule to its content blocks.

**Fallback.** If, at the end of a successful turn, the answer is empty or holds only
a protocol marker, the result text is every segment in order (notes and answer,
separated by blank lines). Nothing is lost, the turn is never empty, and the marker
is still read from the last line by `extractSignal`, unchanged. The adapter builds
this text; the scheduler resets the entry body to the result text whenever it
differs from what was streamed.

Cancelled and failed turns keep their `partialText` as today (all text so far).

### D5. Implementation phase unchanged

With `writeAccess: true` the adapters never call `onNote`: notes stay in the message
as today, since the human watches the work there. The D1 and D2 rules are part of the
debate rules and are not sent in that phase. The diagnostic log (D6) still records
both phases.

### D6. Diagnostic log

Claudex has no diagnostic log today. It gains one, as data separate from the
transcript:

- `AgentSendOptions` gains `onTrace?: (event: AgentTraceEvent) => void`. Events:
  a note (its text), and a finished tool or command (name or command line, input,
  status, exit code when known, and its full output when the adapter has it: Codex's
  `aggregatedOutput` on `commandExecution` items, Claude's `tool_result` content).
- The scheduler stamps each event with the agent, the transcript entry it belongs
  to and a timestamp, and keeps them in a session trace next to the transcript.
- The trace is written where and when the transcript archive is written (`/save`,
  `/new`, `/quit`, the partial snapshot): a second file next to it in
  `.claudex/memory/transcripts/`, same base name with a `.trace.md` suffix, plain
  Markdown, each output in a fenced block. The `.claudex/.gitignore` allowlist
  already keeps it out of commits.
- Each output is capped at 64 KiB in the log, with the number of bytes left out
  stated. This is a log, not the debate: capping it does not contradict the
  no-truncation anti-goal.
- Each fenced block uses a fence longer than any backtick run in its content, so an
  output cannot close its block early.

Security note: command outputs can hold sensitive project data that the agents
read (the sandbox already denies credential stores). The log stays local, inside
`.claudex/`, ignored by git, like the transcripts that may already quote the same
outputs. The README says so.

## Compatibility with the redesign

The redesign is a separate branch with its own design. This branch must not make it
harder, so it keeps data and presentation apart:

- Notes, tool events and messages are distinct typed data (`onNote`, `AgentActivity`,
  `AgentTraceEvent`, `TranscriptEntry`), never pre-formatted strings with colours or
  symbols.
- The scheduler gains no rendering concern: it emits events; `src/ui/` decides how
  they look.
- No change to `TranscriptEntry` kinds or the archive format of the visible
  transcript.

## Tests (written first)

- Rules: the new sentences are present for both agents; the symmetry test passes;
  the evidence rule mentions the excerpt conditions; the word target is phrased as
  a target.
- Codex adapter: commentary removed from the result and passed to `onNote`; phase
  `null` or missing kept as answer; two answer items separated by `\n\n`; commentary
  before and after deltas; only-commentary turn falls back to the full text; trace
  events carry `aggregatedOutput`.
- Claude adapter: text before a tool use becomes a note (streamed and non-streamed);
  text after the last tool use is the answer; a turn without tools is unchanged; a
  turn ending on a tool use with no text after falls back; `writeAccess: true` never
  calls `onNote`; trace events carry the tool result.
- Scheduler, with a fake agent (regression): delivered text equals the entry text
  for both agents; notes neither delivered nor in the entry; a marker after notes
  still yields the right signal and consensus; an only-notes turn is not empty and
  keeps its signal; symmetric behaviour for Claude and Codex.
- UI: an entry reset shows only the answer; the footer shows the note label.
- Store: the trace file is written next to the transcript, output capped with the
  omitted byte count, nothing written when the trace is empty.

`npm run check` must pass.

## Success

- The maintainer's manual smoke test (one debate in French, one in English) finds
  the debate easy to follow, with no loss of argument or evidence.
- Optional measurement with the same word-count script over new transcripts:
  Claude's median below today's 321, and no glued Codex notes.

## Rollback

D1 and D2 are prompt text; D4 to D6 sit behind new optional callbacks and a new
file. Reverting the merge commit restores today's behaviour; existing archives are
unchanged.

## Left to the builder

The exact rule wording, the UI reset mechanism (for example an `onOutputReset`
callback next to `onOutputChunk`), the footer truncation of notes, and the layout of
the trace file, within the constraints above.
