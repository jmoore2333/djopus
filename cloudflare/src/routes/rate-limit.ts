/**
 * The per-IP limit of a route: the app's /mcp requests (MCP_RATE_LIMITER) and /ws upgrades (WS_RATE_LIMITER), both
 * [[ratelimits]] bindings of wrangler.toml. The key is the client's address as Cloudflare saw it, which a client cannot
 * set. A request without one (in-process, or a test) is counted under one key, `unknown`. The address is the limiter's
 * to count, and nobody's to log.
 *
 * Returns the 429 to answer with when the limit is used up, and null when the request may go on.
 */
export async function checkRateLimit(limiter: RateLimit, request: Request): Promise<Response | null> {
  const key = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success } = await limiter.limit({ key });
  if (success) return null;
  // Both limits count a period of 60 seconds.
  return Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } });
}
