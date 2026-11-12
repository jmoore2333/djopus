import {
  checkPatternInput,
  deletePatternRow,
  listPatternRows,
  loadPatternRow,
  savePatternRow,
} from '../routes/api';
import type { PatternStore } from './ports';

/**
 * Saved patterns in the D1 table, for the tools of one session (the ChatGPT surface). It runs the SQL of the
 * /api/patterns routes (src/routes/api.ts), as a trusted caller acting for `ownerSessionId`: a save creates a name
 * or updates a pattern that session owns, a delete removes only such a pattern, and anything else fails with
 * `Pattern "<name>" belongs to another session`. Reads are open to every session, and never return a session_id.
 */
export function createD1PatternStore(db: D1Database, ownerSessionId: string): PatternStore {
  // A write that names no session would land on a pattern of no one's: like a trusted REST call without a
  // sessionId, that is a bug in the caller.
  function owner(): string {
    if (!ownerSessionId) throw new Error('A D1 pattern store has to name the session it saves and deletes for');
    return ownerSessionId;
  }

  return {
    async save(entry) {
      const session = owner();
      return savePatternRow(db, checkPatternInput(entry), session);
    },

    async load(name) {
      const row = await loadPatternRow(db, name);
      return row && { name: row.name, content: row.content, tags: row.tags, source: 'd1' as const };
    },

    async list(tag) {
      const rows = await listPatternRows(db, tag);
      return rows.map((row) => ({ name: row.name, tags: row.tags, source: 'd1' as const }));
    },

    async delete(name) {
      return deletePatternRow(db, name, owner());
    },
  };
}
