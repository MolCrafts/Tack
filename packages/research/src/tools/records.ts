/**
 * What a cited item becomes when a knowledge document is written: a molab
 * ref, a URL or DOI, or a workspace file is a create-time source; another
 * knowledge document is a typed edge added once the document exists.
 */
import { isAssetRef, parseRef, runRef } from "../molab/refs.js";
import type { DocSource } from "../molab/schemas.js";

/** A molab ref as the source kind molab's create route takes; an execution is cited as its run. */
export function sourceOf(ref: string): DocSource {
  if (isAssetRef(ref)) return { kind: "asset", ref };
  const parsed = parseRef(ref);
  if (parsed.experiment !== undefined && parsed.run !== undefined) return { kind: "run", ref: runRef(parsed.experiment, parsed.run) };
  if (parsed.experiment !== undefined) return { kind: "experiment", ref };
  return { kind: "project", ref };
}

/** A knowledge document path (`<host>/knowledges/<slug>.md`), as opposed to any other workspace file. */
export function isKnowledgePath(item: string): boolean {
  return /(^|\/)knowledges\/[^/]+\.(md|html)$/.test(item);
}

/** An http(s) URL or a DOI: molab stores it as a reference source. */
const REFERENCE = /^(https?:\/\/|doi:|10\.\d{4,}\/)/i;

/** Sort citations into create-time sources and documents to link afterwards. */
export function citations(items: readonly string[]): { sources: DocSource[]; documents: string[] } {
  const sources = new Map<string, DocSource>();
  const documents = new Set<string>();
  for (const raw of items) {
    const item = raw.trim();
    if (item === "") continue;
    if (isKnowledgePath(item)) {
      documents.add(item);
      continue;
    }
    const source: DocSource = item.startsWith("molab:") ? sourceOf(item) : REFERENCE.test(item) ? { kind: "reference", ref: item } : { kind: "file", ref: item };
    sources.set(`${source.kind}:${source.ref}`, source);
  }
  return { sources: [...sources.values()], documents: [...documents] };
}
