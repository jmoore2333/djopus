// The secrets of the app Worker (wrangler.toml), for the types of its env. `wrangler secret put` sets a secret, so
// no wrangler config names it and `wrangler types` leaves it out of worker-configuration.d.ts. It is declared here, once
// on Cloudflare.Env (the Worker's env as shared code and cloudflare:workers see it) and once on Env, the interface the
// generated file also makes. src/chatgpt/secrets.d.ts does the same for the ChatGPT Worker.
//
// Optional, because the code runs without it. Left to itself, `wrangler types` would also add every key of a .dev.vars
// next to the config to the generated file, as a required string; `npm run types` passes --env-file /dev/null so that
// no local file changes what is generated.
declare namespace Cloudflare {
  interface Env {
    // Keys the session hash of the logs (src/log.ts). Unset, a random key per isolate does.
    LOG_HASH_KEY?: string;
    DEV_PUBLIC_ORIGIN?: string;
    OPENAI_APP_VERIFICATION_TOKEN?: string;
    CHATGPT_PRIVACY_MODE?: string;
  }
}

interface Env {
  DEV_PUBLIC_ORIGIN?: string;
  LOG_HASH_KEY?: string;
  OPENAI_APP_VERIFICATION_TOKEN?: string;
  CHATGPT_PRIVACY_MODE?: string;
}
