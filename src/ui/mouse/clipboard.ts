import type { spawn as nodeSpawn } from "node:child_process";

export type CopyResult =
  | { kind: "copied" }
  | { kind: "sent-to-terminal" }
  | { kind: "failed"; message: string };

export interface ClipboardDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  spawn: typeof nodeSpawn;
  /** Must go through Ink's write so its frame bookkeeping is not corrupted. */
  writeTerminal: (data: string) => void;
}

/** Fixed commands and arguments only: nothing from an agent ever reaches them. */
export function clipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): [string, string[]][] {
  if (platform === "darwin") return [["pbcopy", []]];
  if (platform === "linux") {
    const commands: [string, string[]][] = [];
    if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
    commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
    return commands;
  }
  return [];
}

type Attempt = CopyResult | "missing";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attempt(
  command: string,
  args: string[],
  text: string,
  spawn: typeof nodeSpawn,
): Promise<Attempt> {
  return new Promise((resolve) => {
    // Resolving twice is harmless; the first outcome wins.
    const fail = (error: unknown) =>
      resolve(
        (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
          ? "missing"
          : { kind: "failed", message: errorMessage(error) },
      );
    try {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], shell: false });
      child.on("error", fail);
      child.on("close", (code) =>
        resolve(
          code === 0
            ? { kind: "copied" }
            : { kind: "failed", message: `${command} exited with code ${String(code)}` },
        ),
      );
      // An exited command closes its stdin: the EPIPE must not become an uncaught error.
      child.stdin?.on("error", fail);
      child.stdin?.end(text);
    } catch (error) {
      fail(error);
    }
  });
}

export async function copyToClipboard(text: string, deps: ClipboardDeps): Promise<CopyResult> {
  try {
    for (const [command, args] of clipboardCommands(deps.platform, deps.env)) {
      const result = await attempt(command, args, text, deps.spawn);
      if (result !== "missing") return result;
    }
    // OSC 52 carries base64 only, so the selected text cannot inject escape sequences.
    deps.writeTerminal(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
    return { kind: "sent-to-terminal" };
  } catch (error) {
    return { kind: "failed", message: errorMessage(error) };
  }
}

export function copyNotice(result: CopyResult, characters: number): string {
  switch (result.kind) {
    case "copied":
      return `Copied ${characters} characters`;
    case "sent-to-terminal":
      return `Sent ${characters} characters to the terminal clipboard`;
    case "failed":
      return `Copy failed: ${result.message}`;
  }
}
