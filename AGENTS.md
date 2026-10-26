# Claudex contributor guide

Claudex is a terminal app that runs a live debate between Claude Code and Codex,
under direct human supervision, before any code is written. This guide is for
anyone changing Claudex itself, human or agent. User documentation is in README.md.

## Stack
- Node.js >= 22, TypeScript (strict, ESM), run through tsx: there is no build step.
  `bin/claudex.mjs` starts `src/cli.tsx` with this repository's tsconfig.
- UI: Ink 7 and React 19, in the terminal's alternate screen.
- Agents: `@anthropic-ai/claude-agent-sdk` for Claude, the `codex app-server`
  protocol for Codex. Running Claudex needs Claude Code and Codex set up and
  logged in (see README).
- Tests: Vitest. Lint: ESLint, with type-checked typescript-eslint rules on TypeScript.

## Commands
- `npm install`: install dependencies.
- `npm run dev`: run Claudex from source on this repository (npm always runs
  scripts from the package root). To try your changes on another project, run
  `claudex` there after `npm link` (see README), or `node /path/to/claudex/bin/claudex.mjs`.
- `npm test`, `npm run test:watch`: unit and integration tests.
- `npm run typecheck`: strict type check. `npm run lint`: ESLint. Both cover
  `src`, `bin`, `docs/demo` and `scripts`.
- `npm run check`: typecheck, lint and tests. CI runs exactly this on every pull
  request to main and every push to main; it must pass before a pull request is opened.

## Layout
- `src/cli.tsx`: entry point (TTY check, memory scaffold, Ink render).
- `src/types.ts`: shared types and the protocol marker constants.
- `src/agents/`: Claude and Codex adapters behind the `CodingAgent` interface.
- `src/orchestrator/`: the scheduler (per-agent delivery queues, intervention
  batches behind a barrier, epoch-based consensus), slash commands, protocol markers.
- `src/memory/`: reads and writes `.claudex/memory/` in the user's project.
- `src/ui/`: welcome screen, debate view, output rendering.
- `src/util/`: small helpers (tool input formatting, project status).
- `docs/demo/`: source of the README demo GIF; typechecked and linted like `src`.
- `scripts/`: maintainer tooling, never run by `npm test` or CI. `readonly-verification/`
  holds the pure logic of `npm run verify:readonly`, which measures against a real SDK
  whether Claude stays read-only during a debate (run it after every SDK upgrade).
- Tests sit in `__tests__/` next to the code they cover; the scheduler's are in
  `src/__tests__/`.

## Conventions
- Code, comments, commit messages and docs are in English. The UI, agent prompts,
  most test names and some comments are still in French and will be translated
  in one pass; until then, match the language of the surrounding strings.
- Comments explain why, not what.
- Conventional Commits for commits and pull request titles (CI checks the title).
- One branch per change (`feat/`, `fix/`, `docs/`, `chore/`, `refactor/`), merged
  through a pull request. Never push to main.
- Write the test first for any behaviour change. Tests never call a real CLI or
  the network: orchestrator and UI tests use a fake `CodingAgent` (for example
  `FakeAgent` in `src/__tests__/scheduler.test.ts`), adapter tests mock the SDK's
  `query` and `child_process.spawn`.
- Discuss any new dependency before adding it.

## Constraints
- In the user's project, Claudex itself writes nothing outside `.claudex/` (the
  agents may, after `/implement`). It never creates or edits CLAUDE.md or AGENTS.md.
- Agents are read-only until the implementation phase. Codex gets a read-only
  sandbox. For Claude, only two things enforce it: the `tools` list
  (`DEBATE_TOOLS` in `src/agents/claudeAgent.ts`) and the human answering
  `canUseTool`. `permissionMode: "plan"`, `allowedTools` and the SDK sandbox do
  not (measured, see limits.md); re-check after every SDK upgrade.
- The debate rules (`CONSENSUS_INSTRUCTIONS`) never name an agent outside the
  self/other roles; a test checks the symmetry.
- There is no unsupervised mode: `src/cli.tsx` refuses to start without a TTY.
  This is why autonomy is unbounded by default.
- Fake agents that always answer `<<CONTINUE>>` never stop; a test that needs a
  finished debate must set its own autonomy bound.

## Project memory
`.claudex/memory/decisions.md` and `limits.md` record settled decisions and
verified limits (in French for now). Read them before proposing an architectural
change, and do not reopen a decision without saying so and giving a new reason.
The rest of `.claudex/memory/` (transcripts, handoffs, devlog) is local and not versioned.
