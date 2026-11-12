# CLI redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the debate screen (fixed 4-row header with a protocol-true status, turn blocks, consensus frame, mini animation in the status row), make mouse wheel scrolling and selection-to-copy work, and make any resize redraw a clean frame.

**Architecture:** The scheduler gains one field (`counted` on the `ok` outcome). Everything else is in `src/ui/`: a pure status/round reducer, a transcript line model carrying a soft-wrap flag, the restyled `TranscriptStream`, new header and status-row components, a stdin filter that turns SGR mouse reports into events before Ink sees them, a pure selection model, and a clipboard writer. All glyphs and colours stay in `src/ui/theme.ts`.

**Tech Stack:** Node >= 22, TypeScript strict ESM via tsx, Ink 7.1.1, React 19, chalk 5, ink-spinner, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-12-cli-redesign-design.md` (read it first; the plan argues from it).

## Global Constraints

- No new npm dependency, runtime or dev. Node built-ins are fine (`util.stripVTControlCharacters`, `child_process.spawn`, `stream`).
- Never patch `node_modules`.
- Everything in English. Comments explain why.
- Tests never touch a real terminal, `claude`, `codex`, the network or the real clipboard: spawn and stdout are fakes.
- Glyphs (Claudex's own UI only): `◆ │ ━ ─ ✓ → ? ! ·`, all defined once in `src/ui/theme.ts`. Agent prose keeps going through `asciiSymbolsForDisplay`.
- Narrow threshold: 60 columns (header status and mini animation hidden below it).
- Body text keeps the terminal's foreground; no background colour except the selection's inverse.
- Unchanged components: `CommandPalette`, `ModelPicker`, `PermissionModal`, `InputBar`, `ModelFooter`, `SettingsConsent`.
- An existing test whose expected string changes only because of the new styling may be updated; list every such test in the commit message body. An existing test whose behaviour assertion would change is a stop point: report to the controller, do not edit.
- `npm run check` must pass at the end of every task.
- Commits: Conventional Commits, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01Thv1Q9XYGkgdMxrCwCA5dF`.

## Review Focus

1. **A lone Esc keypress** (`"\x1b"` as a whole chunk) must reach Ink at once: the mouse filter must never hold it waiting for a mouse report, or the emergency pause breaks. Test in Task 8.
2. **Mouse mode left on after a crash or kill** would flood the user's shell with escape sequences on every mouse move. Mouse reporting is turned off on every exit path. Test in Task 8.
3. **Selection while the transcript changes:** new output, a `reset` rewind, a resize or a scroll must never leave a highlight on the wrong text. Rewind and resize clear the selection; appended lines do not move absolute indices. Test in Task 9.
4. **Wide characters** (CJK, emoji kept in code blocks) in a selected line: column slicing must not cut a grapheme or shift the highlight. Test in Task 9.
5. **A paste containing text that looks like a mouse report** (`\x1b[<0;1;1M` inside bracketed paste) must arrive in the input verbatim. Test in Task 8.

---

### Task 1: Mark which signals count (`counted` on the ok outcome)

**Files:**
- Modify: `src/orchestrator/types.ts:158` (`EntryOutcome`)
- Modify: `src/orchestrator/scheduler.ts` (every `onEntryCompleted(..., { status: "ok", ... })`: ~967, ~1013, ~1462, ~1472, ~1486)
- Modify: `src/ui/stream/transcriptStream.ts` (its local `EntryOutcome` copy: replace it with an import of the orchestrator type)
- Test: `src/__tests__/scheduler.test.ts`

**Interfaces:**
- Produces: `EntryOutcome` ok branch becomes `{ status: "ok"; signal: Signal; counted: boolean; closesDebate?: boolean }`. `counted` is `jobEpoch === this.consensusEpoch` for debate turns (the same test `isConsensusRelevant` already makes, ~1051); `true` for outcomes whose signal is `null` (synthesis, implementation: nothing to set aside).

- [ ] **Step 1: Write the failing tests** in `src/__tests__/scheduler.test.ts`, using the file's `FakeAgent` and a set autonomy bound:
  - `"marks a turn's signal as counted when no intervention arrived during it"`: Claude answers `... <<CONTINUE>>`; the `entry-completed` outcome for that entry equals `{ status: "ok", signal: "continue", counted: true, closesDebate: false }`.
  - `"marks a signal from an older epoch as not counted"`: hold Claude's turn open (deferred promise in the fake), call `intervene("new fact", "both")`, then resolve with `... <<CONSENSUS>>`; that entry's outcome has `signal: "consensus"`, `counted: false`, `closesDebate: false`.
