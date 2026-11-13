import { EventEmitter } from "node:events";
import type { spawn as realSpawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  clipboardCommands,
  copyNotice,
  copyToClipboard,
  type ClipboardDeps,
} from "../clipboard.js";

type Behaviour = "ok" | "enoent" | "exit1" | "error" | "throw" | "stdin-error";

interface Call {
  command: string;
  args: readonly string[];
  options: { shell?: boolean; stdio?: unknown };
  stdin: string;
}

function harness(
  behaviours: Record<string, Behaviour>,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
) {
  const calls: Call[] = [];
  const terminal: string[] = [];
  const spawn = ((command: string, args: readonly string[], options: Call["options"]) => {
    const behaviour = behaviours[command] ?? "enoent";
    if (behaviour === "throw") throw new Error("spawn exploded");
    const call: Call = { command, args, options, stdin: "" };
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: (d: string) => void } };
    const stdin = new EventEmitter() as EventEmitter & { end: (d: string) => void };
    stdin.end = (data: string) => {
      call.stdin += data;
      if (behaviour === "stdin-error") {
        stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        return;
      }
      if (behaviour === "ok") setImmediate(() => child.emit("close", 0));
      if (behaviour === "exit1") setImmediate(() => child.emit("close", 1));
    };
    child.stdin = stdin;
    setImmediate(() => {
      if (behaviour === "enoent") {
        child.emit("error", Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }));
      } else if (behaviour === "error") {
        child.emit("error", Object.assign(new Error("EACCES nope"), { code: "EACCES" }));
      }
    });
    return child;
  }) as unknown as typeof realSpawn;
  const deps: ClipboardDeps = {
    platform,
    env,
    spawn,
    writeTerminal: (data) => terminal.push(data),
  };
  return { calls, terminal, deps };
}

describe("clipboardCommands", () => {
  it("uses pbcopy on darwin", () => {
    expect(clipboardCommands("darwin", {})).toEqual([["pbcopy", []]]);
  });

  it("puts wl-copy first on Wayland only", () => {
    expect(clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual([
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
    ]);
    expect(clipboardCommands("linux", {})).toEqual([
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
    ]);
  });

  it("has no command elsewhere", () => {
    expect(clipboardCommands("win32", {})).toEqual([]);
  });
});

describe("copyToClipboard", () => {
  it("pipes the text to pbcopy on stdin without a shell", async () => {
    const h = harness({ pbcopy: "ok" }, "darwin");
    await expect(copyToClipboard("héllo\nworld", h.deps)).resolves.toEqual({ kind: "copied" });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ command: "pbcopy", args: [], stdin: "héllo\nworld" });
    expect(h.calls[0]?.options).toEqual({ stdio: ["pipe", "ignore", "ignore"], shell: false });
    expect(h.terminal).toEqual([]);
  });

  it("falls through ENOENT to the next candidate", async () => {
    const h = harness({ "wl-copy": "enoent", xclip: "ok" }, "linux", { WAYLAND_DISPLAY: "w" });
    await expect(copyToClipboard("abc", h.deps)).resolves.toEqual({ kind: "copied" });
    expect(h.calls.map((c) => c.command)).toEqual(["wl-copy", "xclip"]);
    expect(h.calls[1]?.args).toEqual(["-selection", "clipboard"]);
    expect(h.calls[1]?.stdin).toBe("abc");
  });

  it("sends OSC 52 when every command is missing", async () => {
    const h = harness({}, "linux");
    await expect(copyToClipboard("héllo", h.deps)).resolves.toEqual({ kind: "sent-to-terminal" });
    expect(h.terminal).toEqual([`\x1b]52;c;${Buffer.from("héllo", "utf8").toString("base64")}\x07`]);
  });

  it("sends OSC 52 on win32 without spawning", async () => {
    const h = harness({}, "win32");
    await expect(copyToClipboard("hi", h.deps)).resolves.toEqual({ kind: "sent-to-terminal" });
    expect(h.calls).toEqual([]);
    expect(h.terminal).toEqual(["\x1b]52;c;aGk=\x07"]);
  });

  it("fails on a non-zero exit, without trying OSC 52", async () => {
    const h = harness({ pbcopy: "exit1" }, "darwin");
    const result = await copyToClipboard("x", h.deps);
    expect(result).toEqual({ kind: "failed", message: "pbcopy exited with code 1" });
    expect(h.terminal).toEqual([]);
  });

  it("fails on a spawn error other than ENOENT", async () => {
    const h = harness({ pbcopy: "error" }, "darwin");
    await expect(copyToClipboard("x", h.deps)).resolves.toEqual({ kind: "failed", message: "EACCES nope" });
  });

  it("does not throw when spawn throws synchronously", async () => {
    const h = harness({ pbcopy: "throw" }, "darwin");
    await expect(copyToClipboard("x", h.deps)).resolves.toEqual({ kind: "failed", message: "spawn exploded" });
  });

  it("does not throw on an EPIPE on stdin", async () => {
    const h = harness({ pbcopy: "stdin-error" }, "darwin");
    await expect(copyToClipboard("x", h.deps)).resolves.toEqual({ kind: "failed", message: "write EPIPE" });
  });
});

describe("copyNotice", () => {
  it("words the three outcomes", () => {
    expect(copyNotice({ kind: "copied" }, 12)).toBe("Copied 12 characters");
    expect(copyNotice({ kind: "sent-to-terminal" }, 12)).toBe("Sent 12 characters to the terminal clipboard");
    expect(copyNotice({ kind: "failed", message: "boom" }, 12)).toBe("Copy failed: boom");
  });
});
