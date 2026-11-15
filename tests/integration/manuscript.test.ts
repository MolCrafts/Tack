/**
 * @tack/manuscript, installed with `tack plugin add` into the research profile
 * beside @tack/reproduce, composes cleanly: the Manuscript orchestrator starts
 * Literature, Figure and Author through its subagent tool and the Critic and
 * Reviewer through its review tool, each a preset declared in the
 * composition (an undeclared id fails the Agent's mount), no role can start
 * subagents of its own, and the two methods' presets coexist in one profile.
 * Each role but the Reviewer carries the project's reviewed Notes from molab;
 * the Reviewer, a blind referee, reads only the PDF and the venue's
 * guidelines, so it gets none. The orchestrator still mounts when the
 * reviewers are routed to a named model.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_KEY, FAKE_KEY_ENV, FAKE_MODEL, FAKE_PROVIDER, type FakeModel, fakeProviderCommands, startFakeModel } from "../fake-model.js";
import { type FakeMolab, startFakeMolab } from "../fake-molab.js";
import { agentPresets, instructionsOf, listsUnder, parseDumpRows, REPO_ROOT, spawnTack, startWeb, tempHome, textOf, type DumpRow, type WebHost } from "../helpers.js";

const PROFILE = "research";
const ROLES = ["manuscript-literature", "manuscript-figure", "manuscript-author", "manuscript-critic", "manuscript-reviewer"];

let home: string;
let rows: DumpRow[];
let dumpStderr: string;

beforeAll(async () => {
  home = tempHome();
  for (const plugin of ["reproduce", "manuscript"]) {
    const added = await spawnTack(["plugin", "add", join(REPO_ROOT, "packages", plugin), "--profile", PROFILE], { home });
    expect(added.code, added.stderr).toBe(0);
  }
  const result = await spawnTack(["doctor", "--dump-config", "--profile", PROFILE], { home });
  expect(result.code, result.stderr).toBe(0);
  rows = parseDumpRows(result.stdout);
  dumpStderr = result.stderr;
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("manuscript plugin", () => {
  it("composes into the research profile beside reproduce without warnings", () => {
    expect(dumpStderr.trim()).toBe("");
    const declared = agentPresets(rows);
    for (const id of ["reproduce", "manuscript", ...ROLES]) expect(declared.has(id), id).toBe(true);
  });

  it("lets the orchestrator start exactly the five roles, the reviewers through their own tool", () => {
    const orchestrator = agentPresets(rows).get("manuscript")!;
    expect(listsUnder(orchestrator, "allowedAgentPresets")).toEqual([
      ["manuscript-literature", "manuscript-figure", "manuscript-author"],
      ["manuscript-critic", "manuscript-reviewer"],
    ]);
    expect(textOf(orchestrator)).toContain("toolName: review");
  });

  it("gives no role a subagent tool of its own", () => {
    const declared = agentPresets(rows);
    for (const role of ROLES) expect(declared.get(role)!.lines.join("\n"), role).not.toContain("dsh-tool-subagent");
  });
});

describe("reviewed lessons", () => {
  const REVIEWED = "State every transport coefficient with its block-averaged error bar";
  const LESSON = "Quote the error bar from block averaging, never from a single run.";
  const PROPOSED = "Prefer the Green-Kubo route to NEMD everywhere";
  let model: FakeModel;
  let molab: FakeMolab;
  let web: WebHost;
  /** A second host whose reviewers are routed to a named model. */
  let routed: WebHost;
  let workdir: string;

  const seedNote = (name: string, body: string, status: string) =>
    fetch(`${molab.url}/api/knowledge/doc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cls: "Note", name, body, sources: [], cites: [], fields: { status }, createdBy: "reviewer" }),
    });

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), "tack-manuscript-work-"));
    model = await startFakeModel();
    for (const args of fakeProviderCommands(model)) expect((await spawnTack(args, { home })).code).toBe(0);
    expect((await spawnTack(["auth", "set", FAKE_KEY_ENV], { home, input: FAKE_KEY })).code).toBe(0);
    molab = await startFakeMolab();
    expect((await seedNote(REVIEWED, LESSON, "active")).ok).toBe(true);
    expect((await seedNote(PROPOSED, "Green-Kubo converges faster for this system.", "proposed")).ok).toBe(true);
    web = await startWeb(home, PROFILE, workdir, { MOLAB_URL: molab.url });
    routed = await startWeb(home, PROFILE, workdir, { MOLAB_URL: molab.url, TACK_REVIEW_PROVIDER: FAKE_PROVIDER, TACK_REVIEW_MODEL: FAKE_MODEL });
  });

  afterAll(async () => {
    web.close();
    routed.close();
    await model.close();
    await molab.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  const instructionsFor = (preset: string, host: WebHost = web) => instructionsOf(host, model, workdir, preset);

  it("puts the reviewed Notes into every role's instructions but the blind Reviewer's, and no proposed one", async () => {
    for (const preset of ["manuscript", ...ROLES]) {
      const instructions = await instructionsFor(preset);
      if (preset === "manuscript-reviewer") {
        expect(instructions, preset).not.toContain(REVIEWED);
        expect(instructions, preset).not.toContain(LESSON);
      } else {
        expect(instructions, preset).toContain(REVIEWED);
        expect(instructions, preset).toContain(LESSON);
      }
      expect(instructions, preset).not.toContain(PROPOSED);
    }
  });

  it("mounts the orchestrator when the reviewers are routed to a named model", async () => {
    expect(await instructionsFor("manuscript", routed)).toContain("Reviewer with the review tool");
  });
});
