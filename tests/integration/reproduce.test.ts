/**
 * @tack/reproduce, installed with `tack plugin add` into the research profile,
 * composes cleanly: the Reproduce orchestrator starts Intake through its
 * subagent tool and the Critic and Judge through its review tool, each a
 * preset declared in the composition (an undeclared id fails the Agent's
 * mount), and no role can start subagents of its own. The review tool runs
 * the reviewers on TACK_REVIEW_PROVIDER / TACK_REVIEW_MODEL when both are
 * set. A preset is composed only by the web host, so the lessons check
 * starts `tack web` and opens one session per preset against a scripted model:
 * the system prompt each role gets carries the project's reviewed Notes from
 * molab (status active) and none of the proposed ones.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText, FAKE_KEY, FAKE_KEY_ENV, FAKE_MODEL, FAKE_PROVIDER, type FakeModel, fakeProviderCommands, startFakeModel } from "../fake-model.js";
import { type FakeMolab, startFakeMolab } from "../fake-molab.js";
import { BIN, parseDumpRows, REPO_ROOT, spawnTack, tempHome, testEnv, type DumpRow } from "../helpers.js";

const PROFILE = "research";
const ROLES = ["reproduce-intake", "reproduce-critic", "reproduce-judge"];

let home: string;
let rows: DumpRow[];
let dumpStderr: string;

beforeAll(async () => {
  home = tempHome();
  const added = await spawnTack(["plugin", "add", join(REPO_ROOT, "packages", "reproduce"), "--profile", PROFILE], { home });
  expect(added.code, added.stderr).toBe(0);
  const result = await spawnTack(["doctor", "--dump-config", "--profile", PROFILE], { home });
  expect(result.code, result.stderr).toBe(0);
  rows = parseDumpRows(result.stdout);
  dumpStderr = result.stderr;
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Agent presets in the composition, by their preset id. */
function presets(): Map<string, DumpRow> {
  const found = new Map<string, DumpRow>();
  for (const row of rows) {
    if (row.name !== "@deepseek-ai/dsh-agent-preset" || row.disabled !== undefined) continue;
    const id = row.lines.map((line) => /^ {4}id: (.+)$/.exec(line)?.[1]).find((value) => value !== undefined);
    if (id !== undefined) found.set(id, row);
  }
  return found;
}

/** The items of each list under `key` in a row's dumped lines, one array per occurrence. */
function listsUnder(row: DumpRow, key: string): string[][] {
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

/** A preset's dumped configuration as one string with every run of whitespace a single space. */
function textOf(row: DumpRow): string {
  return row.lines.join(" ").replace(/\s+/g, " ");
}

describe("reproduce plugin", () => {
  it("composes into the research profile without warnings", () => {
    expect(dumpStderr.trim()).toBe("");
  });

  it("lets the orchestrator start exactly the three roles, each a declared preset, the reviewers through their own tool", () => {
    const declared = presets();
    const orchestrator = declared.get("reproduce");
    expect(orchestrator, "reproduce preset is missing").toBeDefined();
    expect(listsUnder(orchestrator!, "allowedAgentPresets")).toEqual([["reproduce-intake"], ["reproduce-critic", "reproduce-judge"]]);
    expect(textOf(orchestrator!)).toContain("toolName: review");
    for (const role of ROLES) expect(declared.has(role), role).toBe(true);
  });

  it("gives no role a subagent tool of its own", () => {
    const declared = presets();
    for (const role of ROLES) expect(declared.get(role)!.lines.join("\n"), role).not.toContain("dsh-tool-subagent");
  });
});

/** A `tack web` host and an authenticated caller of its client API. */
interface WebHost {
  call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

async function startWeb(cwd: string, env: NodeJS.ProcessEnv): Promise<WebHost> {
  const child: ChildProcess = spawn(process.execPath, [BIN, "web", "--profile", PROFILE, "--port", "0", "--no-open"], { cwd, env: testEnv(home, env) });
  const entry = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const url = /(http:\/\/\S+\?token=\S+)/.exec(out)?.[1];
      if (url !== undefined) resolve(url);
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

describe("reviewed lessons", () => {
  const REVIEWED = "Bound the short-range potential before a long hot steady state";
  const PROPOSED = "Count blocks before choosing a stationarity cut-off";
  let model: FakeModel;
  let molab: FakeMolab;
  let web: WebHost;
  /** A second host whose reviewers are routed to a named model. */
  let reviewed: WebHost;
  let workdir: string;

  const seedNote = (name: string, body: string, status: string) =>
    fetch(`${molab.url}/api/knowledge/doc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cls: "Note", name, body, sources: [], cites: [], fields: { status }, createdBy: "judge" }),
    });

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), "tack-reproduce-work-"));
    model = await startFakeModel();
    for (const args of fakeProviderCommands(model)) expect((await spawnTack(args, { home })).code).toBe(0);
    expect((await spawnTack(["auth", "set", FAKE_KEY_ENV], { home, input: FAKE_KEY })).code).toBe(0);
    molab = await startFakeMolab();
    expect((await seedNote(REVIEWED, "Shift the Born-Mayer repulsion so ion pairs cannot collapse.", "active")).ok).toBe(true);
    expect((await seedNote(PROPOSED, "Derive the cut-off from the actual number of blocks.", "proposed")).ok).toBe(true);
    web = await startWeb(workdir, { MOLAB_URL: molab.url });
    reviewed = await startWeb(workdir, { MOLAB_URL: molab.url, TACK_REVIEW_PROVIDER: FAKE_PROVIDER, TACK_REVIEW_MODEL: FAKE_MODEL });
  });

  afterAll(async () => {
    web.close();
    reviewed.close();
    await model.close();
    await molab.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  /** The system prompt of the first model request a new session in `preset` makes on `host`. */
  async function instructionsOf(preset: string, host: WebHost = web): Promise<string> {
    const { workspace } = (await host.call("workspace/create", { request: { path: workdir } })) as { workspace: { workspaceId: string } };
    const { sessionId } = (await host.call("session/create", { request: { workspaceId: workspace.workspaceId, agentPreset: preset } })) as { sessionId: string };
    model.script([{ text: "ok" }]);
    const before = model.agentRequests().length;
    await host.call("session/prompt", { request: { requestId: randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text: "begin" }] } });
    const deadline = Date.now() + 60_000;
    while (model.agentRequests().length === before) {
      expect(Date.now() < deadline, `${preset} made no model request`).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const request = model.agentRequests()[before]!;
    return request.messages.filter((message) => message.role === "system").map((message) => contentText(message.content)).join("\n");
  }

  it("puts the reviewed Notes into every role's instructions, and no proposed one", async () => {
    for (const preset of ["reproduce", ...ROLES]) {
      const instructions = await instructionsOf(preset);
      expect(instructions, preset).toContain(REVIEWED);
      expect(instructions, preset).toContain("Shift the Born-Mayer repulsion so ion pairs cannot collapse.");
      expect(instructions, preset).not.toContain(PROPOSED);
      expect(instructions, preset).not.toContain("Derive the cut-off from the actual number of blocks.");
    }
  });

  it("mounts the orchestrator when the reviewers are routed to a named model", async () => {
    expect(await instructionsOf("reproduce", reviewed)).toContain("the reviewers with the review tool");
  });
});
