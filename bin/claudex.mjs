#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "..", "src", "cli.tsx");
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));

// tsx looks for the tsconfig from the cwd, but the cwd is the user's project,
// not this one. Without this flag, a folder without a tsconfig makes esbuild
// fall back to classic JSX (`React.createElement`) and cli.tsx dies on
// `React is not defined`; a folder with a foreign tsconfig would impose its
// own settings. We pin ours.
const tsconfig = path.join(here, "..", "tsconfig.json");

const result = spawnSync(
  process.execPath,
  [tsxCli, "--tsconfig", tsconfig, cliEntry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
