// Sent with every asset a Worker serves (the REPL page and the rest) and with the ChatGPT /widget page. A session
// id travels in the URL of those pages (/s/<id>, /?session=, /widget?session=), and by default a browser sends the
// whole URL as the Referer of the same-origin requests the page makes. redact_query_string keeps the
// query out of the request URL Cloudflare records, but not out of request headers, so the id would
// still reach the logs through Referer. With strict-origin the Referer is the origin and nothing more.
// The assets that no Worker serves get it from static/_headers: the app's pages and files come straight from the
// assets (run_worker_first in wrangler.toml), and the two places have to agree.
export const REFERRER_POLICY = 'strict-origin';

/**
 * Serves the static Strudel REPL through the ASSETS binding, and adds Referrer-Policy to what it answers
 * with, a 304 included: a browser revalidates the page on every load. The ChatGPT Worker sends every asset through
 * this (run_worker_first = true); the app's Worker reaches it only for what its list leaves unanswered.
 *
 * `cors` adds Access-Control-Allow-Origin and -Methods, for a host whose assets are loaded by a page of
 * another origin: ChatGPT's srcdoc widget iframe has the origin null.
 */
export async function serveAsset(request: Request, env: Cloudflare.Env, opts: { cors: boolean }): Promise<Response> {
  const assetResp = await env.ASSETS.fetch(request);
  const resp = new Response(assetResp.body, assetResp);
  if (opts.cors) {
    resp.headers.set('Access-Control-Allow-Origin', '*');
    resp.headers.set('Access-Control-Allow-Methods', 'GET');
  }
  resp.headers.set('Referrer-Policy', REFERRER_POLICY);
  return resp;
}
