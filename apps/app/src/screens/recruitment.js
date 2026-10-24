import React, { useEffect, useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Empty, ErrorBox, H1, H2, Loading, Screen, Seg, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { Pill } from './marketplace';
import { c, money, when } from '../theme';

// Player recruitment pipeline (issue #314): staff run a post's candidates through stages; applicants and guardians follow them.
const STAGE = {
  applied: ['Applied', c.violetSoft], shortlisted: ['Shortlisted', c.cyanSoft], trial: ['Trial', c.sunSoft], evaluated: ['Evaluated', c.pinkSoft],
  offered: ['Offered', c.limeSoft], accepted: ['Accepted', c.limeSoft], declined: ['Declined', c.violetSoft], withdrawn: ['Withdrawn', c.violetSoft],
};
const TABS = ['applied', 'shortlisted', 'trial', 'evaluated', 'offered', 'closed'];
const CLOSED = ['accepted', 'declined', 'withdrawn'];
const newKey = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const UNIT = { match: 'per match', hour: 'per hour', month: 'per month', season: 'per season' };
const UNITS = Object.entries(UNIT).map(([value, label]) => ({ value, label }));
const StagePill = ({ s }) => <Pill label={(STAGE[s]?.[0] ?? s).toUpperCase()} fg={c.ink} bg={STAGE[s]?.[1] ?? c.violetSoft} />;
/** Plain-language server answers: stale versions, lapsed offers, missing guardian consent. */
const say = (e) => {
  const code = e?.details?.code;
  if (code === 'stale_version') return 'This application was changed somewhere else. Pull to reload, then try again.';
  if (code === 'offer_expired') return 'This offer has expired. Ask the team to send a new one.';
  if (code === 'guardian_consent_required') return 'A guardian has not given current consent for recruitment.';
  if (code === 'positions_filled') return 'All positions have been filled.';
  return e?.message ?? 'Something went wrong';
};
const offerLine = (o) => [o.role, o.rate_cents != null ? `${money(o.rate_cents)} ${UNIT[o.rate_unit] ?? ''}`.trim() : 'rate to agree', o.starts_on && `starts ${o.starts_on}`].filter(Boolean).join(' · ');
const iso = (date, time) => new Date(`${date}T${time || '12:00'}:00`).toISOString();
const left = (deadline) => { const ms = new Date(deadline) - Date.now(); if (ms <= 0) return 'expired'; const d = Math.floor(ms / 86400000); return d >= 1 ? `${d} day${d > 1 ? 's' : ''} left` : `${Math.max(1, Math.round(ms / 3600000))} h left`; };
const saveCsv = (filename, csv, setText) => {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  } else setText(csv);
};

/** Run an action that changes an application: fresh idempotency key per attempt, plain errors, then reload. */
function useAct(reload) {
  const { toast } = useSession();
  return async (fn, done) => { try { await fn(newKey()); await reload(); if (done) toast(done); } catch (e) { toast(say(e)); } };
}

