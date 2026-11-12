/**
 * Widget HTML injection for the ChatGPT App surface.
 *
 * Fetches the existing Strudel REPL index.html from Cloudflare Assets
 * and injects config, CSS overrides, and a ChatGPT bridge script
 * to make the REPL work as an embedded widget.
 */

// ── Injection fragments ──────────────────────────────────────────────────

/**
 * JSON for an inline <script>. JSON.stringify alone is not enough there: a "<"
 * inside a string can still end the script ("</script>") or start a comment
 * ("<!--"), and U+2028 / U+2029 end a line in the JavaScript of older engines.
 * Escaping them keeps the text valid JSON with the same value.
 */
export function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function configScript(sessionId: string, origin: string): string {
  // The session ID comes from the URL. Serialized, it and the origin are data:
  // neither can end the string or the script around it.
  const wsOrigin = origin.replace('http://', 'ws://').replace('https://', 'wss://');
  const config = { sessionId, mode: 'widget', wsUrl: `${wsOrigin}/ws` };
  return `<script>
window.DJOPUS_CONFIG = ${serializeForInlineScript(config)};
</script>`;
}

const storageShimScript = `<script>
(function() {
  function createStorageShim() {
    var store = new Map();
    return {
      get length() {
        return store.size;
      },
      key: function(index) {
        return Array.from(store.keys())[index] || null;
      },
      getItem: function(key) {
        key = String(key);
        return store.has(key) ? store.get(key) : null;
      },
      setItem: function(key, value) {
        store.set(String(key), String(value));
      },
      removeItem: function(key) {
        store.delete(String(key));
      },
      clear: function() {
        store.clear();
      },
    };
  }

  function installStorageShim(name) {
    try {
      void window[name];
      return;
    } catch (error) {
      Object.defineProperty(window, name, {
        configurable: true,
        value: createStorageShim(),
      });
      console.warn('[djopus-widget] installed ' + name + ' shim:', error);
    }
  }

  installStorageShim('sessionStorage');
  installStorageShim('localStorage');
})();
</script>`;

const widgetCSS = `<style id="djopus-widget-mode">
/* Widget mode: hide non-essential UI, compact layout for ~600px ChatGPT iframe.
   Selectors derived from live DOM inspection of the Strudel REPL (Astro build). */

:root {
  --djopus-shell-height: 500px;
  --djopus-editor-max-height: 300px;
}

/* Hide the right-side Menu Panel (welcome/patterns/sounds/reference/export/console/settings) */
nav[aria-label="Menu Panel"] {
  display: none !important;
}

/* In the top nav bar, hide share, learn, and hamburger menu buttons.
   Keep: play and update buttons. */
nav > div > div > a[href*="workshop"],
nav > div > div > button:last-child {
  display: none !important;
}
/* Hide share button (identified by text content via attribute selector fallback) */
nav button:has(> span:only-child) {
  /* share button has just a text span child */
}
/* More robust: hide 3rd and 4th action items and hamburger in top nav */
nav > div:last-child > div:first-child > *:nth-child(3),
nav > div:last-child > div:first-child > *:nth-child(4),
nav > div:last-child > button {
  display: none !important;
}

/* Let the code editor fill the full width (no menu panel beside it) */
section.code-container {
  flex: 1 1 auto !important;
  max-height: var(--djopus-editor-max-height);
  overflow-y: auto !important;
}

/* Prevent body scrolling in widget context */
html, body {
  overflow: hidden !important;
  height: 100% !important;
}

/* Compact the top nav bar */
nav:first-of-type {
  min-height: 36px !important;
  max-height: 36px !important;
}

/* Ensure the main flex container fits the widget viewport */
.h-full.flex.flex-col.relative {
  height: var(--djopus-shell-height) !important;
  max-height: var(--djopus-shell-height) !important;
}
</style>`;

const layoutScript = `<script>
(function() {
  'use strict';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function applyLayout(payload) {
    var displayMode = payload && payload.displayMode ? payload.displayMode : 'inline';
    var rawHeight = Number(payload && payload.height) || window.innerHeight || 500;
    var minHeight = displayMode === 'pip' ? 260 : 360;
    var shellHeight = clamp(rawHeight, minHeight, 1400);
    var editorMaxHeight = Math.max(displayMode === 'pip' ? 150 : 220, shellHeight - (displayMode === 'pip' ? 86 : 126));

    document.documentElement.style.setProperty('--djopus-shell-height', shellHeight + 'px');
    document.documentElement.style.setProperty('--djopus-editor-max-height', editorMaxHeight + 'px');
  }

  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'djopus:layout') {
      applyLayout(event.data);
    }
  });

  window.addEventListener('resize', function() {
    applyLayout({ height: window.innerHeight });
  }, { passive: true });

  applyLayout({ height: window.innerHeight });
})();
</script>`;

