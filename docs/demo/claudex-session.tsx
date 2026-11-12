import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { render } from "ink";
import { useCallback, useState } from "react";
import { DebateSession } from "../../src/orchestrator/session.js";
import type { AgentResult } from "../../src/orchestrator/types.js";
import type { AgentSendOptions, CodingAgent } from "../../src/agents/types.js";
import type { AgentId } from "../../src/types.js";
import { DebateView } from "../../src/ui/DebateView.js";
import { initMemoryScaffold } from "../../src/memory/store.js";
import { RENDER_OPTIONS } from "../../src/renderOptions.js";
import { WelcomeScreen } from "../../src/ui/components/WelcomeScreen.js";
import { DEFAULT_HEADER_ANIMATION, type HeaderAnimationId } from "../../src/ui/headerArt.js";
import type { ProjectStatus } from "../../src/util/projectStatus.js";

const TOPIC = "How do we rework auth without logging out signed-in users?";

class DemoAgent implements CodingAgent {
  readonly label: string;
  private turn = 0;

  constructor(readonly id: AgentId) {
    this.label = id === "claude" ? "Claude" : "Codex";
  }

  currentModel(): string {
    return this.id === "claude" ? "Opus 5" : "gpt-5.6-sol";
  }

  hasExplicitModel(): boolean {
    return true;
  }

  setModel(): void {
    // Demo agents have fixed model labels.
  }

  resetSession(): void {
    this.turn = 0;
  }

  async send(_message: string, options: AgentSendOptions): Promise<AgentResult> {
    const response = this.responseFor();
    this.turn++;

    options.onActivity?.({ kind: "waiting", status: "running" });
    await delay(400, options.signal);

    if (this.id === "codex" && this.turn === 1) {
      options.onActivity?.({
        kind: "command",
        status: "running",
        label: "node --test auth-migration.test.mjs",
        activeCount: 1,
      });
      await delay(900, options.signal);
      options.onActivity?.({
        kind: "command",
        status: "failure",
        label: "node --test auth-migration.test.mjs",
        durationMs: 740,
        exitCode: 1,
      });
      await delay(260, options.signal);
    }

    for (const chunk of chunks(response, 18)) {
      if (options.signal?.aborted) return { kind: "cancelled", partialText: response };
      options.onTextDelta?.(chunk);
      await delay(46, options.signal);
    }

    options.onContextUsage?.({
      usedTokens: 21_400 + this.turn * 380,
      contextWindow: 200_000,
    });

    // Let Ink paint the final chunks before keeping the completed answer still.
    if (this.id === "codex" && this.turn === 1) {
      await delay(250, options.signal);
      freeze(3_000);
    }

    return { kind: "success", text: response };
  }

  async stop(): Promise<void> {
    // No remote process to stop in the demo.
  }

  private responseFor(): string {
    if (this.id === "claude" && this.turn === 0) {
      return [
        "Topic accepted. I would frame the migration as a gradual switchover, not a rewrite.",
        "",
        "- keep the old cookie valid for a short window;",
        "- issue the new format from the next sign-in;",
        "- accept both formats on the server during the transition;",
        "- measure the sessions still on the old format before removing the fallback.",
        "",
        "Point for Codex to check: the fallback must never reactivate a revoked session.",
        "",
        "<<CONTINUE>>",
      ].join("\n");
    }

    if (this.id === "codex" && this.turn === 0) {
      return [
        "I am checking the most dangerous regression risk.",
        "",
        "$ node --test auth-migration.test.mjs",
        "[ok] new tokens replace old ones",
        "[x] a revoked session comes back if the fallback reads the old cookie",
        "",
        "I recommend centralizing revocation before any legacy-format read.",
        "",
        "<<CONTINUE>>",
      ].join("\n");
    }

    if (this.id === "claude") {
      return [
        "I agree. The spec must require a verified revocation check before choosing the legacy or modern reader.",
        "",
        "The acceptance test becomes simple: an explicitly revoked session stays dead in both formats.",
        "",
        "<<CONSENSUS>>",
      ].join("\n");
    }

    return [
      "Consensus confirmed.",
      "",
      "The key criterion is observable: a revoked session must never be restored by the legacy fallback.",
      "",
      "<<CONSENSUS>>",
    ].join("\n");
  }
}

const cwd = mkdtempSync(path.join(os.tmpdir(), "claudex-demo-"));
await initMemoryScaffold(cwd);

const agents: Record<AgentId, CodingAgent> = {
  claude: new DemoAgent("claude"),
  codex: new DemoAgent("codex"),
};
const session = new DebateSession(agents, {
  cwd,
  starter: "claude",
  autonomyBudget: { kind: "automatic-starts", maximum: 1 },
});

const status: ProjectStatus = {
  decisionsCount: 5,
  decisionsText: null,
  lastSession: "2026-09-28T08:12:00.000Z",
  autonomyBudget: null,
  claudeConfiguredModel: "Opus 5",
  claudeDefaultModel: "Opus 5",
  codexDefaultModel: "gpt-5.6-sol",
  codexDefaultEffort: "medium",
};

function DemoApp() {
  const [activeSession, setActiveSession] = useState<DebateSession | null>(null);
  const [topic, setTopic] = useState(TOPIC);
  const [headerAnimation, setHeaderAnimation] = useState<HeaderAnimationId>(DEFAULT_HEADER_ANIMATION);
  const start = useCallback((nextTopic: string) => {
    setTopic(nextTopic);
    setActiveSession(session);
  }, []);

  if (!activeSession) {
    return (
      <WelcomeScreen
        agents={agents}
        status={status}
        headerAnimation={headerAnimation}
        onHeaderAnimationChange={setHeaderAnimation}
        onStart={start}
      />
    );
  }

  return (
    <DebateView
      session={activeSession}
      topic={topic}
      cwd={cwd}
      status={status}
      headerAnimation={headerAnimation}
      coordinatorState={{ kind: "idle" }}
      coordinatorNotice={null}
      onLifecycleRequest={() => Promise.resolve({ ok: true, message: "Demo finished." })}
      onAutonomySelected={() => Promise.resolve()}
    />
  );
}

const app = render(<DemoApp />, RENDER_OPTIONS);

setTimeout(() => {
  app.unmount();
  rmSync(cwd, { recursive: true, force: true });
  process.exit(0);
}, 20_000);

function chunks(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    parts.push(text.slice(index, index + size));
  }
  return parts;
}

function freeze(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
