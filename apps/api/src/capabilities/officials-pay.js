// Official fee and payment status (#88). The organiser records an agreed fee on an official assignment and where it stands; the official confirms
// receipt or disputes it. This is a record, not a ledger: money that moves through SportArena settles through #71, and a status here never means
// a payout happened unless the organiser recorded it. Every change is kept in an append-only log.
import { z } from 'zod';
import { cap, id, money, page } from '../registry.js';
import { many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { eventForOrganizer } from './events.js';

const TAG = 'Officials';
const ORDER = { none: 0, agreed: 1, due: 2, paid: 3 };
const log = (c, fo, actor, from, to, note) => c.query('INSERT INTO fixture_official_pay_log(fixture_official_id, actor_id, fee_minor, fee_currency, from_status, to_status, note) VALUES ($1,$2,$3,$4,$5,$6,$7)', [fo.id, actor, fo.fee_minor, fo.fee_currency, from, to, note ?? null]);

async function loadFo(c, foId) {
  const fo = (await c.query('SELECT fo.*, f.event_id, f.status AS fixture_status FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id WHERE fo.id=$1 FOR UPDATE OF fo', [foId])).rows[0];
  if (!fo) throw notFound('official assignment');
  return fo;
}

cap({
  name: 'set_official_fee', method: 'POST', path: '/official-assignments/:id/fee', tag: TAG,
  summary: 'Organiser records the fee for an official on a fixture and where payment stands (agreed, due, paid). Money moves only through the payment system; this is the record both sides see. A paid fee cannot be changed.',
  input: z.object({ id, fee_minor: money, currency: z.string().regex(/^[A-Z]{3}$/), status: z.enum(['agreed', 'due', 'paid']), note: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const fo = await loadFo(c, i.id);
      const ev = await eventForOrganizer(user, fo.event_id, c);
      if (!['invited', 'accepted'].includes(fo.status)) throw conflict(`Assignment is ${fo.status}`);
      if (fo.pay_status === 'paid') throw conflict('This fee is already marked paid and cannot be changed');
      if (fo.pay_status !== 'disputed' && ORDER[i.status] < ORDER[fo.pay_status]) throw badRequest(`Payment cannot move back from ${fo.pay_status} to ${i.status}`);
      if (i.status === 'paid' && fo.status !== 'accepted') throw badRequest('Only a confirmed official can be marked paid');
      const next = { ...fo, fee_minor: i.fee_minor, fee_currency: i.currency };
      await c.query('UPDATE fixture_officials SET fee_minor=$2, fee_currency=$3, pay_status=$4, pay_updated_at=now(), pay_updated_by=$5, pay_confirmed_at=NULL WHERE id=$1', [fo.id, i.fee_minor, i.currency, i.status, user.id]);
      await log(c, next, user.id, fo.pay_status, i.status, i.note);
      await notify(c, fo.user_id, { kind: 'official_assignment', title: i.status === 'paid' ? 'Fee marked as paid' : 'Fee recorded', body: `${ev.name}: ${(i.fee_minor / 100).toFixed(2)} ${i.currency} is ${i.status}.`, data: { fixture_id: fo.fixture_id, official_id: fo.id } });
      return (await c.query('SELECT id, fee_minor::float8 AS fee_minor, fee_currency, pay_status, pay_updated_at, pay_confirmed_at FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
    });
  },
});

cap({
  name: 'respond_official_payment', method: 'POST', path: '/official-assignments/:id/payment-response', tag: TAG,
  summary: 'The official confirms they received a paid fee, or disputes a due or paid fee (the organiser is told; the record keeps both).',
  input: z.object({ id, response: z.enum(['confirm', 'dispute']), note: z.string().trim().min(2).max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const fo = await loadFo(c, i.id);
      if (fo.user_id !== user.id) throw forbidden('This assignment is not yours');
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [fo.event_id])).rows[0];
      if (i.response === 'confirm') {
        if (fo.pay_status !== 'paid') throw conflict('Only a fee marked paid can be confirmed');
        await c.query('UPDATE fixture_officials SET pay_confirmed_at=coalesce(pay_confirmed_at, now()) WHERE id=$1', [fo.id]);
        await log(c, fo, user.id, 'paid', 'paid', 'Confirmed received');
      } else {
        if (!['due', 'paid'].includes(fo.pay_status)) throw conflict('There is nothing to dispute yet');
        if (!i.note) throw badRequest('Say what is wrong so the organiser can fix it');
        await c.query("UPDATE fixture_officials SET pay_status='disputed', pay_updated_at=now(), pay_updated_by=$2, pay_confirmed_at=NULL WHERE id=$1", [fo.id, user.id]);
        await log(c, fo, user.id, fo.pay_status, 'disputed', i.note);
        await notify(c, ev.organizer_id, { kind: 'official_assignment', title: 'An official disputes a fee', body: `${ev.name}: a ${fo.role} says the recorded fee is wrong.`, data: { fixture_id: fo.fixture_id, official_id: fo.id } });
      }
      return (await c.query('SELECT id, fee_minor::float8 AS fee_minor, fee_currency, pay_status, pay_updated_at, pay_confirmed_at FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
    });
  },
});

cap({
  name: 'list_official_payment_log', method: 'GET', path: '/official-assignments/:id/payment-log', tag: TAG,
  summary: 'Every change to an official\'s fee and payment status, in order (the official and the organiser).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const fo = (await many('SELECT fo.user_id, e.organizer_id FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id WHERE fo.id=$1', [i.id]))[0];
    if (!fo || (fo.user_id !== user.id && fo.organizer_id !== user.id && !user.roles?.includes('admin'))) throw notFound('official assignment');
    return many('SELECT l.fee_minor, l.fee_currency, l.from_status, l.to_status, l.note, l.at, u.display_name AS actor_name FROM fixture_official_pay_log l JOIN users u ON u.id=l.actor_id WHERE l.fixture_official_id=$1 ORDER BY l.at, l.id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
  },
});