const bridgeScript = `<script>
(function() {
  'use strict';

  // The REPL is a child of the app shell. The host bridge lives in the
  // shell, so send follow-up requests there instead of looking for window.openai.
  // ── "Ask DJ Opus" button ─────────────────────────────────────────────

  function createAskButton() {
    var btn = document.createElement('button');
    btn.id = 'djopus-ask-btn';
    btn.textContent = 'Ask DJ Opus';
    btn.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:99998;' +
      'background:#ffcc00;color:#222;border:none;border-radius:8px;' +
      'padding:8px 16px;font-size:14px;font-weight:bold;cursor:pointer;' +
      'font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);';

    btn.addEventListener('click', function() {
      var code = '';
      var bpm = 120;
      try {
        var sm = window.strudelMirror;
        if (sm) {
          code = sm.code || '';
          if (sm.repl && sm.repl.scheduler) {
            bpm = sm.repl.scheduler.cps ? Math.round(sm.repl.scheduler.cps * 60 * 4) : 120;
          }
        }
      } catch (e) {
        console.warn('[djopus-widget] error reading state:', e);
      }

      var prompt = 'I have this Strudel pattern at ' + bpm + ' BPM';
      if (code) {
        prompt += ':\\n\`\`\`\\n' + code + '\\n\`\`\`\\n';
      } else {
        prompt += ' (empty editor). ';
      }
      prompt += 'Suggest a creative modification or new pattern.';

      window.parent.postMessage({ type: 'djopus:ask', prompt: prompt }, '*');
    });

    document.body.appendChild(btn);
  }

  // ── Init: poll for strudelMirror (same pattern as strudel-ws-bridge) ─

  function initWidget() {
    if (window.strudelMirror) {
      createAskButton();
    } else {
      setTimeout(initWidget, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }
})();
</script>`;

// ── Main export ──────────────────────────────────────────────────────────

/**
 * Returns a lightweight widget shell for ChatGPT. The full Strudel REPL runs
 * in a child iframe hosted at `/widget`, which gives it a normal document
 * origin instead of the stricter `srcdoc` environment used for MCP templates.
 */
