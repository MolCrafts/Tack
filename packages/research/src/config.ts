/**
 * The `tack-research` row's config, validated once at apply time.
 */
import { z } from "zod";

const ResearchConfig = z
  .object({
    molab: z
      .object({
        /** Base URL of `molab serve`, rooted at the node this research is bound to. */
        url: z.url().default("http://localhost:8000"),
        /** Environment variable holding a molab bearer token, when the server runs with `--auth`. */
        tokenEnv: z.string().min(1).default("MOLAB_TOKEN"),
      })
      .prefault({}),
    /** Author recorded on every molab write. */
    createdBy: z.string().min(1).default("tack"),
  })
  .strict();

export type ResearchConfig = z.infer<typeof ResearchConfig>;

/** Validate a row config; the error names every bad field. */
export function parseConfig(raw: unknown): ResearchConfig {
  const parsed = ResearchConfig.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`tack-research: invalid config: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
