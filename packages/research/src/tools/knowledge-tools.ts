/**
 * Knowledge documents in molab: write one (create, or rewrite in place under
 * the same name and host) of molab's knowledge classes with the sources it
 * rests on, or delete one written in error. Molab renders the Markdown body,
 * turns its `molab:` refs into links, and keeps every version in its history.
 */
import type { LiteratureMeta } from "../molab/client.js";
import { KNOWLEDGE_CLASSES, type KnowledgeClass } from "../molab/schemas.js";
import { citations } from "./records.js";
import type { ResearchDeps, ToolSpec } from "./types.js";

/** Classes whose trail must lead back to registered results. */
const EVIDENCED: ReadonlySet<KnowledgeClass> = new Set(["Report", "Finding"]);
/** A link that only works on the machine that wrote it. */
const LOCAL_URL = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?\b/i;
/** Markup that makes a body a page rather than Markdown. */
const HTML_PAGE = /<\s*(?:!doctype|html|head|body|iframe|script|style)\b/i;

interface WriteArgs {
  cls: KnowledgeClass;
  name: string;
  body: string;
  host?: string;
  sources?: string[];
  literature?: LiteratureMeta;
}

/** Why a document cannot be written as given; undefined when it can. */
export function writeRefusal(args: WriteArgs): string | undefined {
  if (args.name.trim() === "" || args.body.trim() === "") return "a document has a name and a body";
  const sources = args.sources ?? [];
  if (EVIDENCED.has(args.cls) && !sources.some((item) => item.startsWith("molab:"))) {
    return `a ${args.cls} cites at least one molab: ref in sources (the asset, run or execution it rests on), so its trail leads back to registered results`;
  }
  if (args.literature !== undefined && args.cls !== "Literature") return "literature metadata goes with cls Literature only";
  const texts = [args.body, ...sources];
  const local = texts.find((text) => LOCAL_URL.test(text));
  if (local !== undefined) return `a document holds no link to this machine (localhost / 127.0.0.1): it is dead for every other reader. Cite the molab: ref of what it showed instead (found in: ${local.slice(0, 120)})`;
  if (HTML_PAGE.test(args.body)) return "the body is Markdown that molab renders, not an HTML page: no <html>, <iframe> or <script>";
  return undefined;
}

export function molabWriteKnowledge(deps: ResearchDeps): ToolSpec<WriteArgs> {
  return {
    name: "molab_write_knowledge",
    description: [
      `Write a molab knowledge document: ${KNOWLEDGE_CLASSES.join(", ")}. Writing the same name under the same host rewrites that document in place (molab keeps the history), so keep names stable: no date or version in them.`,
      "The body is Markdown that molab renders; molab: refs in it become links (an asset ref opens the asset, a structure in MolVis). Never link a page served from this machine and never write HTML.",
      "List what it rests on in sources: molab: refs (asset, run, execution, experiment), URLs or DOIs, workspace files, and other knowledge document paths. A Report or Finding cites at least one molab: ref.",
    ].join(" "),
    parameters: {
      cls: { type: "string", required: true, enum: [...KNOWLEDGE_CLASSES] },
      name: { type: "string", required: true, description: "Document name; the same name under the same host rewrites it." },
      body: { type: "string", required: true, description: "The narrative, in Markdown." },
      host: { type: "string", description: "Workspace-relative directory (a project, experiment or run path) to file it under; default the served root." },
      sources: { type: "array", items: { type: "string" }, description: "molab: refs, URLs or DOIs, workspace files and knowledge document paths it rests on." },
      literature: {
        type: "object",
        description: "With cls Literature: the reference's bibliographic fields.",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          authors: { type: "array", items: { type: "string" } },
          year: { type: "integer" },
          doi: { type: "string" },
          venue: { type: "string" },
          url: { type: "string" },
        },
      },
    },
    async execute(args, exec) {
      const refusal = writeRefusal(args);
      if (refusal !== undefined) throw new Error(refusal);
      const { sources, documents } = citations(args.sources ?? []);
      const written = await deps.molab.createDoc(
        {
          name: args.name.trim(),
          cls: args.cls,
          ...(args.host !== undefined && args.host.trim() !== "" && { hostPath: args.host.trim() }),
          body: args.body,
          sources,
          createdBy: deps.config.createdBy,
          ...args.literature,
        },
        exec.signal,
      );
      for (const target of documents) await deps.molab.cite(written.relPath, target, exec.signal);
      return { text: `Wrote ${written.cls} ${written.relPath}.`, meta: written };
    },
  };
}

export function molabDeleteKnowledge(deps: ResearchDeps): ToolSpec<{ path: string }> {
  return {
    name: "molab_delete_knowledge",
    description:
      "Delete a knowledge document written in error (a duplicate, a wrong report or plan). molab's history keeps what it said. Write the correct document instead of keeping the wrong one beside it.",
    parameters: { path: { type: "string", required: true, description: "Workspace-relative path of the document." } },
    async execute(args, exec) {
      if (args.path.trim() === "") throw new Error("name the document by its workspace-relative path");
      await deps.molab.deleteDoc(args.path.trim(), exec.signal);
      return { text: `Deleted ${args.path.trim()}.` };
    },
  };
}
