/**
 * Molab structure and compute, through the served scope. Molab decides run
 * identity, resume semantics and dispatch; these tools only call its verbs.
 * Starting an attempt is the one step a person approves: the request shows
 * the dry run of what will execute, and nothing starts without an explicit
 * one-shot approval.
 */
import { MolabError } from "../molab/client.js";
import { executionRef, runRef } from "../molab/refs.js";
import type { DryRun } from "../molab/schemas.js";
import { type ApprovalOutcome, clipJson, type ResearchDeps, type ToolSpec } from "./types.js";

const RUN_PARAMS = {
  project: { type: "string", required: true, description: "Project id ('-' when molab serves that project or below)." },
  experiment: { type: "string", required: true, description: "Experiment id." },
  run: { type: "string", required: true, description: "Run id." },
} as const;

const DEFAULT_PROJECT = "-";

/** The dry run of an experiment's workflow, with molab's two expected refusals said plainly. */
async function dryRunOf(deps: ResearchDeps, project: string, experiment: string, source: "code" | "stored", signal: AbortSignal): Promise<DryRun> {
  try {
    return await deps.molab.dryRun(project, experiment, signal, source);
  } catch (error) {
    if (error instanceof MolabError && error.status === 404) {
      throw new Error(`no workflow is stored for experiment ${experiment} yet (${error.detail}): have a worker write it first`, { cause: error });
    }
    if (error instanceof MolabError && error.status === 400) {
      throw new Error(`the workflow of experiment ${experiment} does not compile: ${error.detail}. Send it back to the worker.`, { cause: error });
    }
    throw error;
  }
}

/** What a dry run would execute: waves, branches and run parameters, as a person reads it. */
export function describeDryRun(dry: DryRun): string {
  const waves = dry.waves.map((wave, index) => `- wave ${index + 1}: ${wave.join(", ")}`);
  const branches = dry.branches.map((branch) => `- ${branch.source} → ${branch.target}${branch.label ? ` (${branch.label})` : ""}`);
  return [
    `Workflow ${dry.workflow.name} of experiment ${dry.experiment.name} (${dry.experiment.id}, ${dry.experiment.path}): ${dry.waves.length} wave(s), ${dry.runs.length} run(s), ${dry.branches.length} branch(es).`,
    `Source: ${dry.source}${dry.entrypoint ? ` (${dry.entrypoint})` : ""}.`,
    ["Waves:", ...(waves.length > 0 ? waves : ["- (none)"])].join("\n"),
    ...(branches.length > 0 ? [["Branches:", ...branches].join("\n")] : []),
    `Runs:\n${clipJson(dry.runs.map((run) => run.params), 3_000)}`,
  ].join("\n\n");
}

export function molabDryRun(deps: ResearchDeps): ToolSpec<{ experiment: string; project?: string; source?: "code" | "stored" }> {
  return {
    name: "molab_dry_run",
    description: [
      "Preview an experiment's workflow without creating records or executing anything.",
      "source code (default) imports the current script in an isolated scratch process and shows its declared runs; source stored walks the saved graph and registered run inventory, which may include historical runs.",
      "404 when no workflow is stored yet; 400 when it does not compile.",
    ].join(" "),
    parameters: {
      experiment: { type: "string", required: true, description: "Experiment id." },
      project: { type: "string", description: "Project id ('-' when molab serves that project or below; the default)." },
      source: { type: "string", enum: ["code", "stored"], description: "code (default): current source declaration; stored: saved graph and registered inventory." },
    },
    async execute(args, exec) {
      const dry = await dryRunOf(deps, args.project ?? DEFAULT_PROJECT, args.experiment, args.source ?? "code", exec.signal);
      return { text: `Dry run (nothing was executed).\n\n${describeDryRun(dry)}`, meta: dry };
    },
  };
}

interface CreateExperimentArgs {
  project: string;
  name: string;
  description?: string;
  parameterSpace?: Record<string, unknown>;
  workflowSource?: Record<string, unknown>;
  defaultTarget?: string;
}

export function molabCreateExperiment(deps: ResearchDeps): ToolSpec<CreateExperimentArgs> {
  return {
    name: "molab_create_experiment",
    description:
      "Create an experiment: a new testable question or comparison design. Changing the hypothesis, main method or comparison design is a new experiment; varying declared parameters or seeds is a new run in the existing one.",
    parameters: {
      project: { type: "string", required: true, description: "Project id." },
      name: { type: "string", required: true },
      description: { type: "string" },
      parameterSpace: { type: "json", description: "Parameter space definition." },
      workflowSource: { type: "json", description: "Workflow IR document, bound as the document kind." },
      defaultTarget: { type: "string", description: "Compute target new runs default to." },
    },
    async execute(args) {
      const { project, ...body } = args;
      const experiment = await deps.molab.createExperiment(project, body);
      return { text: `Created experiment ${experiment.name} (${experiment.id}), ref ${experiment.ref}.`, meta: experiment };
    },
  };
}

