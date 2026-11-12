/**
 * The research plugin's molab tools over an in-memory molab: the tool set,
 * the approval that guards starting compute, and knowledge writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { parseConfig } from "../../packages/research/src/config.js";
import { losslessValue, toDshTool } from "../../packages/research/src/dsh/adapter.js";
import { apply, researchTools } from "../../packages/research/src/index.js";
import { executionRef, parseRef, runRef } from "../../packages/research/src/molab/refs.js";
import { citations } from "../../packages/research/src/tools/records.js";
import { researchHarness, type ResearchHarness } from "../research-harness.js";

const DRY_RUN = (experiment: string) => ({
  body: {
    experiment: { id: experiment, name: "screen", path: "experiments/screen" },
    workflow: { name: "screen" },
    source: "code",
    waves: [["build"], ["md", "analyse"]],
    branches: [],
    runs: [{ params: { seq: "ABAB", seed: 1 } }, { params: { seq: "AABB", seed: 1 } }],
    tasks: [],
  },
});

const posts = (h: ResearchHarness) => h.molab.requests.filter((request) => request.startsWith("POST ") && request.endsWith("/executions"));

describe("tool set", () => {
  it("is the molab tools only, each compiling under DSH's tool schema rules", () => {
    const names = researchTools({ config: parseConfig({}) } as never).map((spec) => (toDshTool(spec, () => undefined) as { name: string }).name);
    expect(names).toEqual([
      "molab_context",
      "molab_dry_run",
      "molab_create_experiment",
      "molab_create_run",
      "molab_start_execution",
      "molab_cancel_execution",
      "molab_read_outputs",
      "molab_write_knowledge",
      "molab_delete_knowledge",
    ]);
  });

  it("registers every tool in one effect and disposes them all", () => {
    const registered: string[] = [];
    const disposed: string[] = [];
    let effect: (() => () => void) | undefined;
    apply({
      tools: { register: (tool) => { const name = (tool as { name: string }).name; registered.push(name); return () => disposed.push(name); } },
      get: () => undefined,
      effect: (execute) => { effect = execute; },
      provide: () => () => undefined,
    }, {});
    expect(registered).toEqual([]);
    const dispose = effect!();
    expect(registered).toHaveLength(9);
    dispose();
    expect([...disposed].sort()).toEqual([...registered].sort());
  });

  it("leaves no tool registered when a later registration is refused", () => {
    const live = new Set<string>();
    let effect: (() => () => void) | undefined;
    apply({
      tools: { register: (tool) => {
        const name = (tool as { name: string }).name;
        if (name === "molab_write_knowledge") throw new Error("registry refused");
        live.add(name);
        return () => live.delete(name);
      } },
      get: () => undefined,
      effect: (execute) => { effect = execute; },
      provide: () => () => undefined,
    }, {});
    expect(() => effect!()).toThrow("registry refused");
    expect([...live]).toEqual([]);
  });

  it("drops values that would not survive JSON before they reach DSH", () => {
    const value = losslessValue({ text: "ok", meta: { kept: { relPath: "a.md" }, gone: undefined } });
    expect(value).toEqual({ text: "ok", meta: { kept: { relPath: "a.md" } } });
  });

  it("validates config and refuses keys of the removed supervision system", () => {
    expect(parseConfig({}).molab.url).toBe("http://localhost:8000");
    expect(() => parseConfig({ molab: { url: "not a url" } })).toThrow(/invalid config/);
    for (const removed of [{ gates: { plan: false } }, { pollSeconds: 30 }, { workers: { confine: false } }]) {
      expect(() => parseConfig(removed)).toThrow(/invalid config/);
    }
  });

  it("parses molab refs and sorts citations into sources and documents", () => {
    expect(parseRef(executionRef("E1", "R1", "e02"))).toEqual({ experiment: "E1", run: "R1", execution: "e02" });
    expect(() => parseRef("projects/p1")).toThrow(/not a molab/);
    expect(citations([executionRef("E1", "R1", "e02"), "molab:asset/A7", "https://doi.org/10.1/x", "10.1021/abc", "experiments/screen/scratch/out.csv", "experiments/screen/knowledges/plan.md", " "])).toEqual({
      sources: [
        { kind: "run", ref: runRef("E1", "R1") },
        { kind: "asset", ref: "molab:asset/A7" },
        { kind: "reference", ref: "https://doi.org/10.1/x" },
        { kind: "reference", ref: "10.1021/abc" },
        { kind: "file", ref: "experiments/screen/scratch/out.csv" },
      ],
      documents: ["experiments/screen/knowledges/plan.md"],
    });
  });
});

describe("molab_start_execution asks the person first", () => {
  let h: ResearchHarness;
  let at: { project: string; experiment: string; run: string };

  beforeEach(async () => {
    h = await researchHarness();
    const seeded = h.molab.seedRun();
    at = { project: "P1", ...seeded };
    h.molab.dryRun(seeded.experiment, DRY_RUN(seeded.experiment));
  });
  afterEach(() => h.close());

  it("starts the attempt once the person approves, after showing the dry run", async () => {
    const value = await h.call("molab_start_execution", { ...at, target: "cluster" }, { approval: "allowed-once" });
    expect(h.asked).toHaveLength(1);
    const [asked] = h.asked;
    expect(asked!.toolName).toBe("molab_start_execution");
    expect(asked!.session).toBe("S1");
    expect(asked!.callId).toMatch(/^call-/);
    expect(asked!.reason).toContain(`initial attempt of run ${at.run} (${runRef(at.experiment, at.run)}) on target cluster`);
    expect(asked!.reason).toContain("wave 1: build");
    expect(asked!.reason).toContain("wave 2: md, analyse");
    expect(asked!.reason).toContain('"seq": "AABB"');
    expect(posts(h)).toHaveLength(1);
    expect(h.molab.executions.get(at.run)!.map((attempt) => attempt.executor.target)).toEqual(["cluster"]);
    expect(value.text).toContain(executionRef(at.experiment, at.run, "e01"));
  });

  for (const [outcome, message] of [["rejected", /declined/], ["cancelled", /withdrawn/], ["unavailable", /no one can approve/]] as const) {
    it(`starts nothing when the approval is ${outcome}`, async () => {
      await expect(h.call("molab_start_execution", at, { approval: outcome })).rejects.toThrow(message);
      expect(h.asked).toHaveLength(1);
      expect(posts(h)).toEqual([]);
      expect(h.molab.executions.get(at.run)).toEqual([]);
    });
  }

  it("fails closed when the host composes no approval service", async () => {
    await expect(h.call("molab_start_execution", at)).rejects.toThrow(/Not started: no one can approve/);
    expect(posts(h)).toEqual([]);
  });

  it("fails closed when the call has no agent to ask on behalf of", async () => {
    await expect(h.call("molab_start_execution", at, { approval: "allowed-once", noAgent: true })).rejects.toThrow(/no one can approve/);
    expect(h.asked).toEqual([]);
    expect(posts(h)).toEqual([]);
  });

  it("asks nothing and starts nothing when there is no workflow to show", async () => {
    const other = h.molab.seedRun();
    await expect(h.call("molab_start_execution", { project: "P1", ...other }, { approval: "allowed-once" })).rejects.toThrow(/no workflow is stored/);
    expect(h.asked).toEqual([]);
    expect(posts(h)).toEqual([]);
  });

  it("cancels an attempt it started", async () => {
    await h.call("molab_start_execution", at, { approval: "allowed-once" });
    await h.call("molab_cancel_execution", { ...at, execution: "e01" });
    expect(h.molab.executions.get(at.run)![0]!.status).toBe("cancelled");
  });
});

describe("knowledge documents", () => {
  let h: ResearchHarness;
  beforeEach(async () => {
    h = await researchHarness();
  });
  afterEach(() => h.close());

  it("writes a Report with its sources and links the documents it cites", async () => {
    const { experiment, run } = h.molab.seedRun();
    await h.call("molab_write_knowledge", { cls: "Plan", name: "Sequence plan", body: "Compare ABAB with AABB.", host: "experiments/screen", sources: [`molab:experiment/${experiment}`] });
    h.molab.plantFile("experiments/screen/scratch/sigma.csv");
    const value = await h.call("molab_write_knowledge", {
      cls: "Report",
      name: "Sequence conductivity",
      body: "AABB conducts 1.3x better ([run](molab:asset/A1)).",
      host: "experiments/screen",
      sources: [executionRef(experiment, run, "e01"), "molab:asset/A1", "experiments/screen/scratch/sigma.csv", "experiments/screen/knowledges/sequence-plan.md"],
    });
    const path = "experiments/screen/knowledges/sequence-conductivity.md";
    expect(value.text).toContain(path);
    const doc = h.molab.docs.get(path)!;
    expect(doc.cls).toBe("Report");
    expect(doc.createdBy).toBe("tack");
    expect(doc.sources).toEqual([
      { kind: "run", ref: runRef(experiment, run) },
      { kind: "asset", ref: "molab:asset/A1" },
      { kind: "file", ref: "experiments/screen/scratch/sigma.csv" },
    ]);
    expect(doc.edges).toEqual([{ target: "experiments/screen/knowledges/sequence-plan.md", role: "cites" }]);
  });

  it("rewrites the document in place under the same name", async () => {
    await h.call("molab_write_knowledge", { cls: "Note", name: "Open questions", body: "first" });
    await h.call("molab_write_knowledge", { cls: "Note", name: "Open questions", body: "second" });
    expect(h.molab.rewrites).toEqual(["knowledges/open-questions.md"]);
    expect(h.molab.docs.get("knowledges/open-questions.md")!.body).toBe("second");
  });

  it("files Literature with its bibliographic fields and reference source", async () => {
    await h.call("molab_write_knowledge", {
      cls: "Literature",
      name: "Ion transport in block copolymers",
      body: "Blocky sequences raise conductivity.",
      sources: ["https://doi.org/10.1021/ma000000"],
      literature: { title: "Ion transport in block copolymers", authors: ["A. Author"], year: 2021, doi: "10.1021/ma000000" },
    });
    const doc = h.molab.docs.get("knowledges/ion-transport-in-block-copolymers.md")!;
    expect(doc.extra).toMatchObject({ title: "Ion transport in block copolymers", authors: ["A. Author"], year: 2021, doi: "10.1021/ma000000" });
    expect(doc.sources).toEqual([{ kind: "reference", ref: "https://doi.org/10.1021/ma000000" }]);
  });

  it("refuses a Finding without a molab ref, a link to this machine, HTML, and stray literature fields", async () => {
    const refused = [
      [{ cls: "Finding", name: "AABB wins", body: "AABB conducts better.", sources: ["experiments/screen/scratch/sigma.csv"] }, /at least one molab: ref/],
      [{ cls: "Report", name: "Chart", body: "See http://localhost:5173/chart", sources: ["molab:asset/A1"] }, /no link to this machine/],
      [{ cls: "Note", name: "Page", body: "<html><body>x</body></html>" }, /not an HTML page/],
      [{ cls: "Note", name: "Paper", body: "x", literature: { title: "x" } }, /cls Literature only/],
      [{ cls: "Delegation", name: "Old", body: "x" }, /"cls" must be one of/],
    ] as const;
    for (const [args, message] of refused) await expect(h.call("molab_write_knowledge", args as never)).rejects.toThrow(message);
    expect(h.molab.docs.size).toBe(0);
  });

  it("deletes a document, and reports one that does not exist", async () => {
    await h.call("molab_write_knowledge", { cls: "Note", name: "Duplicate", body: "x" });
    await h.call("molab_delete_knowledge", { path: "knowledges/duplicate.md" });
    expect(h.molab.deleted).toEqual(["knowledges/duplicate.md"]);
    await expect(h.call("molab_delete_knowledge", { path: "knowledges/duplicate.md" })).rejects.toThrow(/404/);
  });

  it("finds written knowledge through the context's search hits", async () => {
    await h.call("molab_write_knowledge", { cls: "Hypothesis", name: "Blocky conducts", body: "Blocky sequences conduct better." });
    const value = await h.call("molab_context", { query: "blocky", section: "hits" });
    const page = (value.meta as { page: { hits: { path: string; title: string; type: string }[] } }).page;
    expect(page.hits).toEqual([{ path: "knowledges/blocky-conducts.md", title: "Blocky conducts", type: "Hypothesis", tags: [], snippet: "Blocky sequences conduct better.", source: "workspace" }]);
  });
});

describe("runs consume registered assets", () => {
  let h: ResearchHarness;
  beforeEach(async () => {
    h = await researchHarness();
  });
  afterEach(() => h.close());

  it("sends each cited asset's id as the run's inputs", async () => {
    const experiment = (await h.call("molab_create_experiment", { project: "P1", name: "eq-conductivity" })).meta as { id: string };
    const value = await h.call("molab_create_run", {
      project: "P1",
      experiment: experiment.id,
      params: { state: "liquid", seed: 1 },
      inputs: ["molab:asset/A7", "molab:asset/B2"],
    });
    expect((value.meta as { inputs: string[] }).inputs).toEqual(["A7", "B2"]);
  });

  it("refuses an input that is not an asset ref and creates nothing", async () => {
    const experiment = (await h.call("molab_create_experiment", { project: "P1", name: "eq-conductivity" })).meta as { id: string };
    const before = h.molab.requests.length;
    await expect(h.call("molab_create_run", { project: "P1", experiment: experiment.id, params: {}, inputs: ["molab:experiment/E1"] })).rejects.toThrow(/asset ref/);
    expect(h.molab.requests.slice(before)).toEqual([]);
  });
});

describe("research service", () => {
  it("lets another plugin reuse the molab client and wrap its own tools with the same approval", async () => {
    const provided = new Map<string, unknown>();
    const asked: string[] = [];
    const approval = { request: async (req: { toolName: string }) => { asked.push(req.toolName); return "rejected" as const; } };
    apply({
      tools: { register: () => () => undefined },
      get: (name: string) => (name === "approval" ? approval : undefined),
      effect: () => undefined,
      provide: (name: string, value: unknown) => { provided.set(name, value); return () => provided.delete(name); },
    }, { molab: { url: "http://molab.test:9000" } });
    const research = provided.get("research") as {
      config: { molab: { url: string } };
      molab: { url: string };
      toTool(spec: unknown): { name: string; execute(args: unknown, exec: unknown): Promise<{ text: string }> };
    };
    expect(research.config.molab.url).toBe("http://molab.test:9000");
    const tool = research.toTool({
      name: "reproduce_probe",
      description: "probe",
      parameters: {},
      execute: async (_args: unknown, exec: { approve?: (reason: string) => Promise<string> }) => ({ text: await exec.approve!("may I?") }),
    });
    const value = await tool.execute({}, { signal: new AbortController().signal, callId: "c1", agent: { session: { id: "S1" } } });
    expect(value.text).toBe("rejected");
    expect(asked).toEqual(["reproduce_probe"]);
  });
});
