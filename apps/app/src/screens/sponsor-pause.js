import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, Loading, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';

const REASONS = [{ value: 'injury', label: 'Injury' }, { value: 'season_break', label: 'Season break' }, { value: 'funding_review', label: 'Funding review' }, { value: 'force_majeure', label: 'Circumstances beyond our control' }, { value: 'other', label: 'Other' }];
const REASON = Object.fromEntries(REASONS.map((r) => [r.value, r.label]));
const POLICY = {
  hold: { label: 'Hold until resume', text: 'Dues not yet due stay owed and fall due again on the day the agreement resumes.' },
  reschedule: { label: 'Reschedule', text: 'Dues not yet due move later by the length of the pause, and the agreement end moves with them.' },
};
const SIDE = { sponsor: 'the sponsor', recipient: 'the recipient' };
const STATE = { requested: 'Waiting for approval', scheduled: 'Approved, starts later', active: 'Paused', declined: 'Declined', withdrawn: 'Withdrawn', resumed: 'Resumed', ended: 'Closed with the agreement' };
const when = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
const todayIso = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const held = (p) => Object.entries(p.summary?.held_cents ?? {}).map(([cur, v]) => fmt(v, cur)).join(' · ');

/**
 * Pause and resume of an accepted agreement (#297): one side asks, the other approves, and both see the same agreed policy for the dues
 * in the pause. Nothing is waived: a resume preview shows every due that moves before anything changes.
 */
export function SponsorPause({ deal: d, can, act }) {
  const [form, setForm] = useState(null); // 'request' | 'decline'
  const [preview, setPreview] = useState(false);
  if (!d.accepted_version || !['sponsor', 'recipient'].includes(d.role)) return null;
  const pauses = d.pauses ?? [];
  if (!['active', 'paused'].includes(d.status) && !pauses.length) return null; // a finished agreement has nothing to pause
  const cur = pauses.find((p) => ['requested', 'scheduled', 'active'].includes(p.status));
  const past = pauses.filter((p) => p !== cur);
  const me = d.role, canAct = me === 'recipient' || can('pause');
  const rev = d.pause_rev ?? 0;
  const mine = cur?.requested_by_side === me;
  const call = (fn, ok) => act(fn, ok);
  const decide = (decision, note) => call(() => api.patch(`/sponsorship-pauses/${cur.id}`, { expected_pause_rev: rev, decision, note }), { approve: 'Pause approved', decline: 'Pause declined', withdraw: 'Request withdrawn' }[decision]);
  const stale = (e) => { d.reload?.(); return e.status === 409 ? new Error('The agreement changed while you were editing. The latest version is now shown — review it and try again.') : e; };
  const canRequest = d.status === 'active' && !cur && canAct;

  return (
    <Section title="Pause" color={c.sun}>
      {!cur ? (
        <Card>
          <T accessibilityRole="text">{d.status === 'active' ? 'This agreement is running normally.' : `This agreement is ${d.status}.`}</T>
          {d.status === 'active' ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Either side can ask for a pause. The other side has to approve it, and nothing changes until they do. Dues that are already due are never paused.</T> : null}
          {canRequest ? <Btn small title="Request a pause" color={c.sun} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 10 }} onPress={() => setForm('request')} /> : null}
          {d.status === 'active' && !canAct ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>Your role cannot pause agreements for the brand; a manager or approver can.</T> : null}
        </Card>
      ) : (
        <Card color={cur.status === 'active' ? c.sunSoft : c.paper}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Tag label={STATE[cur.status]} color={cur.status === 'active' ? c.sun : c.paper} />
            <Tag label={`Policy: ${POLICY[cur.policy].label}`} color={c.violetSoft} />
          </View>
          <T weight="800" style={{ marginTop: 8 }} accessibilityRole="text">
            {cur.status === 'active' ? `Paused since ${when(cur.effective_from)}` : `From ${when(cur.effective_from)}`}{cur.planned_resume_on ? ` · planned resume ${when(cur.planned_resume_on)}` : ''}
          </T>
          <T size={13} style={{ marginTop: 4 }}>{REASON[cur.reason_code]}{cur.reason ? ` — ${cur.reason}` : ''}</T>
          <T size={12} color={c.mute} style={{ marginTop: 4 }}>{POLICY[cur.policy].text} Dues that were already due, or that have a payment, delivery or endorsement in progress, are not paused.</T>
          <T size={12} color={c.mute} style={{ marginTop: 4 }}>Requested by {cur.requested_by} for {SIDE[cur.requested_by_side]}{cur.decided_by && cur.status !== 'requested' ? ` · agreed by ${cur.decided_by}` : ''}{cur.status === 'active' && cur.summary ? ` · ${cur.summary.held_dues} due${cur.summary.held_dues === 1 ? '' : 's'} held${held(cur) ? ` (${held(cur)})` : ''}` : ''}</T>

          {cur.status === 'requested' && !mine ? (
            canAct ? (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <Btn small title="Approve pause" color={c.mint} ink={c.ink} onPress={() => decide('approve')} />
                <Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => setForm('decline')} />
              </View>) : <T size={12} color={c.mute} style={{ marginTop: 8 }}>Your role cannot decide this; a manager or approver can.</T>
          ) : null}
          {['requested', 'scheduled'].includes(cur.status) && mine && canAct ? (
            <View style={{ marginTop: 10 }}>
              {cur.status === 'requested' ? <T size={12} weight="700" accessibilityRole="text">Waiting for {SIDE[me === 'sponsor' ? 'recipient' : 'sponsor']} to approve.</T> : null}
              <Btn small title="Withdraw request" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => decide('withdraw')} />
            </View>) : null}
          {cur.status === 'scheduled' && !mine ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>Starts automatically on {when(cur.effective_from)}.</T> : null}
          {cur.status === 'active' && canAct ? <Btn small title="Preview resume" color={c.sun} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 10 }} onPress={() => setPreview(true)} /> : null}
        </Card>)}

      {past.length ? (
        <View style={{ gap: 2 }}>
          <T weight="700" style={{ marginTop: 6 }}>Earlier pauses</T>
          {past.map((p) => <T key={p.id} size={12} color={c.mute}>{when(p.effective_from)} · {REASON[p.reason_code]} · {POLICY[p.policy].label} · {STATE[p.status]}{p.resumed_on ? ` on ${when(p.resumed_on)}` : ''}{p.decision_note ? ` — ${p.decision_note}` : ''}</T>)}
        </View>) : null}

      <FormSheet visible={form === 'request'} onClose={() => setForm(null)} title="Request a pause" submitLabel={`Send to ${SIDE[me === 'sponsor' ? 'recipient' : 'sponsor']}`}
        fields={[
          { key: 'reason_code', label: 'Why', type: 'chips', options: REASONS },
          { key: 'reason', label: 'Note', type: 'multiline', optional: true, hint: 'Required when the reason is “Other”.' },
          { key: 'effective_from', label: 'Pause starts', type: 'date', min: todayIso() },
          { key: 'planned_resume_on', label: 'Planned resume', type: 'date', optional: true, min: todayIso(), hint: 'Only a plan. You decide when to actually resume.' },
          { key: 'policy', label: 'Dues during the pause', type: 'chips', options: Object.entries(POLICY).map(([value, p]) => ({ value, label: p.label })), default: 'hold', hint: 'Hold: dues stay owed and fall due on resume. Reschedule: dues move later by the length of the pause. Nothing is waived either way.' },
        ]}
        onSubmit={async (v) => {
          try { await api.post(`/sponsorships/${d.id}/pause-requests`, { expected_pause_rev: rev, ...v }); } catch (e) { throw stale(e); }
          d.reload?.();
          return 'Request sent — nothing changes until the other side approves';
        }} />
      <FormSheet visible={form === 'decline'} onClose={() => setForm(null)} title="Decline the pause" submitLabel="Decline" fields={[{ key: 'note', label: 'Why you are declining', type: 'multiline' }]}
        onSubmit={async (v) => { try { await api.patch(`/sponsorship-pauses/${cur.id}`, { expected_pause_rev: rev, decision: 'decline', note: v.note }); } catch (e) { throw stale(e); } d.reload?.(); return 'Pause declined'; }} />
      {preview ? <ResumeSheet deal={d} rev={rev} onClose={() => setPreview(false)} /> : null}
    </Section>
  );
}

