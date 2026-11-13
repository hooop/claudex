# Resize and layout robustness — design

Date: 2026-11-13. Branch: `fix/resize-layout`. Technical choices delegated to Claude by
the maintainer ("c'est toi le developpeur senior"); every decision below is Claude's.

## Why

The maintainer, in the macOS Terminal.app, after the CLI redesign was merged: "when I
make the window taller, the footer (prompt + context info) moves up; when I make it
shorter, the header disappears."

## What was measured

Each screen was run in a real Terminal.app window driven by AppleScript (`set bounds`,
then `contents of selected tab`), with the same Ink options and the same
`installResizeClear` as `Root`:

| Case | Result |
|------|--------|
| Minimal frame (`height = rows - 1`, header and footer text) | correct at 20, 38 and 11 rows |
| Debate screen, idle, 20 → 38 rows | correct |
| Debate screen, streaming, dragged 20 → 38 → 15 rows in 15 px steps | correct |
| Debate screen, idle, 11 rows | broken: the `CLAUDEX` title row is gone and the header status is drawn over the topic row |
| Welcome screen, 20 → 38 rows | broken: the prompt and model line stay at row 20 of 38 |
| Welcome screen, 38 → 11 rows | broken: the header art and memory lines are gone |

So Ink's resize repaint and `installResizeClear` work. Two separate defects remain.

### Defect 1 — the welcome screen does not follow the terminal size

`WelcomeScreen` (and `AnimatedHeader` inside it) read `stdout.rows` and `stdout.columns`
during render and never subscribe to `resize`. Ink's own resize handler recomputes the
layout of the existing tree but does not re-render React components, so the frame keeps
the height it had when the welcome screen last re-rendered for another reason. Taller:
the frame is too short and the footer floats in the middle. Shorter: the frame is too
tall and the terminal scrolls its top out of view.

`DebateView` does subscribe, with its own `prependListener` in an effect, which is why
it follows the resize. The size logic exists twice, written differently.

### Defect 2 — the declared minimum height is lower than what the debate screen needs

`MIN_ROWS = 10` is the threshold below which the screen shows "Terminal too small".
The debate frame needs `DEBATE_HEADER_ROWS` (4) + one transcript row + the rule (1) +
the footer (up to `MAX_DYNAMIC_ROWS`, 8) = 14 rows, plus the row Ink keeps free at the
bottom: 15 terminal rows. Between 10 and 14 rows the content is taller than the frame,
Yoga shrinks the header (Ink boxes shrink by default), and its rows collapse onto each
other.

### Why the tests did not catch it

`terminal.test.tsx` checks that the header and footer text are written again after the
full-screen erase, not where they land. The DebateView resize tests check that text is
present or that the cursor never moves more than the screen height. No test asserts
the frame's height, its first row or its last row after a resize, and no test covers
the welcome screen's size at all.

## Goals

- G1. Every screen (welcome, debate) occupies exactly `rows - 1` rows after any resize,
  with its header on the first row and its footer on the last row.
- G2. One source of truth for the terminal size, used by every component that depends on
  it.
- G3. One minimum terminal size, derived from the layout constants rather than written
  by hand, below which every screen shows the same "too small" message.
- G4. Resizing below the minimum and back loses nothing: transcript, scroll position,
  draft in the input bar, open palette.
- G5. Regression tests that assert positions and heights, on both screens, for growing,
  shrinking and crossing the minimum.

## Non-goals

- The verbosity of the agents and the model line: a separate branch.
- Any visual change at normal sizes.
- Ink's incremental diff or `installResizeClear`: measured correct, unchanged.

## Anti-goals

- A per-screen resize workaround (a forced re-render timer, a `key` that remounts the
  screen): it would hide the size from the components instead of giving it to them, and
  a remount loses state.
- Unmounting a screen when the terminal is too small: the input bar's draft and the
  debate view's state would be lost.

## Decisions

### D1. `useTerminalSize()` — the single source

A hook in `src/ui/terminal.ts` returns `{ columns, rows }`, initialised from `stdout`
and updated on `resize`. Its listener is added with `prependListener`, so React state
changes before Ink's own resize handler computes the new frame (the order `DebateView`
already relies on, kept and documented once). Fallbacks stay 80 × 24 for a stream
without a size.

`DebateView`, `WelcomeScreen`, `AnimatedHeader` and any other component that reads
`stdout.rows` or `stdout.columns` during render use the hook instead. `DebateView`'s
own listener is replaced; clearing the selection on resize stays in `DebateView` as an
effect on the size.

