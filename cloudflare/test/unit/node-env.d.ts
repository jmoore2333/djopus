// test/tsconfig.json carries the Workers types and no Node types. The unit tests load the CommonJS bridge
// through Node's createRequire, and check-static.test.ts and library.test.ts run a script and build throwaway
// directories, build-strudel.test.ts runs the build script against throwaway git repositories, and
// bridge-boot.test.ts runs the bridge as a page does. These declarations are all of Node that takes,
// and only the parts the tests call.
declare module 'node:crypto' {
  export function createHash(algorithm: string): { update(data: string): { digest(encoding: 'hex'): string } };
}

declare module 'node:module' {
  export function createRequire(url: string | URL): (id: string) => unknown;
}

declare module 'node:child_process' {
  export function spawnSync(
    command: string,
    args: string[],
    options: { encoding: 'utf8'; cwd?: string; env?: Record<string, string | undefined> },
  ): { status: number | null; stdout: string; stderr: string };
}

declare module 'node:fs' {
  export function chmodSync(path: string, mode: number): void;
  export function copyFileSync(from: string, to: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  export function symlinkSync(target: string, path: string): void;
  export function writeFileSync(path: string, data: string): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:process' {
  export const env: Record<string, string | undefined>;
  export const execPath: string;
  export const version: string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:vm' {
  export function runInNewContext(code: string, sandbox: object): unknown;
}

interface ImportMeta {
  url: string;
}
