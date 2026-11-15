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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_KEY, FAKE_KEY_ENV, FAKE_MODEL, FAKE_PROVIDER, type FakeModel, fakeProviderCommands, startFakeModel } from "../fake-model.js";
import { type FakeMolab, startFakeMolab } from "../fake-molab.js";
import { agentPresets, instructionsOf, listsUnder, parseDumpRows, REPO_ROOT, spawnTack, startWeb, tempHome, textOf, type DumpRow, type WebHost } from "../helpers.js";

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
const presets = () => agentPresets(rows);

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
    web = await startWeb(home, PROFILE, workdir, { MOLAB_URL: molab.url });
    reviewed = await startWeb(home, PROFILE, workdir, { MOLAB_URL: molab.url, TACK_REVIEW_PROVIDER: FAKE_PROVIDER, TACK_REVIEW_MODEL: FAKE_MODEL });
  });

  afterAll(async () => {
    web.close();
    reviewed.close();
    await model.close();
    await molab.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  const instructionsFor = (preset: string, host: WebHost = web) => instructionsOf(host, model, workdir, preset);

  it("puts the reviewed Notes into every role's instructions, and no proposed one", async () => {
    for (const preset of ["reproduce", ...ROLES]) {
      const instructions = await instructionsFor(preset);
      expect(instructions, preset).toContain(REVIEWED);
      expect(instructions, preset).toContain("Shift the Born-Mayer repulsion so ion pairs cannot collapse.");
      expect(instructions, preset).not.toContain(PROPOSED);
      expect(instructions, preset).not.toContain("Derive the cut-off from the actual number of blocks.");
    }
  });

  it("mounts the orchestrator when the reviewers are routed to a named model", async () => {
    expect(await instructionsFor("reproduce", reviewed)).toContain("the reviewers with the review tool");
  });
});
