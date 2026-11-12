# CLI redesign — design

Date: 2026-11-12. Branch: `feat/cli-redesign`. Awaiting the maintainer's approval.

## Why

Claudex is about to be distributed (open source, possibly a specialised marketplace). The
engine is done; what people see is not. The maintainer wants the debate screen to be
sober, elegant, very readable and professional, with a recognisable Claudex identity, and
to put forward what makes Claudex different: a technical dialogue between two agents,
their objections, their convergence and the progress of the debate.

The maintainer's brief (memory `cli-redesign-brief.md`) gave an illustrative mock-up. It
is a starting point, not a template: Claudex cannot know some of what it shows (the total
number of rounds, a list of agreements and disagreements), and the agents must keep
writing naturally.

The maintainer delegated every design decision to Claude ("take the best decisions for a
professional distribution"). Decisions below marked **(Claude's call)** were not
discussed with them; the others are their explicit requests.

## What the maintainer asked for, in their words

1. The welcome screen keeps its animated header, one row shorter.
2. The animation disappears once the debate starts, so the conversation can be scrolled
   with the mouse.
3. A mini animation of the same kind, at the bottom right, coloured differently depending
   on whether Claude or Codex is thinking.
4. Selecting text copies it automatically.
5. Resizing the window's height must not break the layout.
6. No decoration library in the style of Python's Rich ("old-fashioned renders").
7. Menus, command palette and prompt stay as they are. What matters is the formatting of
   the debate.

## Goals

- G1. Each turn is a clearly delimited block; Claude, Codex, the human and Claudex itself
  are told apart at a glance, including in the middle of a long message after scrolling.
- G2. The progress of the debate is visible and true: round of each turn, who has
  signalled what, consensus, pauses. Everything shown comes from the protocol, nothing is
  inferred from prose.
- G3. Transient activity (thinking, reading a file, running a command) lives in one
  bottom row and never enters the transcript (already true; kept).
- G4. Mouse wheel scrolling works in Terminal.app, iTerm2 and common Linux terminals.
- G5. Mouse selection in the transcript copies the selected text to the system clipboard,
  without the decoration (rails, rules).
- G6. Any resize, width or height, larger or smaller, redraws a clean frame: no
  duplicated lines, no overlap.
- G7. All visual choices (glyphs, colours, spacing, widths) live in one rendering layer;
  the scheduler, session and adapters know nothing about them (principle F of the brief).

## Non-goals

- The command palette, model picker, permission prompt, input bar and model footer keep
  their current look and behaviour (request 7). Only their position in the frame may move
  by a row.
- No change to the debate protocol, the markers, the prompts or the scheduler's state
  machine.
- The bugs reported on 2026-10-28 that are not about layout (Esc does not resume, `/model`
  list) are out of scope. The display duplication on resize is in scope (G6).
- No live plain mode for non-interactive output: Claudex refuses to start without a TTY
  (settled constraint), and the plain record of a debate is the archived transcript, which
  is unchanged. **(Claude's call.)**

## Anti-goals (would make this a failure even if it works)

- A status block that guesses agreements or disagreements from the agents' prose.
- Imposed sections (Position / Objection / Proposal) in every turn.
- Big boxes, permanent decorative animation in the reading area, a busy palette.
- A new rendering dependency. Ink, chalk and ink-spinner, already in the stack, are
  enough.
- Breaking the light terminal themes: body text keeps the terminal's own foreground; no
  background colour except the selection highlight.

## Constraints

- Settled decision 2026-09-28: the debate owns a full-screen viewport in the alternate
  screen; header and footer never move; only the transcript scrolls; nothing is written
  behind the frame. This design keeps it.
- Agent prose stays ASCII-only for status symbols (`asciiSymbolsForDisplay`). That rule
  covers what the agents write, not Claudex's own interface glyphs, which may use the
  Unicode characters listed below (all render in Terminal.app and iTerm2 with their
  default fonts).
- The render pipeline (`MarkerFilter` -> `AnsiSanitizer` -> `LineBuffer` ->
  `MarkdownStreamer` -> `StreamController`) and its guarantees (no marker printed before
  the verdict, no agent-controlled escape sequence, append-only except `reset`) are kept.
- Everything in English. Tests never touch a real terminal, `claude` or `codex`.

## The debate screen

Target layout, 80 columns, while Codex is thinking:

```
 CLAUDEX 0.1.0 · debate                     Claude ✓ ready · Codex → continues
 Topic  Server-side sessions or JWT for the auth service?
 Memory 12 decisions · last session 2026-11-11
 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 ◆ CLAUDE                                                       Round 3 · 14:02
 │ Keep server-side sessions. JWTs make immediate revocation hard and add a
 │ token lifecycle we do not need.
 │
 │ **Risk.** A leaked token stays valid until it expires.
 │ **Proposal.** Redis sessions with a sliding expiry.
 │
 │ ✓ Ready for consensus · over to Codex

 ◆ YOU → both                                                             14:03
 │ Assume Redis is already in production.

 ◆ CODEX                                                        Round 3 · 14:03
 │ Agreed on server sessions. Redis is a network dependency, so ...

 ─────────────────────────────────────────────────────────────────────────────────
 ⠋ Codex · reading src/auth/session.ts                                  ░▒▓█▓▒░
 > message (→ both), /claude, /codex, ...
 Claude opus-4.x 12% · Codex gpt-5.x 8%
```

### Fixed header (top, 4 rows) **(Claude's call)**

- Row 1: `CLAUDEX` in the brand colour, bold, then the version from `package.json` and the
  stage, dim: `debate`, `consensus` (derived from `consensus-reached` /
  `consensus-invalidated`; it is not a `Phase` value), `implementation`, `ended`. Right-aligned: the
  debate status line (below). Below 60 columns the status moves away and only
  `CLAUDEX · phase` remains.
- Row 2: `Topic` label (dim) and the topic on one row, truncated with `… /topic`
  (today it may take three rows; one is enough now that `/topic` exists).
- Row 3: `Memory` label and the existing memory line (`welcomeMemoryLine`).
- Row 4: a heavy rule `━` over the content width.
- The one-row animated header shown today during the debate is removed (request 2).
- "Debate #" from the mock-up is dropped: Claudex has no reliable debate counter, and
  inventing one adds nothing. **(Claude's call.)**

### Debate status (replaces the mock-up's DEBATE STATUS block)

The protocol gives, for every agent turn, a signal (`continue`, `consensus`, `wait-human`,
`no-topic`, or none), and the session tells when the consensus is reached or invalidated
(a human intervention starts a new epoch). That is what the status shows, and only that:

- Per agent, its latest signal in the current epoch: `✓ ready` (consensus), `→ continues`,
  `? asks you` (wait-human), `·` (nothing yet in this epoch). In the agent's colour.
- When both agree: `✓ Consensus` in green replaces the two entries.
- Reset to `·` for both when a new epoch starts. The scheduler starts one on every human
  intervention, right after adding the intervention entry (`scheduler.ts`, `intervene`);
  there is no epoch event, so the human `intervention` entry is the reset trigger.
  `consensus-invalidated` also resets.
- A signal that does not count is never shown. A turn already running when the human
  intervenes finishes with a signal from the old epoch, which the scheduler ignores for
  consensus. The session therefore adds one field to the `ok` outcome of
  `entry-completed`: `counted: boolean` (true when the job's epoch is the current
  consensus epoch, the same test the scheduler already makes). The status ignores
  uncounted signals, and that turn's verdict line reads
  `· Signal set aside: your message arrived during this turn`. This is the only session
  change of the branch.

It is derived in the UI from session events (`entry-completed` outcome, `entry-started`
author, human `intervention` entries, `consensus-reached`, `consensus-invalidated`). Agreements and disagreements by subject are not shown: the protocol does
not carry them, and the anti-goals forbid inferring them. **(Claude's call.)**

### Turn blocks

- Header row: `◆` and the author in capitals, bold, in the author's colour (`CLAUDE`,
  `CODEX`, `YOU`; `YOU → claude` for a targeted intervention). Right-aligned, dim:
  `Round n · HH:MM` for an agent turn, `HH:MM` otherwise.
- Interrupted turns: an intervention, permission record or notice written while an agent
  is answering cuts its block today (events are rendered in order, a guarantee of the
  renderer that stays). When the agent's text resumes, the renderer writes the header
  again as `◆ CODEX (continued)`, without round or clock, so the rest is never anonymous.
  **(Claude's call.)**
- Body: the current coloured rail `│ ` is kept for agent and human turns. It is what tells
  who is speaking after scrolling into a long message (G1), and it already exists.
  **(Claude's call.)**
- The rule under the author from the mock-up is dropped: with the rail it doubles the
  separation. One blank row between blocks. **(Claude's call.)**
- Closing verdict (already produced by `verdictText`), restyled with interface glyphs:
  `→ Continues · over to Codex`, `✓ Ready for consensus · over to Codex`,
  `✓ Consensus approved · the debate is closed`, `? Waiting for your answer`,
  `! No decision signalled`, `· No topic to debate · the debate starts on your next
  message`. In the agent's colour, dim except the glyph.
- Markdown inside the body keeps today's quiet styling. Two changes: headings and a bold
  label opening a line (`**Risk.**`, `**Proposal:**`) are rendered bold in the author's
  colour, so the "→ Risk / → Proposal" effect of the mock-up appears whenever the agent
  chooses that structure, never imposed (principle C).
- System lines (Claudex notices, permission records): dim, no rail, prefixed `·`.
  Errors: `!` in the error colour.
- The consensus summary: framed by two heavy rules `━` in green with the title
  `CONSENSUS` between the first rule and the body; body without rail but still rendered
  as markdown. Today the renderer's rail flag also switches markdown on; the two become
  separate flags. It is the one moment that deserves emphasis.

### Round numbers

A round is an agent's n-th answering turn in the current debate: Claude's 3rd answer is
"Round 3", and so is Codex's 3rd. Counted in the rendering layer from completed agent
message entries; the number is fixed when the turn starts (completed answering turns of
that agent + 1), because the header is written then. A failed or cancelled turn that is
retried keeps the same number: it is the same round. Synthesis turns and implementation
turns are not counted; `/new` starts a new session and therefore restarts at 1. The total is never shown, except when an
autonomy bound in automatic starts is set (`/autonomy starts N`), where the footer may
show the remaining budget if the session exposes it already; otherwise not at all.
In the implementation phase the header shows `Implementation` instead of `Round n`.
**(Claude's call.)**

### Bottom area

- A thin rule `─` above the footer.
- The status row (today's `StatusBar`) keeps its content and its truncation, with the
  mini animation added at its right end:
  - 7 to 10 columns wide, one row, drawn with the same generator and ramp (`░▒▓█`, braille
    for line presets) as the welcome header, in the thinking agent's colour (the existing
    `CLAUDE_FLASH_COLOR` / `CODEX_FLASH_COLOR` or the agent colours, builder's choice of
    the more legible pair on dark and light themes).
  - Animated only while an agent has a turn in flight; absent otherwise. It is the only
    animation on the debate screen.
  - Hidden below 60 columns.
  - Its timer drives only the status row component, so a frame does not re-render the
    transcript.
- Input bar, palettes, permission prompt and model footer: unchanged (request 7).

## The welcome screen

- `HEADER_ROWS` goes from 5 to 4 (request 1). Every preset must still look right at 4
  rows; the builder checks each one visually (rendered frame dumps in tests are enough).
- Nothing else changes on the welcome screen.

## Mouse: scrolling and selection

### Why the current approach is replaced

Today Claudex writes mode 1007 ("alternate scroll"): a compatible terminal turns the wheel
into arrow keys. That is not reliable in Terminal.app, the maintainer's terminal, and it
cannot support selection-to-copy. **(Claude's call, from the code; the maintainer
reported scrolling as broken on 2026-10-28.)**

### The approach

- During the debate screen, Claudex enables mouse reporting with SGR coordinates
  (`CSI ?1000h`, `?1002h` for drag, `?1006h`) and disables it on exit, on `/new`'s return
  to the welcome screen, and on every exit path where 1007 is reset today (including
  errors). It no longer writes 1007.
- Mouse reports are removed from the input before Ink sees them: Claudex passes Ink a
  filtered stdin stream that extracts complete SGR mouse sequences
  (`ESC [ < b ; x ; y M|m`) and emits them as typed events, and forwards everything else
  byte for byte. Bracketed paste content is forwarded untouched even if it contains text
  that looks like a mouse report. A partial sequence at a chunk boundary is held until
  complete. Without this, the reports would be typed into the input bar.
- The wheel scrolls the transcript by 3 lines per notch, with the same bounds as the arrow
  keys.
- Selection, in the transcript viewport only:
  - Press and drag selects by character cells, line by line, like a terminal; the selected
    cells are drawn inverted.
  - On release, the selected text is copied: plain text, rails, verdict glyph and trailing
    spaces removed, lines joined with `\n`. A line soft-wrapped by the renderer is joined
    back without a newline when the builder can tell it was a soft wrap; otherwise a
    newline is acceptable. **(Claude's call.)**
  - Copy target, first that applies **(Claude's call)**:
    1. macOS: `pbcopy`.
    2. Linux: `wl-copy` when `WAYLAND_DISPLAY` is set, else `xclip -selection clipboard`,
       else `xsel --clipboard --input`, whichever is installed.
    3. Otherwise, the OSC 52 sequence (`ESC ] 52 ; c ; <base64> BEL`). Some terminals
       (VTE-based ones such as GNOME Terminal) ignore it silently, so the notice is honest:
       `Sent 214 characters to the terminal clipboard`.
    Commands are spawned without a shell, the text on stdin, fixed arguments. Success of
    a command: `Copied 214 characters`. A failure shows a notice; it never throws.
  - The selection clears on the next click, on a keypress, or when new output scrolls it
    away. Dragging past the top or bottom edge scrolls the transcript.
  - A click without drag does nothing (no copy of an empty selection).
- Selection elsewhere (header, footer) is ignored. Native terminal selection stays
  available with a modifier: Option in Terminal.app and iTerm2, Shift in most Linux
  terminals; the README says so.
- To make copying possible, each transcript line keeps its plain text next to its styled
  form. Pipeline lines have it (`PhysicalLine.text`); the lines built already styled do
  not (`raw()` input such as `/help` and `/decisions`, verdict, error and cancelled lines).
  So the `StreamWriter` contract changes from a string split on `\n` to a list of
  `{ styled, plain }` lines, and every producer of styled lines supplies both. A selected
  line is drawn from the
  plain text with the selected cells inverted, losing its other colours while selected.
  This avoids slicing ANSI-styled strings. **(Claude's call.)**

### Security note

`pbcopy`, `wl-copy`, `xclip` and `xsel` are fixed commands with fixed arguments, run
without a shell, with the text on stdin; nothing from an agent reaches their arguments.
They are looked up on `PATH` like any command the user runs. OSC 52 carries base64 only. The clipboard is written only on
an explicit human selection.

## Resize

Observed (reported 2026-10-28): enlarging the window after launch duplicates the display.
Likely cause, to be confirmed by a failing test before any fix: Ink 7.1.1 clears its
previous frame on resize only when the width decreases (`ink.js`, `resized`), and Claudex
renders with `incrementalRendering: true` in the alternate screen, so a height change
redraws over a stale frame. The fix must make any size change (width or height, up or
down) produce a full clean frame, from Claudex's code (for example by clearing through the
Ink instance on resize), never by patching `node_modules`. The transcript lines already
written are not reflowed (current behaviour, kept); the frame, header, rules and footer
are recomputed. If the builder finds the cause is elsewhere, the requirement (G6) stands
and the finding goes into this document.

## Where things live

- `src/ui/theme.ts`: the only place for colours, glyphs (`◆ │ ━ ─ ✓ → ? ! ·`), widths
  and the thresholds (60 columns).
- `src/ui/stream/transcriptStream.ts`: turn headers, verdicts, round labels, summary
  framing; lines carry `{ styled, plain }`.
- A new `src/ui/debateStatus.ts`: a pure reducer from session events to the status shown
  in the header and to the round counters. Unit-tested without Ink.
- A new `src/ui/mouse/`: the stdin filter (pure, tested on byte chunks), the selection
  model (pure: anchors, extraction of plain text), the clipboard writer (spawn mocked in
  tests).
- `src/ui/DebateView.tsx`: frame composition only; the header, status row and viewport as
  components.
- `src/cli.tsx` / `src/renderOptions.ts`: mouse mode on and off, filtered stdin. Mouse
  reporting left on would fill the user's shell with garbage on every mouse move, so it
  is also turned off on `SIGTERM`, `SIGHUP`, `uncaughtException` and
  `unhandledRejection`, not only in the `finally` that resets 1007 today.

## Settled decision reopened

`.claudex/memory/decisions.md` (2026-09-28) settles wheel scrolling through mode 1007.
This design replaces that part with mouse reporting, for a new reason: 1007 does not work
reliably in Terminal.app and cannot give selection-to-copy, which the maintainer now asks
for. The rest of that decision (alternate screen, fixed header and footer, nothing written
behind the frame) stands. The branch updates that entry in `decisions.md`.

## Testing

- Pure units: status reducer (every signal, epoch reset, consensus), round counting,
  mouse filter (complete, split, interleaved with keys, inside bracketed paste, invalid
  sequences), selection extraction (rails stripped, multi-line, soft wraps, empty),
  clipboard command selection per platform.
- Rendering: frames captured the way `src/ui/__tests__/debateView.test.tsx` already does
  (Ink's `render` on a fake stdout; no new test dependency) for the header at 40, 60, 80 and
  120 columns, turn blocks for each author and verdict, the summary frame, the status row
  with and without the mini animation.
- Resize: a test that renders, changes rows up then down, and asserts the written output
  contains a full clear before the new frame and no duplicated header.
- Existing tests whose expected strings change because of the new styling are updated;
  that is a translation of the same behaviour, and each such change is listed in the PR.
  Any test whose behaviour assertion would change is a stop point.
- Manual smoke test by the maintainer in Terminal.app: a real debate, wheel scroll,
  selection and paste into another app, resize in both directions.

## Rollback

Pure UI change on one branch; reverting the merge commit restores the previous screen.
The one cross-cutting risk is the mouse mode: if it misbehaves in a terminal, mouse
reporting can be disabled by a single constant, falling back to keyboard scrolling and
native selection.

## Left to the builder

- Exact column widths, the mini animation's preset and speed, the exact dim shades, as
  long as the palette stays limited and legible on light and dark themes.
- How the soft-wrap flag is carried on lines.
- The order of tasks in the plan.
