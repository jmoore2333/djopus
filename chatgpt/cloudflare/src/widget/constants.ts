export const WIDGET_RESOURCE_URI = 'ui://widget/dj-opus-unified-v1.html';
// Bump this when the ChatGPT widget shell changes so the host fetches a fresh template.
export const CHATGPT_WIDGET_RESOURCE_URI = 'ui://widget/dj-opus-unified-v3.html';
export const CHATGPT_WIDGET_V2_RESOURCE_URI = 'ui://widget/dj-opus-unified-v2.html';
// Release candidate only: create the reviewed version tag and make it available
// in the public DJ Opus repository before deploying a widget that advertises it.
export const CHATGPT_SOURCE_URL = 'https://github.com/jmoore2333/djopus/tree/chatgpt-v0.1.4/chatgpt';
export function widgetResourceUri(chatgpt: boolean): string {
  return chatgpt ? CHATGPT_WIDGET_RESOURCE_URI : WIDGET_RESOURCE_URI;
}
export const WIDGET_RESOURCE_NAME = 'widget';
export const WIDGET_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
export const WIDGET_DESCRIPTION = 'DJ Opus live-coding music widget';
export const WIDGET_MODEL_DESCRIPTION =
  'DJ Opus live-coding Strudel REPL with inline playback and editing controls. When the user asks to start music, open the REPL and then use DJ Opus.compose or DJ Opus.write directly instead of only pasting code into chat. If audio seems stuck or the session needs a clean reset, use the DJ Opus recovery tools instead of guessing.';