// ================================================================== STAFF: the pipeline of one post
export function RecruitmentPipeline({ id }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [tab, setTab] = useState('applied');
  const [csv, setCsv] = useState(null);
  const [more, setMore] = useState([]); // later pages of the selected stage, appended under the first
  const [paging, setPaging] = useState(false);
  const PAGE = 25;
  // the selected stage is fetched from the API (not filtered from one page), so every application stays reachable
  const q = useLoad(() => api.get(`/billboard/${id}/pipeline`, { stage: tab, limit: PAGE }), [id, tab]);
  useEffect(() => { setMore([]); }, [id, tab, q.data]);
  const act = useAct(q.reload);
  if (q.error) return <Screen><ErrorBox error={q.error} onRetry={q.reload} /></Screen>;
  if (!q.data) return <Screen><Loading /></Screen>;
  const { post, counts, candidates } = q.data;
  const closedN = CLOSED.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const shown = [...candidates, ...more];
  const total = tab === 'closed' ? closedN : counts[tab] ?? 0;
  const loadMore = async () => {
    setPaging(true);
    try { const r = await api.get(`/billboard/${id}/pipeline`, { stage: tab, limit: PAGE, offset: shown.length }); setMore((m) => [...m, ...r.candidates]); } catch (e) { toast(say(e)); } finally { setPaging(false); }
  };
  return (
    <Screen refreshing={q.loading} onRefresh={q.reload}>
      <H1>{post.title}</H1>
      <T size={13} color={c.mute}>{post.positions_needed} position{post.positions_needed > 1 ? 's' : ''} · {counts.accepted} filled · {counts.offered} offer{counts.offered === 1 ? '' : 's'} out</T>
      <Seg value={tab} onChange={setTab} options={TABS.map((s) => ({ value: s, label: `${s === 'closed' ? 'Closed' : STAGE[s][0]} ${s === 'closed' ? closedN : counts[s] ?? 0}` }))} />
      {q.loading && !shown.length ? <Loading /> : null}
      {!q.loading && shown.length === 0 ? <Empty emoji="🧢" title="No one at this stage yet" sub="Candidates appear here as they move through the pipeline." /> : shown.map((x) => (
        <Card key={x.response_id} pad={14}>
          {x.hidden ? (
            <View style={{ gap: 6 }}>
              <T weight="800">Young applicant (hidden)</T>
              <T size={13} color={c.mute}>A guardian's consent for recruitment is not current, so this applicant's details and actions are unavailable.</T>
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                <Avatar user={x} size={38} />
                <View style={{ flex: 1 }}>
                  <T weight="800" size={15}>{x.display_name}</T>
                  <T size={12} color={c.mute}>Applied {when(x.created_at)}{x.has_source ? ' · evidence link' : ''}</T>
                </View>
                <StagePill s={x.stage} />
              </View>
              {x.message ? <T size={13} color={c.mute}>“{x.message}”</T> : null}
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {x.is_youth ? <Pill label="YOUTH · CONSENT OK" fg={c.ink} bg={c.limeSoft} /> : null}
                {x.trial_at ? <Pill label={`TRIAL ${when(x.trial_at).toUpperCase()}`} fg={c.ink} bg={c.sunSoft} /> : null}
                {x.rating ? <Pill label={`RATING ${x.rating}/5`} fg={c.ink} bg={c.pinkSoft} /> : null}
                {x.offer_version ? <Pill label={`OFFER V${x.offer_version} · ${x.offer_status.toUpperCase()}`} fg={c.ink} bg={c.limeSoft} /> : null}
              </View>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {x.stage === 'applied' ? <Btn small title="Shortlist" onPress={() => act((k) => api.post(`/billboard/responses/${x.response_id}/stage`, { to: 'shortlisted', row_version: x.row_version, idempotency_key: k }), 'Shortlisted')} /> : null}
                {['shortlisted', 'evaluated'].includes(x.stage) ? <Btn small title="Schedule trial" onPress={() => push('RecruitmentApplication', { id: x.response_id })} /> : null}
                {['applied', 'shortlisted', 'trial', 'evaluated', 'offered'].includes(x.stage) ? <Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act((k) => api.post(`/billboard/responses/${x.response_id}/stage`, { to: 'declined', row_version: x.row_version, idempotency_key: k }), 'Declined')} /> : null}
                <Btn small title="Open" color={c.paper} onPress={() => push('RecruitmentApplication', { id: x.response_id })} />
              </View>
            </View>
          )}
        </Card>
      ))}
      {shown.length < total ? <Btn small title={paging ? 'Loading…' : `Show more (${total - shown.length} left)`} color={c.paper} disabled={paging} onPress={loadMore} /> : null}
      <Btn small title="Export CSV" color={c.paper} onPress={async () => { try { const e = await api.get(`/billboard/${id}/pipeline/export`); saveCsv(e.filename, e.csv, setCsv); toast(`Exported ${e.rows} row${e.rows === 1 ? '' : 's'}${e.withheld ? `, ${e.withheld} withheld without guardian consent` : ''}. This download is logged.`); } catch (e) { toast(say(e)); } }} />
      {csv ? <T size={12} color={c.mute} selectable>{csv}</T> : null}
    </Screen>
  );
}

