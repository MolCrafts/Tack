/**
 * Reading the served scope: molab's workspace context (with a keyword search
 * over knowledge) and one attempt's outputs and logs. Neither writes.
 */
import { experimentRef, projectRef, runRef } from "../molab/refs.js";
import type { WorkspaceContext } from "../molab/schemas.js";
import { bounds, clipJson, paged, type ResearchDeps, type ToolSpec } from "./types.js";

const RUN_PARAMS = {
  project: { type: "string", required: true, description: "Project id ('-' when molab serves that project or below)." },
  experiment: { type: "string", required: true, description: "Experiment id." },
  run: { type: "string", required: true, description: "Run id." },
} as const;

type RunRow = WorkspaceContext["recentRuns"][number];
const withRunRefs = (rows: RunRow[]): RunRow[] => rows.map((row) => ({ ref: runRef(row.experimentId, row.runId), ...row }));

/** The context with the `molab:` ref the tools take on every project, experiment and run. */
export function withRefs(context: WorkspaceContext): WorkspaceContext {
  return {
    ...context,
    projects: context.projects.map((row) => ({ ref: projectRef(row.id), ...row })),
    experiments: context.experiments.map((row) => ({ ref: experimentRef(row.id), ...row })),
    recentRuns: withRunRefs(context.recentRuns),
    failedRuns: withRunRefs(context.failedRuns),
    runningRuns: withRunRefs(context.runningRuns),
  };
}

interface ContextArgs {
  query?: string;
  projectId?: string;
  experimentId?: string;
  runId?: string;
  section?: string;
  offset?: number;
  limit?: number;
}

export function molabContext(deps: ResearchDeps): ToolSpec<ContextArgs> {
  return {
    name: "molab_context",
    description: [
      "Read what already exists in the served Molab scope before adding work, whoever wrote it: projects, experiments, workflows, recent, failed and running runs, assets, and knowledge documents.",
      "Start broad, then narrow with projectId / experimentId / runId. Pass query to search knowledge (plans, findings, reports) by keyword; the matches are in hits.",
    ].join(" "),
    parameters: {
      query: { type: "string", description: "Keyword search over knowledge documents." },
      projectId: { type: "string" },
      experimentId: { type: "string" },
      runId: { type: "string" },
      section: { type: "string", description: "One section (e.g. experiments, recentRuns, assets, knowledge, hits). Omit for a paged overview." },
      offset: { type: "integer", description: "Row offset (default 0)." },
      limit: { type: "integer", description: "Rows per section (default 10, maximum 100)." },
    },
    async execute(args, exec) {
      const focus = { projectId: args.projectId, experimentId: args.experimentId, runId: args.runId };
      const [context, search] = await Promise.all([
        deps.molab.context(focus, exec.signal),
        args.query === undefined ? Promise.resolve(undefined) : deps.molab.search(args.query, exec.signal),
      ]);
      const view: Record<string, unknown> = { ...withRefs(context), ...(search !== undefined && { hits: search.hits }) };
      if (args.section !== undefined && !(args.section in view)) throw new Error(`unknown section ${args.section}; choose ${Object.keys(view).join(", ")}`);
      const selected = args.section === undefined ? view : { [args.section]: view[args.section] };
      const { offset, limit } = bounds(args, 10);
      const { page, pagination } = paged(selected, offset, limit);
      const text = [
        `Context (each project, experiment and run carries the ref the tools take):\n${clipJson(page, 8_000)}`,
        `Pagination (select a section, then offset/limit):\n${JSON.stringify(pagination)}`,
      ].join("\n\n");
      return { text, meta: { page, pagination } };
    },
  };
}

const OUTPUT_SECTIONS = ["summary", "results", "assets", "evidence", "unregistered"] as const;

interface OutputsArgs {
  project: string;
  experiment: string;
  run: string;
  execution: string;
  log?: "stdout" | "stderr" | "run";
  offset?: number;
  limit?: number;
  section?: (typeof OUTPUT_SECTIONS)[number];
}

export function molabReadOutputs(deps: ResearchDeps): ToolSpec<OutputsArgs> {
  return {
    name: "molab_read_outputs",
    description:
      "Read one attempt's evidence: without log, its outputs (results, registered assets, evidence files, unregistered files); with log, one window of stdout / stderr / run.log from offset (pass nextOffset back to continue).",
    parameters: {
      ...RUN_PARAMS,
      execution: { type: "string", required: true, description: "Attempt id, e.g. e01." },
      log: { type: "string", enum: ["stdout", "stderr", "run"] },
      offset: { type: "integer", description: "Byte offset for logs, row offset for output sections (default 0)." },
      limit: { type: "integer", description: "Output rows per section (default 20)." },
      section: { type: "string", enum: [...OUTPUT_SECTIONS], description: "Default summary: results and paged assets/evidence; logs are read separately." },
    },
    async execute(args, exec) {
      const at = { project: args.project, experiment: args.experiment, run: args.run };
      if (args.log !== undefined) {
        const chunk = await deps.molab.log(at, args.execution, args.log, args.offset ?? 0, exec.signal);
        return { text: `${chunk.text}\n[nextOffset ${chunk.nextOffset}${chunk.eof ? ", end of file" : ""}]` };
      }
      const outputs = await deps.molab.outputs(at, args.execution, exec.signal);
      const section = args.section ?? "summary";
      const selected: Record<string, unknown> = section === "summary"
        ? {
            executionId: outputs.executionId,
            results: outputs.results,
            assets: outputs.assets,
            evidence: outputs.evidence,
            unregisteredCount: outputs.unregistered.length,
            stdoutAvailable: Boolean(outputs.stdout),
            stderrAvailable: Boolean(outputs.stderr),
          }
        : { [section]: outputs[section] };
      const { offset, limit } = bounds(args, 20);
      const { page, pagination } = paged(selected, offset, limit);
      const value = { ...page, pagination };
      return { text: clipJson(value), meta: value };
    },
  };
}
