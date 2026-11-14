/**
 * The `{{molab_active_notes}}` prompt variable as DSH's system-prompt
 * assembly runs it: an assembly that does not reference it reads nothing from
 * molab (a session that never asks for Notes does not depend on molab to
 * start), and an agent reads the Notes once, when its session starts, so its
 * instructions do not change under it when a Note is reviewed later.
 */
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { ACTIVE_NOTES_VARIABLE, activeNotes } from "../../packages/research/src/active-notes.js";
import { type PromptAssembly, promptVariable } from "../../packages/research/src/dsh/adapter.js";
import { MolabClient } from "../../packages/research/src/molab/client.js";
import { type FakeMolab, startFakeMolab } from "../fake-molab.js";

let molab: FakeMolab;
let listener: ReturnType<typeof promptVariable>;

const assembly = (persona: string): PromptAssembly => ({ sections: [{ text: persona }], contexts: [], variables: { model: "m" } });
const assemble = (persona: string, agent: object) => listener(assembly(persona), { agent }, () => Promise.resolve(assembly(persona)));
const listed = () => molab.requests.filter((request) => request === "GET /api/knowledge").length;

async function writeNote(name: string, status: string): Promise<void> {
  const response = await fetch(`${molab.url}/api/knowledge/doc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cls: "Note", name, body: `${name} body`, sources: [], cites: [], fields: { status } }),
  });
  expect(response.ok).toBe(true);
}

beforeEach(async () => {
  molab = await startFakeMolab();
  const client = new MolabClient({ url: molab.url });
  listener = promptVariable(ACTIVE_NOTES_VARIABLE, (signal) => activeNotes(client, signal));
});

afterEach(() => molab.close());

describe("molab_active_notes", () => {
  it("reads nothing for an assembly that does not reference it", async () => {
    await writeNote("Lesson", "active");
    const result = await assemble("You are a research agent powered by {{model}}.", {});
    expect(result.variables[ACTIVE_NOTES_VARIABLE]).toBeUndefined();
    expect(listed()).toBe(0);
  });

  it("reads the Notes once per agent, at its first assembly", async () => {
    await writeNote("First lesson", "active");
    const agent = {};
    const persona = "Lessons:\n\n{{molab_active_notes}}";
    expect((await assemble(persona, agent)).variables[ACTIVE_NOTES_VARIABLE]).toContain("First lesson body");
    await writeNote("Second lesson", "active");
    expect((await assemble(persona, agent)).variables[ACTIVE_NOTES_VARIABLE]).not.toContain("Second lesson body");
    expect(listed()).toBe(1);
    expect((await assemble(persona, {})).variables[ACTIVE_NOTES_VARIABLE]).toContain("Second lesson body");
  });
});
