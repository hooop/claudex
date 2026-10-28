import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SdkLoadError, loadSdk } from "../sdk.js";

let dir: string;
beforeEach(() => {
  // Node resolves symlinks (/var is one on macOS), so compare against the real path.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "claudex-sdk-test-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Installs a fake SDK package in <dir>/node_modules, shaped like the given package.json. */
function installFakeSdk(packageJson: Record<string, unknown>, files: Record<string, string>): void {
  const root = join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  writeFile(join(root, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", ...packageJson }));
  for (const [name, content] of Object.entries(files)) writeFile(join(root, name), content);
}

const QUERY_MODULE = 'export function query() { return "fake query"; }\n';

describe("loadSdk", () => {
  it("loads an SDK that has no exports field (0.1.x layout) and reports no Claude Code version", async () => {
    installFakeSdk({ version: "0.1.77", main: "sdk.mjs", type: "module" }, { "sdk.mjs": QUERY_MODULE });

    const sdk = await loadSdk(dir);

    expect(sdk.version).toBe("0.1.77");
    expect(sdk.claudeCodeVersion).toBeNull();
    expect(sdk.entry).toBe(join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"));
    expect(sdk.query({ prompt: "p", options: {} })).toBe("fake query");
  });

  it("loads an SDK that only exports its default condition (0.3.x layout) and reports the Claude Code version", async () => {
    installFakeSdk(
      {
        version: "0.3.310",
        main: "sdk.mjs",
        type: "module",
        exports: { ".": { types: "./sdk.d.ts", default: "./sdk.mjs" } },
        claudeCodeVersion: "2.1.310",
      },
      { "sdk.mjs": QUERY_MODULE },
    );

    const sdk = await loadSdk(dir);

    expect(sdk.version).toBe("0.3.310");
    expect(sdk.claudeCodeVersion).toBe("2.1.310");
    expect(sdk.query({ prompt: "p", options: {} })).toBe("fake query");
  });

  it("finds the version when the entry sits in a subfolder of the package", async () => {
    installFakeSdk(
      { version: "1.0.0", type: "module", exports: { ".": { default: "./dist/index.mjs" } } },
      { "dist/index.mjs": QUERY_MODULE },
    );

    const sdk = await loadSdk(dir);

    expect(sdk.version).toBe("1.0.0");
  });

  it("names the directory when it does not exist", async () => {
    const missing = join(dir, "nowhere");

    await expect(loadSdk(missing)).rejects.toThrow(SdkLoadError);
    await expect(loadSdk(missing)).rejects.toThrow(missing);
  });

  it("names the directory when it does not contain the SDK", async () => {
    await expect(loadSdk(dir)).rejects.toThrow(SdkLoadError);
    await expect(loadSdk(dir)).rejects.toThrow(dir);
  });

  it("rejects an SDK that exports no query function", async () => {
    installFakeSdk({ version: "0.1.77", main: "sdk.mjs", type: "module" }, { "sdk.mjs": "export const other = 1;\n" });

    await expect(loadSdk(dir)).rejects.toThrow(/query/);
  });
});
