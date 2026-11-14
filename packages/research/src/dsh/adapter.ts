/**
 * The only place `@tack/research` touches DeepSeek Harness: a runtime-neutral
 * tool spec becomes a registered DSH tool, a spec's approval request goes
 * through DSH's approval seam (`ctx.approval`, dsh-user-approval), which
 * audits it in the session log and fails closed without an answerer, and the
 * `{{molab_active_notes}}` prompt variable is resolved in DSH's system-prompt
 * assembly.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { ApprovalOutcome, ToolExec, ToolSpec, ToolValue } from "../tools/types.js";

/** The DSH execution fields the research tools read (DSH's ToolRunContext). */
interface ResearchExec {
  signal: AbortSignal;
  callId: ToolCallId;
  agent?: Agent;
}

/** The slice of the approval service a tool asks through. */
export type ApprovalPort = Pick<ApprovalService, "request">;

/**
 * A tool value as plain JSON. DSH refuses a value that does not survive a JSON
 * round trip (an `undefined` field, a class instance), after the tool has
 * already acted — so the value is normalized here, once, for every tool.
 */
export function losslessValue(value: ToolValue): ToolValue {
  return JSON.parse(JSON.stringify(value)) as ToolValue;
}

/**
 * The approval a call asks for: one request to DSH's approval service for
 * this call, on behalf of its agent. Without the service or an agent there is
 * no one to ask, which is `unavailable`.
 */
function approver(toolName: string, exec: ResearchExec, approval: () => ApprovalPort | undefined): ToolExec["approve"] {
  return async (reason: string): Promise<ApprovalOutcome> => {
    const service = approval();
    if (service === undefined || exec.agent === undefined) return "unavailable";
    return service.request({ agent: exec.agent, toolName, callId: exec.callId, reason, signal: exec.signal });
  };
}

/**
 * A runtime-neutral spec as a DSH tool. The value's text is what the model
 * reads; its meta is persisted. `approval` is read at each call, so a host
 * that composes no approval service leaves every approval `unavailable`.
 */
export function toDshTool(spec: ToolSpec<never>, approval: () => ApprovalPort | undefined): unknown {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: "json" },
      render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: (value as ToolValue).text }],
      presentationMeta: (_args: unknown, value: unknown) => ((value as ToolValue).meta ?? null) as never,
    },
    execute: async (args: never, exec: ResearchExec) => {
      const value = await spec.execute(args, { signal: exec.signal, approve: approver(spec.name, exec, approval) });
      return losslessValue(value) as never;
    },
  } as never);
}

/** The parts of a DSH prompt assembly (dsh-system-prompt's `PromptAssembly`) the variable reads and extends. */
export interface PromptAssembly {
  sections: { text: string; interpolate?: boolean }[];
  contexts: { text: string; interpolate?: boolean }[];
  variables: Record<string, string | undefined>;
}

/** The parts of DSH's `AssembleContext` the variable reads: the assembling agent, when there is one. */
export interface AssembleContext {
  agent?: object;
  signal?: AbortSignal;
}

/**
 * A `system-prompt/assemble` listener that gives `name` the text `resolve`
 * reads, for every assembly whose sections or contexts reference `{{name}}`.
 * An agent reads it once, at its first such assembly, so its instructions
 * stay as they were when its session started; an assembly that does not
 * reference it reads nothing. A failed read fails the assembly.
 */
export function promptVariable(name: string, resolve: (signal?: AbortSignal) => Promise<string>) {
  const reference = `{{${name}}}`;
  const perAgent = new WeakMap<object, string>();
  const references = (entries: PromptAssembly["sections"]) => entries.some((entry) => entry.interpolate !== false && entry.text.includes(reference));
  return async (_assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly> => {
    const assembly = await next();
    if (!references(assembly.sections) && !references(assembly.contexts)) return assembly;
    const agent = context.agent;
    const text = (agent === undefined ? undefined : perAgent.get(agent)) ?? (await resolve(context.signal));
    if (agent !== undefined) perAgent.set(agent, text);
    return { ...assembly, variables: { ...assembly.variables, [name]: text } };
  };
}
