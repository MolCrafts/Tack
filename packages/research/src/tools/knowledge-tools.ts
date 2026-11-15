/**
 * Knowledge documents in molab: write one (create, or rewrite in place under
 * the same name and host) of molab's knowledge classes with the sources it
 * rests on, or delete one written in error. Molab renders the Markdown body,
 * turns its `molab:` refs into links, and keeps every version in its history.
 */
import { KNOWLEDGE_CLASSES, type KnowledgeClass } from "../molab/schemas.js";
import { citations } from "./records.js";
import type { ResearchDeps, ToolSpec } from "./types.js";

interface WriteArgs {
  cls: KnowledgeClass;
  name: string;
  body: string;
  host?: string;
  sources?: string[];
  fields?: Record<string, unknown>;
}

export function molabWriteKnowledge(deps: ResearchDeps): ToolSpec<WriteArgs> {
  return {
    name: "molab_write_knowledge",
    description: [
      `Write a molab knowledge document: ${KNOWLEDGE_CLASSES.join(", ")}. Writing the same name under the same host rewrites that document in place (molab keeps the history), so keep names stable: no date or version in them.`,
      "The body is Markdown that molab renders; molab: refs in it become links (an asset ref opens the asset, a structure in MolVis). Never link a page served from this machine and never write HTML.",
      "A Manuscript is the exception: its body is the whole LaTeX paper, stored as <name>.tex and compiled as it stands; each \\cite{key} names a Literature document (its file name, in the same host or one above), and `molab knowledge bib` writes the bibliography from them.",
      "List what it rests on in sources: molab: refs (asset, run, execution, experiment), URLs or DOIs, workspace files, and other knowledge document paths. A Report or Finding cites at least one asset, run or execution.",
      "molab refuses a document that breaks one of its rules and says which; fix the write from that message.",
    ].join(" "),
    parameters: {
      cls: { type: "string", required: true, enum: [...KNOWLEDGE_CLASSES] },
      name: { type: "string", required: true, description: "Document name; the same name under the same host rewrites it." },
      body: { type: "string", required: true, description: "The narrative, in Markdown; for a Manuscript, the LaTeX paper." },
      host: {
        type: "string",
        description:
          "The project, experiment or run folder to file it under, as a path relative to the served root (the node `molab serve` opened), not to the workspace: when molab serves a project, '.' is that project and 'experiments/<name>' one of its experiments. Omitted, the served root. A molab: ref is not accepted.",
      },
      sources: { type: "array", items: { type: "string" }, description: "molab: refs, URLs or DOIs, workspace files and knowledge document paths it rests on." },
      fields: {
        type: "object",
        additionalProperties: true,
        description:
          "The structured fields its class declares, and no others: Literature title, authors, year, doi, venue, url, pdf_asset_id; Hypothesis verdict (open, supported, refuted, unsettled); Decision status (open while it waits for a person, made); Todo items [{id, title, status: open|done|blocked, stage?}]; Roadmap stages [{id, title, experiment?, depends_on?}]; Milestone criterion, status (open, met, missed), stage?; Note status. A Manuscript declares none.",
      },
    },
    async execute(args, exec) {
      const { sources, cites } = citations(args.sources ?? []);
      const written = await deps.molab.createDoc(
        {
          name: args.name.trim(),
          cls: args.cls,
          ...(args.host !== undefined && args.host.trim() !== "" && { hostPath: args.host.trim() }),
          body: args.body,
          sources,
          cites,
          ...(args.fields !== undefined && { fields: args.fields }),
          createdBy: deps.config.createdBy,
        },
        exec.signal,
      );
      return { text: `Wrote ${written.cls} ${written.relPath}.`, meta: written };
    },
  };
}

export function molabDeleteKnowledge(deps: ResearchDeps): ToolSpec<{ path: string }> {
  return {
    name: "molab_delete_knowledge",
    description:
      "Delete a knowledge document written in error (a duplicate, a wrong report or plan). molab's history keeps what it said. Write the correct document instead of keeping the wrong one beside it.",
    parameters: { path: { type: "string", required: true, description: "The document's path relative to the served root, as molab_write_knowledge reports it." } },
    async execute(args, exec) {
      if (args.path.trim() === "") throw new Error("name the document by its path relative to the served root");
      await deps.molab.deleteDoc(args.path.trim(), exec.signal);
      return { text: `Deleted ${args.path.trim()}.` };
    },
  };
}