- [ ] **Step 2:** `npx vitest run src/__tests__/scheduler.test.ts` — the two new tests fail on the missing `counted` field.
- [ ] **Step 3:** Add `counted` to the type and to every ok outcome emitted by the scheduler; make `transcriptStream.ts` import `EntryOutcome` from `../../orchestrator/types.js` and drop its duplicate.
- [ ] **Step 4:** `npm run check` — all green.
- [ ] **Step 5:** Commit `feat: tell the renderer whether a turn's signal counts`.

---

### Task 2: Debate status and round reducer

**Files:**
- Create: `src/ui/debateStatus.ts`
- Modify: `src/ui/theme.ts` (add `CONSENSUS_COLOR = "#57d68d"`; Task 4 reuses it)
- Test: `src/ui/__tests__/debateStatus.test.ts`

**Interfaces:**
- Consumes: `EntryOutcome` with `counted` (Task 1), `TranscriptEntry`, `Phase`, `AgentId`.
- Produces:
  ```ts
  export type AgentStance = "none" | "continues" | "ready" | "asks";
  export type Stage = "debate" | "consensus" | "implementation" | "ended";
  export interface DebateStatus {
    stance: Record<AgentId, AgentStance>;
    consensus: boolean;
    phase: Phase;
    /** Completed answering turns per agent in the current debate. */
    answered: Record<AgentId, number>;
  }
  export type StatusEvent =
    | { kind: "entry"; entry: TranscriptEntry }            // complete entries (interventions)
    | { kind: "completed"; agent: AgentId | "system" | "human"; outcome: EntryOutcome }
    | { kind: "consensus-reached" }
    | { kind: "consensus-invalidated" }
    | { kind: "phase"; phase: Phase };
  export const INITIAL_STATUS: DebateStatus;
  export function reduceStatus(status: DebateStatus, event: StatusEvent): DebateStatus;
  export function stageOf(status: DebateStatus): Stage;
  /** Round label for a turn starting now, or null outside the debate phase. */
  export function roundForStart(status: DebateStatus, agent: AgentId): number | null;
  export function statusLine(status: DebateStatus): { text: string; color: string }[];
  ```
- Rules (from the spec): a human `intervention` entry resets both stances to `"none"`; `consensus-invalidated` resets stances and `consensus`; a completed agent turn with `status: "ok"`, `counted: true` sets its stance (`continue`→`continues`, `consensus`→`ready`, `wait-human`→`asks`, `no-topic`/`null`→`none`) and, in phase `debate`, increments `answered[agent]`; `counted: false` increments `answered` but leaves the stance; `error`/`cancelled` change nothing. `roundForStart` = `answered[agent] + 1` in phase `debate`, else `null`. `stageOf`: `ended`/`implementation` from phase, else `consensus` if `consensus`, else `debate`.
- `statusLine` segments (text exact, colour = agent colour, consensus in green `#57d68d`): consensus → `[{ "✓ Consensus" }]`; otherwise `Claude ✓ ready`, `Claude → continues`, `Claude ? asks you`, `Claude ·`, then a dim `" · "` separator, then the same for Codex.

- [ ] **Step 1: Write failing tests** — one per rule above, plus: `"a retried turn keeps its round"` (start → `roundForStart` 1, completed with `error`, `roundForStart` still 1); `"rounds are counted per agent"` (Claude ok twice, Codex once → 3 and 2); `"implementation turns have no round"`; `"an uncounted consensus does not show as ready"`; `"statusLine shows only consensus once both agree"`.
- [ ] **Step 2:** Run `npx vitest run src/ui/__tests__/debateStatus.test.ts` — fails, module missing.
- [ ] **Step 3:** Implement `src/ui/debateStatus.ts` (pure, no Ink, no chalk; colours as strings from `theme.ts`).
- [ ] **Step 4:** `npm run check` green.
- [ ] **Step 5:** Commit `feat: derive the debate status and round numbers from session events`.

---

### Task 3: Transcript line model with a soft-wrap flag

No visible change. The viewport, the selection and the copy all need, per line, the styled string and whether it continues the previous line.

