import generated from '../library.generated.json';

/** One curated pattern of the library: a patterns/*.json file of the repository, without its timestamp. */
export interface LibraryEntry {
  name: string;
  content: string;
  tags: string[];
}

/**
 * The read-only library every session sees next to its own crate (src/core/crate-store.ts): the curated patterns of
 * patterns/, sorted by name. It is src/library.generated.json, which scripts/build-library.mjs writes (`npm run
 * build:library`, run before the tests and before a deploy), so the Worker bundles it and reads no file.
 */
export const LIBRARY: readonly LibraryEntry[] = generated;
