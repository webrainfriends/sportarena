// Standard country rulebooks (#568 follow-up): a reference catalogue of the six standard rules for each priority country, as jurisdiction packs.
// Browsing is open to anyone who runs a scope; installing writes them into the platform rulebook through import_compliance_rules, so they get the
// same checks as a hand-written pack (laws wait for a second platform administrator, nothing is imported twice). One engine, one rulebook.
import { z } from 'zod';
import { cap, capabilities } from '../registry.js';
import { badRequest, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { invoke } from '../invoke.js';
import { standardCountries, standardPack } from '../compliance-rulebooks.js';
import { TAG } from './compliance.js';

const country = z.string().regex(/^[A-Za-z]{2}$/).transform((x) => x.toUpperCase());

cap({
  name: 'list_standard_rulebooks', method: 'GET', path: '/compliance/rulebooks', tag: TAG,
  summary: 'The standard country rulebooks the platform ships: for each priority country, how many rules, and the version. A research anchor and checklist, not legal advice.',
  input: z.object({}),
  async handler({ user }) {
    if (!user) throw notFound('Rulebooks');
    return { items: standardCountries() };
  },
});

cap({
  name: 'get_standard_rulebook', method: 'GET', path: '/compliance/rulebooks/:country', tag: TAG,
  summary: 'One standard country rulebook as a jurisdiction pack: each rule with the instrument it is anchored to, the regulator\'s link, who must review it, its classification and what it stops. Export it, read it, or install it.',
  input: z.object({ country }),
  async handler({ user }, i) {
    if (!user) throw notFound('Rulebook');
    const pack = standardPack(i.country);
    if (!pack) throw notFound('Rulebook');
    return pack;
  },
});

cap({
  name: 'install_standard_rulebook', method: 'POST', path: '/compliance/rulebooks/:country/install', tag: TAG, status: 201,
  summary: 'Install a standard country rulebook into the platform rulebook (platform administrators only). Checked and imported like any pack: laws and regulations wait for a second platform administrator to approve them, recommended standards advise and never block, and a rule already installed is skipped, so installing twice changes nothing. Tailor a rule afterwards by writing a narrower rule of your own for a state or municipality.',
  input: z.object({ country }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw notFound('Rulebook');
    const pack = standardPack(i.country);
    if (!pack) throw badRequest('There is no standard rulebook for that country');
    const imp = capabilities.find((x) => x.name === 'import_compliance_rules');
    const out = await invoke(imp, user, { scope_kind: 'platform', pack: { format: pack.format, rules: pack.rules } });
    return { country: i.country, version: pack.version, ...out };
  },
});