/** What resuming would do, due by due, before anyone commits to it. */
function ResumeSheet({ deal: d, rev, onClose }) {
  const pv = useLoad(() => api.get(`/sponsorships/${d.id}/resume-preview`), [d.id, rev]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const p = pv.data;
  const go = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/sponsorships/${d.id}/resume`, { expected_pause_rev: p.pause_rev }); onClose(); d.reload?.(); } catch (e) { setErr(e.status === 409 ? 'The agreement changed while you were looking. The latest version is now shown — review it and try again.' : explain(e)); if (e.status === 409) { d.reload?.(); pv.reload(); } } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Resume the agreement">
      {pv.loading && !p ? <Loading /> : pv.error ? <LoadError error={pv.error} onRetry={pv.reload} /> : p ? (
        <View style={{ gap: 8 }}>
          <T size={13} color={c.mute} accessibilityRole="text">Policy: {POLICY[p.policy].label}. {p.shift_days ? `The pause lasted ${p.shift_days} day${p.shift_days === 1 ? '' : 's'}.` : 'Resuming today.'}</T>
          {p.dues.length ? p.dues.map((x) => (
            <View key={x.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <T size={13} style={{ flex: 1 }}>{x.label} · {x.kind === 'money' ? fmt(x.amount_cents, x.currency) : x.kind}</T>
              <T size={13} weight={x.due_on === x.new_due_on ? '500' : '800'}>{x.due_on === x.new_due_on ? `due ${when(x.due_on)}` : `${when(x.due_on)} → ${when(x.new_due_on)}`}</T>
            </View>)) : <Empty emoji="🗓️" title="No dues are held" sub="Nothing needs to move. The agreement simply becomes active again." />}
          {Object.keys(p.totals).length ? <T size={13} weight="800">Held cash: {Object.entries(p.totals).map(([cur, v]) => fmt(v, cur)).join(' · ')}</T> : null}
          {p.new_ends_on && p.new_ends_on !== p.ends_on ? <T size={13} weight="700">Agreement end: {when(p.ends_on)} → {when(p.new_ends_on)}</T> : null}
          <T size={12} color={c.mute}>Dues are moved, never re-created or waived, so nothing is charged twice. Currencies are never combined.</T>
          {err ? <T color={c.red} weight="700" accessibilityRole="alert">{err}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn title="Back" color={c.paper} ink={c.ink} onPress={onClose} />
            <Btn title="Resume agreement" color={c.mint} ink={c.ink} loading={busy} onPress={go} />
          </View>
        </View>) : null}
    </Sheet>
  );
}
