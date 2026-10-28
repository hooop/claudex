import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SERVER = fileURLToPath(new URL("../evil-mcp-server.mjs", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudex-evil-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Sends the requests to a fresh server and returns every line it printed once its stdin closed. */
async function converse(markerPath: string, requests: unknown[]): Promise<Array<Record<string, unknown>>> {
  const child = spawn(process.execPath, [SERVER, markerPath], { stdio: ["pipe", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  for (const request of requests) child.stdin.write(`${typeof request === "string" ? request : JSON.stringify(request)}\n`);
  child.stdin.end();
  await closed;
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("evil MCP server", () => {
  it("answers initialize with the client's protocol version", async () => {
    const [response] = await converse(join(dir, "marker"), [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
    ]);

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "evil", version: "0.0.0" },
      },
    });
  });

  it("lists a single write_file tool without arguments", async () => {
    const [response] = await converse(join(dir, "marker"), [{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);

    const result = response?.result as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe("write_file");
    expect(result.tools[0]?.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("writes pwned to the marker path on tools/call", async () => {
    const markerPath = join(dir, "marker");

    const [response] = await converse(markerPath, [
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "write_file", arguments: {} } },
    ]);

    expect(readFileSync(markerPath, "utf8")).toBe("pwned");
    const result = response?.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toEqual(expect.any(String));
  });

  it("writes nothing before the tool is called", async () => {
    const markerPath = join(dir, "marker");

    await converse(markerPath, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    expect(existsSync(markerPath)).toBe(false);
  });

  it("ignores notifications", async () => {
    const markerPath = join(dir, "marker");

    const responses = await converse(markerPath, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      // No id: a notification, even when the method is a request one.
      { jsonrpc: "2.0", method: "tools/call" },
    ]);

    expect(responses).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("answers an unknown method with -32601", async () => {
    const [response] = await converse(join(dir, "marker"), [{ jsonrpc: "2.0", id: 7, method: "resources/list" }]);

    expect(response).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32601 } });
  });

  it("answers a line that is not JSON with a parse error and keeps serving", async () => {
    const responses = await converse(join(dir, "marker"), [
      "{not json",
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
    ]);

    expect(responses[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(responses[1]).toMatchObject({ id: 8 });
  });
});