**Files:**
- Modify: `src/ui/stream/streamController.ts`, `src/ui/stream/transcriptStream.ts`, `src/ui/DebateView.tsx` (`appendTranscript`, `rewindTranscript`, `transcriptBlockLines`, `TranscriptViewport`, `helpLines`, `documentLines`)
- Modify: `src/ui/stream/lineBuffer.ts` (add `sliceColumns`)
- Test: `src/ui/stream/__tests__/streamController.test.ts`, `src/ui/stream/__tests__/transcriptStream.test.ts`, `src/ui/stream/__tests__/lineBuffer.test.ts`, `src/ui/__tests__/debateView.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // src/ui/stream/streamController.ts
  export interface TranscriptLine { styled: string; softWrap: boolean }
  export type StreamWriter = (lines: readonly TranscriptLine[]) => void;
  export function line(styled: string, softWrap = false): TranscriptLine;
  // StreamController.push(lines: readonly TranscriptLine[])
  // src/ui/stream/transcriptStream.ts
  //   raw(lines: readonly string[])  — unchanged signature, wraps each with line()
  //   options.write: StreamWriter (new type), options.rewind/length unchanged
  // src/ui/stream/lineBuffer.ts
  export function plainOf(styled: string): string;   // util.stripVTControlCharacters
  export function sliceColumns(text: string, start: number, end: number): string; // grapheme-safe, by display width
  ```
  `softWrap` is `true` exactly for pipeline lines whose `PhysicalLine.continuation` is true. `DebateView` keeps `TranscriptLine[]` in state instead of `string[]`.
- Spec deviation (simpler, same result): plain text is derived with `stripVTControlCharacters` from the styled line instead of being carried; agent text cannot contain escape sequences (it went through `AnsiSanitizer`), so the two are equivalent. Record this in the spec's "Left to the builder" section in this task's commit.

- [ ] **Step 1: Failing tests:** `"marks wrapped continuation lines as soft wraps"` (a 30-column stream fed a 70-character sentence writes lines whose `softWrap` flags are `[false, true, true]`); `"plainOf strips styling"`; `sliceColumns("a界b", 1, 3) === "界"` and `sliceColumns("a界b", 2, 3) === ""` (never half a wide char); existing streamController tests adapted to the line objects.
- [ ] **Step 2:** Run the four test files — new tests fail.
- [ ] **Step 3:** Implement. `StreamController.flush` passes the queued `TranscriptLine[]` to `write` instead of joining with `\n`.
- [ ] **Step 4:** `npm run check` green; existing transcript tests adapted only for the type change (list them in the commit body).
- [ ] **Step 5:** Commit `refactor: carry transcript lines with their soft-wrap flag`.

---

### Task 4: Turn blocks, verdicts, system lines and the consensus frame

**Files:**
- Modify: `src/ui/theme.ts` (glyphs, `SYSTEM_STYLE.badge` `"·"`, `ERROR_STYLE.badge` `"!"`, `SUMMARY_STYLE` badge `"CONSENSUS"` coloured `CONSENSUS_COLOR`, `NARROW_COLUMNS = 60`)
- Modify: `src/ui/stream/transcriptStream.ts`, `src/ui/stream/markdownStream.ts`
- Test: `src/ui/stream/__tests__/transcriptStream.test.ts`, `src/ui/stream/__tests__/markdownStream.test.ts`

**Interfaces:**
- Consumes: `EntryOutcome.counted` (Task 1), `TranscriptLine` (Task 3).
- Produces: `TranscriptStreamOptions.round?: (entry: TranscriptEntry) => number | null` (called once at `entryStarted` / `entry`); `EntryStyle` gains `markdown: boolean` (separate from `rail`); `MarkdownStreamer` constructor takes `{ accent?: (text: string) => string }`.

Exact output (plain text, before colour), content width 60:
- Agent header, one line, no rail line under it: `◆ CLAUDE` left, `Round 3 · 14:02` right-aligned to the content width; round omitted when `round()` returns null (`14:02` only). Human: `◆ YOU → both` / `◆ YOU → claude`. `◆` and the name bold in the author colour, right part dim.
- Body lines keep `│ ` in the author colour.
- Continued header: when a running entry is interrupted by permanent lines (`pushPermanent` while `active` is set) and then writes more lines (chunk output, `entryCompleted` remainder or verdict), the first such write is preceded by `◆ CODEX (continued)` (no right part). After a `reset` that replays interleaved lines, the next write gets it too.
- Verdicts (after a blank rail line, glyph in author colour, words dim):
  `→ Continues · over to Codex` · `✓ Ready for consensus · over to Codex` · `✓ Consensus approved · the debate is closed` · `? Waiting for your answer` · `! No decision signalled` · `· No topic to debate · the debate starts on your next message` · and for any non-null signal with `counted: false`: `· Signal set aside: your message arrived during this turn`.
