# Resize and Layout Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both screens fill exactly `rows - 1` rows after any resize, with header first and footer last, and hide (never unmount) below one computed minimum size.

**Architecture:** One `useTerminalSize()` hook feeds every size-dependent component. The minimum size is derived in `theme.ts` from the frame constants. A `ScreenVisibleContext` lets each screen hide its frame with `display="none"` and deactivate every key listener while too small.

**Tech Stack:** TypeScript strict ESM, Ink 7.1.1, React 19, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-11-13-resize-layout-design.md`

## Global Constraints

- No new dependency. No change to existing tests (modifying one is a stop point).
- Everything in English; comments explain why.
- `MIN_ROWS` = `DEBATE_HEADER_ROWS (4) + MIN_TRANSCRIPT_ROWS (1) + RULE_ROWS (1) + MAX_DYNAMIC_ROWS (8) + INK_SPARE_ROWS (1)` = 15; `MIN_COLS` = 40.
- Too-small message: `Terminal too small (min 40 × 15)` (built from the constants).
- No visual change at sizes ≥ the minimum.
- `npm run check` passes at the end of every task.

## Review Focus

- Resize while a palette or the permission prompt is open: the frame stays `rows - 1` and the surface survives (Task 5 test).
- Shrink below the minimum then grow back with a draft typed: the draft and scroll offset are intact (Tasks 4 and 5 tests).
- Ctrl+C while hidden still quits (Task 3 test via Root's handler, which is outside the screens).
- Width-only resize on the welcome screen updates the art and memory widths (Task 4 test).
- Resize during streaming: new text keeps the header pinned (existing DebateView tests, plus the Terminal.app probe in Task 6).

---

### Task 1: Computed minimum size

**Files:**
- Modify: `src/ui/theme.ts` (constants block around `MIN_ROWS`)
- Modify: `src/ui/components/DebateHeader.tsx:10` (re-export)
- Modify: `src/ui/components/DynamicFooter.tsx` (`footerMode` uses `isTooSmall`)
- Test: `src/ui/__tests__/theme.test.ts` (new)

**Interfaces:**
- Produces: `DEBATE_HEADER_ROWS = 4`, `MIN_TRANSCRIPT_ROWS = 1`, `RULE_ROWS = 1`, `INK_SPARE_ROWS = 1`, `MIN_ROWS`, `MIN_COLS`, `isTooSmall(columns: number, rows: number): boolean`, `tooSmallMessage(): string` — all from `src/ui/theme.ts`. `DebateHeader.tsx` keeps exporting `DEBATE_HEADER_ROWS` (re-export).

- [ ] **Step 1: Write the failing tests** in `theme.test.ts`:
  - `MIN_ROWS` equals `DEBATE_HEADER_ROWS + MIN_TRANSCRIPT_ROWS + RULE_ROWS + MAX_DYNAMIC_ROWS + INK_SPARE_ROWS` and equals 15.
  - `isTooSmall(40, 15)` is false; `isTooSmall(40, 14)` and `isTooSmall(39, 15)` are true.
  - `tooSmallMessage()` is `"Terminal too small (min 40 × 15)"`.
- [ ] **Step 2: Run** `npx vitest run src/ui/__tests__/theme.test.ts` — expect FAIL (exports missing).
- [ ] **Step 3: Implement** the constants and functions in `theme.ts`; `DebateHeader.tsx` re-exports `DEBATE_HEADER_ROWS` from `theme.js`; `footerMode` returns `too-small` when `isTooSmall(columns, terminalRows)`.
- [ ] **Step 4: Run** `npm run check` — expect PASS (existing `dynamicFooter` and `debateHeader` tests unchanged and green).
- [ ] **Step 5: Commit** `fix: derive the minimum terminal size from the frame layout`

### Task 2: `useTerminalSize` hook

**Files:**
- Create: `src/ui/useTerminalSize.ts`
- Test: `src/ui/__tests__/useTerminalSize.test.tsx`

**Interfaces:**
- Produces: `useTerminalSize(): { columns: number; rows: number }` — reads `useStdout().stdout`, falls back to 80 × 24, subscribes with `stdout.prependListener("resize", …)`, unsubscribes on unmount.

- [ ] **Step 1: Write the failing tests** (render a probe component printing `${columns}x${rows}` on a fake stdout `EventEmitter` with `isTTY`, `columns`, `rows`, `write`):
  - initial frame shows `100x30`;
  - after setting `rows = 40` and emitting `resize`, the frame shows `100x40`;
  - after unmount, `stdout.listenerCount("resize")` is back to its value before mount;
  - with another `resize` listener registered before mount, the hook's listener is first: `stdout.listeners("resize")[0]` is not the earlier one.
- [ ] **Step 2: Run** `npx vitest run src/ui/__tests__/useTerminalSize.test.tsx` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the hook. Comment why `prependListener`: React state must change before Ink's own resize handler lays out the new frame.
- [ ] **Step 4: Run** the test, then `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat: add a single terminal size hook`

### Task 3: Screen visibility context and too-small line

**Files:**
- Create: `src/ui/screenVisibility.tsx`
- Modify: `src/ui/components/InputBar.tsx:320,338`, `src/ui/components/PermissionModal.tsx:20`, `src/ui/components/ModelPicker.tsx:62`, `src/ui/components/DecisionViewer.tsx:32`, `src/ui/mouse/MouseContext.tsx` (`useMouse`)
- Test: `src/ui/__tests__/screenVisibility.test.tsx`

**Interfaces:**
- Produces: `ScreenVisibleContext` (default `true`), `useScreenVisible(): boolean`, `<TerminalTooSmall />` (one `Text` with `tooSmallMessage()`, `wrap="truncate-end"`), and `<FittedScreen columns rows>{frame}</FittedScreen>` which renders `<TerminalTooSmall />` plus `<Box display="none">` around `frame` when `isTooSmall`, and the frame alone otherwise, providing the context value accordingly.
- Each listener's `isActive` becomes `<existing condition> && useScreenVisible()`; `PermissionModal`, `ModelPicker`, `DecisionViewer` gain `{ isActive: visible }`; `useMouse(handler, active)` treats `active && visible`.

- [ ] **Step 1: Write the failing tests** — inside `<ScreenVisibleContext.Provider value={false}>`:
  - `PermissionModal`: pressing `y` and `n` never calls `onDecide`;
  - `ModelPicker`: Esc does not call `onCancel`, Enter does not call `onSelect`;
  - `DecisionViewer`: Esc does not call `onClose`;
  - `InputBar`: typing `abc` and pasting do not change the value nor call `onSubmit` on Enter;
  - `FittedScreen` at 40 × 14 renders exactly `Terminal too small (min 40 × 15)` and not the child text; at 40 × 15 renders the child and not the message;
  - a child with `useState` keeps its state across 15 → 14 → 15 rows (rerender with new props, child counter value unchanged).
  - With the provider set to `true` (control), `PermissionModal` `y` calls `onDecide(true)`.
- [ ] **Step 2: Run** `npx vitest run src/ui/__tests__/screenVisibility.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** the module and wire `useScreenVisible()` into the five listeners.
- [ ] **Step 4: Run** `npm run check` — PASS (default context `true` keeps every existing test's behaviour).
- [ ] **Step 5: Commit** `fix: ignore keys and the mouse while the screen is hidden`

### Task 4: Welcome screen follows the terminal size

**Files:**
- Modify: `src/ui/components/WelcomeScreen.tsx:84-85,149-200`, `src/ui/components/AnimatedHeader.tsx:16`
- Create: `src/ui/__tests__/frameHarness.tsx` (shared by Tasks 4 and 5)
- Test: `src/ui/components/__tests__/welcomeScreen.test.tsx` (new)

**Interfaces:**
- Consumes: `useTerminalSize` (Task 2), `FittedScreen` (Task 3).
- Produces (harness): `mountFrame(node: ReactElement, size: { columns: number; rows: number })` returning `{ resize(size), frame(): string[], type(text), unmount() }`. It renders with Ink `debug: true` (each write is a whole frame), `patchConsole: false`, on a fake stdout/stdin like `terminal.test.tsx`'s `fakeTerminal`; `frame()` returns the last write's rows with ANSI stripped; `resize` sets `columns`/`rows` then emits `resize` and waits 100 ms.

- [ ] **Step 1: Write the failing tests** with `mountFrame(<WelcomeScreen …/>)` (agents and status as in `docs/demo/claudex-session.tsx`):
  - at 80 × 24 then `resize({80, 40})`: `frame()` has 39 rows, `frame()[0]` is the first art row (non-empty), the last row contains `/help` (model line);
  - `resize({80, 16})`: 15 rows, last row contains `/help`, the input placeholder `Describe the technical problem` is on row `15 - 3` (inside the 3-row input bar above the model line);
  - `resize({120, 24})`: the memory divider row's width equals `Math.min(120, HEADER_MAX_WIDTH)`;
  - `resize({80, 12})`: frame is exactly the too-small message; type `hidden`; `resize({80, 24})`: the frame has 23 rows again and no row contains `hidden` (keys ignored while hidden).
  - A draft typed at 24 rows (`draft`) is still shown after 24 → 12 → 24.
- [ ] **Step 2: Run** `npx vitest run src/ui/components/__tests__/welcomeScreen.test.tsx` — expect FAIL on the 39-row and 15-row assertions.
- [ ] **Step 3: Implement**: `WelcomeScreen` and `AnimatedHeader` take their size from `useTerminalSize()`; the screen body is wrapped in `FittedScreen`; the upper content box gets `flexShrink={1}`, `minHeight={0}`, `overflow="hidden"`; the model picker, input bar and model footer get `flexShrink={0}`.
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `fix: make the welcome screen follow terminal resizes`

### Task 5: Debate screen uses the shared size and hides when too small

**Files:**
- Modify: `src/ui/DebateView.tsx:103-106,218-234,241,668-790`, `src/ui/components/DynamicFooter.tsx` (`DynamicFooter` too-small branch)
- Test: `src/ui/__tests__/debateLayout.test.tsx` (new; uses `frameHarness`)

**Interfaces:**
- Consumes: `useTerminalSize`, `FittedScreen`, `isTooSmall`, harness from Task 4.
- `DynamicFooter` no longer renders the too-small text itself; `DebateView` wraps it in `FittedScreen`. `footerMode` keeps returning `too-small` (existing tests).

- [ ] **Step 1: Write the failing tests** (fake agents as in `debateView.test.tsx`'s `FakeAgent`, with a debate that has streamed 60 lines):
  - for every `rows` from `MIN_ROWS` to 40: frame has `rows - 1` rows, row 0 starts with `CLAUDEX`, last row contains `/help`;
  - same loop with the command palette open (type `/`): last row is the input bar's bottom border (row 0 still `CLAUDEX`);
  - same loop with a pending permission: last row contains `/help`, the permission question is visible;
  - 24 → 12: frame is the too-small message; press PgUp and Esc while hidden; → 24: scroll offset unchanged (bottom transcript line identical to before), session not paused;
  - a draft typed at 24 survives 24 → 12 → 24.
- [ ] **Step 2: Run** `npx vitest run src/ui/__tests__/debateLayout.test.tsx` — expect FAIL on the hidden-state tests (today `DynamicFooter` unmounts the frame, so the draft is lost and PgUp still scrolls). The 15–40 loop may already pass after Task 1; it pins the invariant.
- [ ] **Step 3: Implement**: replace the local size state and resize listener with `useTerminalSize()`; keep clearing the selection in a `useEffect` on `[columns, rows]`; the stream's width getter reads a ref updated from the hook; header and every footer row get `flexShrink={0}`; wrap the frame in `FittedScreen`.
- [ ] **Step 4: Run** `npm run check` — PASS, including all existing `debateView.test.tsx` resize tests.
- [ ] **Step 5: Commit** `fix: keep the debate frame whole at every supported size`

### Task 6: Real-terminal verification and docs

**Files:**
- Modify: `README.md` (minimum terminal size, one line in the requirements or usage section)

- [ ] **Step 1:** Re-run the Terminal.app probe (AppleScript `set bounds` + `contents of selected tab`) on the welcome screen and the debate screen: grow 20 → 38 rows, shrink to 11 and to 15, drag during streaming. Expected: header on the first row and footer on the last row in every capture; too-small line at 11.
- [ ] **Step 2:** Add the minimum size (40 × 15) to the README.
- [ ] **Step 3: Run** `npm run check` — PASS.
- [ ] **Step 4: Commit** `docs: state the minimum terminal size`
