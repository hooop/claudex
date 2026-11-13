# Claudex

[![CI](https://github.com/hooop/claudex/actions/workflows/ci.yml/badge.svg)](https://github.com/hooop/claudex/actions/workflows/ci.yml)

Claudex runs a structured debate between Claude Code and Codex on a technical question, inside a single terminal, with a human in control. It replaces the manual copy-paste of one agent's answer into the other and keeps the discussion attached to the project.

<img src="docs/demo/claudex.gif" alt="Claudex demo: animated header, a topic typed into the prompt, then Claude and Codex debating an authentication migration" width="660">

## How it works

*Both agents answer in the language of your messages, English otherwise. They are asked to write code, comments and commit messages in English.*

A session always follows the same cycle:

1. A technical question is asked.
2. Claude answers. The answer is forwarded to Codex.
3. Codex answers. The answer is forwarded to Claude.
4. The cycle repeats until both agents explicitly agree.
5. Claudex prints a summary of what was decided.
6. `/handoff` writes that decision to a standalone markdown file, ready to hand to a `claude` or `codex` session for implementation.
7. Alternatively, `/implement claude` or `/implement codex` lets the chosen agent implement the agreed plan without leaving Claudex.

The debate phase is read-only for the agents: both can inspect the code, but neither can modify it. During a debate Claude Code runs no hook from the repository, your settings or plugins (hooks set by a machine administrator's managed settings still run), no MCP server, and gets none of your claude.ai connectors. If the analysed repository's Claude Code settings ask Claude Code to run a command (a credential helper such as `apiKeyHelper`) or to set environment variables, Claudex shows them at launch and starts nothing until you accept (see [What leaves the machine](#what-leaves-the-machine)). Write access is enabled only after an explicit `/implement` command.

The topic is not restricted to architecture. Anything settled before code gets written fits: choosing between two approaches, reviewing existing code, diagnosing an observed bug, weighing a trade-off.

## Notable points

**Verbatim forwarding.** No answer is summarised before reaching the other agent. The text is passed on in full.

**No turn limit by default.** The debate runs until consensus is reached. `Esc` pauses it at any moment, including while an agent is answering. Optional autonomy limits can cap the number of turns or the elapsed time.

**Human intervention at any point.** A message can be addressed to both agents, or to a single one.

**Topic qualification.** The first message is assessed before it becomes the official topic. An off-topic or incomplete request receives an answer and waits for clarification. Nothing is written to project memory until a topic has been accepted.

**Persistent project memory.** Decisions and constraints are stored in `.claudex/memory/`. The debate rules sent to both agents point them at those files, so every new debate starts from what was already settled.

**Your instruction files stay yours.** Claudex never creates or modifies `CLAUDE.md` or `AGENTS.md`. If you already have them, both agents keep reading them during a debate. Earlier versions of Claudex appended a section titled "Mémoire du projet (Claudex)" (French text, quoted as it was written) to these files, or created them; that section, or the whole file if Claudex created it, can be deleted safely.

**Full-screen terminal interface.** A fixed four-row header shows the version and the stage of the debate, the protocol status of each agent (`✓` ready, `→` continues, `?` asks you, `✓ Consensus` once both agree), the topic and the project memory. A pulse in the agent's colour shows which one is thinking. Each turn starts with a `◆ CLAUDE` or `◆ CODEX` line with its round and time, and consensus is framed in green. The header and input stay fixed while the transcript scrolls independently; the complete transcript is archived in `.claudex/memory/transcripts/`. Resizing the window redraws a clean frame.

**Scrolling and copying.** The mouse wheel scrolls the transcript 3 lines at a time; `↑`/`↓`, `Page Up`/`Page Down` and `Home`/`End` work too. Press and drag inside the transcript to select text: the selection is copied when you release the button, and a notice tells you how many characters were copied. Claudex uses `pbcopy` on macOS and `wl-copy`, `xclip` or `xsel` on Linux when one is installed (all optional); otherwise it asks the terminal to set the clipboard (OSC 52), which not every terminal allows. To use your terminal's own selection instead, hold `Option` (Terminal.app, iTerm2) or `Shift` (most Linux terminals) while dragging.

Each archived transcript may come with a `.trace.md` diagnostic file holding the agents' working notes and the full output of their tool calls. It is local, git-ignored like the rest of the transcripts, and can contain project data the agents read.

**Long pastes.** A paste longer than 500 characters, or spanning several lines, appears in the input as a single `[Pasted text · N characters]` label. Its full text, line breaks included, is sent on Enter and shown in the transcript; the fixed header shows only the first lines of the topic, and `/topic` prints it in full.

## What leaves the machine

Worth reading before pointing Claudex at a repository owned by someone else, or using it in a professional setting.

**The code is sent to two providers.** Claudex drives Claude Code (Anthropic) and Codex (OpenAI). Everything the agents read, whether files, excerpts or search results, is sent to both, and each answer from one is forwarded to the other.

**Debate permissions are deliberately narrow.** During a debate, Codex can execute shell commands inside a read-only, network-disabled operating system sandbox. On macOS, Claude Code gets a shell too, run by Claude Code's own sandbox. In our measurements it could write nothing in the project or anywhere outside the engine's temporary directory, and reach no network (loopback included). The sandbox is configured to hide the usual credential stores (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.claude`, `~/.codex`, `~/.npmrc` and others) and environment variables whose name contains KEY, SECRET, TOKEN, PASSWORD, CREDENTIAL, AUTH, DSN or DATABASE_URL. In our measurements, commands run without a prompt unless they name a path outside the project, in which case you are asked. If the sandbox is unavailable the turn fails; Claude Code never runs a command unsandboxed. On Linux, WSL and Windows this has not been measured, so Claude Code keeps only its file-reading and search tools there. No MCP tool is offered to it on any platform.

**Read-only means "the agents cannot modify anything", not "only sees the repository".** In the current version of Codex, nothing restricts what a command may read. It can open any file the current account has access to and copy its contents into the transcript, which is then sent to both models and written to disk. Without network access a command cannot exfiltrate anything by itself, but it can still copy. The same holds for Claude's sandboxed shell on macOS: only the credential stores and secret-looking environment variables listed above are hidden, so a command can read any other file the account can, and the output goes into the transcript. Environment variables are matched by name, so a secret in a variable named otherwise stays visible. The engine's temporary directory `/tmp/claude-<uid>` is writable from the sandbox and is shared with your other Claude Code sessions; we found no setting that moves it. With the sandbox on, Claude Code also creates an empty `.claude/` directory (sometimes `.claude/.cc-writes/`) in the analysed project; Claudex removes it after the turn when it was absent before and is still empty. We measured this on one machine and account (macOS, SDK 0.3.310, `claude-sonnet-5-5`, fresh folders); the same checks in a folder Claude Code already trusts have not been run yet. Claudex should therefore not be used to analyse untrusted code. How Claude Code is kept away from the repository's own tooling is described next.

**During a debate, Claude Code is isolated from the repository's and your account's tooling.** Claudex tells Claude Code to run no hook (except those of a machine administrator's managed settings, which the SDK does not let a session turn off), start no MCP server (whether declared by the repository's `.mcp.json`, your user settings or a plugin) and connect none of your claude.ai connectors. We measured three of these vectors, with controls showing each is live without the isolation: a repository `SessionStart` hook, a repository `.mcp.json` stdio server and the claude.ai connectors. The measurements were made on macOS, on one machine and account, twice per case, in fresh folders and in a folder Claude Code already trusts; every folder there was trusted through a parent folder, so folders that were never trusted were not measured, and neither were Linux and Windows. The repository's `CLAUDE.md`, `.claude/commands`, agents, skills and output styles are still loaded on purpose: they can influence what the model says, not which tools it has (see above).

**The repository's command settings need your consent.** A repository's `.claude/settings.json` can ask Claude Code to run a command during its sessions (a credential helper such as `apiKeyHelper`), or set environment variables for it. The isolation above does not stop either. We measured two consequences, under the same conditions as above: Claude Code ran a repository's `apiKeyHelper` without a prompt, and a repository's `env.ANTHROPIC_BASE_URL` sent Claude Code's API requests, which carry the conversation and the code Claude read, to a server the repository chose (a local test server received them; whether they also carried your credential was not checked). Before this version, any repository could do both during a debate, unseen. Now, at launch, before it writes anything or starts either agent, Claudex reads the launch folder's `.claude/settings.json` itself, without running anything. If the file declares any of the six top-level credential helpers Claude Code knows (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`), any plugin marketplace declaration (`extraKnownMarketplaces` or its alias `additionalMarketplaces`, shown whole: it can name URLs, header helpers and plugin commands; whether Claude Code fetches or runs anything from a marketplace a repository declares was not measured), or any `env` entry, Claudex prints them in full and asks: `y` continues with them; `n`, `q`, Enter, Escape or Ctrl+C quit, so quitting is the default. If Claudex cannot read or parse that file, it only offers to quit. Your answer is not remembered: the question comes back at every launch. Before every Claude turn, Claudex reads the file again; if those entries changed, the turn is not sent, and you need to quit and relaunch to review them. This is not complete. Inside a running `/implement` turn, Claude Code may reload its settings, so a helper or `env` value an agent writes during that turn could apply before Claudex checks again; this is neither measured nor closed. Nothing guarantees you see such a write before it lands. Claude's permission prompt shows a write only when no allow rule has already approved it: allow rules, yours or the analysed repository's own `permissions.allow` (which the consent screen does not show), are applied before that prompt, and whether Claude Code shields its own settings files from them was not measured. A write made through Bash shows only the command, not which files it changes. With `/implement codex`, Codex writes in the project with no prompt at all (Claudex runs it with `approvalPolicy: "never"`). In every one of these cases, Claudex catches the change only before the next Claude turn. Claudex reads only the launch folder's `.claude/settings.json`: in our runs Claude Code ran neither a helper in the git root's settings when launched from a subfolder nor one in `.claude/settings.local.json`. Codex's own project configuration is not checked.

**Implementation is a separate, explicit phase.** `/implement` gives the agents write-capable tools. Codex remains sandboxed to the current project and temporary directories, with network access disabled. Claude Code uses its normal implementation tools and may ask for permission before sensitive actions. In this phase Claude Code works as it does in your own sessions: your hooks, MCP servers and connectors are back, and so are the repository's hooks and stdio MCP servers, but without the workspace trust dialog Claude Code shows the first time you open a folder. Review the agreed plan before enabling this phase.

**Debates are written inside the repository.** Claudex creates a `.claudex/` directory at the root of the folder it is launched from, and stores transcripts there. On first launch it also installs a `.gitignore` so those transcripts never reach a commit. Decisions and limits stay committable on purpose: they are short, and anyone who clones the repository should get them.

## Requirements

| Required | Purpose |
|---|---|
| Node.js 22 or newer | Runs Claudex |
| A Claude Code account | A supported Claude plan or Anthropic Console account, already signed in |
| A Codex account | A ChatGPT plan that includes Codex, already signed in |
| An interactive terminal | Claudex refuses to start inside a script or a pipe |

Access to both agents is required at the same time because a debate consumes usage on both sides. Plan availability and limits can change; check the current [Claude Code setup documentation](https://docs.anthropic.com/en/docs/claude-code/getting-started) and [Codex plan documentation](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).

### No API key is needed

Claudex asks for no API key, stores none and reads none. There is no `.env` file to create and no environment variable to set.

Authentication happens once, inside Claude Code and inside Codex, using the usual accounts. Claudex then reuses those sessions. The only account configuration it reads is the default model, so that it can display it in the interface.

One exception is worth knowing about. If the `ANTHROPIC_API_KEY` environment variable is set, Claude Code may use it instead of the subscription, which means per-token billing. To stay on the subscription, `echo $ANTHROPIC_API_KEY` should print nothing.

## Installation

### 1. Node.js

```bash
node --version
```

If the reported version is below `v22`, install Node.js from [nodejs.org](https://nodejs.org), choosing the LTS release, then open a new terminal.

### 2. Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude
```

Sign in on first launch, then quit with `/quit`. Confirm with `claude --version`.

### 3. Codex

```bash
npm install -g @openai/codex
codex
```

Sign in on first launch, then quit. Confirm with `codex --version`.

### 4. Claudex

```bash
git clone https://github.com/hooop/claudex.git
cd claudex
npm install
npm link
```

`npm install` also downloads the Claude Code engine bundled with the Claude Agent SDK (about 270 MB on macOS arm64). Signing in still goes through your own Claude Code, as in step 2.

`npm link` makes the `claudex` command available from any directory. It creates a link to this folder, which must therefore not be moved afterwards. To remove the command later: `npm unlink -g claudex`.

Claudex is currently installed from source; it is not published as an npm package.

### 5. Verification

```bash
npm run check
```

This runs the strict TypeScript typecheck, ESLint, then the complete test suite. Everything should pass. The same command runs in CI, on Node 22, for every pull request and every push to `main`.

### Common problems

| Message | Cause and fix |
|---|---|
| `command not found: claudex` | Step 4 did not complete. Run `npm link` again from the `claudex` folder. |
| `Claudex a besoin d'un vrai terminal interactif (TTY)` | Claudex was started inside a script or a pipe. Start it directly in a terminal. |
| `command not found: claude` or `codex` | Repeat step 2 or step 3. |
| The debate fails on the first turn | One of the two accounts is not signed in. Run `claude` and `codex` separately to check. |
| Claude never answers, the turn never ends | An outbound firewall that rules per program (LuLu, Little Snitch) sees each install location of the Claude Code engine bundled with the SDK as a new program, and blocks its requests until you allow it. Allow `node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude` inside the `claudex` folder, for example `claude-agent-sdk-darwin-arm64` on an Apple silicon Mac. |
| `EACCES` during `npm install -g` | Insufficient permissions on the global npm directory. See [the npm documentation](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). |

## Usage

```bash
claudex
```

The welcome screen shows the configured models and the state of the project memory, then waits for a topic.

To start straight on a topic:

```bash
claudex "What architecture should the video timeline use?"
```

### Walkthrough of a session

1. Move into the directory of the project concerned. Claudex reads that directory and writes its memory there.
2. Run `claudex`.
3. Type the question, in plain language.
4. Let the debate run. `Esc` pauses it, and a plain message redirects both agents.
5. Once consensus is reached, the summary appears automatically.
6. `/handoff` writes the decision to a standalone markdown file.
7. `/quit` archives the session and exits.

No code is modified along this recommended path. To implement inside Claudex instead, use `/implement claude` or `/implement codex` after reviewing the consensus summary.

### Commands

Talking to the agents:

| Command | Effect |
|---|---|
| plain text | Message sent to both agents. On the welcome screen, starts the debate on that topic. |
| `/claude <text>` | Message addressed to Claude only |
| `/codex <text>` | Message addressed to Codex only |
| `/model claude\|codex <name>` | Changes an agent's model, including before the debate starts |
| `/topic` | Prints the complete accepted topic in the transcript |

Recording:

| Command | Effect |
|---|---|
| `/handoff` | After consensus, writes a standalone markdown file into `.claudex/memory/handoffs/`, ready to hand to a `claude` or `codex` session for implementation |
| `/implement [claude\|codex] [instruction]` | Enables the implementation phase and optionally starts the chosen agent on the agreed plan |
| `/save` | Writes a snapshot of the running session, marked as partial, without closing it |
| `/decide <topic> \| <approach>` | Records a decision in the project memory |
| `/limit <text>` | Records a known constraint |
| `/decisions` | Displays the decisions recorded so far |

Controlling the pace:

| Command | Effect |
|---|---|
| `/pause` | Stops the automatic chaining after the current turn |
| `/resume` | Retries a failed turn, or opens a new autonomy window |
| `/cancel` | Cancels the current turn, keeping the text already received |
| `/accept-topic` | Manually accepts a topic after a qualification protocol error |
| `/autonomy starts <N>` | Limits the debate to N automatic starts |
| `/autonomy time <duration>` | Limits automatic starts over time (`ms`, `s`, `m`, `h`) |
| `/autonomy unbounded` | Removes the limit. This is the default behaviour. |
| `--remember` | Appended to an `/autonomy` command, stores the policy for the project |

Finishing:

| Command | Effect |
|---|---|
| `/new` | Archives the session, resets both agents and returns to the welcome screen |
| `/quit` | Archives the session and exits |
| `/retry` | Retries whichever shutdown or archiving step failed |
| `/help` | Prints the help inside the debate log |

`Ctrl+C` follows the same path as `/quit` and never silently discards an archive. The built-in `/help` lists every command, including those reserved for last-resort situations.

## Architecture

```
src/
  agents/         adapters for the Claude Agent SDK and Codex app-server
  orchestrator/   debate state machine (turns, consensus, interventions)
  memory/         reads and writes .claudex/memory/
  ui/             welcome screen, debate view, output rendering pipeline
```

## Status

Claudex is usable today and under active development. The current release includes topic qualification, the autonomous debate loop, human interventions, project memory, transcript archives, context-usage indicators, model selection, handoffs, and an optional implementation phase.

## Contributing

[AGENTS.md](AGENTS.md) describes the stack, the commands (`npm run check` must pass before a pull request), the conventions and the constraints to respect. `CLAUDE.md` imports it, so Claude Code and Codex read the same guide.

## License

Claudex is available under the [MIT License](LICENSE). You may use, copy, modify, distribute, sublicense, or sell it, including for commercial purposes, provided that the copyright and license notice are retained.
