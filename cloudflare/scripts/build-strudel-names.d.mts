// Types for scripts/build-strudel-names.mjs, which is plain Node and has none of its own. The tests import it.

export interface StrudelNames {
  strudelCommit: string;
  generatedBy: string;
  names: string[];
}

/** The commit scripts/build-strudel.sh pins. */
export function pinnedCommit(): string;

/** The generated file's content for the Strudel clone at `buildDir`. Throws when it is not at the pinned commit. */
export function buildStrudelNames(buildDir: string): Promise<StrudelNames>;

/** The file's text for `content`. */
export function serialize(content: StrudelNames): string;
