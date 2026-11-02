import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket, MemoryStorage, makeMirror } from './helpers/fake-env';

// The boot layer of the bridge: what it does in a page, where it has no module system and loads as a plain script.
// bridge.test.ts and bridge-manual-edit.test.ts drive the core, which holds the logic, and this holds the wiring to
// a few things that are requirements and not logic: the pill follows the core's states, its links open the source in
// a tab of their own, its button copies the link to the session, and a widget has no pill. The page here is a
// hand-made document with just enough in it for the pill.

const SESSION = 'abcdefghjkmnpqrstvwxyz0123';
const SOURCE = readFileSync(fileURLToPath(new URL('../../client/strudel-ws-bridge.js', import.meta.url)), 'utf8');

/** An element of the hand-made document: it keeps what the bridge sets on it, and runs its click listeners. */
class PageElement {
  readonly children: PageElement[] = [];
  readonly style = { cssText: '' };
  readonly attributes: Record<string, string> = {};
  private readonly listeners: Record<string, Array<(event: object) => void>> = {};
  parent: PageElement | null = null;
  id = '';
  type = '';
  href = '';
  target = '';
  rel = '';
  title = '';
  textContent = '';

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  appendChild(child: PageElement): PageElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: (event: object) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
  }

  click(): void {
    for (const listener of this.listeners.click ?? []) listener({});
  }

  find(id: string): PageElement | null {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.find(id);
      if (found) return found;
    }
    return null;
  }
}

/** Loads the bridge as a page does, as a classic script with no `module`, and so it boots. */
function loadPage(config?: object) {
  FakeWebSocket.reset();
  const body = new PageElement('body');
  const clipboard = { writeText: vi.fn((_text: string) => Promise.resolve()) };
  const noop = () => {};
  const window: Record<string, any> = {
    strudelMirror: makeMirror(),
    DJOPUS_CONFIG: config,
    WebSocket: FakeWebSocket,
    location: { protocol: 'https:', host: 'djopus.test', origin: 'https://djopus.test', pathname: `/s/${SESSION}`, search: '' },
    // Called through these, as the page's window is: the fake timers of the test are the globals at the time of the call.
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: never) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: never) => clearInterval(id),
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) },
    history: { replaceState: noop },
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    navigator: { onLine: true, clipboard },
    addEventListener: noop,
  };
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    body,
    createElement: (tag: string) => new PageElement(tag),
    getElementById: (id: string) => body.find(id),
    addEventListener: noop,
  };
  runInNewContext(SOURCE, { window, document, console, TextEncoder, setTimeout });
  return { window, body, clipboard, pill: () => body.find('djopus-status') };
}

/** What the pill says: its second child, after the dot. */
const saying = (pill: PageElement | null) => pill?.children[1].textContent;

const last = () => FakeWebSocket.last();

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the status pill in a page', () => {
  it('follows the connection and the agent: connecting, waiting for your agent, connected, reconnecting', () => {
    const { pill, window } = loadPage();
    expect(pill()?.attributes.role).toBe('status');
    expect(saying(pill())).toBe('Connecting...');

    last().open();
    expect(saying(pill())).toBe('Waiting for your agent');

    last().receive({ type: 'get_code', request_id: 'g1' }); // the first command of an agent to reach the page
    expect(saying(pill())).toBe('Connected');
    expect(window.strudelWSBridge.pill).toBe('connected');

    last().drop();
    expect(saying(pill())).toBe('Reconnecting...');
  });

  it('links the source in a tab of its own, with no way back to the page', () => {
    const { pill } = loadPage();
    const links = (pill()?.children ?? []).filter((child) => child.tagName === 'a');
    expect(links.map(({ textContent, href, target, rel }) => ({ textContent, href, target, rel }))).toEqual([
      { textContent: 'Source', href: 'https://github.com/jmoore2333/djopus', target: '_blank', rel: 'noopener noreferrer' },
      {
        textContent: 'Strudel',
        href: 'https://codeberg.org/uzu/strudel/src/commit/9f19e4616a358ad31032e0f9af82060d23bc0d70',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    ]);
  });

  it('copies the link to the session, and says so for a moment', async () => {
    const { pill, clipboard } = loadPage();
    const copy = (pill()?.children ?? []).find((child) => child.tagName === 'button')!;
    expect(copy.textContent).toBe('Copy link');

    copy.click();
    expect(clipboard.writeText).toHaveBeenCalledWith(`https://djopus.test/s/${SESSION}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.textContent).toBe('Copied');
    await vi.advanceTimersByTimeAsync(1500);
    expect(copy.textContent).toBe('Copy link');
  });

  it('has no pill in the ChatGPT widget, which still connects', () => {
    const { pill, body, window } = loadPage({ mode: 'widget', sessionId: 'widget-7', wsUrl: 'wss://chatgpt.example/ws' });
    expect(pill()).toBeNull();
    expect(body.children).toEqual([]);

    expect(last().url).toBe('wss://chatgpt.example/ws?session=widget-7');
    last().open();
    last().receive({ type: 'get_code', request_id: 'g1' });
    expect(window.strudelWSBridge.status).toBe('connected');
  });
});
