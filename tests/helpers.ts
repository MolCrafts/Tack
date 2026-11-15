import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contentText, type FakeModel } from "./fake-model.js";

export const REPO_ROOT = resolve(import.meta.dirname, "..");
export const BIN = join(REPO_ROOT, "packages", "tack", "lib", "bin.js");

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "tack-test-home-"));
}

/** Environment for a spawned Tack: isolated home, no credentials, telemetry off. */
export function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TACK_HOME: home, DSH_TELEMETRY_DISABLED: "1", ...extra };
  delete env.DEEPSEEK_API_KEY;
  delete env.DSH_HOME;
  return env;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  home: string;
  input?: string;
  /** Working directory (default: this process's). */
  cwd?: string;
  /** Extra environment on top of {@link testEnv}. */
  env?: NodeJS.ProcessEnv;
  /** The `tack` entry to run (default: the repository's built bin). */
  bin?: string;
}

export function spawnTack(args: readonly string[], options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [options.bin ?? BIN, ...args], {
      env: testEnv(options.home, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd !== undefined && { cwd: options.cwd }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

export interface DumpRow {
  id: string;
  name?: string;
  disabled?: string;
  lines: string[];
}

/** Top-level rows of a `tack doctor --dump-config` document (id, module name, disabled expression). */
export function parseDumpRows(text: string): DumpRow[] {
  const rows: DumpRow[] = [];
  let current: DumpRow | undefined;
  for (const line of text.split("\n")) {
    const id = /^- id: (.+)$/.exec(line);
    if (id) {
      current = { id: id[1]!.replace(/^['"]|['"]$/g, ""), lines: [] };
      rows.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (!line.startsWith("  ")) {
      if (line.trim() !== "" && !line.startsWith("#")) current = undefined;
      continue;
    }
    current.lines.push(line);
    const name = /^ {2}name: (.+)$/.exec(line);
    if (name) current.name = name[1]!.replace(/^['"]|['"]$/g, "");
    const disabled = /^ {2}disabled: (.+)$/.exec(line);
    if (disabled) current.disabled = disabled[1]!;
  }
  return rows;
}

/** Enabled agent presets in a dumped composition, by their preset id. */
export function agentPresets(rows: readonly DumpRow[]): Map<string, DumpRow> {
  const found = new Map<string, DumpRow>();
  for (const row of rows) {
    if (row.name !== "@deepseek-ai/dsh-agent-preset" || row.disabled !== undefined) continue;
    const id = row.lines.map((line) => /^ {4}id: (.+)$/.exec(line)?.[1]).find((value) => value !== undefined);
    if (id !== undefined) found.set(id, row);
  }
  return found;
}

/** The items of each list under `key` in a row's dumped lines, one array per occurrence. */
export function listsUnder(row: DumpRow, key: string): string[][] {
  const found: string[][] = [];
  row.lines.forEach((head, start) => {
    if (head.trim() !== `${key}:`) return;
    const indent = head.search(/\S/);
    const items: string[] = [];
    for (const line of row.lines.slice(start + 1)) {
      const item = /^(\s*)- (.+)$/.exec(line);
      if (item === null || item[1]!.length < indent) break;
      items.push(item[2]!.replace(/^['"]|['"]$/g, ""));
    }
    found.push(items);
  });
  return found;
}

/** A row's dumped configuration as one string with every run of whitespace a single space. */
export function textOf(row: DumpRow): string {
  return row.lines.join(" ").replace(/\s+/g, " ");
}

/** A `tack web` host and an authenticated caller of its client API. */
export interface WebHost {
  call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/** Start `tack web` for `profile` in `cwd`, the only host that composes a preset, and log in. */
export async function startWeb(home: string, profile: string, cwd: string, env: NodeJS.ProcessEnv): Promise<WebHost> {
  const child = spawn(process.execPath, [BIN, "web", "--profile", profile, "--port", "0", "--no-open"], { cwd, env: testEnv(home, env) });
  const entry = await new Promise<string>((resolvePromise, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const url = /(http:\/\/\S+\?token=\S+)/.exec(out)?.[1];
      if (url !== undefined) resolvePromise(url);
    });
    child.on("close", (code) => reject(new Error(`tack web exited (${code}) before serving: ${out}`)));
  });
  const login = await fetch(entry, { redirect: "manual" });
  const cookie = login.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
  const origin = new URL(entry).origin;
  return {
    async call(method, args) {
      const response = await fetch(`${origin}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args } }),
      });
      const body = (await response.json()) as { result?: { ok: boolean; value?: Record<string, unknown> } };
      if (body.result?.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(body)}`);
      return body.result.value!;
    },
    close: () => child.kill(),
  };
}

/** The system prompt of the first model request a new session in `preset` makes on `host`. */
export async function instructionsOf(host: WebHost, model: FakeModel, workdir: string, preset: string): Promise<string> {
  const { workspace } = (await host.call("workspace/create", { request: { path: workdir } })) as { workspace: { workspaceId: string } };
  const { sessionId } = (await host.call("session/create", { request: { workspaceId: workspace.workspaceId, agentPreset: preset } })) as { sessionId: string };
  model.script([{ text: "ok" }]);
  const before = model.agentRequests().length;
  await host.call("session/prompt", { request: { requestId: randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text: "begin" }] } });
  const deadline = Date.now() + 60_000;
  while (model.agentRequests().length === before) {
    if (Date.now() >= deadline) throw new Error(`${preset} made no model request`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const request = model.agentRequests()[before]!;
  return request.messages.filter((message) => message.role === "system").map((message) => contentText(message.content)).join("\n");
}
