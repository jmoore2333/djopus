import { byteLength, MAX_CODE_BYTES, MAX_NAME_CHARS, MAX_TAG_CHARS, MAX_TAGS } from '../limits';
import type { SessionBridge } from '../session-bridge';
import type { LibraryEntry } from './library';
import type { PatternStore } from './ports';

// The saves of a session: its crate, kept in the session's own Durable Object (src/session-bridge.ts), private to it
// and gone with it after 30 idle days; and the library, the curated patterns of patterns/ (src/core/library.ts),
// the same for every session and read-only. The tools of the generic MCP save, load, list and delete through
// createCrateLibraryStore.

/** The most entries a session's crate holds. */
export const CRATE_MAX_ENTRIES = 50;

/** What the Durable Object keeps for each crate entry, under the key `crate:<name>`. The name is the key and only that. */
export interface CrateEntry {
  content: string;
  tags: string[];
  /** When the entry was saved, last time: saving a name again moves it. ISO 8601. */
  savedAt: string;
}

/** An entry as the crate lists it: its name, and what it holds but the content. */
export interface CrateSummary {
  name: string;
  tags: string[];
  savedAt: string;
}

/**
 * Why a save was refused. The checks behind the last three are those of the REST route (src/limits.ts). `too_large` is
 * also the answer for content that is not a string: the crate has no other word for content.
 */
export type CrateError = 'crate_full' | 'invalid_name' | 'too_large' | 'invalid_tags';

/**
 * What a crate call that can be refused answers with. A refusal is a value and not an exception, so that it crosses the
 * RPC boundary to the Worker as it is.
 */
export type CrateResult<T> = { ok: true; value: T } | { ok: false; error: CrateError };

const EMPTY_EDITOR = 'The editor is empty, so there is nothing to save. Write a pattern first.';

/** What the agent is told when the crate turns a save away. `content` is the content that was refused, whatever it was. */
function refusal(error: CrateError, content: unknown): string {
  switch (error) {
    case 'crate_full':
      return `The crate is full (${CRATE_MAX_ENTRIES} patterns). Delete one first.`;
    case 'invalid_name':
      return `name must be 1 to ${MAX_NAME_CHARS} characters`;
    case 'too_large':
      return typeof content === 'string'
        ? `content is too large (${byteLength(content)} bytes, the limit is ${MAX_CODE_BYTES})`
        : 'content must be a string';
    case 'invalid_tags':
      return `tags must be at most ${MAX_TAGS} strings of at most ${MAX_TAG_CHARS} characters each`;
  }
}

/** Whether one of `tags` is `wanted`, however either is cased. The table this replaced matched tags that way too. */
function hasTag(tags: readonly string[], wanted: string): boolean {
  const lower = wanted.toLowerCase();
  return tags.some((tag) => tag.toLowerCase() === lower);
}

/**
 * The PatternStore of the generic MCP surface, for the session whose Durable Object is `stub`: its crate, with
 * `library` behind it. A name is looked up in the crate first, so a saved pattern hides a library pattern of the same
 * name (and deleting it shows the library pattern again). The library is never written to.
 */
export function createCrateLibraryStore(stub: DurableObjectStub<SessionBridge>, library: readonly LibraryEntry[]): PatternStore {
  const inLibrary = (name: string) => library.find((entry) => entry.name === name);

  return {
    async save(entry) {
      // The editor was empty. The table this replaced refused that too, and a crate has only 50 places. (Content that
      // is not a string at all is the crate's to refuse, below.)
      if (entry.content === '') throw new Error(EMPTY_EDITOR);
      const result = await stub.crateSave(entry);
      if (!result.ok) throw new Error(refusal(result.error, entry.content));
      return { saved: result.value.saved };
    },

    async load(name) {
      const saved = await stub.crateGet(name);
      if (saved) return { name, content: saved.content, tags: saved.tags, source: 'crate' };
      const curated = inLibrary(name);
      // A copy of the tags: what a caller does to the result must not reach the library every session shares.
      return curated ? { name: curated.name, content: curated.content, tags: [...curated.tags], source: 'library' } : null;
    },

    async list(tag) {
      const saved = await stub.crateList();
      // The same name once: what load would give for it. The tag filter looks at that entry, not at the one it hides.
      const hidden = new Set(saved.map((entry) => entry.name));
      const all = [
        ...saved.map(({ name, tags }) => ({ name, tags, source: 'crate' as const })),
        ...library
          .filter((entry) => !hidden.has(entry.name))
          .map(({ name, tags }) => ({ name, tags: [...tags], source: 'library' as const })),
      ];
      return tag ? all.filter((entry) => hasTag(entry.tags, tag)) : all;
    },

    async delete(name) {
      if (await stub.crateDelete(name)) return { deleted: name };
      if (inLibrary(name)) throw new Error('Library patterns are read-only');
      throw new Error(`Pattern "${name}" not found`);
    },
  };
}
