/**
 * @tack/reproduce, installed with `tack plugin add` into the research profile,
 * composes cleanly: the Reproduce orchestrator's subagent tool admits exactly
 * the Intake, Critic and Judge presets, each declared in the composition (an
 * undeclared id fails the Agent's mount), and no role can start subagents of
 * its own. A preset is composed only by the web host, so a live turn is not
 * run here.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseDumpRows, REPO_ROOT, spawnTack, tempHome, type DumpRow } from "../helpers.js";

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

/** The items of the list under `key` in a row's dumped lines. */
function listUnder(row: DumpRow, key: string): string[] {
  const start = row.lines.findIndex((line) => line.trim() === `${key}:`);
  expect(start, `${row.id} has no ${key}`).toBeGreaterThanOrEqual(0);
  const indent = row.lines[start]!.search(/\S/);
  const items: string[] = [];
  for (const line of row.lines.slice(start + 1)) {
    const item = /^(\s*)- (.+)$/.exec(line);
    if (item === null || item[1]!.length < indent) break;
    items.push(item[2]!.replace(/^['"]|['"]$/g, ""));
  }
  return items;
}

describe("reproduce plugin", () => {
  it("composes into the research profile without warnings", () => {
    expect(dumpStderr.trim()).toBe("");
  });

  it("lets the orchestrator start exactly the three roles, each a declared preset", () => {
    const declared = presets();
    const orchestrator = declared.get("reproduce");
    expect(orchestrator, "reproduce preset is missing").toBeDefined();
    expect([...listUnder(orchestrator!, "allowedAgentPresets")].sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) expect(declared.has(role), role).toBe(true);
  });

  it("gives no role a subagent tool of its own", () => {
    const declared = presets();
    for (const role of ROLES) expect(declared.get(role)!.lines.join("\n"), role).not.toContain("dsh-tool-subagent");
  });
});
