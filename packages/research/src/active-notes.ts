/**
 * The served scope's Notes in force, for a preset's instructions.
 *
 * A Note's lifecycle status is molab's `fields.status`, `active` unless set.
 * A writer that wants review first proposes a Note under another status
 * (`proposed`); a person sets it to `active` once reviewed. A preset that
 * writes `{{molab_active_notes}}` in its persona gets those Notes there, read
 * from molab once when its session starts (see `activeNotesVariable`).
 */
import type { MolabClient } from "./molab/client.js";

/** The prompt variable a persona writes to receive the Notes in force. */
export const ACTIVE_NOTES_VARIABLE = "molab_active_notes";

/** molab's lifecycle status of a Note in force. */
const IN_FORCE = "active";

/** Each active Note of the served scope as a Markdown section (title, path, body); `none` when there is none. */
export async function activeNotes(molab: MolabClient, signal?: AbortSignal): Promise<string> {
  const listed = await molab.listKnowledge({ status: IN_FORCE }, signal);
  const notes = listed.notes.filter((row) => row.cls === "Note");
  if (notes.length === 0) return "none";
  const bodies = await Promise.all(notes.map(async (row) => (await molab.readDoc(row.relPath, signal)).body.trim()));
  return notes.map((row, index) => `### ${row.title ?? row.name} (${row.relPath})\n\n${bodies[index]}`).join("\n\n");
}