- System entries: `· <text>`, dim, no rail. Errors: `! <text>` in the error colour. Cancelled: `· Cancelled`.
- Summary (`kind: "summary"`): a heavy rule `━` over the content width in green, `CONSENSUS` bold green, a blank line, the body rendered as markdown without rail, then a closing heavy rule in green at completion (or at the end of `entry()` for a complete summary).
- Markdown accent: a heading, or a bold span opening a non-continuation line (`**Risk.** ...`, `**Proposal:** ...`), is rendered bold through `accent` (the author colour). Other bold spans keep today's style.

- [ ] **Step 1: Failing tests** in `transcriptStream.test.ts` (assert on `plainOf` of written lines): one per bullet above, including `"writes a continued header when an intervention interrupts a running turn"`, `"shows the set-aside verdict for an uncounted signal"`, `"frames the consensus summary with rules and keeps its markdown"`, `"omits the round when the callback returns null"`, `"right-aligns round and clock to the content width"`. In `markdownStream.test.ts`: `"accents a bold label opening a line"`, `"does not accent a bold span mid-line"`.
- [ ] **Step 2:** Run both files — new tests fail.
- [ ] **Step 3:** Implement. `verdictText` gains the `counted` argument. Keep the pipeline order and the marker-filter guarantee intact.
- [ ] **Step 4:** `npm run check` green; update existing expected strings that changed only in wording/glyphs and list them in the commit body.
- [ ] **Step 5:** Commit `feat: restyle turn blocks, verdicts and the consensus summary`.

---

### Task 5: Fixed debate header and shorter welcome animation

**Files:**
- Create: `src/version.ts`, `src/ui/components/DebateHeader.tsx`
- Modify: `src/ui/DebateView.tsx` (remove `AnimatedHeaderLine` and `IntroPanel`; wire `reduceStatus` and `round` callback; `introRows` becomes `DEBATE_HEADER_ROWS`), `src/ui/headerArt.ts` (`HEADER_ROWS = 4`), `src/ui/components/WelcomeScreen.tsx` if it hard-codes 5
- Test: `src/ui/components/__tests__/debateHeader.test.tsx`, `src/ui/__tests__/headerArt.test.ts`, `src/ui/__tests__/debateView.test.tsx`

**Interfaces:**
- Consumes: `DebateStatus`, `reduceStatus`, `stageOf`, `roundForStart`, `statusLine` (Task 2); `TranscriptStreamOptions.round` (Task 4).
- Produces: `export const CLAUDEX_VERSION: string` (read once from `package.json` next to `src/`, via `readFileSync(new URL("../package.json", import.meta.url))`); `export const DEBATE_HEADER_ROWS = 4`; `DebateHeader(props: { columns: number; topic: string; status: DebateStatus; memory: Pick<ProjectStatus, "decisionsCount" | "lastSession"> })`.
- Rows (content width = `Math.min(columns, HEADER_MAX_WIDTH)`):
  1. `CLAUDEX` bold brand colour, ` 0.1.0 · debate` dim (stage from `stageOf`); `statusLine` right-aligned. Below 60 columns, no status. If both do not fit, the status is dropped, never wrapped.
  2. `Topic  ` dim + topic flattened to one row, truncated with `… /topic`.
  3. `Memory ` dim + `welcomeMemoryLine` content.
  4. `━` over the content width, dim.
- `DebateView` keeps `DebateStatus` in state, updated from `entry` (interventions), `entry-completed` (with the author remembered from `entry-started`), `consensus-reached`, `consensus-invalidated`, `phase`; passes `round: (entry) => (entry.from === "claude" || entry.from === "codex") && entry.kind === "message" ? roundForStart(status, entry.from) : null` reading the latest status through a ref.

