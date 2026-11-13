#!/usr/bin/env node
import { render } from "ink";
import type { SettingsFinding } from "./agents/projectSettings.js";
import { prepareLaunch, SETTINGS_REFUSED_MESSAGE } from "./launch.js";
import { hasInteractiveTerminal, RENDER_OPTIONS } from "./renderOptions.js";
import { CONSENT_RENDER_OPTIONS, formatConsentText, SettingsConsent } from "./ui/components/SettingsConsent.js";
import { createMouseFilteredStdin } from "./ui/mouse/mouseInput.js";
import { MouseProvider } from "./ui/mouse/MouseContext.js";
import { Root } from "./ui/Root.js";
import { installExitGuards, setMouseReporting } from "./ui/terminal.js";

// The list is printed as plain text so it stays in scrollback however long it
// is; Ink then draws only a short prompt in the normal screen. That instance is
// fully unmounted before Root takes the alternate screen.
async function askInInk(findings: SettingsFinding[]): Promise<boolean> {
  process.stdout.write(`${formatConsentText(findings)}\n`);
  let accepted = false;
  const app = render(
    <SettingsConsent
      findings={findings}
      onDecide={(accept) => {
        accepted = accept;
        app.unmount();
      }}
    />,
    CONSENT_RENDER_OPTIONS,
  );
  await app.waitUntilExit();
  return accepted;
}

async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  const cwd = process.cwd();

  if (!hasInteractiveTerminal(process.stdin, process.stdout)) {
    console.error(
      "Claudex needs a real interactive terminal (TTY): run it directly in your terminal, not through a pipe, a non-interactive script or `| cat`.",
    );
    process.exit(1);
  }

  const decision = await prepareLaunch(cwd, askInInk);
  if (decision.kind === "refused") {
    console.log(SETTINGS_REFUSED_MESSAGE);
    return;
  }
  if (decision.created.length) {
    console.log(`Project memory initialised: ${decision.created.join(", ")}`);
  }

  const mouse = createMouseFilteredStdin(process.stdin);
  const removeExitGuards = installExitGuards(process.stdout);
  const app = render(
    <MouseProvider source={mouse}>
      <Root cwd={cwd} initialTopic={topic || undefined} approvedSettings={decision.approved} />
    </MouseProvider>,
    { ...RENDER_OPTIONS, stdin: mouse.stdin },
  );
  try {
    await app.waitUntilExit();
  } finally {
    // DebateView turns reporting off when it unmounts; this covers an exit
    // that skipped the unmount.
    setMouseReporting(process.stdout, false);
    removeExitGuards();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
