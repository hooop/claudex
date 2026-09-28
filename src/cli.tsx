#!/usr/bin/env node
import { render } from "ink";
import { initMemoryScaffold } from "./memory/store.js";
import { Root } from "./ui/Root.js";

async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  const cwd = process.cwd();

  if (!process.stdin.isTTY) {
    console.error(
      "Claudex a besoin d'un vrai terminal interactif (TTY) : lance-le directement dans ton terminal, pas via un pipe, un script non interactif ou un `| cat`.",
    );
    process.exit(1);
  }

  const { created } = await initMemoryScaffold(cwd);
  if (created.length) {
    console.log(`Mémoire de projet initialisée : ${created.join(", ")}`);
  }

  // The alternate screen gives Claudex a real viewport: header and footer stay
  // fixed while the app scrolls only the transcript. Mode 1007 asks compatible
  // terminals to translate the wheel into arrow keys in that screen.
  const app = render(<Root cwd={cwd} initialTopic={topic || undefined} />, {
    exitOnCtrlC: false,
    alternateScreen: true,
    incrementalRendering: true,
  });
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