export function molabCreateRun(deps: ResearchDeps): ToolSpec<{ project: string; experiment: string; params: Record<string, unknown>; target?: string }> {
  return {
    name: "molab_create_run",
    description:
      "Create a run in an experiment: one set of declared parameters (including the seed). A retry of a failed attempt is not a new run; start a new attempt with molab_start_execution instead.",
    parameters: {
      project: { type: "string", required: true },
      experiment: { type: "string", required: true },
      params: { type: "json", required: true, description: "Run parameters." },
      target: { type: "string", description: "Compute target hint." },
    },
    async execute(args) {
      const run = await deps.molab.createRun(args.project, args.experiment, { params: args.params, ...(args.target !== undefined && { target: args.target }) });
      return { text: `Created run ${run.name} (${run.id}), ref ${runRef(args.experiment, run.id)}.`, meta: run };
    },
  };
}

interface StartArgs {
  project: string;
  experiment: string;
  run: string;
  mode?: "initial" | "rerun" | "resume" | "reproduce";
  basedOnExecutionId?: string;
  target?: string;
}

/** Why an attempt did not start, for every outcome but a grant. */
const NOT_STARTED: Record<Exclude<ApprovalOutcome, "allowed-once">, string> = {
  rejected: "the person declined it. Ask what they want changed; do not retry unchanged.",
  cancelled: "the approval request was withdrawn before anyone answered.",
  unavailable:
    "no one can approve it here (no approval channel, as in a headless `tack run`, or approvals are off). Show the person the dry run and ask them to start it from a session that can approve.",
};

/** The request a person approves: which attempt, where, and the dry run of what executes. */
function approvalReason(args: StartArgs, dry: DryRun): string {
  const mode = args.mode ?? "initial";
  return [
    `Start a ${mode} attempt of run ${args.run} (${runRef(args.experiment, args.run)}) on target ${args.target ?? "local"}${args.basedOnExecutionId !== undefined ? `, based on attempt ${args.basedOnExecutionId}` : ""}.`,
    describeDryRun(dry),
  ].join("\n\n");
}

export function molabStartExecution(deps: ResearchDeps): ToolSpec<StartArgs> {
  return {
    name: "molab_start_execution",
    description: [
      "Start one attempt of a run through molab: to this machine by default (target local), or to a registered compute target via molq.",
      "mode: initial for a new run; resume continues a failed attempt from its completed nodes; rerun recomputes; reproduce checks a succeeded one.",
      "The person is asked to approve it first, shown the dry run of the experiment's workflow; without their approval nothing starts.",
      "Compute takes time: after it starts, schedule a check rather than polling.",
    ].join(" "),
    parameters: {
      ...RUN_PARAMS,
      mode: { type: "string", enum: ["initial", "rerun", "resume", "reproduce"] },
      basedOnExecutionId: { type: "string", description: "Predecessor attempt for resume / rerun / reproduce." },
      target: { type: "string", description: "Compute target name (default: local, this machine)." },
    },
    async execute(args, exec) {
      const dry = await dryRunOf(deps, args.project, args.experiment, "code", exec.signal);
      const outcome = exec.approve === undefined ? "unavailable" : await exec.approve(approvalReason(args, dry));
      if (outcome !== "allowed-once") throw new Error(`Not started: ${NOT_STARTED[outcome]}`);
      const at = { project: args.project, experiment: args.experiment, run: args.run };
      const execution = await deps.molab.createExecution(
        at,
        {
          ...(args.mode !== undefined && { mode: args.mode }),
          ...(args.basedOnExecutionId !== undefined && { basedOnExecutionId: args.basedOnExecutionId }),
          ...(args.target !== undefined && { target: args.target }),
          requestedBy: deps.config.createdBy,
        },
        exec.signal,
      );
      const ref = executionRef(args.experiment, args.run, execution.id);
      return { text: `Approved and started attempt ${execution.id} (${execution.status}), ref ${ref}.`, meta: execution };
    },
  };
}

export function molabCancelExecution(deps: ResearchDeps): ToolSpec<{ project: string; experiment: string; run: string; execution: string }> {
  return {
    name: "molab_cancel_execution",
    description: "Cancel one attempt of a run (its molq job too).",
    parameters: { ...RUN_PARAMS, execution: { type: "string", required: true, description: "Attempt id, e.g. e01." } },
    async execute(args) {
      const result = await deps.molab.cancelExecution({ project: args.project, experiment: args.experiment, run: args.run }, args.execution);
      return { text: `Cancel requested for ${executionRef(args.experiment, args.run, args.execution)}.`, meta: result };
    },
  };
}