export function getWidgetShellHtml(_sessionId: string, origin: string, preventShareLookup = false, sourceUrl?: string): string {
  const sourceLink = sourceUrl
    ? `<a id="source-link" class="toolbar-btn" href="${sourceUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}" target="_blank" rel="noopener noreferrer">Source</a>`
    : '';
  const sourceHandler = sourceUrl ? `
        document.getElementById('source-link').addEventListener('click', function(event) {
          var url = ${serializeForInlineScript(sourceUrl)};
          if (bridgeReady) {
            event.preventDefault();
            requestHost('ui/open-link', { url: url });
          } else if (window.openai && typeof window.openai.openExternal === 'function') {
            event.preventDefault();
            window.openai.openExternal({ href: url, redirectUrl: false });
          }
        });` : '';
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>DJ Opus</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #161616;
        color: #f6f6f6;
        font-family: ui-sans-serif, system-ui, sans-serif;
        display: flex;
        flex-direction: column;
      }

      #toolbar {
        position: relative;
        z-index: 2;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
        padding: 10px 10px 6px;
        background: linear-gradient(180deg, rgba(22, 22, 22, 0.96), rgba(22, 22, 22, 0.72));
      }

      .toolbar-btn {
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 999px;
        background: rgba(14, 14, 14, 0.82);
        color: #f5f5f5;
        padding: 6px 10px;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
        backdrop-filter: blur(10px);
        text-decoration: none;
      }

      .toolbar-btn[hidden] {
        display: none;
      }

      .toolbar-btn:hover {
        background: rgba(36, 36, 36, 0.9);
      }

      #frame {
        width: 100%;
        flex: 1 1 auto;
        min-height: 220px;
        border: 0;
        display: block;
        background: #111;
      }

      #fallback {
        display: none;
        padding: 12px;
        font-size: 14px;
      }

      a {
        color: #9ecbff;
      }

      @media (max-width: 480px) {
        #toolbar {
          justify-content: flex-start;
          gap: 6px;
          padding: 8px 8px 4px;
        }

        .toolbar-btn {
          padding: 6px 8px;
          font-size: 11px;
        }
      }
    </style>
  </head>
  <body>
    <div id="toolbar">
      ${sourceLink}
      <button id="pip-btn" class="toolbar-btn" type="button" hidden>Keep visible</button>
      <button id="fullscreen-btn" class="toolbar-btn" type="button" hidden>Fullscreen</button>
    </div>
    <iframe
      id="frame"
      allow="autoplay"
      referrerpolicy="no-referrer"
    ></iframe>
    <div id="fallback">
      DJ Opus could not load inline.
      <a id="fallback-link" href="${origin}/widget" target="_blank" rel="noreferrer">Open DJ Opus directly</a>
    </div>
    <script>
      (function() {
        var frame = document.getElementById('frame');
        var toolbar = document.getElementById('toolbar');
        var fallback = document.getElementById('fallback');
        var fallbackLink = document.getElementById('fallback-link');
        var pipButton = document.getElementById('pip-btn');
        var fullscreenButton = document.getElementById('fullscreen-btn');
        var toolResult = null;
        var hostContext = {};
        var bridgeReady = false;
        var nextRequestId = 1;
        var initializeId = nextRequestId++;

        // MCP Apps uses JSON-RPC over postMessage. Keep the existing ChatGPT
        // globals as a fallback for hosts that only implement the older bridge.
        function sendToHost(message) {
          window.parent.postMessage(message, '*');
        }

        function notifyHost(method, params) {
          sendToHost({ jsonrpc: '2.0', method: method, params: params || {} });
        }

        function requestHost(method, params) {
          sendToHost({ jsonrpc: '2.0', id: nextRequestId++, method: method, params: params });
        }

        window.addEventListener('message', function(event) {
          if (event.source === frame.contentWindow && event.origin === ${serializeForInlineScript(origin)}) {
            if (event.data && event.data.type === 'djopus:ask' && typeof event.data.prompt === 'string') {
              if (bridgeReady) {
                requestHost('ui/message', { role: 'user', content: [{ type: 'text', text: event.data.prompt }] });
              } else if (window.openai && typeof window.openai.sendFollowUpMessage === 'function') {
                window.openai.sendFollowUpMessage({ prompt: event.data.prompt });
              }
            }
            return;
          }
          if (event.source !== window.parent || !event.data || event.data.jsonrpc !== '2.0') return;
          var message = event.data;
          if (message.id === initializeId && message.result) {
            bridgeReady = true;
            hostContext = message.result.hostContext || {};
            notifyHost('ui/notifications/initialized');
            updateToolbar();
            applyShellLayout();
          } else if (message.method === 'ui/notifications/tool-result') {
            toolResult = message.params || {};
            mountFrame();
          } else if (message.method === 'ui/notifications/host-context-changed') {
            hostContext = Object.assign({}, hostContext, message.params || {});
            updateToolbar();
            applyShellLayout();
          }
        });

        function getSessionId() {
          if (toolResult && toolResult._meta && typeof toolResult._meta.sessionId === 'string') {
            return toolResult._meta.sessionId;
          }
          if (window.openai) {
            var metadata = window.openai.toolResponseMetadata;
            if (metadata && typeof metadata.sessionId === 'string' && metadata.sessionId.length > 0) {
              return metadata.sessionId;
            }

            var output = window.openai.toolOutput;
            if (output && typeof output.sessionId === 'string' && output.sessionId.length > 0) {
              return output.sessionId;
            }
          }

          return null;
        }

        function getWidgetUrl(sessionId) {
          // Strudel treats any query string as a Supabase share-code lookup
          // unless a code fragment exists. The fragment decodes to a harmless
          // comment; session_state restores the real editor contents. Keep the
          // capability in the query so Cloudflare query redaction still covers it.
          return '${origin}/widget?session=' + encodeURIComponent(sessionId) + '${preventShareLookup ? '#Ly8' : ''}';
        }

        function getDisplayMode() {
          return hostContext.displayMode || (window.openai && window.openai.displayMode) || 'inline';
        }

        function getFrameHeight() {
          var maxHeight = Number(hostContext.containerDimensions && hostContext.containerDimensions.maxHeight) || Number(window.openai && window.openai.maxHeight) || window.innerHeight || 560;
          var minHeight = getDisplayMode() === 'pip' ? 260 : 420;
          return Math.max(minHeight, maxHeight);
        }

        function postLayoutToFrame() {
          if (!frame.contentWindow) return;
          frame.contentWindow.postMessage({
            type: 'djopus:layout',
            displayMode: getDisplayMode(),
            height: getFrameHeight(),
          }, '${origin}');
        }

        function applyShellLayout() {
          var shellHeight = getFrameHeight();
          var toolbarHeight = toolbar.offsetHeight || 0;
          var frameHeight = Math.max(220, shellHeight - toolbarHeight - 6);
          frame.style.height = frameHeight + 'px';

          if (bridgeReady) {
            notifyHost('ui/notifications/size-changed', { width: window.innerWidth, height: toolbarHeight + frameHeight + 6 });
          } else if (window.openai && window.openai.notifyIntrinsicHeight) {
            window.openai.notifyIntrinsicHeight(toolbarHeight + frameHeight + 6);
          }

          postLayoutToFrame();
        }

        function updateToolbar() {
          var legacy = window.openai && typeof window.openai.requestDisplayMode === 'function';
          var modes = bridgeReady && Array.isArray(hostContext.availableDisplayModes) ? hostContext.availableDisplayModes : [];
          var displayMode = getDisplayMode();
          pipButton.hidden = displayMode === 'pip' || (!legacy && modes.indexOf('pip') < 0);
          fullscreenButton.hidden = displayMode === 'fullscreen' || (!legacy && modes.indexOf('fullscreen') < 0);
        }

        function showFallback() {
          frame.style.display = 'none';
          fallback.style.display = 'block';
        }

        function mountFrame() {
          var sessionId = getSessionId();
          if (!sessionId) {
            showFallback();
            return;
          }

          var widgetUrl = getWidgetUrl(sessionId);
          if (frame.src !== widgetUrl) {
            frame.src = widgetUrl;
          }
          fallbackLink.href = widgetUrl;
          if (window.openai && typeof window.openai.setOpenInAppUrl === 'function') {
            window.openai.setOpenInAppUrl({ href: widgetUrl });
          }
          frame.style.display = 'block';
          fallback.style.display = 'none';
          updateToolbar();
        }

        ${sourceHandler}

        pipButton.addEventListener('click', function() {
          if (bridgeReady && (hostContext.availableDisplayModes || []).indexOf('pip') >= 0) {
            requestHost('ui/request-display-mode', { mode: 'pip' });
          } else if (window.openai && typeof window.openai.requestDisplayMode === 'function') {
            window.openai.requestDisplayMode({ mode: 'pip' });
          }
        });

        fullscreenButton.addEventListener('click', function() {
          if (bridgeReady && (hostContext.availableDisplayModes || []).indexOf('fullscreen') >= 0) {
            requestHost('ui/request-display-mode', { mode: 'fullscreen' });
          } else if (window.openai && typeof window.openai.requestDisplayMode === 'function') {
            window.openai.requestDisplayMode({ mode: 'fullscreen' });
          }
        });

        frame.addEventListener('error', showFallback);
        frame.addEventListener('load', applyShellLayout);
        window.addEventListener('resize', applyShellLayout, { passive: true });
        window.addEventListener('openai:set_globals', function() {
          mountFrame();
          updateToolbar();
          applyShellLayout();
        }, { passive: true });
        sendToHost({
          jsonrpc: '2.0', id: initializeId, method: 'ui/initialize',
          params: { appInfo: { name: 'DJ Opus', version: '1.0.0' }, appCapabilities: { availableDisplayModes: ['inline', 'pip', 'fullscreen'] }, protocolVersion: '2026-01-26' }
        });
        mountFrame();
        updateToolbar();
        applyShellLayout();

        window.setTimeout(function() {
          applyShellLayout();
        }, 100);
      })();
    </script>
  </body>
