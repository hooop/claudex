import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeAgent {
    readonly label = "Fake";
    constructor(readonly id: "claude" | "codex") {}
    currentModel() {
      return "fake-model";
    }
    hasExplicitModel() {
      return true;
    }
    setModel() {}
    resetSession() {}
    send() {
      return new Promise(() => {});
    }
    async stop() {}
  }
  return { FakeAgent, claudeArgs: [] as unknown[][] };
});

// Separate from root.test.tsx, whose ClaudeAgent mock ignores its arguments.
vi.mock("../../agents/claudeAgent.js", () => ({
  ClaudeAgent: class extends mocks.FakeAgent {
    constructor(...args: unknown[]) {
      super("claude");
      mocks.claudeArgs.push(args);
    }
  },
}));
vi.mock("../../agents/codexAgent.js", () => ({
  CodexAgent: class extends mocks.FakeAgent {
    constructor() {
      super("codex");
    }
  },
}));
vi.mock("../../util/projectStatus.js", () => ({
  getProjectStatus: () => ({
    decisionsCount: 0,
    decisionsText: "",
    lastSession: null,
    claudeDefaultModel: null,
    codexDefaultModel: null,
    codexDefaultEffort: null,
    autonomyBudget: null,
  }),
}));

import { inspectProjectSettings, SETTINGS_CHANGED_MESSAGE } from "../../agents/projectSettings.js";
import { Root } from "../Root.js";

function fakeTerminal() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    read: () => null,
    ref: () => stdin,
    unref: () => stdin,
  });
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: () => true });
  const stderr = Object.assign(new EventEmitter(), { write: () => true });
  return { stdin, stdout, stderr };
}

describe("Root settings guard", () => {
  it("gives ClaudeAgent a settings guard as third constructor argument", async () => {
    const terminal = fakeTerminal();
    const app = render(<Root cwd="/projet-test" />, {
      stdout: terminal.stdout as never,
      stdin: terminal.stdin as never,
      stderr: terminal.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });
    await vi.waitFor(() => expect(mocks.claudeArgs).toHaveLength(1));
    expect(typeof mocks.claudeArgs[0]?.[2]).toBe("function");
    app.unmount();
  });
});

describe("Root settings guard wiring", () => {
  it("builds the guard from approvedSettings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudex-root-guard-"));
    try {
      await mkdir(join(dir, ".claude"));
      await writeFile(join(dir, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "touch /tmp/marker" }));
      const guardFor = async (approvedSettings?: Awaited<ReturnType<typeof inspectProjectSettings>>) => {
        mocks.claudeArgs.length = 0;
        const terminal = fakeTerminal();
        const app = render(<Root cwd={dir} approvedSettings={approvedSettings} />, {
          stdout: terminal.stdout as never,
          stdin: terminal.stdin as never,
          stderr: terminal.stderr as never,
          exitOnCtrlC: false,
          patchConsole: false,
          interactive: true,
        });
        await vi.waitFor(() => expect(mocks.claudeArgs).toHaveLength(1));
        app.unmount();
        return mocks.claudeArgs[0]?.[2] as (cwd: string) => Promise<string | null>;
      };

      const unapproved = await guardFor(undefined);
      expect(await unapproved(dir)).toBe(SETTINGS_CHANGED_MESSAGE);
      const approved = await guardFor(await inspectProjectSettings(dir));
      expect(await approved(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
