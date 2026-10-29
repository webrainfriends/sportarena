import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static checks on the device lock, deep links and retry outbox (issue #599, ported onto the command-centre workspace of #562).
// The app has no test runner of its own, so the wiring that white-screens a phone when it is wrong is checked here.
const src = new URL('../../app/src/', import.meta.url);
const read = (f) => readFileSync(new URL(f, src), 'utf8');
const app = read('App.js');

test('the lock provider wraps the shell inside the session, and links are opened with the same targets as a tapped push', () => {
  assert.match(app, /<SessionProvider><AppLockProvider><BasketProvider><NavProvider><Shell \/>/);
  assert.match(app, /import \{ [^}]*Linking[^}]* \} from 'react-native'/);
  assert.match(app, /targetFromUrl\(url, APP_HOSTS\)/);
  assert.match(app, /link\.remove\(\)/);
});

test('the retry outbox takes a method, stays in memory and still needs a client_key', () => {
  const outbox = read('outbox.js');
  assert.match(outbox, /method = 'post'/);
  assert.match(outbox, /outbox writes need a client_key/);
  assert.ok(!/AsyncStorage|SecureStore|localStorage|FileSystem/.test(outbox), 'the outbox stays in memory');
});

test('deep links: only the app\'s own scheme or a listed https host open anything, and only to known target syntax', () => {
  const code = read('deeplink.js').replace('export function', 'function') + '\nreturn targetFromUrl;';
  const targetFromUrl = new Function(code)();
  assert.equal(targetFromUrl('sportarena://gate/0f1c2d3e-4a5b-6c7d-8e9f-a0b1c2d3e4f5'), 'gate:0f1c2d3e-4a5b-6c7d-8e9f-a0b1c2d3e4f5');
  assert.equal(targetFromUrl('sportarena://open?target=event-accreditation:abc-123'), 'event-accreditation:abc-123');
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
