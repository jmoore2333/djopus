import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { getWidgetHtml, getWidgetShellHtml } from '../../src/widget/widget-html';

const ORIGIN = 'https://djopus.test';

function shell(openai?: object, sourceUrl?: string) {
  const messages: any[] = [];
  const listeners: Record<string, Function[]> = {};
  const parent = { postMessage: (data: unknown) => messages.push(data) };
  const child = { postMessage: () => {} };
  const elements: Record<string, any> = {};
  for (const id of ['frame', 'toolbar', 'fallback', 'fallback-link', 'pip-btn', 'fullscreen-btn', 'source-link']) {
    elements[id] = { style: {}, handlers: {}, addEventListener(name: string, fn: Function) { this.handlers[name] = fn; }, offsetHeight: 36, hidden: false };
  }
  elements.frame.contentWindow = child;
  const window = {
    parent, openai, innerWidth: 600, innerHeight: 500,
    addEventListener: (name: string, fn: Function) => (listeners[name] ??= []).push(fn),
    setTimeout() {},
  };
  const html = getWidgetShellHtml('ignored', ORIGIN, true, sourceUrl);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('No shell script');
  runInNewContext(script, { window, document: { getElementById: (id: string) => elements[id] } });
  return { html, messages, elements, parent, child, receive: (event: object) => listeners.message.forEach(fn => fn(event)) };
}

it('exposes a source link only for the versioned ChatGPT shell and opens it through the MCP host', () => {
  const source = 'https://github.com/jmoore2333/djopus/tree/chatgpt-v0.1.4/chatgpt';
  expect(getWidgetShellHtml('', ORIGIN)).not.toContain('id="source-link"');
  const h = shell(undefined, source);
  expect(h.html).toContain(`id="source-link" class="toolbar-btn" href="${source}"`);
  const initialize = h.messages.find(m => m.method === 'ui/initialize');
  h.receive({ source: h.parent, data: { jsonrpc: '2.0', id: initialize.id, result: { hostContext: {} } } });
  let prevented = false;
  h.elements['source-link'].handlers.click({ preventDefault: () => { prevented = true; } });
  expect(prevented).toBe(true);
  expect(h.messages.find(m => m.method === 'ui/open-link').params).toEqual({ url: source });
});

it('uses the ChatGPT openExternal API for the source link when the standard bridge is unavailable', () => {
  const source = 'https://github.com/jmoore2333/djopus/tree/chatgpt-v0.1.4/chatgpt';
  const opened: unknown[] = [];
  const h = shell({ openExternal: (args: unknown) => opened.push(args) }, source);
  let prevented = false;
  h.elements['source-link'].handlers.click({ preventDefault: () => { prevented = true; } });
  expect(prevented).toBe(true);
  expect(opened).toEqual([{ href: source, redirectUrl: false }]);
});

it('initializes the MCP Apps bridge and opens the player from tool-result metadata', () => {
  const h = shell();
  const initialize = h.messages.find(m => m.method === 'ui/initialize');
  expect(initialize.params.protocolVersion).toBe('2026-01-26');
  h.receive({ source: h.parent, data: { jsonrpc: '2.0', id: initialize.id, result: { hostContext: { availableDisplayModes: ['inline', 'pip', 'fullscreen'] } } } });
  expect(h.elements['fullscreen-btn'].hidden).toBe(false);
  h.elements['fullscreen-btn'].handlers.click();
  expect(h.messages.find(m => m.method === 'ui/request-display-mode').params.mode).toBe('fullscreen');
  expect(h.messages.some(m => m.method === 'ui/notifications/initialized')).toBe(true);
  h.receive({ source: h.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { _meta: { sessionId: 'chatgpt-conv-1234' } } } });
  const widget = new URL(h.elements.frame.src);
  expect(widget.searchParams.get('session')).toBe('chatgpt-conv-1234');
  // Upstream Strudel looks up any query as a shared pattern unless there is a
  // fragment. A harmless comment prevents leaking the capability as a lookup.
  expect(atob(widget.hash.slice(1))).toBe('//');
  expect(h.elements.frame.style.display).toBe('block');
});

it('supports ChatGPT globals, and forwards only verified player messages to the host', () => {
  const h = shell({ toolResponseMetadata: { sessionId: 'chatgpt-conv-legacy' } });
  expect(h.elements.frame.src).toBe(`${ORIGIN}/widget?session=chatgpt-conv-legacy#Ly8`);
  const initialize = h.messages.find(m => m.method === 'ui/initialize');
  h.receive({ source: h.parent, data: { jsonrpc: '2.0', id: initialize.id, result: { hostContext: {} } } });
  const event = { source: h.child, origin: ORIGIN, data: { type: 'djopus:ask', prompt: 'Change the beat' } };
  h.receive({ ...event, origin: 'https://wrong.test' });
  h.receive({ ...event, source: {} });
  expect(h.messages.filter(m => m.method === 'ui/message')).toHaveLength(0);
  h.receive(event);
  expect(h.messages.find(m => m.method === 'ui/message').params).toEqual({ role: 'user', content: [{ type: 'text', text: 'Change the beat' }] });
});

it('creates the Ask button in the child player even without a host global', async () => {
  const page = '<html><head><base href="/"></head><body><script src="/strudel-ws-bridge.js"></script></body></html>';
  const html = await getWidgetHtml({ fetch: async () => new Response(page) } as unknown as Fetcher, 'session', ORIGIN);
  expect(html).not.toContain('<script src="/strudel-ws-bridge.js"></script>');
  const script = html.match(/<script src="\/strudel-ws-bridge-chatgpt.js"><\/script>\s*<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('No player bridge script');
  let onClick: Function = () => {};
  const sent: any[] = [];
  const button = { style: {}, addEventListener: (_: string, fn: Function) => { onClick = fn; } };
  const window = { strudelMirror: { code: 's("bd")' }, parent: { postMessage: (data: unknown) => sent.push(data) } };
  const document = { readyState: 'complete', createElement: () => button, body: { appendChild() {} } };
  runInNewContext(script, { window, document, console });
  onClick();
  expect(sent[0].type).toBe('djopus:ask');
  expect(sent[0].prompt).toContain('s("bd")');
});
