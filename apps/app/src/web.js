// Makes the web build behave like an installed app: no browser-style page bounce, no text-selection / tap flashes on
// controls, safe-area aware, correct mobile viewport height, and "Add to Home Screen" opens it full-screen.
import { Platform } from 'react-native';
import { c, dark } from './theme';

export function installWebShell() {
  if (Platform.OS !== 'web' || typeof document === 'undefined' || document.getElementById('sa-shell')) return;
  const meta = (name, content) => { const m = document.createElement('meta'); m.name = name; m.content = content; document.head.appendChild(m); };
  const vp = document.querySelector('meta[name=viewport]');
  const viewport = 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';
  if (vp) vp.setAttribute('content', viewport); else meta('viewport', viewport);
  meta('theme-color', c.bg);
  meta('mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-status-bar-style', dark ? 'black-translucent' : 'default');
  meta('apple-mobile-web-app-title', 'SportArena');
  const link = (rel, href, extra = {}) => { const l = document.createElement('link'); l.rel = rel; l.href = href; Object.assign(l, extra); document.head.appendChild(l); };
  link('manifest', '/manifest.webmanifest');
  link('apple-touch-icon', '/icon-192.png');
  const style = document.createElement('style');
  style.id = 'sa-shell';
  style.textContent = `
    html, body { height: 100%; overscroll-behavior: none; -webkit-text-size-adjust: 100%; background: ${c.bg}; color-scheme: ${dark ? 'dark' : 'light'}; }
    body { overflow: hidden; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; touch-action: manipulation; }
    #root { height: 100vh; height: 100dvh; display: flex; }
    * { -webkit-user-select: none; user-select: none; }
    input, textarea, [contenteditable], [data-selectable] { -webkit-user-select: text; user-select: text; }
    div[role=button], [tabindex], a { cursor: pointer; }
    ::-webkit-scrollbar { width: 0; height: 0; }
    * { scrollbar-width: none; }
  `;
  document.head.appendChild(style);
}
