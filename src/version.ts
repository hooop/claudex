import { readFileSync } from "node:fs";

// Read once from the package manifest next to `src/`, so the header never
// drifts from the published version.
export const CLAUDEX_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
