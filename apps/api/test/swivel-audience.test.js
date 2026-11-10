// The More swivel offers each person only the modules meant for the roles they hold, and the rulebook's official link is offered only when it answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOOKS, POINTS } from '../src/rulebook/catalog.js';
import { resolveBook } from '../src/rulebook/apply.js';
import { linkCandidates, officialLink, setLinkProbe } from '../src/rulebook/links.js';

const src = readFileSync(resolve(import.meta.dirname, '../../app/src/screens/more-catalog.js'), 'utf8').replace(/export /g, '') + '\nreturn { MODULES, AUDIENCE, orderedModules, moduleVisible, isClinician };';
const { MODULES, AUDIENCE, orderedModules, moduleVisible, isClinician } = new Function(src)();
const names = (roles, desk) => orderedModules(roles, desk).map((m) => m[0]);

test('an athlete-only account sees no organisation, business or practice modules', () => {
  const mine = names(['athlete']);
  for (const hidden of ['Orgs', 'Federations', 'MediaWorkspace', 'Analytics', 'Supply', 'ServicesBuyer', 'Marketplace', 'Advertising', 'Finance', 'Earnings', 'EventInbox', 'Openings', 'Sponsors', 'Insurance']) assert.ok(!mine.includes(hidden), `${hidden} is not for an athlete`);
  for (const kept of ['FindGames', 'Leaderboard', 'Health', 'Insure', 'Wallet', 'MyLicences', 'MyDevelopment', 'Family', 'Support']) assert.ok(mine.includes(kept), `${kept} stays for an athlete`);
  assert.equal(new Set(mine).size, mine.length, 'no module is offered twice');
  assert.equal(isClinician(['athlete']), false);
  assert.equal(isClinician(['athlete', 'physio']), true);
});

test('every restricted module names real routes and roles, and the roles that run things still get them', () => {
  const routes = new Set(MODULES.map((m) => m[0]));
  for (const [name, roles] of Object.entries(AUDIENCE)) { assert.ok(routes.has(name), `${name} is a module`); assert.ok(roles.length, `${name} has an audience`); }
  for (const role of ['organizer', 'venue_manager', 'coach', 'referee', 'supplier']) for (const m of ['Orgs', 'Analytics', 'Openings', 'Finance']) assert.ok(names([role]).includes(m), `${role} keeps ${m}`);
  assert.ok(names(['athlete', 'organizer']).includes('Orgs'), 'holding one qualifying role is enough');
  assert.ok(names(['doctor']).includes('Earnings') && !names(['doctor']).includes('Orgs'));
  assert.ok(moduleVisible('Finance', [], true), 'a front-desk cashier counts as venue staff');
  assert.equal(names(['platform_admin']).length, MODULES.length + 1, 'the platform team sees every module plus Workspaces');
});

test('the official rulebook link is offered only when the page answers, falling back to the body\'s home page', async () => {
  const book = BOOKS.football, [deep, home] = linkCandidates(book);
  assert.ok(deep.startsWith('https://') && home.endsWith('/') && deep !== home);
  for (const b of Object.values(BOOKS)) assert.ok(linkCandidates(b).every((u) => u.startsWith('https://')), `${b.name} only has https addresses`);
  const was = setLinkProbe(async () => true);
  try {
    assert.deepEqual({ ...(await officialLink(book)), checked_at: 0 }, { url: deep, verified: true, exact: true, checked_at: 0 });
    setLinkProbe(async (u) => u === home);
    const fallback = await officialLink(book);
    assert.equal(fallback.url, home); assert.equal(fallback.exact, false); assert.equal(fallback.verified, true);
    setLinkProbe(async () => false);
    assert.deepEqual({ ...(await officialLink(book)), checked_at: 0 }, { url: null, verified: false, exact: false, checked_at: 0 });
    let calls = 0; setLinkProbe(async () => { calls++; return true; });
    await officialLink(book); await officialLink(book);
    assert.equal(calls, 1, 'an answer is remembered, so a page of readers does not hammer the governing body');
  } finally { setLinkProbe(was); }
});

test('decision points: every listed rule exists, football is a full handbook, and a sport without them is labelled a summary', () => {
  for (const [slug, byRule] of Object.entries(POINTS)) {
    const rules = new Set(BOOKS[slug].cards.map((c) => c.no));
    for (const [no, list] of Object.entries(byRule)) { assert.ok(rules.has(no), `${slug} has ${no}`); assert.ok(list.length && list.every((p) => p.length > 20 && p.length < 400)); }
  }
  const fb = resolveBook('football', undefined, {});
  assert.equal(fb.depth, 'handbook'); assert.ok(fb.cards.every((c) => c.points.length >= 2), 'all 17 Laws carry decision points');
  for (const slug of Object.keys(BOOKS)) { const b = resolveBook(slug, undefined, {}); assert.equal(b.depth, POINTS[slug] ? 'handbook' : 'summary', slug); assert.ok(b.cards.every((c) => Array.isArray(c.points))); }
});
