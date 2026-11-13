# Troubleshooting

Back to the [README](../README.md).

| Message | Cause and fix |
|---|---|
| `command not found: claudex` | Step 4 did not complete. Run `npm link` again from the `claudex` folder. |
| `Claudex a besoin d'un vrai terminal interactif (TTY)` | Claudex was started inside a script or a pipe. Start it directly in a terminal. |
| `Terminal too small (min 40 × 15)` | The window is smaller than 40 columns × 15 rows. Enlarge it: the screen comes back as it was, draft and scroll position included. Keys are ignored meanwhile, except Ctrl+C. |
| `command not found: claude` or `codex` | Repeat step 2 or step 3. |
| The debate fails on the first turn | One of the two accounts is not signed in. Run `claude` and `codex` separately to check. |
| Claude never answers, the turn never ends | An outbound firewall that rules per program (LuLu, Little Snitch) sees each install location of the Claude Code engine bundled with the SDK as a new program, and blocks its requests until you allow it. Allow `node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude` inside the `claudex` folder, for example `claude-agent-sdk-darwin-arm64` on an Apple silicon Mac. |
| `EACCES` during `npm install -g` | Insufficient permissions on the global npm directory. See [the npm documentation](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). |
