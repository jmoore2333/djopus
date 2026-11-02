// Types for scripts/build-library.mjs, which is plain Node and has none of its own. The tests import it.
import type { LibraryEntry } from '../src/core/library';

/** What src/limits.ts allows a crate entry, as the script keeps it. */
export const LIBRARY_LIMITS: {
  readonly maxNameChars: number;
  readonly maxCodeBytes: number;
  readonly maxTags: number;
  readonly maxTagChars: number;
};

/** The library of the *.json files in `patternsDir`, sorted by name. Throws, listing every problem, when a file cannot be an entry. */
export function buildLibrary(patternsDir: string): LibraryEntry[];
