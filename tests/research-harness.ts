/**
 * The research tools wired the way `apply` wires them, over an in-memory
 * molab: each tool is the DSH tool `toDshTool` builds, called with a DSH-like
 * execution (agent, call id, signal), and DSH's approval service is a fake
 * that answers every request with the outcome the test chose.
 */
import { parseConfig } from "../packages/research/src/config.js";
import { type ApprovalPort, toDshTool } from "../packages/research/src/dsh/adapter.js";
import { researchTools } from "../packages/research/src/index.js";
import { MolabClient } from "../packages/research/src/molab/client.js";
import type { ApprovalOutcome, ResearchDeps, ToolValue } from "../packages/research/src/tools/types.js";
import { type FakeMolab, startFakeMolab } from "./fake-molab.js";

/** One request DSH's approval service received. */
export interface AskedApproval {
  toolName: string;
  callId?: string;
  reason?: string;
  session: string;
}

export interface CallOptions {
  /** How the approval service answers; `absent` composes no approval service at all (default). */
  approval?: ApprovalOutcome | "absent";
  /** Call without an agent, as a host-plane caller would. */
  noAgent?: boolean;
}

export interface ResearchHarness {
  molab: FakeMolab;
  deps: ResearchDeps;
  asked: AskedApproval[];
  /** Call a research tool as DSH would, from session S1. */
  call(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<ToolValue>;
  close(): Promise<void>;
}

type DshTool = { name: string; execute(args: unknown, exec: unknown): Promise<ToolValue> };

export async function researchHarness(): Promise<ResearchHarness> {
  const molab = await startFakeMolab();
  const deps: ResearchDeps = { config: parseConfig({}), molab: new MolabClient({ url: molab.url }) };
  const asked: AskedApproval[] = [];
  let calls = 0;
  const call: ResearchHarness["call"] = async (name, args, options = {}) => {
    const answer = options.approval ?? "absent";
    const service: ApprovalPort | undefined =
      answer === "absent"
        ? undefined
        : {
            request: async (req) => {
              asked.push({ toolName: req.toolName, callId: req.callId, reason: req.reason, session: String(req.agent.session.id) });
              return answer;
            },
          };
    const tool = researchTools(deps)
      .map((spec) => toDshTool(spec, () => service) as DshTool)
      .find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    const exec = { signal: new AbortController().signal, callId: `call-${++calls}`, ...(options.noAgent !== true && { agent: { session: { id: "S1" } } }) };
    return tool.execute(args, exec);
  };
  return { molab, deps, asked, call, close: () => molab.close() };
}
