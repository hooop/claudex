# Long paste — implementation plan

**Spec:** design approved in chat on 2026-10-26 (small change, no spec file). Summary:

- A paste arrives in one piece, line breaks included (Ink 7 `usePaste`, already installed).
- A paste longer than 500 characters, or containing a line break, shows in the input as
  `[Texte collé · 12 430 caractères]` instead of its text. Shorter single-line pastes are
  inserted as typed text.
- The label behaves as one character: text can be typed before or after it, Backspace removes
  it whole. Several labels in the draft are numbered (`#1`, `#2`).
- Enter submits the draft with every label replaced by its full text, line breaks included.
- Terminals without bracketed paste: chunks arriving in the same burst must no longer be lost.
- The transcript shows the submitted message in full (unchanged behaviour).
- The fixed debate header shows at most 3 lines of the topic, the last one ending with
  `… /topic pour le voir en entier`.

**Global constraints:** no new dependency; `npm run check` green; tests written first.

## Task 1: InputBar keeps every chunk of a burst

Root cause: the `useInput` handler reads `value`/`cursor` from the last render, so a second
event delivered before React re-renders overwrites the first.

- Test (inputBar.test.tsx): queue two chunks, emit one `readable`, submit; expect both chunks.
  Expected before fix: FAIL (second chunk missing).
- Fix: keep the draft in a ref updated synchronously, render from state.
- Test command: `npx vitest run src/ui/components/__tests__/inputBar.test.tsx`

## Task 2: Bracketed paste with labels

- Tests (inputBar.test.tsx), bracketed paste pushed as `\u001b[200~…\u001b[201~`:
  - 30 000-character paste: input shows `[Texte collé · 30 000 caractères]`, submit sends all 30 000.
  - multi-line paste (`a\r\nb\rc`): label shown, submit sends `a\nb\nc`.
  - 500 characters single line: inserted as text; 501: label.
  - typing before and after a label, then submit: text around the expanded paste is kept.
  - Backspace right after a label removes it whole.
  - two labels: numbered `#1` and `#2`.
  - Ctrl+U clears labels; a later submit does not resend old pastes.
- Implementation: each paste is stored in a map and represented in the draft by one
  Supplementary Private Use Area-B code point (U+100000+), rendered as its label and expanded on
  submit. Incoming typed text is stripped of that range so it cannot forge a label.
- Test command: `npx vitest run src/ui/components/__tests__/inputBar.test.tsx`

## Task 3: Bounded topic in the debate header

- Test (debateView.test.tsx): `topicHeaderLines` of a topic wider than 3 lines returns 3 lines,
  the last ending with `… /topic pour le voir en entier`, none wider than the width; a topic
  with line breaks is shown on one logical line; a short topic is unchanged.
- Implementation: `topicHeaderLines(topic, width)` used by both `IntroPanel` and the row budget
  in `DebateView`.
- Test command: `npx vitest run src/ui/__tests__/debateView.test.tsx`

## Task 4: Full check

- `npm run check` green.