- [ ] **Step 1: Failing tests:** header at 40, 60, 80, 120 columns (exact row count 4, status present only at >= 60, no row wider than `columns`); `"shows consensus stage after consensus-reached"`; `"the topic takes one row"`; `headerFrame` returns 4 rows for every preset (existing 5-row expectation is the requested change — list it); in `debateView.test.tsx`, `"the debate screen has no animated header"` and `"a Claude turn header shows Round 1 then Round 2"`.
- [ ] **Step 2:** Run the three files — new tests fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm run check` green.
- [ ] **Step 5:** Commit `feat: fixed debate header with version, stage and protocol status`.

---

### Task 6: Status row with the mini animation

**Files:**
- Create: `src/ui/components/ThinkingPulse.tsx`
- Modify: `src/ui/components/StatusBar.tsx` (accept `trailing` width to reserve), `src/ui/DebateView.tsx` (thin `─` rule row above the footer, counted in the frame height)
- Test: `src/ui/components/__tests__/thinkingPulse.test.tsx`, `src/ui/components/__tests__/statusBar.test.ts`

**Interfaces:**
- Produces: `export const PULSE_WIDTH = 8`; `ThinkingPulse(props: { agent: AgentId | null; columns: number })` — renders nothing when `agent` is null or `columns < NARROW_COLUMNS`; otherwise row 0 of `headerFrame(PULSE_WIDTH, t, DEFAULT_HEADER_ANIMATION)`, every band coloured with `AGENT_STYLE[agent].color`, its own 90 ms timer (state local to the component so a tick re-renders only it). `fitActivityDescription` truncates to `statusBarWidth(width) - (pulse shown ? PULSE_WIDTH + 1 : 0)`.

- [ ] **Step 1: Failing tests:** `"renders nothing while no agent thinks"`; `"renders 8 columns in the agent's colour"` (check the ANSI colour of Claude vs Codex differ and match `AGENT_STYLE`); `"hidden below 60 columns"`; `"the activity text leaves room for the pulse"`; `"stops its timer on unmount"` (fake timers, no further renders).
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement; the frame height math in `DebateView` adds 1 row for the rule (`transcriptRows = preferredFooterHeight - 1 - DEBATE_HEADER_ROWS - 1 - rows`).
- [ ] **Step 4:** `npm run check` green.
- [ ] **Step 5:** Commit `feat: show a per-agent thinking pulse in the status row`.

---

### Task 7: Clean frame on every resize

**Files:**
- Create: `src/ui/terminal.ts`
- Modify: `src/cli.tsx`
- Test: `src/ui/__tests__/terminal.test.tsx`

**Interfaces:**
- Produces: `export function installResizeClear(stdout: NodeJS.WriteStream, app: { clear(): void }): () => void` — listens with `prependListener("resize", ...)` so the clear runs before Ink's own resize render; returns the remover.

- [ ] **Step 1: Failing test first, to confirm the cause:** render a small Ink tree with `RENDER_OPTIONS` on a fake TTY stdout (EventEmitter with `isTTY`, `columns`, `rows`, captured `write`), change `rows` from 24 to 40, emit `resize`; assert the bytes written after the resize contain an erase of the previous frame before the new one. Run it without the fix: it must fail (if it passes, the cause is elsewhere: investigate with superpowers:systematic-debugging, record the finding in the spec's Resize section, and adapt). Add the same for 40 → 24 and for a width increase.
- [ ] **Step 2:** Run — fails.
- [ ] **Step 3:** Implement `installResizeClear` and call it in `cli.tsx` right after `render(<Root ...>)`, removing it in the `finally`.
- [ ] **Step 4:** `npm run check` green.
- [ ] **Step 5:** Commit `fix: redraw a clean frame on every terminal resize`.

---

### Task 8: Mouse reports filtered out of stdin, mouse mode on and off

**Files:**
- Create: `src/ui/mouse/mouseInput.ts`, `src/ui/mouse/MouseContext.tsx`
- Modify: `src/ui/terminal.ts`, `src/cli.tsx` (pass the filtered stdin to `render`, remove every `?1007` write, install exit guards), `src/ui/Root.tsx` or `cli.tsx` (wrap `Root` in the provider), `src/ui/DebateView.tsx` (enable on mount, disable on unmount)
- Test: `src/ui/mouse/__tests__/mouseInput.test.ts`, `src/ui/__tests__/terminal.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type MouseEvent =
    | { kind: "press" | "drag" | "release"; x: number; y: number }   // 0-based cells
    | { kind: "wheel"; direction: "up" | "down"; x: number; y: number };
  export function createMouseFilteredStdin(source: NodeJS.ReadStream): {
    stdin: NodeJS.ReadStream;          // what Ink reads
    on(listener: (event: MouseEvent) => void): () => void;
  };
  export function parseMouseChunk(buffer: string, inPaste: boolean):
    { forward: string; events: MouseEvent[]; rest: string; inPaste: boolean };   // pure core
  // src/ui/terminal.ts
  export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
  export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
  export function setMouseReporting(stdout: { write(s: string): unknown; isTTY?: boolean }, on: boolean): void; // idempotent
  export function installExitGuards(stdout: ..., onExit?: () => void): () => void; // SIGTERM, SIGHUP, uncaughtException, unhandledRejection → mouse off; signals then exit with 128+n, errors rethrown/printed as today
  // src/ui/mouse/MouseContext.tsx
  export function MouseProvider(props: { source: { on(l: (e: MouseEvent) => void): () => void } | null; children: ReactNode }): JSX.Element;
  export function useMouse(handler: (event: MouseEvent) => void, active: boolean): void;
  ```
- SGR decoding: `ESC [ < b ; x ; y M|m`. `b & 64` → wheel (`b & 1` down else up); `b & 32` → drag; `M` with button 0 → press; `m` → release; other buttons ignored (dropped, not forwarded). Modifier bits (4, 8, 16) ignored.
- Hold rule: only a buffered tail that is a strict prefix of a mouse report **and** already starts with `ESC [ <` is held for the next chunk; a lone `ESC` or `ESC [` at the end of a chunk is forwarded immediately. Between `ESC[200~` and `ESC[201~` nothing is parsed.
- The returned `stdin` must satisfy Ink's use of stdin: `isTTY`, `setRawMode`, `setEncoding`, `ref`, `unref`, `read()` with `'readable'` events (`node_modules/ink/build/components/App.js`); delegate the TTY methods to `source`.

- [ ] **Step 1: Failing tests** for `parseMouseChunk` and the stream: press/drag/release/wheel decoding with 1-based → 0-based coordinates; a report split over two chunks; reports interleaved with typed keys (keys forwarded in order); `"forwards a lone Esc immediately"`; `"forwards ESC [ A (arrow) untouched"`; `"leaves a mouse-like sequence inside bracketed paste untouched"`; an invalid `ESC[<abc` forwarded as is; a real Ink `render` with the filtered stdin receives typed text and never sees a mouse report. In `terminal.test.tsx`: `setMouseReporting` writes `MOUSE_ON` once even if called twice; `installExitGuards` writes `MOUSE_OFF` on a simulated `SIGTERM` (inject the process-like emitter and an `exit` fake).
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement and wire: `cli.tsx` creates the filter from `process.stdin`, passes `stdin` in the render options, wraps `Root` in `MouseProvider`, installs guards, and in the `finally` calls `setMouseReporting(process.stdout, false)` instead of the 1007 reset. `DebateView` turns reporting on in a mount effect and off in its cleanup.
- [ ] **Step 4:** `npm run check` green.
- [ ] **Step 5:** Commit `feat: read mouse reports from stdin without leaking them into the input`.

---

### Task 9: Wheel scrolling, selection and highlight

**Files:**
- Create: `src/ui/mouse/selection.ts`
- Modify: `src/ui/DebateView.tsx` (`useMouse` handler, `TranscriptViewport` highlight)
- Test: `src/ui/mouse/__tests__/selection.test.ts`, `src/ui/__tests__/debateView.test.tsx`

**Interfaces:**
- Consumes: `MouseEvent`, `useMouse` (Task 8); `TranscriptLine`, `plainOf`, `sliceColumns` (Task 3).
- Produces:
  ```ts
  export interface Cell { line: number; col: number }          // absolute transcript line index, display column
  export interface Selection { anchor: Cell; focus: Cell }
  export function screenToCell(y: number, x: number, viewport: { top: number; height: number; firstLine: number }): Cell | null; // null outside the viewport
  export function orderedRange(selection: Selection): { start: Cell; end: Cell };
  export function selectedColumns(selection: Selection, line: number, width: number): [number, number] | null; // end exclusive
  export function selectedText(lines: readonly TranscriptLine[], selection: Selection): string;
  export const WHEEL_LINES = 3;
  ```
- `selectedText`: per selected line, `sliceColumns(plainOf(styled), start, end)`; strip a leading rail `│ ` or `│` when the slice starts at column 0; strip a leading `◆ ` likewise; `trimEnd`; join with `\n`, except a line with `softWrap: true` is joined to the previous one with a single space (check `LineBuffer` drops the breaking space; if it keeps it, join with `""` — the test pins the result: the copied text equals the original sentence). Empty selection (anchor equals focus) → `""`.
- Viewport behaviour in `DebateView`: viewport `top = DEBATE_HEADER_ROWS`; press inside starts a selection, drag extends it (dragging on the first/last viewport row scrolls by one line per event), release ends it and calls `onCopy(text)` (Task 10 wires the clipboard; until then a no-op prop) when non-empty; wheel scrolls by `WHEEL_LINES` within the existing bounds; any keypress, a new press, a `rewind`, or a resize clears the selection. A selected line renders from `plainOf` with the selected columns in `chalk.inverse`.

- [ ] **Step 1: Failing tests:** selection units (single line, multi-line both directions, rail and `◆` stripped, soft-wrapped paragraph copied as one sentence, wide characters `"界"` never split, outside-viewport → null, empty → `""`); in `debateView.test.tsx` with a fake mouse source: `"wheel down then up scrolls the transcript by three lines"`, `"drag selects and highlights, release reports the text"`, `"a rewind clears the selection"`, `"a keypress clears the selection"`.
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm run check` green.
- [ ] **Step 5:** Commit `feat: scroll with the wheel and select transcript text with the mouse`.

---

### Task 10: Copy to the clipboard

**Files:**
- Create: `src/ui/mouse/clipboard.ts`
- Modify: `src/ui/DebateView.tsx` (`onCopy` → `copyToClipboard` → `flash`)
- Test: `src/ui/mouse/__tests__/clipboard.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CopyResult = { kind: "copied" } | { kind: "sent-to-terminal" } | { kind: "failed"; message: string };
  export interface ClipboardDeps {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    spawn: typeof import("node:child_process").spawn;
    writeTerminal: (data: string) => void;
  }
  export function clipboardCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): [string, string[]][];
  export function copyToClipboard(text: string, deps: ClipboardDeps): Promise<CopyResult>;
  export function copyNotice(result: CopyResult, characters: number): string;
  ```
- `clipboardCommands`: `darwin` → `[["pbcopy", []]]`; `linux` → `[["wl-copy", []]]` first only if `env.WAYLAND_DISPLAY`, then `["xclip", ["-selection", "clipboard"]]`, `["xsel", ["--clipboard", "--input"]]`; others → `[]`.
- `copyToClipboard`: try each command in order with `spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], shell: false })`, text on stdin; `ENOENT` → next; exit code 0 → `copied`; another error or non-zero exit → `failed` with the message. When no command applies or all are missing: `writeTerminal("\x1b]52;c;" + base64(text) + "\x07")` → `sent-to-terminal`. Never throws.
- Notices exact: `Copied N characters` · `Sent N characters to the terminal clipboard` · `Copy failed: <message>` (N = number of characters of the copied text).

- [ ] **Step 1: Failing tests** with a fake `spawn` (EventEmitter child with a writable stdin): command lists per platform and env; `pbcopy` success → `copied` and stdin received exactly the text; `wl-copy` ENOENT then `xclip` success; all missing on linux → OSC 52 written with the right base64; `win32` → OSC 52; non-zero exit → `failed`; `spawn` throwing synchronously → `failed`, not a throw; `shell: false` asserted; the three notices.
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement and wire in `DebateView` with the real `spawn`, `process.platform`, `process.env`, and `stdout.write`.
- [ ] **Step 4:** `npm run check` green.
- [ ] **Step 5:** Commit `feat: copy the selected transcript text to the clipboard`.

---

### Task 11: Documentation and the reopened decision

**Files:**
- Modify: `README.md` (debate screen description; scrolling with wheel, arrows, PgUp/PgDn, Home/End; selection copies automatically; native selection with Option on macOS, Shift on most Linux terminals; Linux clipboard tools `wl-copy`/`xclip`/`xsel` optional, OSC 52 fallback), `.claudex/memory/decisions.md` (amend the 2026-09-28 entry: wheel scrolling now through SGR mouse reporting, with the reason and date 2026-11-12; the rest stands), `src/ui/DebateView.tsx` `helpLines` (mouse lines), `docs/demo/claudex-session.tsx` only if it no longer typechecks.
- Test: none new; `npm run check`.

- [ ] **Step 1:** Write the README and decisions.md changes; update `/help`.
- [ ] **Step 2:** `npm run check` green.
- [ ] **Step 3:** Commit `docs: describe the redesigned debate screen and mouse support`.
