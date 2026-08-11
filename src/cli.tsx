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

  // exitOnCtrlC: false — Root handles Ctrl+C itself so it can save the
  // transcript to disk before exiting, instead of Ink just killing the
  // process outright.
  render(<Root cwd={cwd} initialTopic={topic || undefined} />, { exitOnCtrlC: false });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
