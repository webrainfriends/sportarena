// Turns a link that opened the app (sportarena://gate/<event id>, sportarena://open?target=gate:<id>, a universal link path) into the
// "kind:id:extra" target string that push.js parseTarget already understands, so a link, a tapped push and a web ?open= all land on the
// same screen. Pure on purpose (no React Native import) so it can be tested on its own. Only the app's own scheme or an https link
// on the app's own host is accepted: anything else returns null and is ignored.
const SCHEME = /^sportarena:\/\//i;

/** @param {string|null|undefined} url @param {string[]} [hosts] https hosts that belong to the app @returns {string|null} */
export function targetFromUrl(url, hosts = []) {
  if (!url || typeof url !== 'string' || url.length > 600) return null;
  let rest;
  if (SCHEME.test(url)) rest = url.replace(SCHEME, '');
  else {
    const m = /^https:\/\/([^/?#]+)\/(.*)$/i.exec(url);
    if (!m || !hosts.map((h) => h.toLowerCase()).includes(m[1].toLowerCase())) return null;
    rest = m[2];
  }
  const [path, query = ''] = rest.split('#')[0].split('?');
  const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts[0] === 'open') {
    const t = new URLSearchParams(query).get('target');
    return t && /^[a-z0-9:_-]{1,120}$/i.test(t) ? t : null;
  }
  if (!parts.length || !parts.every((p) => /^[a-z0-9_-]{1,80}$/i.test(p))) return null;
  return parts.join(':');
}
