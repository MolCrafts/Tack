/**
 * An in-memory stand-in for `molab serve`, covering the endpoints the research
 * tools call, with molab's wire shapes (camelCase JSON, workspace-relative
 * paths, `molab:` refs): the workspace context, knowledge search, structure
 * and attempt verbs, outputs and logs, and knowledge documents.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeExecution {
  id: string;
  runId: string;
  mode: string;
  status: string;
  createdAt: string;
  finishedAt?: string | null;
  executor: Record<string, unknown>;
  environment: Record<string, unknown>;
  error?: Record<string, unknown> | null;
}

export interface FakeDoc {
  cls: string;
  name: string;
  hostPath: string;
  createdBy: string;
  body: string;
  sources: { kind: string; ref: string }[];
  edges: { target: string; role: string }[];
  extra: Record<string, unknown>;
}

export interface FakeMolab {
  url: string;
  readonly docs: Map<string, FakeDoc>;
  readonly executions: Map<string, FakeExecution[]>;
  readonly requests: string[];
  /** Documents a create rewrote in place (the same name again), in order. */
  readonly rewrites: string[];
  /** Documents deleted, in order. */
  readonly deleted: string[];
  /** Create an experiment and a run under the served project; returns their ids. */
  seedRun(params?: Record<string, unknown>): { experiment: string; run: string };
  settle(run: string, execution: string, status: string): void;
  /** Put an ordinary workspace file in place (a worker's product). */
  plantFile(relPath: string): void;
  /** What `GET /api/projects/{p}/experiments/{id}/workflow/dry-run` answers for an experiment (until set: 404, no workflow stored). */
  dryRun(experiment: string, answer: { status?: number; body: unknown }): void;
  /** What `GET .../executions/{id}/outputs` answers for an attempt (default: results only). */
  outputs(execution: string, body: Record<string, unknown>): void;
  close(): Promise<void>;
}

const PROJECT = "P1";
const SOURCED = ["Report", "Finding", "Plan", "Observation"];
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

