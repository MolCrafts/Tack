/**
 * What a cited item becomes when a knowledge document is written: another
 * knowledge document is a typed edge (`cites`); a molab ref, a URL or DOI, or
 * a workspace file is a source. molab classifies and checks both.
 */
import type { DocCite } from "../molab/client.js";

/** A knowledge document path (`<host>/knowledges/<slug>.md`), as opposed to any other workspace file. */
export function isKnowledgePath(item: string): boolean {
  return /(^|\/)knowledges\/[^/]+\.(md|html)$/.test(item);
}

/** Sort citations into sources and the documents the new one cites, dropping blanks and repeats. */
export function citations(items: readonly string[]): { sources: string[]; cites: DocCite[] } {
  const sources = new Set<string>();
  const documents = new Set<string>();
  for (const raw of items) {
    const item = raw.trim();
    if (item === "") continue;
    (isKnowledgePath(item) ? documents : sources).add(item);
  }
  return { sources: [...sources], cites: [...documents].map((target) => ({ target })) };
}
