import generated from '../references.generated.json';

/** One reference file of the DJ skill (skills/dj-opus/references/), served as an MCP resource. */
export interface ReferenceEntry {
  /** The resource's name, and the last part of its URI: djopus://reference/<name>. */
  name: string;
  mimeType: string;
  description: string;
  text: string;
}

/** The URI scheme and path of the reference resources. */
export const REFERENCE_URI_PREFIX = 'djopus://reference/';

/**
 * The reference files the generic MCP serves as resources (src/remote-mcp/guide.ts): the DJ skill's references, in a
 * fixed order. It is src/references.generated.json, which scripts/build-references.mjs writes (`npm run
 * build:references`, checked before the tests and run before a deploy), so the Worker bundles the files and reads none.
 */
export const REFERENCES: readonly ReferenceEntry[] = generated;

/** The URI of a reference. */
export function referenceUri(name: string): string {
  return `${REFERENCE_URI_PREFIX}${name}`;
}
