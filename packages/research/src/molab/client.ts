/**
 * A typed client for the slice of `molab serve`'s HTTP API the research tools
 * call.
 *
 * Scope is the server's job: `molab serve` opened at a project / experiment /
 * run exposes only that node and its descendants, so every call here is
 * already bounded by the bound scope. Responses are validated; a molab error
 * surfaces as {@link MolabError} with its status and detail.
 */
import { z } from "zod";
import {
  DryRun,
  Execution,
  ExecutionOutputs,
  Experiment,
  type KnowledgeClass,
  KnowledgeDoc,
  KnowledgeList,
  LogChunk,
  NoteSummary,
  Run,
  SearchHits,
  WorkspaceContext,
} from "./schemas.js";

export class MolabError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly endpoint: string,
  ) {
    super(`molab ${endpoint} answered ${status}: ${detail}`);
    this.name = "MolabError";
  }
}

export interface MolabClientOptions {
  url: string;
  token?: string;
  fetch?: typeof fetch;
}

/** Where a run lives: molab routes address it by project, experiment and run id. */
export interface RunLocator {
  project: string;
  experiment: string;
  run: string;
}

export interface CreateExecution {
  mode?: "initial" | "rerun" | "resume" | "reproduce";
  basedOnExecutionId?: string;
  target?: string;
  requestedBy: string;
}

/** One typed edge a new document carries: a knowledge document path or a molab: ref. */
export interface DocCite {
  target: string;
  role?: string;
}

export interface CreateDoc {
  name: string;
  cls: KnowledgeClass;
  hostPath?: string;
  body: string;
  /** What the document rests on: molab: refs, URLs or DOIs, workspace files. */
  sources: string[];
  cites: DocCite[];
  /** The fields its class declares; molab refuses any other key. */
  fields?: Record<string, unknown>;
  createdBy: string;
}

const seg = encodeURIComponent;
const anyJson = z.unknown();

function runPath(at: RunLocator): string {
  return `/api/projects/${seg(at.project)}/experiments/${seg(at.experiment)}/runs/${seg(at.run)}`;
}

