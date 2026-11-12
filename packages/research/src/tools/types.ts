/**
 * Runtime-neutral tool specs. Nothing under `tools/` imports DSH: the adapter
 * in `dsh/` turns each spec into a registered DSH tool, and unit tests call
 * `execute` directly with fakes.
 */
import type { ResearchConfig } from "../config.js";
import type { MolabClient } from "../molab/client.js";

/** A one-shot human decision, in DSH's approval vocabulary; only `allowed-once` grants. */
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** What a tool sees of its call. */
export interface ToolExec {
  signal: AbortSignal;
  /**
   * Ask the person to approve this call, showing `reason`. Absent when the
   * runtime offers no approval channel: a caller treats that as `unavailable`.
   */
  approve?: (reason: string) => Promise<ApprovalOutcome>;
}

/** A tool's value: model-facing text, plus the structured record kept as presentation meta. */
export interface ToolValue {
  text: string;
  meta?: unknown;
}

/** dsh-tools' parameter DSL, kept structural so this layer needs no DSH import. */
export type ParameterSpec = Record<string, Record<string, unknown>>;

export interface ToolSpec<A = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: ParameterSpec;
  execute(args: A, exec: ToolExec): Promise<ToolValue>;
}

export interface ResearchDeps {
  config: ResearchConfig;
  molab: MolabClient;
}

/** Pretty JSON, cut to `limit` characters so one read cannot flood the context. */
export function clipJson(value: unknown, limit = 12_000): string {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return text.length > limit ? JSON.stringify({ truncated: true, preview: text.slice(0, Math.floor(limit / 2)),
    totalCharacters: text.length, hint: "Select a section and page with offset/limit, or narrow projectId/experimentId/runId." }) : text;
}

type Row = Record<string, unknown>;

/** One page of every array in `view`, and where each continues. Non-array values pass through. */
export function paged(view: Row, offset: number, limit: number): { page: Row; pagination: Row } {
  const entries = Object.entries(view);
  const page = Object.fromEntries(entries.map(([key, value]) => [key, Array.isArray(value) ? value.slice(offset, offset + limit) : value]));
  const pagination = Object.fromEntries(
    entries
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => {
        const total = (value as unknown[]).length;
        return [key, { offset, limit, total, nextOffset: offset + limit < total ? offset + limit : null }];
      }),
  );
  return { page, pagination };
}

/** A caller's offset and limit, bounded. */
export function bounds(args: { offset?: number; limit?: number }, defaultLimit: number): { offset: number; limit: number } {
  return { offset: Math.max(0, args.offset ?? 0), limit: Math.max(1, Math.min(100, args.limit ?? defaultLimit)) };
}
