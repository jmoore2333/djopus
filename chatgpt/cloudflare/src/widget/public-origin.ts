/** Public origin used by the widget. Wrangler's local custom-domain routing can rewrite
 * request.url, so a local tunnel may supply an explicit origin with --var. Do not infer
 * this value from forwarding headers, which clients can forge. */
export function publicOrigin(request: Request, env: { DEV_PUBLIC_ORIGIN?: string }): string {
  const configured = env.DEV_PUBLIC_ORIGIN;
  if (!configured) return new URL(request.url).origin;
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.origin !== configured || url.username || url.password) {
    throw new Error('DEV_PUBLIC_ORIGIN must be an HTTPS origin without a path');
  }
  return url.origin;
}
