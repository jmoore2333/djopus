import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getWidgetShellHtml } from './widget-html';
import {
  WIDGET_DESCRIPTION, WIDGET_MODEL_DESCRIPTION, WIDGET_RESOURCE_MIME_TYPE,
  WIDGET_RESOURCE_NAME, WIDGET_RESOURCE_URI, CHATGPT_WIDGET_RESOURCE_URI,
  CHATGPT_WIDGET_V2_RESOURCE_URI, CHATGPT_SOURCE_URL,
} from './constants';

/** The UI template is static; the launcher supplies the session capability in tool-result metadata. */
export function registerWidgetResource(server: McpServer, origin: string, chatgpt = false): void {
  const websocketOrigin = origin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const register = (name: string, uri: string, preventShareLookup = false, sourceUrl?: string) => server.registerResource(name, uri, {
    description: WIDGET_DESCRIPTION, mimeType: WIDGET_RESOURCE_MIME_TYPE,
  }, async () => ({
    contents: [{
      uri, mimeType: WIDGET_RESOURCE_MIME_TYPE,
      text: getWidgetShellHtml('', origin, preventShareLookup, sourceUrl),
      _meta: {
        ui: { prefersBorder: true, domain: origin, csp: { resourceDomains: [origin], connectDomains: [origin, websocketOrigin], frameDomains: [origin] } },
        'openai/widgetDescription': WIDGET_MODEL_DESCRIPTION,
        'openai/widgetPrefersBorder': true,
        'openai/widgetDomain': origin,
        'openai/widgetCSP': { resource_domains: [origin], connect_domains: [origin, websocketOrigin], frame_domains: [origin] },
      },
    }],
  }));
  // Keep the old URI available for existing conversations and generic clients.
  register(WIDGET_RESOURCE_NAME, WIDGET_RESOURCE_URI);
  if (chatgpt) {
    // Retain both older templates for existing conversations; a fresh URI
    // ensures hosts fetch the source-link UI instead of a cached template.
    register(`${WIDGET_RESOURCE_NAME}-v2`, CHATGPT_WIDGET_V2_RESOURCE_URI, true);
    register(`${WIDGET_RESOURCE_NAME}-v3`, CHATGPT_WIDGET_RESOURCE_URI, true, CHATGPT_SOURCE_URL);
  }
}
