#!/usr/bin/env node
import { render } from "ink";
import type { SettingsFinding } from "./agents/projectSettings.js";
import { prepareLaunch, SETTINGS_REFUSED_MESSAGE } from "./launch.js";
import { hasInteractiveTerminal, RENDER_OPTIONS } from "./renderOptions.js";
import { SettingsConsent } from "./ui/components/SettingsConsent.js";
import { Root } from "./ui/Root.js";

// The consent screen gets its own Ink instance, fully unmounted before Root
// renders, so the two alternate-screen sessions never overlap.
async function askInInk(findings: SettingsFinding[]): Promise<boolean> {
  let accepted = false;
  const app = render(
    <SettingsConsent
      findings={findings}
      onDecide={(accept) => {
        accepted = accept;
        app.unmount();
      }}
    />,
    RENDER_OPTIONS,
  );
  await app.waitUntilExit();
  return accepted;
}

async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  const cwd = process.cwd();

  if (!hasInteractiveTerminal(process.stdin, process.stdout)) {
    console.error(
      "Claudex a besoin d'un vrai terminal interactif (TTY) : lance-le directement dans ton terminal, pas via un pipe, un script non interactif ou un `| cat`.",
    );
    process.exit(1);
  }

  const decision = await prepareLaunch(cwd, askInInk);
  if (decision.kind === "refused") {
    console.log(SETTINGS_REFUSED_MESSAGE);
    return;
  }
  if (decision.created.length) {
    console.log(`Mémoire de projet initialisée : ${decision.created.join(", ")}`);
  }

  // Mode 1007 asks compatible terminals to translate the wheel into arrow keys
  // in the alternate screen.
  const app = render(
    <Root cwd={cwd} initialTopic={topic || undefined} approvedSettings={decision.approved} />,
    RENDER_OPTIONS,
  );
  if (process.stdout.isTTY) process.stdout.write("\u001b[?1007h");
  try {
    await app.waitUntilExit();
  } finally {
    if (process.stdout.isTTY) process.stdout.write("\u001b[?1007l");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