export async function startFakeMolab(root = "/tmp/fake-ws/projects/polymer"): Promise<FakeMolab> {
  const experiments = new Map<string, { id: string; projectId: string; name: string; path: string; ref: string; parameterSpace: Record<string, unknown> }>();
  const runs = new Map<string, { id: string; name: string; path: string; projectId: string; experimentId: string; parameters: Record<string, unknown> }>();
  const executions = new Map<string, FakeExecution[]>();
  const docs = new Map<string, FakeDoc>();
  const requests: string[] = [];
  const rewrites: string[] = [];
  const deleted: string[] = [];
  const files = new Set<string>();
  const dryRuns = new Map<string, { status?: number; body: unknown }>();
  const outputs = new Map<string, Record<string, unknown>>();
  let counter = 0;

  const addExperiment = (name: string) => {
    const id = `E${++counter}`;
    const experiment = { id, projectId: PROJECT, name, path: `experiments/${slug(name)}`, ref: `molab:experiment/${id}`, parameterSpace: {} };
    experiments.set(id, experiment);
    return experiment;
  };
  const addRun = (experimentId: string, parameters: Record<string, unknown>) => {
    const experiment = experiments.get(experimentId)!;
    const id = `R${++counter}`;
    const name = Object.entries(parameters).map(([k, v]) => `${k}=${String(v)}`).join("_") || id;
    const run = { id, name, path: `${experiment.path}/runs/${name}`, projectId: PROJECT, experimentId, parameters };
    runs.set(id, run);
    executions.set(id, []);
    return run;
  };
  const runRef = (run: { id: string; experimentId: string; projectId: string }) => {
    const attempts = executions.get(run.id) ?? [];
    const last = attempts.at(-1);
    return { runId: run.id, experimentId: run.experimentId, projectId: run.projectId, status: last?.status ?? "created", currentExecutionId: last?.id ?? null };
  };
  /** molab's WorkspaceContext read-model, camel-cased as its route serves it. */
  const context = () => {
    const all = [...runs.values()].map(runRef);
    return {
      workspace: { id: "W1", name: "fake", root, targets: ["local"] },
      focus: { projectId: null, experimentId: null, runId: null, selectedObjectRefs: [] },
      projects: [{ id: PROJECT, name: "Polymer" }],
      experiments: [...experiments.values()].map(({ id, name, projectId, parameterSpace }) => ({ id, name, projectId, parameterSpace })),
      workflows: [],
      recentRuns: all,
      failedRuns: all.filter((run) => run.status === "failed"),
      runningRuns: all.filter((run) => run.status === "queued" || run.status === "running"),
      assets: [],
      knowledge: [...docs.entries()].map(([path, doc]) => ({ path, type: doc.cls, title: doc.name, id: null })),
      staleOrMissing: [],
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    const body = (await readBody(req)) as Record<string, unknown> | undefined;
    requests.push(`${method} ${url.pathname}`);
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const fail = (status: number, detail: string) => send(status, { detail });
    const path = url.pathname;
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/api/workspace/context") return send(200, context());

    if ((m = path.match(/^\/api\/projects\/([^/]+)\/experiments\/([^/]+)\/workflow\/dry-run$/)) && method === "GET") {
      if (!experiments.has(m[2]!)) return fail(404, "experiment not found");
      const answer = dryRuns.get(m[2]!);
      if (answer === undefined) return fail(404, "no workflow.ir.json is stored for this experiment");
      return send(answer.status ?? 200, answer.body);
    }
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/experiments$/)) && method === "POST") {
      return send(201, addExperiment(String(body?.name)));
    }
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/experiments\/([^/]+)\/runs$/)) && method === "POST") {
      if (!experiments.has(m[2]!)) return fail(404, "experiment not found");
      return send(201, addRun(m[2]!, (body?.params as Record<string, unknown>) ?? {}));
    }
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/experiments\/([^/]+)\/runs\/([^/]+)(\/.*)?$/))) {
      const run = runs.get(m[3]!);
      if (run === undefined) return fail(404, "run not found");
      const rest = m[4] ?? "";
      const attempts = executions.get(run.id)!;
      if (rest === "" && method === "GET") return send(200, run);
      if (rest === "/executions" && method === "POST") {
        const attempt: FakeExecution = {
          id: `e${String(attempts.length + 1).padStart(2, "0")}`,
          runId: run.id,
          mode: String(body?.mode ?? "initial"),
          status: "queued",
          createdAt: new Date().toISOString(),
          executor: { backend: "molq", target: body?.target ?? "local", requested_by: body?.requestedBy ?? null },
          environment: {},
        };
        attempts.push(attempt);
        return send(201, attempt);
      }
      if ((m = rest.match(/^\/executions\/([^/]+)(\/.*)?$/))) {
        const attempt = attempts.find((item) => item.id === m![1]);
        if (attempt === undefined) return fail(404, "execution not found");
        const tail = m[2] ?? "";
        if (tail === "/cancel" && method === "POST") {
          attempt.status = "cancelled";
          return send(200, attempt);
        }
        if (tail === "/outputs" && method === "GET") {
          return send(200, { executionId: attempt.id, stdout: null, stderr: null, runtime: null, assets: [], evidence: [], unregistered: [], results: {}, ...outputs.get(attempt.id) });
        }
        if (tail.startsWith("/logs/")) return send(200, { text: "step 100 ok\n", nextOffset: 12, eof: true, size: 12 });
      }
      return fail(404, `no route ${method} ${path}`);
    }

    if (method === "GET" && path === "/api/knowledge/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const hits = [...docs.entries()]
        .filter(([, doc]) => doc.body.toLowerCase().includes(q) || doc.name.toLowerCase().includes(q))
        .map(([relPath, doc]) => ({ path: relPath, title: doc.name, type: doc.cls, tags: [], snippet: doc.body.slice(0, 80), source: "workspace" }));
      return send(200, { hits, truncated: false });
    }
    if (method === "POST" && path === "/api/knowledge/doc") {
      const name = String(body?.name);
      const hostPath = String(body?.hostPath ?? "");
      const relPath = `${hostPath === "" ? "" : `${hostPath}/`}knowledges/${slug(name)}.md`;
      const cls = String(body?.cls ?? "Note");
      const sources = (body?.sources as FakeDoc["sources"]) ?? [];
      const { name: _name, hostPath: _host, cls: _cls, sources: _sources, body: _body, createdBy, ...extra } = body ?? {};
      if (SOURCED.includes(cls) && sources.length === 0) return fail(422, `${cls} requires at least one SourceRef`);
      if (sources.some((source) => source.kind === "reference" && !/^(https?:\/\/|doi:|10\.)/i.test(source.ref))) return fail(422, "reference is not an http(s) URL or a DOI");
      if (sources.some((source) => source.kind === "file" && !files.has(source.ref))) return fail(422, "file source is not a file in this workspace");
      const prior = docs.get(relPath);
      const summary = { name, title: name, relPath, hostPath, excerpt: "", cls };
      if (prior !== undefined) {
        // As molab's write_knowledge: the same name rewrites the document in place (a non-empty body replaced).
        if (prior.cls !== cls) return fail(422, `${relPath} is a ${prior.cls}, not a ${cls}`);
        rewrites.push(relPath);
        const text = String(body?.body ?? "");
        docs.set(relPath, { ...prior, body: text === "" ? prior.body : text, sources: sources.length > 0 ? sources : prior.sources, extra: { ...prior.extra, ...extra } });
        return send(201, summary);
      }
      docs.set(relPath, { cls, name, hostPath, createdBy: String(createdBy ?? "ui"), body: String(body?.body ?? ""), sources, edges: [], extra });
      return send(201, summary);
    }
    if (method === "POST" && path === "/api/knowledge/doc/embed") {
      const doc = docs.get(url.searchParams.get("path") ?? "");
      if (doc === undefined) return fail(404, "note not found");
      if (body?.target_kind === "reference" && !docs.has(String(body.target))) return fail(404, "reference not found");
      doc.edges.push({ target: String(body?.target), role: String(body?.role ?? "cites") });
      return send(200, { srcPath: url.searchParams.get("path"), target: body?.target, role: body?.role });
    }
    if (method === "DELETE" && path === "/api/knowledge/doc") {
      const relPath = url.searchParams.get("path") ?? "";
      if (!docs.delete(relPath)) return fail(404, "note not found");
      deleted.push(relPath);
      return send(200, { message: `note '${relPath}' deleted` });
    }
    return fail(404, `no route ${method} ${path}`);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: String(error) }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    docs,
    executions,
    requests,
    rewrites,
    deleted,
    seedRun(params = { seq: "ABAB", seed: 1 }) {
      const experiment = addExperiment(`Screen ${counter + 1}`);
      const run = addRun(experiment.id, params);
      return { experiment: experiment.id, run: run.id };
    },
    settle(run, execution, status) {
      const attempt = executions.get(run)?.find((item) => item.id === execution);
      if (attempt === undefined) throw new Error(`no attempt ${execution} on ${run}`);
      attempt.status = status;
      attempt.finishedAt = new Date().toISOString();
    },
    plantFile(relPath) {
      files.add(relPath);
    },
    dryRun(experiment, answer) {
      dryRuns.set(experiment, answer);
    },
    outputs(execution, value) {
      outputs.set(execution, value);
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
