/**
 * The only place `@tack/research` touches DeepSeek Harness: a runtime-neutral
 * tool spec becomes a registered DSH tool, and a spec's approval request goes
 * through DSH's approval seam (`ctx.approval`, dsh-user-approval), which
 * audits it in the session log and fails closed without an answerer.
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
