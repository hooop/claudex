# Using Claudex

Back to the [README](../README.md).

## Starting a session

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

## The interface in detail

**Verbatim forwarding.** No answer is summarised before reaching the other agent. The text is passed on in full.

**No turn limit by default.** The debate runs until consensus is reached. `Esc` pauses it at any moment, including while an agent is answering. Optional autonomy limits can cap the number of turns or the elapsed time.

**Human intervention at any point.** A message can be addressed to both agents, or to a single one.

**Topic qualification.** The first message is assessed before it becomes the official topic. A plain question about the project gets a direct answer without starting a debate, and the session waits for your next message. A message with no topic receives a one-sentence answer, and an incomplete topic a question back. Nothing is written to project memory until a topic has been accepted.

**Persistent project memory.** Decisions and constraints are stored in `.claudex/memory/`. The debate rules sent to both agents point them at those files, so every new debate starts from what was already settled.

**Your instruction files stay yours.** Claudex never creates or modifies `CLAUDE.md` or `AGENTS.md`. If you already have them, both agents keep reading them during a debate. Earlier versions of Claudex appended a section titled "Mémoire du projet (Claudex)" (French text, quoted as it was written) to these files, or created them; that section, or the whole file if Claudex created it, can be deleted safely.

**Full-screen terminal interface.** A fixed four-row header shows the version and the stage of the debate, the protocol status of each agent (`✓` ready, `→` continues, `?` asks you, `✓ Consensus` once both agree), the topic and the project memory. A pulse in the agent's colour shows which one is thinking. Each turn starts with a `◆ CLAUDE` or `◆ CODEX` line with its round and time, and consensus is framed in green. The header and input stay fixed while the transcript scrolls independently. Below the input, the line with each agent's model and free context appears during a debate only when one agent has less than 25 % of its context free; the welcome screen always shows the models. The complete transcript is archived in `.claudex/memory/transcripts/`. Resizing the window redraws a clean frame.

**Scrolling and copying.** The mouse wheel scrolls the transcript 3 lines at a time; `↑`/`↓`, `Page Up`/`Page Down` and `Home`/`End` work too. Press and drag inside the transcript to select text: the selection is copied when you release the button, and a notice tells you how many characters were copied. Claudex uses `pbcopy` on macOS and `wl-copy` (Wayland), `xclip` or `xsel` (X11, only when `DISPLAY` is set) on Linux when one is installed (all optional); otherwise it asks the terminal to set the clipboard (OSC 52), which not every terminal allows. To use your terminal's own selection instead, hold `Fn` or `Option` on macOS (depending on the terminal), or `Shift` in most Linux terminals, while dragging.

Each archived transcript may come with a `.trace.md` diagnostic file holding the agents' working notes and the full output of their tool calls. It is local, git-ignored like the rest of the transcripts, and can contain project data the agents read.

**Long pastes.** A paste longer than 500 characters, or spanning several lines, appears in the input as a single `[Pasted text · N characters]` label. Its full text, line breaks included, is sent on Enter and shown in the transcript; the fixed header shows only the first lines of the topic, and `/topic` prints it in full.
