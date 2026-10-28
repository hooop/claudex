#!/usr/bin/env node
import { render } from "ink";
import { initMemoryScaffold } from "./memory/store.js";
import { hasInteractiveTerminal, RENDER_OPTIONS } from "./renderOptions.js";
import { Root } from "./ui/Root.js";

async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  const cwd = process.cwd();

  if (!hasInteractiveTerminal(process.stdin, process.stdout)) {
    console.error(
      "Claudex a besoin d'un vrai terminal interactif (TTY) : lance-le directement dans ton terminal, pas via un pipe, un script non interactif ou un `| cat`.",
    );
    process.exit(1);
  }

  const { created } = await initMemoryScaffold(cwd);
  if (created.length) {
    console.log(`Mémoire de projet initialisée : ${created.join(", ")}`);
  }

  // Mode 1007 asks compatible terminals to translate the wheel into arrow keys
  // in the alternate screen.
  const app = render(<Root cwd={cwd} initialTopic={topic || undefined} />, RENDER_OPTIONS);
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
