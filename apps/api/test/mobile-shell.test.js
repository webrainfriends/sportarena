import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static checks on the role-driven mobile shell (issue #599): the app has no test runner of its own, so the wiring that
// white-screens a phone when it is wrong is checked here, the way app-routes.test.js does for screens.
const src = new URL('../../app/src/', import.meta.url);
const read = (f) => readFileSync(new URL(f, src), 'utf8');
const app = read('App.js');

test('the bar is Home, Calendar, More (centre swivel), Work and Profile; the Inbox is the top-right button', () => {
  const bar = app.match(/const BAR = \[([^\]]*)\]/)[1].match(/'([A-Za-z]+)'/g).map((x) => x.replaceAll("'", ''));
  assert.deepEqual(bar, ['Home', 'Schedule', 'Hub', 'Work', 'Me']);
  const tabs = [...app.match(/const TABS = \[(.*)\];/)[1].matchAll(/\['([A-Za-z]+)',/g)].map((m) => m[1]);
  for (const t of bar.filter((x) => x !== 'Hub')) assert.ok(tabs.includes(t), `${t} is a tab`); // Hub is the swivel: it toggles the overlay, it is not a page
  assert.match(app, /centre \? toggleMenu\(\)/, 'the centre button opens the swivel');
  assert.match(app, /<InboxButton \/><AccountButton \/>/, 'the Inbox sits beside the account button at the top right');
  const labels = app.match(/const TAB_LABEL = \{([^}]*)\}/)[1];
  assert.match(labels, /Schedule: 'Calendar'/);
  assert.match(labels, /Me: 'Profile'/);
  assert.match(labels, /Hub: 'More'/);
  assert.match(labels, /Work: 'Workbench'/);
  for (const t of ['Work', 'Inbox', 'Hub']) assert.match(read('icons.js'), new RegExp(`\\n  ${t}: wrap`), `${t} has an icon`);
});

test('the workspace is provided to the shell, behind the session and navigation', () => {
  assert.match(app, /<SessionProvider><AppLockProvider><BasketProvider><NavProvider><WorkspaceProvider><Shell \/>/);
});

test('Community and Inbox stay reachable as pushed pages with titles, and the old inbox section is gone from the settings page', () => {
  assert.match(app, /const PAGES = \{[^}\n]*\bCommunity, Inbox\b/); // whatever else is registered before them, they stay in the map
  assert.match(app, /const TITLES = \{[^}\n]*\bCommunity: 'Community', Inbox: 'Inbox'/);
  const reserve = read('screens/reserve.js');
  const settings = reserve.slice(reserve.indexOf('export function Notifications()'));
  assert.ok(!settings.includes('<Section title="Inbox"'), 'one inbox: the list lives in the Inbox tab only');
  assert.match(settings, /Notification settings/);
});

test('one-tap answers go through the retry outbox with a client_key and never persist to disk', () => {
  const ws = read('workspace.js');
  assert.match(ws, /send\(q\.path, \{ \.\.\.q\.body, client_key: key\(\) \}/);
  const outbox = read('outbox.js');
  assert.ok(!/AsyncStorage|SecureStore|localStorage|FileSystem/.test(outbox), 'the outbox stays in memory');
  assert.match(outbox, /method = 'post'/);
});

test('deep links: only the app\'s own scheme or a listed https host open anything, and only to known target syntax', () => {
  const code = read('deeplink.js').replace('export function', 'function') + '\nreturn targetFromUrl;';
  const targetFromUrl = new Function(code)();
  assert.equal(targetFromUrl('sportarena://gate/0f1c2d3e-4a5b-6c7d-8e9f-a0b1c2d3e4f5'), 'gate:0f1c2d3e-4a5b-6c7d-8e9f-a0b1c2d3e4f5');
  assert.equal(targetFromUrl('sportarena://open?target=event-accreditation:abc-123'), 'event-accreditation:abc-123');
  assert.equal(targetFromUrl('sportarena://my-integrity'), 'my-integrity');
  assert.equal(targetFromUrl('https://gotmygame.com/event/abc-123', ['gotmygame.com']), 'event:abc-123');
  assert.equal(targetFromUrl('https://evil.example/event/abc-123', ['gotmygame.com']), null, 'a foreign host is ignored');
  assert.equal(targetFromUrl('https://gotmygame.com/event/abc-123'), null, 'no hosts configured: https links are ignored');
  assert.equal(targetFromUrl('sportarena://gate/../../etc'), null);
  assert.equal(targetFromUrl('sportarena://open?target=<script>'), null);
  assert.equal(targetFromUrl('javascript:alert(1)'), null);
  assert.equal(targetFromUrl(null), null);
});

test('the device lock is native-only, asks for one successful check before turning on, and always offers sign out', () => {
  const lock = read('app-lock.js');
  assert.match(lock, /Platform\.OS === 'web' \|\| !Local/);
  assert.match(lock, /Turn on the device lock/);
  assert.match(lock, /Sign out instead/);
  assert.match(read('screens/security.js'), /<DeviceLockRow \/>/);
  assert.match(readFileSync(new URL('../../app/app.json', import.meta.url), 'utf8'), /expo-local-authentication/);
});

test('every fast action is at least 44pt and labelled for screen readers', () => {
  const home = read('screens/role-home.js');
  assert.match(home, /minHeight: 88/);
  assert.match(home, /accessibilityRole="button" accessibilityLabel=\{a\.label\}/);
  assert.match(home, /accessibilityLiveRegion="polite"/);
});

test('Work is the role\'s one workspace: no "All tools" button, the swivel's Workspaces tile lists every held role', () => {
  const home = read('screens/role-home.js');
  assert.ok(!home.includes('All tools and modules'), 'the swivel is the More button now');
  assert.match(home, /ScreenHeaderProvider value=\{queue\}/, 'the queue tops the role\'s own screen');
  const catalog = read('screens/more-catalog.js').replace(/export /g, '') + '\nreturn { workspacesFor, orderedModules };';
  const { workspacesFor, orderedModules } = new Function(catalog)();
  assert.deepEqual(workspacesFor(['coach', 'sponsor', 'athlete']).map((w) => w[0]), ['coach', 'sponsor', 'athlete'], 'every held role has a workspace in the swivel');
  assert.deepEqual(workspacesFor([]), []);
  assert.deepEqual(workspacesFor(['platform_admin']).map((w) => w[0]), ['platform_admin', 'platform_admin']); // the commercial console and the keys & audit console
  assert.deepEqual(workspacesFor(['athlete'], true).map((w) => w[0]), ['venue_manager'], 'a front-desk cashier still reaches the desk');
  assert.ok(orderedModules(['coach']).some((m) => m[0] === 'Workspace'));
  assert.ok(!orderedModules([]).some((m) => m[0] === 'Workspace'));
});