Rejected: a context provider at `Root`. One listener per subscribed component is
negligible, the hook keeps components testable alone, and a provider would add a
mounting requirement to every test.

### D2. The minimum size is computed from the layout constants

`src/ui/theme.ts` already holds the frame constants (`MAX_DYNAMIC_ROWS`, `MIN_ROWS`,
`MIN_COLS`) and existing tests import them from there, so they stay there rather than
in a new module. The header height moves there as `DEBATE_HEADER_ROWS` (re-exported by
`DebateHeader.tsx` for its current importers; `DebateHeader` already imports `theme`,
so the reverse import would be a cycle). `MIN_ROWS` becomes
`DEBATE_HEADER_ROWS (4) + MIN_TRANSCRIPT_ROWS (1) + RULE_ROWS (1) + MAX_DYNAMIC_ROWS (8)
+ INK_SPARE_ROWS (1)` = 15, and `isTooSmall(columns, rows)` in the same module is the
only test of it (`footerMode` calls it). `MIN_COLS` (40) is unchanged. The welcome screen needs less than the debate
screen; it uses the same threshold, so the app has one minimum and never shows the
welcome screen at a size the debate cannot use.

### D3. "Too small" hides, never unmounts

Both screens render their frame inside a box with `display="none"` while the terminal is
too small, and a single shared `TerminalTooSmall` line next to it ("Terminal too small:
enlarge it to at least 40 × 15"). State stays mounted.

While hidden, every key except Ctrl+C is ignored and the mouse is not handled. This
covers every `useInput` / `usePaste` listener of both screens: the input bar (typing and
paste), `DebateView`'s own handler (Esc would pause the debate, arrows and Page keys
would move the scroll offset), `PermissionModal` (`y` would grant a tool permission the
human cannot see), `ModelPicker`, `CommandPalette` and `DecisionViewer` (Esc would close
them, Enter would change a model). Answering anything blind is not acceptable, and G4
requires the scroll offset and an open palette to survive. Mechanism: each screen
provides a `ScreenVisibleContext`; every listener above passes
`isActive: <its own condition> && visible`, so nothing is intercepted at the stream
level and Ink's own Ctrl+C handling (`exitOnCtrlC: false`, handled by `Root`) keeps
working. A test per listener presses its key while hidden and asserts nothing changed.
This restricts the permission prompt (it can no longer be answered while hidden); it
does not change what a permission grants.

### D4. Fixed regions do not shrink

The header and every footer row get `flexShrink={0}`; the transcript viewport (debate)
and the upper content area (welcome) are the only regions that give up rows. On the
welcome screen the upper area gets `overflow="hidden"` and `minHeight={0}`, so a short
window clips the bottom of the art/tagline/help block instead of pushing the frame past
the screen. With D2 the debate content always fits; D4 makes the rule structural rather
than arithmetic.

## Tests (written first)

Positional tests render the real component with Ink in `debug` mode, so every write is a
whole frame, on a fake stdout whose `rows`/`columns` change before `resize` is emitted:

- Welcome: after 24 → 40 and 40 → 16 rows, the frame has `rows - 1` rows, the first
  non-empty row is the header art, the last row is the model line. (Fails today.)
- Debate: for every height from `MIN_ROWS` to 40 and each footer surface combination
  (tail, banner, notice, palette, permission), the frame has `rows - 1` rows, row 0
  starts with `CLAUDEX`, and the last row is the footer's last row: the model line, or
  the input bar's bottom border while a palette is open (`footerRows` deliberately drops
  the model line then; unchanged). (Fails today at 11–14 rows.)
- Both screens: below the minimum the frame is exactly the too-small line; growing back
  restores the previous frame with the same transcript, scroll offset and draft.
- `useTerminalSize`: initial value, update on `resize`, listener removed on unmount,
  listener runs before one registered earlier.
- `theme.ts`: `MIN_ROWS` equals the sum of its parts; `isTooSmall` at the boundaries.

The existing `dynamicFooter` tests that use `MIN_ROWS` keep their meaning (they iterate
from the minimum); if one asserts the old value 10 literally, that is a stop point.

## Verification

`npm run check`, then the Terminal.app probe above re-run on both screens (grow, shrink,
drag during streaming, cross the minimum), results reported in the pull request.

## Rollback

Self-contained UI change; reverting the merge commit restores the previous behaviour.
No data, protocol or agent change.

## Left to the builder

The too-small message wording, the hook's exact module if `terminal.ts` grows too
large, and the test helper's shape.
