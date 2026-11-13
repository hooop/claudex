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
- `docs/diagram/`: the README diagram. `python3 docs/diagram/build.py` rebuilds it; it
  needs the diagram-design Claude Code plugin and Chrome, and is not run by CI.
- `scripts/`: maintainer tooling. `npm run verify:readonly` measures against a real SDK
  whether Claude stays read-only during a debate (run it after every SDK upgrade); that
  command is never run by `npm test` or CI, but its unit tests under
  `scripts/**/__tests__` are. `readonly-verification/` holds its logic.
- Tests sit in `__tests__/` next to the code they cover; the scheduler's are in
  `src/__tests__/`.

## Conventions
- Everything is in English: code, comments, UI, agent prompts, tests, commit messages and docs.
- Comments explain why, not what.
- Conventional Commits for commits and pull request titles (CI checks the title).
- One branch per change (`feat/`, `fix/`, `docs/`, `chore/`, `refactor/`), merged
  through a pull request. Never push to main.
- Write the test first for any behaviour change. Tests never call `claude`,
  `codex` or the network (some run `git init` and spawn `node`): orchestrator and
  UI tests use a fake `CodingAgent` (for example `FakeAgent` in
  `src/__tests__/scheduler.test.ts`), adapter tests mock the SDK's `query` and
  `child_process.spawn`.
- Discuss any new dependency before adding it.

## Constraints
- In the user's project, Claudex itself writes nothing outside `.claudex/` (the
  agents may, after `/implement`). It never creates or edits CLAUDE.md or AGENTS.md.
- Agents are read-only until the implementation phase. Codex gets a read-only
  sandbox. For Claude, only these enforce it: the `tools` list
  (`DEBATE_TOOLS` in `src/agents/debateOptions.ts`), the human answering
  `canUseTool`, and, for Bash, the SDK sandbox. On macOS `resolveDebateSandbox`
  returns a real `cwd` path and `debateQueryOptions` adds Bash with a `sandbox`
  block (`failIfUnavailable`, `allowUnsandboxedCommands: false`, no network,
  `denyWrite` on `cwd`, credential stores in `denyRead`, secret env vars
  denied); elsewhere it returns the read-only options unchanged. There is no
  unsandboxed Bash on any platform or in any failure mode. With the sandbox the
  engine leaves empty directories in `cwd`; `src/agents/engineLeftovers.ts`
  removes them (non-recursive `rmdir`, only those absent before the turn).
  `permissionMode: "plan"` and `allowedTools` enforce nothing (measured, see
  limits.md). Re-check after every SDK upgrade by running
  `npm run verify:readonly` on the old and the new version. The SDK is pinned to an
  exact version for that reason. Debate turns also carry `DEBATE_ISOLATION`
  (same module): no hook, no MCP server, no claude.ai connector (measured,
  limits.md, 2026-11-11).
- The analysed project's command settings (the credential helpers in
  `COMMAND_SETTING_KEYS`, any `env` entry, and the marketplace declarations
  `extraKnownMarketplaces` / `additionalMarketplaces` shown whole, in
  `<cwd>/.claude/settings.json`,
  `src/agents/projectSettings.ts`) need the human's consent at launch, before
  Claudex writes anything or starts either agent; a file Claudex cannot read
  allows only quitting. Consent is never stored. Before every Claude query the
  guard re-reads the file and refuses the turn if it changed. Not closed: a value
  an agent writes inside a running `/implement` turn, which no prompt is
  guaranteed to show first (limits.md, 2026-11-11).
- At every SDK upgrade: run `npm run verify:readonly` cases E to M (including
  Lp and Ll) and S, Sh, Sn, Sr, Se, Sd, Shr, Shn, She, Shu (sandboxed Bash) with their
  controls (Sc, Snc, Src, Sec, Shuc), in fresh and trusted folders, on the old and the
  new version; re-read the whole `Settings` interface in the SDK's `sdk.d.ts` for
  any key whose value is a command, nested ones included (marketplace
  declarations hold several, and have an alias), and compare with what
  `src/agents/projectSettings.ts` flags and what limits.md lists as not shown; if Lp or Ll now run their helper, `PROJECT_SETTINGS_FILES`
  is wrong and the upgrade stops.
- The debate rules (`CONSENSUS_INSTRUCTIONS`) never name an agent outside the
  self/other roles; a test checks the symmetry.
- There is no unsupervised mode: `src/cli.tsx` refuses to start without a TTY.
  This is why autonomy is unbounded by default.
- Fake agents that always answer `<<CONTINUE>>` never stop; a test that needs a
  finished debate must set its own autonomy bound.

## Project memory
`.claudex/memory/decisions.md` and `limits.md` record settled decisions and
verified limits. Read them before proposing an architectural
change, and do not reopen a decision without saying so and giving a new reason.
The rest of `.claudex/memory/` (transcripts, handoffs, devlog) is local and not versioned.
