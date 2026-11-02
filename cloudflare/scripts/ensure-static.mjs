// wrangler.toml serves ./static as the Worker's assets, and that directory is
// gitignored (it holds the built Strudel REPL). Tests need it to exist, so on a
// checkout without a build this writes a stub page and a marker file that tells
// other tooling the directory is a stub. A real build is never touched.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');
const indexPath = join(staticDir, 'index.html');

if (!existsSync(indexPath)) {
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(
    indexPath,
    '<!doctype html><html><head><base href="/"><title>DJ Opus test stub</title></head><body><script src="/strudel-ws-bridge.js"></script></body></html>',
  );
  writeFileSync(join(staticDir, '.djopus-stub'), '');
  console.log('ensure-static: no static/index.html, wrote a test stub (static/.djopus-stub marks it)');
}
