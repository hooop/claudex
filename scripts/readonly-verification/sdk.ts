// Loads the Claude Agent SDK from a chosen directory, so that the same command
// can measure the installed version and any other one installed elsewhere.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { QueryFn } from "./observe.js";

const SDK_NAME = "@anthropic-ai/claude-agent-sdk";

/** The SDK cannot be found or does not look like the SDK. */
export class SdkLoadError extends Error {}

export interface LoadedSdk {
  query: QueryFn;
  /** File the package name resolved to. */
  entry: string;
  version: string;
  /** Absent from the package.json of older SDK versions. */
  claudeCodeVersion: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The version lives in the package's own package.json. It is looked up from
// the resolved entry rather than assumed to sit next to it, in case a version
// moves its entry into a subfolder.
function readPackage(entry: string): { version: string; claudeCodeVersion: string | null } {
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (isRecord(pkg) && pkg.name === SDK_NAME && typeof pkg.version === "string") {
        return {
          version: pkg.version,
          claudeCodeVersion: typeof pkg.claudeCodeVersion === "string" ? pkg.claudeCodeVersion : null,
        };
      }
    }
    if (dirname(dir) === dir) throw new SdkLoadError(`no package.json of ${SDK_NAME} found above ${entry}`);
  }
}

export async function loadSdk(sdkDir: string): Promise<LoadedSdk> {
  if (!existsSync(sdkDir)) throw new SdkLoadError(`--sdk-dir ${sdkDir} does not exist`);

  let entry: string;
  try {
    // Resolved as if from a file inside sdkDir, with Node's usual lookup of node_modules.
    entry = createRequire(join(sdkDir, "package.json")).resolve(SDK_NAME);
  } catch (error) {
    // Node appends a multi-line "Require stack" that only repeats the directory.
    const reason = describeError(error).split("\n")[0];
    throw new SdkLoadError(`cannot resolve ${SDK_NAME} from --sdk-dir ${sdkDir}: ${reason}`);
  }

  const sdk: unknown = await import(pathToFileURL(entry).href);
  if (!isRecord(sdk) || typeof sdk.query !== "function") {
    throw new SdkLoadError(`${entry} (from --sdk-dir ${sdkDir}) does not export a query function`);
  }
  return { query: sdk.query as QueryFn, entry, ...readPackage(entry) };
}
