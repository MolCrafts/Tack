/**
 * The parts of molab's HTTP responses Tack reads. Unknown fields pass through:
 * molab owns these shapes, Tack only relies on the fields named here.
 */
import { z } from "zod";

const Row = z.looseObject({});

export const Experiment = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  path: z.string(),
  ref: z.string(),
});
export type Experiment = z.infer<typeof Experiment>;

export const Run = z.looseObject({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  projectId: z.string(),
  experimentId: z.string(),
});
export type Run = z.infer<typeof Run>;

export const Execution = z.looseObject({
  id: z.string(),
  runId: z.string(),
  mode: z.string(),
  status: z.string(),
  createdAt: z.string(),
});
export type Execution = z.infer<typeof Execution>;

/** `GET /api/workspace/context`: molab's structural snapshot for agents. */
export const WorkspaceContext = z.looseObject({
  workspace: z.looseObject({ id: z.string(), name: z.string(), root: z.string() }),
  focus: Row,
  projects: z.array(z.looseObject({ id: z.string() })).default([]),
  experiments: z.array(z.looseObject({ id: z.string() })).default([]),
  recentRuns: z.array(z.looseObject({ runId: z.string(), experimentId: z.string() })).default([]),
  failedRuns: z.array(z.looseObject({ runId: z.string(), experimentId: z.string() })).default([]),
  runningRuns: z.array(z.looseObject({ runId: z.string(), experimentId: z.string() })).default([]),
  knowledge: z.array(z.looseObject({ path: z.string(), cls: z.string(), title: z.string() })).default([]),
});
export type WorkspaceContext = z.infer<typeof WorkspaceContext>;

/** `GET .../executions/{id}/outputs`: one attempt's registered results and files. */
export const ExecutionOutputs = z.looseObject({
  executionId: z.string(),
  stdout: z.string().nullish(),
  stderr: z.string().nullish(),
  results: z.record(z.string(), z.unknown()).default({}),
  assets: z.array(z.looseObject({ id: z.string(), projectId: z.string().nullish(), runId: z.string().nullish(), executionId: z.string().nullish() })).default([]),
  evidence: z.array(Row).default([]),
  unregistered: z.array(Row).default([]),
});
export type ExecutionOutputs = z.infer<typeof ExecutionOutputs>;

export const LogChunk = z.looseObject({ text: z.string(), nextOffset: z.number(), eof: z.boolean() });
export type LogChunk = z.infer<typeof LogChunk>;

export const NoteSummary = z.looseObject({ name: z.string(), relPath: z.string(), cls: z.string() });
export type NoteSummary = z.infer<typeof NoteSummary>;

/** `GET /api/knowledge`: every document of the served scope (a Note carries its lifecycle status). */
export const KnowledgeList = z.looseObject({
  notes: z.array(z.looseObject({ name: z.string(), title: z.string().nullish(), relPath: z.string(), cls: z.string(), status: z.string().nullish() })),
});
export type KnowledgeList = z.infer<typeof KnowledgeList>;

/** `GET /api/knowledge/note`: one document with its whole body. */
export const KnowledgeDoc = z.looseObject({ name: z.string(), relPath: z.string(), cls: z.string(), body: z.string() });
export type KnowledgeDoc = z.infer<typeof KnowledgeDoc>;

export const SearchHits = z.looseObject({
  hits: z.array(z.looseObject({ path: z.string(), title: z.string(), cls: z.string() })),
  truncated: z.boolean(),
});
export type SearchHits = z.infer<typeof SearchHits>;

/**
 * `GET /api/projects/{project}/experiments/{experiment}/workflow/dry-run`:
 * the waves, branches and runs a workflow would produce, without creating
 * anything.
 */
export const DryRun = z.looseObject({
  experiment: z.looseObject({ id: z.string(), name: z.string(), path: z.string() }),
  workflow: z.looseObject({ name: z.string() }),
  waves: z.array(z.array(z.string())).default([]),
  branches: z.array(z.looseObject({ source: z.string(), label: z.string().default(""), target: z.string() })).default([]),
  runs: z.array(z.looseObject({ params: z.record(z.string(), z.unknown()).default({}) })).default([]),
  source: z.enum(["code", "stored"]).default("stored"),
  entrypoint: z.string().nullish(),
});
export type DryRun = z.infer<typeof DryRun>;

/** The knowledge classes molab writes. */
export const KNOWLEDGE_CLASSES = ["Note", "Literature", "Report", "Finding", "Plan", "Roadmap", "Todo", "Milestone", "Observation", "Hypothesis", "Decision", "Manuscript"] as const;
export type KnowledgeClass = (typeof KNOWLEDGE_CLASSES)[number];
