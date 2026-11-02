// Types for scripts/build-references.mjs, which is plain Node and has none of its own. The tests import it.
import type { ReferenceEntry } from '../src/core/references';

/** The reference files, in resource-list order: resource name, file name in the references directory, MIME type, description. */
export const REFERENCE_FILES: readonly { name: string; file: string; mimeType: string; description: string }[];

/** The largest reference file a resource read may answer with, in bytes. */
export const MAX_REFERENCE_BYTES: number;

/** The references of `referencesDir`, in REFERENCE_FILES order. Throws, listing every problem, when a file is missing, empty or too large. */
export function buildReferences(referencesDir: string): ReferenceEntry[];
