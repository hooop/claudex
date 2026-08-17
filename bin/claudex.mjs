#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "..", "src", "cli.tsx");
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));

// tsx cherche le tsconfig depuis le cwd, or le cwd est le projet de
// l'utilisateur, pas celui-ci. Sans ce flag, un dossier sans tsconfig fait
// retomber esbuild sur le JSX classique (`React.createElement`) et cli.tsx
// meurt sur `React is not defined` ; un dossier avec un tsconfig étranger
// imposerait ses propres réglages. On épingle le nôtre.
const tsconfig = path.join(here, "..", "tsconfig.json");

const result = spawnSync(
  process.execPath,
  [tsxCli, "--tsconfig", tsconfig, cliEntry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
