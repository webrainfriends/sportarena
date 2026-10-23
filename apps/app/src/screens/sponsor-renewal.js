import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useNav } from '../nav';
import { Btn, Card, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';

export const STATUS_LABEL = { term_expired: 'term ended · dues open', completed: 'completed', paused: 'paused', proposed: 'proposed', active: 'active', ended: 'ended early', declined: 'declined', withdrawn: 'withdrawn' };
const INTENTS = [{ value: 'renew', label: 'We want to renew' }, { value: 'renegotiate', label: 'Renew, on new terms' }, { value: 'not_renew', label: 'We do not want to renew' }];
const INTENT = Object.fromEntries(INTENTS.map((i) => [i.value, i.label]));
const SIDE = { sponsor: 'The sponsor', recipient: 'The recipient' };
const when = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayAfter = (s) => { const d = new Date(`${String(s).slice(0, 10)}T00:00:00`); d.setDate(d.getDate() + 1); return iso(d); };
const yearAfter = (s) => { const d = new Date(`${String(s).slice(0, 10)}T00:00:00`); d.setFullYear(d.getFullYear() + 1); return iso(d); };

/**
 * Term end, final settlement and renewal (#299), on the agreement screen (one place). The end date and what is still owed are shown
 * separately; a renewal is a NEW agreement that the other side accepts at its exact terms version, so nothing ever renews by itself.
 */
export function SponsorRenewal({ deal: d, act }) {
  const { push } = useNav();
  const [form, setForm] = useState(null); // 'intent' | 'renew'
  const r = d.renewal;
  if (!r || !['sponsor', 'recipient'].includes(d.role)) return null;
  const me = d.role, other = me === 'sponsor' ? 'recipient' : 'sponsor';
  const mine = r.assessments.find((a) => a.side === me), theirs = r.assessments.find((a) => a.side === other);
  const s = r.settlement;
  const live = d.accepted_version && ['active', 'term_expired', 'completed'].includes(d.status);
  const stale = (e) => { d.reload?.(); return e.status === 409 && e.code !== 'renewal_exists' ? new Error('The agreement changed while you were editing. The latest version is now shown — review it and try again.') : e; };
  const owed = s && Object.entries(s.open_cents ?? {}).map(([cur, v]) => fmt(v, cur)).join(' · ');
  if (!live && !r.predecessor && !r.successor) return null;

  return (
    <Section title="Term & renewal" color={c.cyan}>
      {r.predecessor ? (
        <Card color={c.violetSoft}>
          <T accessibilityRole="text">This agreement is a renewal of {r.predecessor.agreement_ref ?? 'an earlier agreement'} ({STATUS_LABEL[r.predecessor.status] ?? r.predecessor.status}{r.predecessor.ends_on ? `, ended ${when(r.predecessor.ends_on)}` : ''}).</T>
          <Btn small title="View the previous agreement" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => push('SponsorDeal', { id: r.predecessor.id })} accessibilityLabel="Open the previous agreement and its payment history" />
        </Card>) : null}

      {live ? (
        <Card color={d.status === 'term_expired' ? c.pinkSoft : d.status === 'completed' ? c.lime : c.paper}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Tag label={STATUS_LABEL[d.status] ?? d.status} color={d.status === 'term_expired' ? c.pinkSoft : d.status === 'completed' ? c.lime : c.sunSoft} />
            {d.ends_on ? <T size={12} color={c.mute}>Term ends {when(d.ends_on)}{d.timezone ? ` (${d.timezone})` : ''}</T> : null}
          </View>
          {d.status === 'active' && r.days_left != null ? <T weight="800" style={{ marginTop: 8 }} accessibilityRole="text">{r.days_left > 0 ? `${r.days_left} day${r.days_left === 1 ? '' : 's'} left in the term` : 'The term ends today'}</T> : null}
          {s?.state === 'term_expired' ? (
            <View style={{ marginTop: 8 }} accessibilityRole="alert">
              <T weight="800">The term has ended, but {s.open_dues} due{s.open_dues === 1 ? ' is' : 's are'} still open{owed ? `: ${owed}` : ''}.</T>
              <T size={12} color={c.mute} style={{ marginTop: 4 }}>Reaching the end date does not settle anything. Open dues can still be paid, delivered or confirmed below; the agreement is marked completed once the last one is settled.</T>
            </View>) : null}
          {s?.state === 'completed' ? <T weight="800" style={{ marginTop: 8 }} accessibilityRole="text">Every due is settled{s.settled_at ? ` · ${when(s.settled_at)}` : ''}. The history stays available here.</T> : null}
          <T size={12} color={c.mute} style={{ marginTop: 8 }}>Nothing renews by itself. A renewal is a new agreement that the other side has to accept at its exact terms.</T>
        </Card>) : null}

      {live ? (
        <Card>
          <T weight="800">Renewal plans</T>
          {[['You', mine], ['The other side', theirs]].map(([who, a]) => (
            <T key={who} size={13} color={a ? c.ink : c.mute} style={{ marginTop: 4 }} accessibilityRole="text">{who}: {a ? `${INTENT[a.intent]}${a.note ? ` — ${a.note}` : ''} (${when(a.decided_at)})` : 'no answer yet'}</T>))}
          <T size={12} color={c.mute} style={{ marginTop: 4 }}>A plan is only a message to the other side. It does not renew or end anything.</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <Btn small title={mine ? 'Change our plan' : 'Share our plan'} color={c.cyan} ink={c.ink} onPress={() => setForm('intent')} />
            {r.can_renew ? <Btn small title="Propose a renewal" color={c.mint} ink={c.ink} onPress={() => setForm('renew')} /> : null}
          </View>
          {!r.can_renew && !r.successor && d.status === 'active' ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>A renewal can be proposed in the last {r.window_days} days of the term.</T> : null}
        </Card>) : null}

      {r.successor ? (
        <Card color={c.lime}>
          <T weight="800" accessibilityRole="text">Renewal {r.successor.agreement_ref ?? ''}: {STATUS_LABEL[r.successor.status] ?? r.successor.status}</T>
          <T size={12} color={c.mute}>{r.successor.starts_on ? `${when(r.successor.starts_on)} – ${r.successor.ends_on ? when(r.successor.ends_on) : 'open'}` : ''}{r.successor.status === 'proposed' ? ` · waiting for ${r.successor.terms_side === me ? 'the other side to accept' : 'you to accept or counter'} terms v${r.successor.terms_version}` : ''}</T>
          <Btn small title="Open the renewal" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => push('SponsorDeal', { id: r.successor.id })} />
        </Card>) : live && d.status !== 'active' && !r.can_renew ? <T size={12} color={c.mute}>No renewal has been proposed.</T> : null}

      {r.predecessor && d.status === 'proposed' ? <RenewalExit deal={d} act={act} mine={r.opened_by_side === me} /> : null}

      <FormSheet visible={form === 'intent'} onClose={() => setForm(null)} title="Our renewal plan" submitLabel="Share with the other side"
        fields={[
          { key: 'intent', label: 'What do you want?', type: 'chips', options: INTENTS, default: mine?.intent ?? 'renew' },
          { key: 'note', label: 'Note', type: 'multiline', optional: true, hint: 'Optional. Visible to both sides.' },
        ]}
        onSubmit={async (v) => { try { await api.post(`/sponsorships/${d.id}/renewal-assessment`, { expected_renewal_rev: r.renewal_rev, ...v }); } catch (e) { throw stale(e); } d.reload?.(); return 'Plan shared'; }} />
      <FormSheet visible={form === 'renew'} onClose={() => setForm(null)} title="Propose a renewal" initial={d.ends_on ? { starts_on: dayAfter(d.ends_on), ends_on: yearAfter(d.ends_on) } : {}} submitLabel={`Send to ${me === 'sponsor' ? 'the recipient' : 'the sponsor'}`}
        fields={[
          { key: 'starts_on', label: 'New term starts', type: 'date', min: d.ends_on ? dayAfter(d.ends_on) : undefined, hint: 'Must be after the current term ends.' },
          { key: 'ends_on', label: 'New term ends', type: 'date', min: d.ends_on ? dayAfter(d.ends_on) : undefined },
          { key: 'message', label: 'Message', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          let res;
          try { res = await api.post(`/sponsorships/${d.id}/renewal`, { expected_renewal_rev: r.renewal_rev, ...v }); } catch (e) { throw stale(e); }
          d.reload?.();
          push('SponsorDeal', { id: res.id });
          return 'Renewal sent — nothing changes until the other side accepts the exact terms';
        }} />
    </Section>
  );
}

/** The side that proposed a renewal can take it back; the other side can decline it. Accepting is the normal "accept these exact terms" step. */
function RenewalExit({ deal: d, act, mine: mineAuthored }) {
  return (
    <Card>
      <T size={12} color={c.mute} accessibilityRole="text">This is a proposed renewal. It only starts once the side that did not write the current terms accepts that exact version.</T>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {mineAuthored
          ? <Btn small title="Withdraw renewal" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/sponsorships/${d.id}/withdraw`), 'Renewal withdrawn')} />
          : <Btn small title="Decline renewal" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'declined', reason: 'Not renewing' }), 'Renewal declined')} />}
      </View>
    </Card>
  );
}