/** Trial invitation: date and time pickers, and a venue picked from the platform (not typed). */
function TrialForm({ onClose, submit }) {
  const venues = useLoad(() => api.get('/venues', { limit: 100 }), []);
  const options = (venues.data ?? []).map((v) => ({ id: v.id, label: v.name, sub: v.city ?? '', emoji: v.emoji }));
  return (
    <FormSheet visible onClose={onClose} title="Trial" submitLabel="Invite to trial"
      fields={[
        { key: 'date', label: 'Date', type: 'date', min: new Date().toISOString().slice(0, 10) },
        { key: 'time', label: 'Time', type: 'time' },
        { key: 'venue_id', label: 'Venue', type: 'entity', entityKind: 'team', noun: 'venue', optional: true, options },
        { key: 'note', label: 'What to bring', optional: true, type: 'multiline' },
      ]}
      onSubmit={submit} />
  );
}

// ================================================================== one application: staff and applicant see their own view
export function RecruitmentApplication({ id }) {
  const q = useLoad(() => api.get(`/billboard/responses/${id}/application`), [id]);
  const act = useAct(q.reload);
  const { toast } = useSession();
  const [form, setForm] = useState(null);
  const key = useRef(newKey());
  if (q.error) return <Screen><ErrorBox error={q.error} onRetry={q.reload} /></Screen>;
  if (q.loading && !q.data) return <Screen><Loading /></Screen>;
  const { application: a, post, applicant, viewer, events, offers } = q.data;
  const staff = viewer === 'staff';
  const open = ['applied', 'shortlisted', 'trial', 'evaluated', 'offered'].includes(a.stage);
  const cur = offers.find((o) => o.status === 'open');
  const post_ = (path, body, done) => act((k) => api.post(`/billboard/responses/${id}/${path}`, { ...body, row_version: a.row_version, idempotency_key: k }), done);
  const kinds = { applied: 'Applied', stage: 'Moved', trial: 'Trial scheduled', evaluation: 'Evaluated', offer: 'Offer', offer_response: 'Offer answered', offer_expired: 'Offer expired', withdrawn: 'Withdrawn', legacy_decision: 'Decided' };
  return (
    <Screen refreshing={q.loading} onRefresh={q.reload}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Avatar user={applicant} size={44} />
        <View style={{ flex: 1 }}><H1>{staff ? applicant.display_name : post.title}</H1><T size={13} color={c.mute}>{staff ? post.title : 'Your application'}</T></View>
        <StagePill s={a.stage} />
      </View>

      {a.trial_at ? <Card pad={14}><T weight="800">Trial</T><T>{when(a.trial_at)}</T>{a.trial_venue_name ? <T size={13}>📍 {[a.trial_venue_name, a.trial_venue_city].filter(Boolean).join(', ')}</T> : null}{a.trial_note ? <T size={13} color={c.mute}>{a.trial_note}</T> : null}</Card> : null}

      {staff && q.data.message ? <Card pad={14}><T weight="800">Message from the applicant</T><T size={14}>{q.data.message}</T></Card> : null}
      {staff && q.data.source ? (
        <Card pad={14}><T weight="800">Evidence link</T><Btn small title="Open link" color={c.paper} onPress={() => Linking.openURL(q.data.source.url)} accessibilityLabel="Open the applicant's evidence link" /><T size={12} color={c.mute}>Opening is logged.</T></Card>
      ) : null}

      <H2>{offers.length ? 'Offers' : 'No offer yet'}</H2>
      {offers.slice().reverse().map((o) => (
        <Card key={o.version} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">Offer v{o.version}</T><Pill label={o.status.toUpperCase()} fg={c.ink} bg={o.status === 'open' ? c.limeSoft : c.violetSoft} /></View>
          <T>{offerLine(o)}</T>
          <T size={12} color={c.mute}>Respond by {when(o.deadline_at)}{o.status === 'open' ? ` · ${left(o.deadline_at)}` : ''}</T>
          {o.note ? <T size={13} color={c.mute}>{o.note}</T> : null}
        </Card>
      ))}

      {staff && q.data.evaluations?.length ? <>
        <H2>Evaluations</H2>
        {q.data.evaluations.map((e) => <Card key={e.id} pad={14}><T weight="800">{e.rating}/5 · {when(e.created_at)}</T>{e.notes ? <T size={13} color={c.mute}>{e.notes}</T> : null}</Card>)}
      </> : null}

      <H2>History</H2>
      <Card pad={14}><View style={{ gap: 8 }}>
        {events.map((e, i) => <T key={i} size={13}><T weight="700" size={13}>{kinds[e.kind] ?? e.kind}</T>{e.to_stage && e.kind !== 'applied' && e.to_stage !== e.from_stage ? ` → ${STAGE[e.to_stage]?.[0] ?? e.to_stage}` : ''} · <T size={13} color={c.mute}>{when(e.created_at)}{staff && e.note ? ` · ${e.note}` : ''}</T></T>)}
      </View></Card>

      {open ? (
        <View style={{ gap: 8 }}>
          {staff ? <>
            {['shortlisted', 'trial', 'evaluated'].includes(a.stage) ? <Btn title={a.stage === 'trial' ? 'Reschedule trial' : 'Schedule trial'} onPress={() => setForm('trial')} /> : null}
            {a.stage === 'trial' ? <Btn title="Record evaluation" onPress={() => setForm('eval')} /> : null}
            {['shortlisted', 'evaluated', 'offered'].includes(a.stage) ? <Btn title={cur ? `Send revised offer (v${(offers.at(-1)?.version ?? 0) + 1})` : 'Send offer'} onPress={() => setForm('offer')} /> : null}
            {a.stage === 'applied' ? <Btn title="Shortlist" onPress={() => post_('stage', { to: 'shortlisted' }, 'Shortlisted')} /> : null}
            <Btn title="Decline" color={c.paper} ink={c.red} onPress={() => post_('stage', { to: 'declined' }, 'Declined')} />
          </> : <>
            {a.stage === 'offered' && cur ? <>
              <Btn title={`Accept offer v${cur.version}`} onPress={() => post_('offer-response', { accept: true }, 'Offer accepted. Welcome to the team!')} />
              <Btn title="Decline offer" color={c.paper} ink={c.red} onPress={() => post_('offer-response', { accept: false }, 'Offer declined')} />
            </> : null}
            <Btn title="Withdraw application" color={c.paper} ink={c.red} onPress={() => post_('withdraw', {}, 'Application withdrawn')} />
          </>}
        </View>
      ) : null}

      {form === 'trial' ? <TrialForm onClose={() => setForm(null)} submit={async (v) => { try { await api.post(`/billboard/responses/${id}/trial`, { trial_at: iso(v.date, v.time), venue_id: v.venue_id, note: v.note, row_version: a.row_version, idempotency_key: key.current }); key.current = newKey(); await q.reload(); return 'Trial scheduled'; } catch (e) { throw new Error(say(e)); } }} /> : null}
      {form === 'eval' ? (
        <FormSheet visible onClose={() => setForm(null)} title="Evaluation" submitLabel="Save evaluation"
          fields={[{ key: 'rating', label: 'Rating (1–5)', type: 'stepper', min: 1, max: 5, default: 3 }, { key: 'notes', label: 'Private notes', type: 'multiline', optional: true, hint: 'Only staff can read these.' }]}
          onSubmit={async (v) => { try { await api.post(`/billboard/responses/${id}/evaluation`, { rating: v.rating, notes: v.notes, row_version: a.row_version, idempotency_key: key.current }); key.current = newKey(); await q.reload(); return 'Evaluation saved'; } catch (e) { throw new Error(say(e)); } }} />
      ) : null}
      {form === 'offer' ? (
        <FormSheet visible onClose={() => setForm(null)} title={cur ? `Revised offer (v${(offers.at(-1)?.version ?? 0) + 1})` : 'Offer'} submitLabel="Send offer"
          initial={cur ? { rate_cents: cur.rate_cents ?? undefined, rate_unit: cur.rate_unit ?? 'match', starts_on: cur.starts_on ?? undefined } : { rate_unit: 'match' }}
          fields={[
            { key: 'rate_cents', label: 'Rate', type: 'money', currency: () => 'INR', optional: true, hint: 'Leave empty if the rate is agreed later.' },
            { key: 'rate_unit', label: 'Per', type: 'chips', options: UNITS },
            { key: 'starts_on', label: 'Starts', type: 'date', optional: true },
            { key: 'deadline_date', label: 'Respond by', type: 'date', min: new Date().toISOString().slice(0, 10) },
            { key: 'deadline_time', label: 'Time', type: 'time' },
            { key: 'note', label: 'Message', optional: true, type: 'multiline' },
          ]}
          onSubmit={async (v) => { try { await api.post(`/billboard/responses/${id}/offers`, { rate_cents: v.rate_cents, rate_unit: v.rate_cents != null ? v.rate_unit : undefined, starts_on: v.starts_on, deadline_at: iso(v.deadline_date, v.deadline_time), note: v.note, row_version: a.row_version, idempotency_key: key.current }); key.current = newKey(); await q.reload(); return 'Offer sent'; } catch (e) { toast(say(e)); throw new Error(say(e)); } }} />
      ) : null}
    </Screen>
  );
}

