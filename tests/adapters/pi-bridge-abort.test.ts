import "../setup-home";
/**
 * Esc must stop a running ctx_execute. The script writes "started" at once and
 * "finished" 4 s later, so a child that survives the abort leaves the second file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_BUNDLE = fileURLToPath(new URL("../../server.bundle.mjs", import.meta.url));
const SLEEP_MS = 4_000;

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

let scratch: string;
let registrations: Map<string, RegisteredTool>;
let handle: { shutdown: () => void };

const pollUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-pi-abort-"));
  const { bootstrapMCPTools } = await import("../../src/adapters/pi/mcp-bridge.js");

  registrations = new Map();
  const fakePi = {
    registerTool: (tool: RegisteredTool) => registrations.set(tool.name, tool),
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
  };

  handle = await bootstrapMCPTools(fakePi, SERVER_BUNDLE, {
    _resolveJsRuntime: () => process.execPath,
  });
}, 30_000);

afterAll(() => {
  try {
    handle?.shutdown();
  } catch {
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
  }
});

describe("pi bridge abort — Esc stops the running child", () => {
  it("kills the spawned child and settles the call when the signal aborts", async () => {
    const started = join(scratch, "started");
    const finished = join(scratch, "finished");
    const tool = registrations.get("ctx_execute");
    if (!tool) throw new Error("ctx_execute was not registered by the bridge");

    const script = [
      `const fs = require("fs");`,
      `fs.writeFileSync(${JSON.stringify(started)}, "");`,
      `setTimeout(() => { fs.writeFileSync(${JSON.stringify(finished)}, ""); }, ${SLEEP_MS});`,
    ].join("\n");

    const ac = new AbortController();
    const settled: string[] = [];
    const call = tool
      .execute("call-abort", { language: "javascript", code: script }, ac.signal)
      .then(() => settled.push("resolved"))
      .catch((err: Error) => settled.push(`rejected: ${err.message}`));

    expect(await pollUntil(() => existsSync(started), 20_000)).toBe(true);

    ac.abort();

    await pollUntil(() => existsSync(finished), SLEEP_MS + 3_000);
    expect(existsSync(finished)).toBe(false);

    await call;
    expect(settled).toEqual(["rejected: MCP request aborted: tools/call"]);
  }, 30_000);
});
