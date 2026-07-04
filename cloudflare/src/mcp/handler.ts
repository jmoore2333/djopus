// Placeholder: the ChatGPT Apps MCP handler ships when the DJ Opus ChatGPT app is published.
export async function handleMcp(_request: Request, _env: unknown, _ctx: unknown): Promise<Response> {
  return new Response('MCP endpoint not available in this build', { status: 501 });
}