// ================================================================== applicant (or guardian): all my applications
export function MyApplications({ child_id, name }) {
  const { push } = useNav();
  const q = useLoad(() => api.get('/me/billboard-responses', { limit: 100, ...(child_id ? { user_id: child_id } : {}) }), [child_id]);
  const act = useAct(q.reload);
  if (q.error) return <Screen><ErrorBox error={q.error} onRetry={q.reload} /></Screen>;
  if (q.loading && !q.data) return <Screen><Loading /></Screen>;
  const rows = q.data.filter((r) => r.stage);
  return (
    <Screen refreshing={q.loading} onRefresh={q.reload}>
      <H1>{name ? `${name}'s applications` : 'My applications'}</H1>
      {rows.length === 0 ? <Empty emoji="📨" title="No applications yet" sub="Apply to a team or match from the Billboard and follow every step here." /> : rows.map((r) => {
        const o = r.latest_offer;
        return (
          <Card key={r.response_id} pad={14}>
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <View style={{ flex: 1 }}><T weight="800">{r.title}</T><T size={12} color={c.mute}>{[r.team_name, r.author_name, `applied ${when(r.responded_at)}`].filter(Boolean).join(' · ')}</T></View>
                <StagePill s={r.stage} />
              </View>
              {r.trial_at && r.stage === 'trial' ? <T size={13}>Trial: {when(r.trial_at)}{r.trial_venue_name ? ` · 📍 ${[r.trial_venue_name, r.trial_venue_city].filter(Boolean).join(', ')}` : ''}</T> : null}
              {o ? <T size={13}>Offer v{o.version} · {offerLine(o)}{o.status === 'open' ? ` · ${left(o.deadline_at)}` : ` · ${o.status}`}</T> : null}
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {r.stage === 'offered' && o?.status === 'open' ? <>
                  <Btn small title="Accept" onPress={() => act((k) => api.post(`/billboard/responses/${r.response_id}/offer-response`, { accept: true, row_version: r.row_version, idempotency_key: k }), 'Offer accepted')} />
                  <Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act((k) => api.post(`/billboard/responses/${r.response_id}/offer-response`, { accept: false, row_version: r.row_version, idempotency_key: k }), 'Offer declined')} />
                </> : null}
                {['applied', 'shortlisted', 'trial', 'evaluated', 'offered'].includes(r.stage) ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => act((k) => api.post(`/billboard/responses/${r.response_id}/withdraw`, { row_version: r.row_version, idempotency_key: k }), 'Application withdrawn')} /> : null}
                <Btn small title="Details" color={c.paper} onPress={() => push('RecruitmentApplication', { id: r.response_id })} />
              </View>
            </View>
          </Card>
        );
      })}
    </Screen>
  );
}