export class MolabClient {
  readonly #url: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: MolabClientOptions) {
    this.#url = options.url.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async #call<S extends z.ZodType>(schema: S, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<z.infer<S>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
    const endpoint = `${method} ${path.split("?")[0]}`;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        ...(signal !== undefined && { signal }),
      });
    } catch (error) {
      throw new MolabError(0, `cannot reach molab at ${this.#url} (${error instanceof Error ? error.message : String(error)})`, endpoint);
    }
    const text = await response.text();
    if (!response.ok) throw new MolabError(response.status, detailOf(text), endpoint);
    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      throw new MolabError(response.status, "response is not JSON", endpoint);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new MolabError(response.status, `unexpected response shape: ${parsed.error.message}`, endpoint);
    return parsed.data;
  }

  // ── Structure ──────────────────────────────────────────────────────────────
  /** The structural snapshot molab builds for agents (projects, experiments, recent and failed runs, knowledge). */
  context(query: { projectId?: string; experimentId?: string; runId?: string } = {}, signal?: AbortSignal): Promise<WorkspaceContext> {
    const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.#call(WorkspaceContext, "GET", `/api/workspace/context${suffix}`, undefined, signal);
  }

  createExperiment(
    project: string,
    body: { name: string; description?: string; parameterSpace?: Record<string, unknown>; workflowSource?: Record<string, unknown>; defaultTarget?: string },
  ): Promise<Experiment> {
    return this.#call(Experiment, "POST", `/api/projects/${seg(project)}/experiments`, body);
  }

  createRun(project: string, experiment: string, body: { params: Record<string, unknown>; inputs?: string[]; target?: string }): Promise<Run> {
    return this.#call(Run, "POST", `/api/projects/${seg(project)}/experiments/${seg(experiment)}/runs`, body);
  }

  getRun(at: RunLocator, signal?: AbortSignal): Promise<Run> {
    return this.#call(Run, "GET", runPath(at), undefined, signal);
  }

  /** Preview current code in isolation, or explicitly inspect saved IR/inventory. */
  dryRun(project: string, experiment: string, signal?: AbortSignal, source: "code" | "stored" = "code"): Promise<DryRun> {
    return this.#call(DryRun, "GET", `/api/projects/${seg(project)}/experiments/${seg(experiment)}/workflow/dry-run?source=${source}`, undefined, signal);
  }

  // ── Attempts ───────────────────────────────────────────────────────────────
  /** Create one attempt; molab submits it. */
  createExecution(at: RunLocator, body: CreateExecution, signal?: AbortSignal): Promise<Execution> {
    return this.#call(Execution, "POST", `${runPath(at)}/executions`, body, signal);
  }

  cancelExecution(at: RunLocator, execution: string): Promise<unknown> {
    return this.#call(anyJson, "POST", `${runPath(at)}/executions/${seg(execution)}/cancel`);
  }

  /** One attempt's outputs; refused when they carry an asset of another run, project or attempt. */
  async outputs(at: RunLocator, execution: string, signal?: AbortSignal): Promise<ExecutionOutputs> {
    const endpoint = `${runPath(at)}/executions/${seg(execution)}/outputs`;
    const value = await this.#call(ExecutionOutputs, "GET", endpoint, undefined, signal);
    if (value.assets.length > 0) {
      const run = await this.getRun(at, signal);
      const foreign = value.assets.some((asset) => asset.runId !== run.id || asset.executionId !== execution || asset.projectId !== run.projectId);
      if (foreign) throw new MolabError(200, "outputs contain an asset from another run, project or execution; refusing mixed evidence", `GET ${endpoint}`);
    }
    return value;
  }

  log(at: RunLocator, execution: string, stream: "stdout" | "stderr" | "run", offset: number, signal?: AbortSignal): Promise<LogChunk> {
    return this.#call(LogChunk, "GET", `${runPath(at)}/executions/${seg(execution)}/logs/${stream}?offset=${offset}`, undefined, signal);
  }

  // ── Knowledge ──────────────────────────────────────────────────────────────
  search(q: string, signal?: AbortSignal): Promise<SearchHits> {
    return this.#call(SearchHits, "GET", `/api/knowledge/search?${new URLSearchParams({ q })}`, undefined, signal);
  }

  /** Every document of the served scope; with `status`, only the Notes whose lifecycle status it is. */
  listKnowledge(query: { status?: string } = {}, signal?: AbortSignal): Promise<KnowledgeList> {
    const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.#call(KnowledgeList, "GET", `/api/knowledge${suffix}`, undefined, signal);
  }

  /** One document with its whole body, by its path relative to the served root. */
  readDoc(path: string, signal?: AbortSignal): Promise<KnowledgeDoc> {
    return this.#call(KnowledgeDoc, "GET", `/api/knowledge/note?${new URLSearchParams({ path })}`, undefined, signal);
  }

  /** Write a document; the same name under the same host rewrites it in place. */
  createDoc(body: CreateDoc, signal?: AbortSignal): Promise<NoteSummary> {
    return this.#call(NoteSummary, "POST", "/api/knowledge/doc", body, signal);
  }

  /** Delete a document; molab's history keeps what it said. */
  deleteDoc(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.#call(anyJson, "DELETE", `/api/knowledge/doc?${new URLSearchParams({ path })}`, undefined, signal);
  }
}

function detailOf(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text.slice(0, 500) || "(empty body)";
  }
  if (typeof body === "object" && body !== null) {
    const detail = (body as { detail?: unknown; message?: unknown }).detail ?? (body as { message?: unknown }).message;
    if (typeof detail === "string") return detail;
    if (detail !== undefined) return JSON.stringify(detail);
  }
  return text.slice(0, 500) || "(empty body)";
}