</html>`;
}

/**
 * Fetches the REPL index.html from Cloudflare Assets and injects
 * widget configuration, CSS overrides, and the ChatGPT bridge script.
 *
 * @param assets - Cloudflare ASSETS Fetcher binding
 * @param sessionId - Session ID from the request URL (the route has already matched it against SESSION_PARAM_RE)
 * @returns Modified HTML string ready to serve as the widget
 */
export async function getWidgetHtml(assets: Fetcher, sessionId: string, origin: string): Promise<string> {
  const resp = await assets.fetch('http://localhost/');
  let html = await resp.text();

  // Every replacement below is a function, not a string: a replacement string has its
  // $-patterns ($&, $', $`, $$) expanded, and the session ID and the origin are not
  // ours to control.

  // CRITICAL: Replace the existing <base href="/"> with our origin.
  // ChatGPT renders widget HTML as srcdoc — the iframe has no real origin,
  // so relative URLs resolve to nothing. Only the FIRST <base> tag is used
  // by browsers, so we must replace the existing one, not add a second.
  html = html.replace('<base href="/">', () => `<base href="${origin}/">`);

  // Install storage shims before Astro's scripts run. The ChatGPT widget
  // executes inside a srcdoc iframe, where direct sessionStorage/localStorage
  // access can throw a SecurityError on opaque origins.
  html = html.replace('<head>', () => '<head>\n' + storageShimScript);

  // Inject config script and widget CSS before </head>
  html = html.replace(
    '</head>',
    () => configScript(sessionId, origin) + '\n' + widgetCSS + '\n' + layoutScript + '\n</head>',
  );

  // Inject ChatGPT bridge script AFTER the existing WS bridge
  // (must come after strudel-ws-bridge.js so window.strudelWSBridge exists)
  html = html.replace(
    '<script src="/strudel-ws-bridge.js"></script>',
    () => '<script src="/strudel-ws-bridge-chatgpt.js"></script>\n' + bridgeScript,
  );

  return html;
}
