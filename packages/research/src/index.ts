/**
 * `tack-research`: plain molab tools over the node `molab serve` opened.
 *
 * Reading the workspace, previewing and starting compute, and writing
 * knowledge documents; and the `{{molab_active_notes}}` prompt variable, the
 * served scope's Notes in force, for a persona that writes it. Everything
 * else is DeepSeek Harness's: the session is the decision log, workers are
 * its subagent tools, the person is asked through its ask-user tool and
 * approval seam, and waiting on compute is a reminder its schedule service
 * delivers back to the session.
 */
import { parseConfig } from "./config.js";
import { ACTIVE_NOTES_VARIABLE, activeNotes } from "./active-notes.js";
import { type ApprovalPort, type AssembleContext, type PromptAssembly, promptVariable, toDshTool } from "./dsh/adapter.js";
import { MolabClient } from "./molab/client.js";
import { molabDeleteKnowledge, molabWriteKnowledge } from "./tools/knowledge-tools.js";
import { molabCancelExecution, molabCreateExperiment, molabCreateRun, molabDryRun, molabStartExecution } from "./tools/molab-tools.js";
import { molabContext, molabReadOutputs } from "./tools/read-tools.js";
import type { ResearchDeps, ToolSpec } from "./tools/types.js";

export const name = "tack-research";
export const inject = ["tools"];

/** The parts of the plugin context `tack-research` uses. */
interface ResearchContext {
  tools: { register(definition: unknown): () => void };
  get(service: string): unknown;
  on(
    event: "system-prompt/assemble",
    listener: (assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>) => Promise<PromptAssembly>,
  ): () => void;
  effect(execute: () => () => void, label?: string): void;
}

/** Every research tool, in the order a session meets them. */
export function researchTools(deps: ResearchDeps): ToolSpec<never>[] {
  return [
    molabContext(deps),
    molabDryRun(deps),
    molabCreateExperiment(deps),
    molabCreateRun(deps),
    molabStartExecution(deps),
    molabCancelExecution(deps),
    molabReadOutputs(deps),
    molabWriteKnowledge(deps),
    molabDeleteKnowledge(deps),
  ] as ToolSpec<never>[];
}

export function apply(ctx: ResearchContext, rawConfig: unknown): void {
  const config = parseConfig(rawConfig);
  const token = process.env[config.molab.tokenEnv];
  const molab = new MolabClient({ url: config.molab.url, ...(token !== undefined && token !== "" && { token }) });
  const approval = () => ctx.get("approval") as ApprovalPort | undefined;
  ctx.on("system-prompt/assemble", promptVariable(ACTIVE_NOTES_VARIABLE, (signal) => activeNotes(molab, signal)));
  ctx.effect(() => {
    const disposers: (() => void)[] = [];
    const disposeAll = () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
    try {
      for (const spec of researchTools({ config, molab })) disposers.push(ctx.tools.register(toDshTool(spec, approval)));
    } catch (error) {
      // A rejected registration leaves none of the tools behind.
      disposeAll();
      throw error;
    }
    return disposeAll;
  }, "tack-research: tools");
}
