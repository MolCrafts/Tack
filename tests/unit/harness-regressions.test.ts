import { describe, expect, it } from "@rstest/core";
import { MolabClient } from "../../packages/research/src/molab/client.js";
import { molabReadOutputs } from "../../packages/research/src/tools/read-tools.js";
import { clipJson } from "../../packages/research/src/tools/types.js";
import { apply as applyMolplot } from "../../packages/molplot/src/index.js";
import { apply as applyMolvis } from "../../packages/molvis/src/index.js";
import { researchHarness } from "../research-harness.js";

describe("PBIX harness regressions", () => {
  it("inspects a workflow without writing anything", async () => {
    const h = await researchHarness();
    try {
      const { experiment } = h.molab.seedRun();
      h.molab.dryRun(experiment, { body: { experiment: { id: experiment, name: "screen", path: "experiments/screen" },
        workflow: { name: "screen" }, source: "code", waves: [["calc"]], runs: [{ params: { x: 1 } }], tasks: [] } });
      const before = h.molab.requests.length;
      const value = await h.call("molab_dry_run", { project: "P1", experiment });
      expect(value.text).toContain("Source: code");
      expect(value.text).toContain("wave 1: calc");
      expect(h.molab.requests.slice(before).every((request) => request.startsWith("GET "))).toBe(true);
    } finally { await h.close(); }
  });

  it("returns every context row through explicit pages without slicing JSON", async () => {
    const h = await researchHarness();
    try {
      for (let i = 0; i < 25; i++) h.molab.seedRun();
      const a = await h.call("molab_context", { section: "recentRuns", limit: 10 });
      const b = await h.call("molab_context", { section: "recentRuns", offset: 10, limit: 10 });
      const c = await h.call("molab_context", { section: "recentRuns", offset: 20, limit: 10 });
      const pages = [a, b, c].map(v => v.meta as { page: { recentRuns: { runId: string; ref: string }[] }; pagination: { recentRuns: { total: number; nextOffset: number | null } } });
      expect(pages[0]!.pagination.recentRuns).toMatchObject({ total: 25, nextOffset: 10 });
      expect(pages[2]!.pagination.recentRuns.nextOffset).toBe(null);
      expect(new Set(pages.flatMap(p => p.page.recentRuns.map(r => r.runId))).size).toBe(25);
      expect(pages[0]!.page.recentRuns[0]!.ref).toMatch(/^molab:experiment\/E\d+\/run\/R\d+$/);
      expect(JSON.parse(clipJson({ data: "x".repeat(2000) }, 100))).toMatchObject({ truncated: true });
    } finally { await h.close(); }
  });

  it("refuses mixed execution assets even when an older server returns them", async () => {
    for (const wrong of [{ runId: "other", executionId: "e01", projectId: "P1" },
      { runId: "R1", executionId: "e02", projectId: "P1" }, { runId: "R1", executionId: "e01", projectId: "P2" }]) {
      const client = new MolabClient({ url: "http://molab.test", fetch: async input => new Response(JSON.stringify(
        String(input).endsWith("/outputs") ? { executionId: "e01", assets: [{ id: "a1", ...wrong }] } : { id: "R1", name: "r", path: "r", experimentId: "E1", projectId: "P1" })) });
      await expect(client.outputs({ project: "P1", experiment: "E1", run: "R1" }, "e01")).rejects.toThrow("mixed evidence");
    }
  });

  it("pages output lists and leaves raw logs out of the default result", async () => {
    const tool = molabReadOutputs({ molab: { outputs: async () => ({ executionId: "e01", stdout: "x".repeat(100000),
      results: { checks: true }, assets: Array.from({ length: 25 }, (_, id) => ({ id: `a${id}` })), evidence: [], unregistered: [] }) } } as never);
    const result = await tool.execute({ project: "P1", experiment: "E1", run: "R1", execution: "e01", offset: 20, limit: 10 }, { signal: new AbortController().signal });
    const value = JSON.parse(result.text);
    expect(value.assets).toHaveLength(5);
    expect(value.pagination.assets).toMatchObject({ total: 25, nextOffset: null });
    expect(value.stdout).toBeUndefined();
    expect(value.stdoutAvailable).toBe(true);
    expect(value.results).toEqual({ checks: true });
  });

  it("rolls back registrations if a later viewer tool is rejected", () => {
    for (const apply of [applyMolplot, applyMolvis]) {
      let calls = 0;
      let disposed = false;
      expect(() => apply({ tools: { register() {
        if (++calls === 2) throw new Error("registry refused");
        return () => { disposed = true; };
      } } })).toThrow("registry refused");
      expect(disposed).toBe(true);
    }
  });
});
