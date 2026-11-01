// Federation extras (#703) 3/3: the optional demographic a federation census can count, held ONLY if the person chose to give it.
// Gender is encrypted (`gender_enc`) with a keyed blind index so a census can group by it without decrypting anything; giving it is consent, withdrawing it
// is one call and the census then counts the person as "not stated". A young person's is given (and withdrawn) by their verified guardian. Every read is audit-logged.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, tx } from '../db.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt, blindIndex } from '../crypto.js';
import { actingFor } from '../youth.js';
import { GENDERS } from '../kpi/catalogue.js';

const TAG = 'People';
const KEYS = GENDERS.map((g) => g.key);
const view = (row, by) => ({ user_id: row?.user_id ?? null, held: !!row && !row.withdrawn_at, given_at: row && !row.withdrawn_at ? row.consent_at : null, withdrawn_at: row?.withdrawn_at ?? null, choices: GENDERS, by });

cap({
  name: 'get_demographics', method: 'GET', path: '/demographics', tag: TAG,
  summary: 'The optional census information you have chosen to give (today: gender). Nothing is held unless you gave it. Yours, or a young person\'s if you are their verified guardian with the `consent` scope. Reading it is audit-logged.',
  input: z.object({ user_id: id.optional() }),
  async handler({ user }, i) {
    const sid = i.user_id ?? user.id, by = await actingFor(user, sid, 'consent');
    const row = await one('SELECT * FROM person_demographics WHERE user_id=$1', [sid]);
    await audit(null, user.id, 'read_demographics', 'person_demographics', sid);
    return { ...view(row, by), gender: row && !row.withdrawn_at ? decrypt(row.gender_enc, 'person_demographics.gender') : null };
  },
});

cap({
  name: 'set_demographics', method: 'POST', path: '/demographics', tag: TAG,
  summary: 'Choose to give your gender for your federation\'s census. It is optional, encrypted, counted only in totals of five or more, and you can withdraw it at any time. A guardian gives it for a young person (scope `consent`). Pass consent=true to confirm.',
  input: z.object({ user_id: id.optional(), gender: z.enum(KEYS), consent: z.literal(true) }),
  handler: ({ user }, i) => tx(async (c) => {
    const sid = i.user_id ?? user.id, by = await actingFor(user, sid, 'consent');
    const row = (await c.query(
      `INSERT INTO person_demographics(user_id, gender_enc, gender_idx, given_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET gender_enc=EXCLUDED.gender_enc, gender_idx=EXCLUDED.gender_idx, given_by=EXCLUDED.given_by, consent_at=now(), withdrawn_at=NULL, updated_at=now() RETURNING *`,
      [sid, encrypt(i.gender, 'person_demographics.gender'), blindIndex(`gender|${i.gender}`), user.id])).rows[0];
    await audit(c, user.id, 'set_demographics', 'person_demographics', sid);
    return view(row, by);
  }),
});

cap({
  name: 'withdraw_demographics', method: 'DELETE', path: '/demographics', tag: TAG,
  summary: 'Take back the census information you gave. The census stops counting it straight away (you become "not stated"); the withdrawal is kept as history, nothing else changes.',
  input: z.object({ user_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const sid = i.user_id ?? user.id, by = await actingFor(user, sid, 'consent');
    const row = (await c.query('UPDATE person_demographics SET withdrawn_at=coalesce(withdrawn_at, now()), updated_at=now() WHERE user_id=$1 RETURNING *', [sid])).rows[0];
    if (row) await audit(c, user.id, 'withdraw_demographics', 'person_demographics', sid);
    return view(row, by);
  }),
});
