// Tools > Scoring & Game Tracking (#416): linking a sheet to a game, reviewing a proposed result, reading an uploaded sheet, and the
// event's scoring rules + approval policy. Roles and permissions are never decided here: the server resolves them from the game's own
// assignments and these screens only show the actions it says the caller has (can_review, can_apply, can_override, can_withdraw).
import React, { useEffect, useState } from 'react';
import { Image, Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H2, Loading, Section, Seg, Sheet, T, Tag } from '../ui';
import { Counter } from '../pickers';
import { SportSelect } from '../sportpicker';
import { pickDocument } from './insurance';
import { c } from '../theme';

const nice = (s = '') => String(s).replace(/_/g, ' ');
const STATE_TONE = { proposed: c.sun, under_review: c.sun, approved: c.mint, applied: c.mint, changes_requested: c.cyan, rejected: c.orange, disputed: c.orange, withdrawn: c.violetSoft, superseded: c.violetSoft };
export const StateTag = ({ s }) => <Tag label={nice(s)} color={STATE_TONE[s] ?? c.violetSoft} />;
const SEV = { error: '⛔', warn: '⚠️', info: 'ℹ️' };
const ROLE = { organiser: 'Organiser', official: 'Referee / official', home_manager: 'Home team manager', away_manager: 'Away team manager' };

const Notes = ({ list }) => (list?.length ? <View style={{ gap: 6 }}>{list.map((k, i) => <T key={i} size={13} color={k.severity === 'error' ? c.orange : c.ink}>{SEV[k.severity] ?? '•'} {k.message}</T>)}</View> : null);

async function openBlob(path, toast) {
  try {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return toast?.('Evidence files open in the web app');
    const url = URL.createObjectURL(await api.download(path));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) { toast?.(e.message); }
}

// ----------------------------------------------------------------------------------------------------------- link a sheet to a game
export function LinkSheet({ sheet, onClose, onDone }) {
  const { toast } = useSession();
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(null);
  const [homeIs, setHomeIs] = useState('home');
  const [busy, setBusy] = useState(false);
  const cands = useLoad(() => api.get('/tracking/link-candidates', { sheet_id: sheet.id, q: q.trim() || undefined, days: 7 }), [q]);
  const submit = async () => {
    setBusy(true);
    try { onDone(await api.post(`/tracking/sheets/${sheet.id}/proposals`, { fixture_id: pick.id, home_is: homeIs })); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Link to a game">
      <View style={{ gap: 12 }}>
        <Card color={c.orangeSoft} pad={12}><T weight="700" size={13}>This sends your sheet as a proposal. The official result does not change until the game's officials (and anyone the event requires) approve it.</T></Card>
        <Field label="Search by team or event" value={q} onChangeText={setQ} placeholder="Leave empty for games around the sheet's date" />
        {cands.loading ? <Loading /> : (cands.data ?? []).length ? cands.data.map((g) => (
          <Card key={g.id} onPress={() => setPick(g)} color={pick?.id === g.id ? c.violetSoft : c.paper} pad={12} accessibilityLabel={`${g.home_name} vs ${g.away_name}`}>
            <T weight="800">{g.home_name} vs {g.away_name}</T>
            <T size={12} color={c.mute}>{g.event_name} · {new Date(g.scheduled_at).toLocaleString()}{g.open_proposal ? ` · a result proposal is already open (${nice(g.open_proposal)})` : ''}</T>
          </Card>
        )) : <Empty emoji="🔎" title="No games found" sub="Only games in public events of the same sport, around the sheet's date, are listed." />}
        {pick ? (
          <>
            <T weight="700" size={13}>Which side is your sheet's "{sheet.labels.home}"?</T>
            <Seg options={[{ label: pick.home_name, value: 'home' }, { label: pick.away_name, value: 'away' }]} value={homeIs} onChange={setHomeIs} />
            <Btn title="Send as proposal" loading={busy} onPress={submit} />
          </>
        ) : null}
      </View>
    </Sheet>
  );
}

// ----------------------------------------------------------------------------------------------------------- review a proposal
const Cell = ({ children, bold }) => <View style={{ flex: 1 }}><T weight={bold ? '800' : '500'} size={14}>{children}</T></View>;

export function ProposalReview({ id, onChanged, onOpenScoreSheet }) {
  const { toast } = useSession();
  const view = useLoad(() => api.get(`/tracking/proposals/${id}`), [id]);
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const p = view.data;
  if (view.error) return <ErrorBox error={view.error} onRetry={view.reload} />;
  if (!p) return <Loading />;
  const run = async (fn, ok) => { setBusy(true); try { const r = await fn(); if (ok) toast(ok); setComment(''); view.reload(); onChanged?.(); return r; } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const decide = (decision, extra = {}) => {
    if (decision !== 'approve' && !comment.trim()) { toast('Say why in the comment first'); return; }
    return run(() => api.post(`/tracking/proposals/${id}/review`, { decision, comment: comment.trim() || undefined, ...extra }), 'Recorded');
  };
  const cur = p.current, pay = p.payload;
  const official = cur.published ? `${cur.published.score[0]}–${cur.published.score[1]} (published)` : cur.fixture_score ? `${cur.fixture_score[0]}–${cur.fixture_score[1]}` : 'No official result yet';
  return (
    <View style={{ gap: 14 }}>
      <View><H2>{p.fixture.home_name} vs {p.fixture.away_name}</H2><T color={c.mute} size={12}>{p.fixture.event_name} · {p.ruleset.label} rules pinned by the event · round {p.round}</T></View>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><StateTag s={p.state} />{p.stale ? <Tag label="stale: re-submit needed" color={c.orange} /> : null}<Tag label={`submitted by ${p.submitter_name}`} color={c.violetSoft} /></View>

      <Card pad={14}>
        <View style={{ flexDirection: 'row' }}><Cell bold> </Cell><Cell bold>Proposed</Cell><Cell bold>Official now</Cell></View>
        <View style={{ flexDirection: 'row' }}><Cell>Score</Cell><Cell bold>{pay.home_score}–{pay.away_score}</Cell><Cell>{official}</Cell></View>
        {cur.live_log ? <View style={{ flexDirection: 'row' }}><Cell>Live match log</Cell><Cell> </Cell><Cell>{cur.live_log.home}–{cur.live_log.away} ({cur.live_log.events} events)</Cell></View> : null}
        {pay.sets?.length ? <View style={{ flexDirection: 'row' }}><Cell>Sets</Cell><Cell>{pay.sets.map((s) => `${s.home}-${s.away}`).join(', ')}</Cell><Cell> </Cell></View> : null}
        {pay.periods?.length ? <View style={{ flexDirection: 'row' }}><Cell>By period</Cell><Cell>{pay.periods.map((s) => `${s.home}-${s.away}`).join(', ')}</Cell><Cell> </Cell></View> : null}
      </Card>

      <Notes list={p.warnings} />

      {p.evidence ? <Btn small title="Open the uploaded sheet (evidence)" color={c.cyan} onPress={() => openBlob(p.evidence.url.replace('/api/v1', ''), toast)} /> : <T size={12} color={c.mute}>Tracked live on screen ({p.sheet.ref}); {p.sheet.entries.length} recent entries recorded.</T>}

      <Section title="Who must approve">
        {p.approval.requirements.map((r) => (
          <View key={r.key} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <T size={18}>{r.approved ? '✅' : '⬜'}</T>
            <T style={{ flex: 1 }} weight="700">{r.label ?? nice(r.key)} <T size={12} color={c.mute}>({r.roles.map((x) => ROLE[x]).join(' or ')})</T></T>
            <Tag label={r.approved ? 'approved' : 'waiting'} color={r.approved ? c.mint : c.sun} />
          </View>
        ))}
        <T size={12} color={c.mute}>{p.approval.mode === 'sequential' ? 'In order, top to bottom.' : 'In any order.'}{p.approval.quorum ? ` ${p.approval.quorum} approvals are enough.` : ''}</T>
        {p.my_roles.length ? <T size={12} color={c.mute}>You act as: {p.my_roles.map((r) => ROLE[r]).join(', ')}</T> : null}
      </Section>

      {p.reviews.length ? <Section title="Review history">{p.reviews.map((r, i) => <T key={i} size={13}>{r.reviewer_name} ({ROLE[r.resolved_role] ?? r.resolved_role}) · {nice(r.decision)}{r.override ? ' · override' : ''} · round {r.round}{r.comment ? `: ${r.comment}` : ''}</T>)}</Section> : null}

      {p.can_review ? (
        <Section title="Your review">
          <Field label="Comment (required unless you approve)" value={comment} onChangeText={setComment} multiline maxLength={1000} />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn title="Approve" color={c.mint} loading={busy} onPress={() => decide('approve')} />
            <Btn title="Request changes" color={c.cyan} loading={busy} onPress={() => decide('changes_requested')} />
            <Btn title="Reject" color={c.orange} loading={busy} onPress={() => decide('reject')} />
            <Btn title="Dispute" color={c.violet} loading={busy} onPress={() => decide('dispute')} />
          </View>
        </Section>
      ) : null}
      {p.can_override ? (
        <Section title="Organiser override">
          <Field label="Why approve every remaining step yourself?" value={reason} onChangeText={setReason} maxLength={500} />
          <Btn title="Approve all remaining steps" color={c.sun} disabled={reason.trim().length < 5} loading={busy} onPress={() => decide('approve', { override_reason: reason.trim() })} />
        </Section>
      ) : null}
      {p.state === 'approved' ? (
        p.can_apply ? (
          <Section title="Apply">
            <T size={13} color={c.mute}>Applying opens a draft score sheet for this game. It still needs the usual sign-offs, approval and publication before it becomes official.</T>
            {p.needs_reconcile ? <Field label="Why does this replace the live log or published result? (organiser)" value={reason} onChangeText={setReason} maxLength={500} /> : null}
            <Btn title="Apply to the score sheet" loading={busy} onPress={async () => { const r = await run(() => api.post(`/tracking/proposals/${id}/apply`, { reconcile_reason: reason.trim() || undefined }), 'Draft score sheet opened'); if (r) onOpenScoreSheet?.(p.fixture_id ?? p.fixture.id); }} />
          </Section>
        ) : <T size={13} color={c.mute}>{p.stale ? 'The official record changed. The submitter has to re-submit it for review.' : 'Approved. An organiser or match official applies it.'}</T>
      ) : null}
      {p.state === 'applied' && onOpenScoreSheet ? <Btn title="Open the score sheet" onPress={() => onOpenScoreSheet(p.fixture.id)} /> : null}
      {p.can_withdraw ? <Btn small title="Withdraw my proposal" color={c.violet} onPress={() => run(() => api.post(`/tracking/proposals/${id}/withdraw`), 'Withdrawn')} /> : null}
    </View>
  );
}

// ----------------------------------------------------------------------------------------------------------- upload + extraction review
export function UploadFlow({ onDone, resumeId }) {
  const { toast } = useSession();
  const [sport, setSport] = useState(null);
  const [imp, setImp] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [labels, setLabels] = useState({ home: '', away: '' });
  const [sets, setSets] = useState([]);
  const [totals, setTotals] = useState({ home: 0, away: 0 });
  const [periods, setPeriods] = useState([]);
  const [linkSheet, setLinkSheet] = useState(null);

  const show = (r) => {
    setImp(r);
    if (r.sport) setSport(r.sport.slug);
    const x = r.extracted ?? {};
    setLabels({ home: x.home_label ?? '', away: x.away_label ?? '' });
    setSets(x.sets ?? []); setPeriods(x.periods ?? []); setTotals({ home: x.home ?? 0, away: x.away ?? 0 });
  };
  const pending = useLoad(() => (resumeId ? Promise.resolve([]) : api.get('/tracking/imports')), []);
  const resume = async (rid) => { try { show(await api.get(`/tracking/imports/${rid}`)); } catch (e) { toast(e.message); } };
  useEffect(() => { if (resumeId) resume(resumeId); }, [resumeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = async () => {
    const f = await pickDocument();
    if (!f) return;
    setBusy(true);
    try {
      const r = await api.postRaw(`/tracking/imports?sport=${encodeURIComponent(sport)}`, f.blob);
      show(r);
      if (Platform.OS === 'web' && f.blob.type?.startsWith('image/')) setPreview(URL.createObjectURL(f.blob));
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  if (!imp) {
    return (
      <View style={{ gap: 12 }}>
        <T color={c.mute}>Upload a PDF, photo or scan of a completed SportArena sheet. You review what was read before anything is saved, and it stays unofficial until you link it to a game and officials approve it.</T>
        <SportSelect label="Sport" value={sport} onChange={setSport} />
        <Btn title="Choose a file" disabled={!sport} loading={busy} onPress={choose} />
        {(pending.data ?? []).length ? (
          <Section title="Unfinished uploads">
            {pending.data.map((p) => <Card key={p.id} onPress={() => resume(p.id)} pad={12}><T weight="800">{p.sport_name ?? 'Sheet'} · uploaded {new Date(p.created_at).toLocaleString()}</T><T size={12} color={c.mute}>{p.state === 'needs_manual' ? 'Needs the values typed in' : 'Read automatically: needs your check'}</T></Card>)}
          </Section>
        ) : null}
      </View>
    );
  }
  const rs = imp.template.ruleset, kind = rs.kind;
  const flagged = new Set((imp.warnings ?? []).filter((w) => w.field).map((w) => w.field));
  const low = (f) => flagged.has(f) || flagged.has('totals');
  const derived = kind === 'sets' && sets.length ? { home: sets.filter((s) => s.home > s.away).length, away: sets.filter((s) => s.away > s.home).length } : kind === 'points_events' && periods.length ? { home: periods.reduce((n, p) => n + p.home, 0), away: periods.reduce((n, p) => n + p.away, 0) } : totals;
  const confirm = async () => {
    setBusy(true);
    try {
      const sheet = await api.post(`/tracking/imports/${imp.id}/confirm`, { sport, labels: { home: labels.home || undefined, away: labels.away || undefined }, totals: { ...derived, ...(kind === 'sets' && sets.length ? { sets } : {}), ...(kind === 'points_events' && periods.length ? { periods: periods.map((p, i) => ({ period: p.period ?? i + 1, home: p.home, away: p.away })) } : {}) } });
      toast('Saved as an unofficial sheet');
      setLinkSheet(sheet);
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 14 }}>
      {imp.duplicate ? <Card color={c.violetSoft} pad={12}><T weight="700" size={13}>You uploaded this file before. Showing that import.</T></Card> : null}
      <Section title="The sheet you uploaded">
        {preview ? <Image source={{ uri: preview }} style={{ width: '100%', height: 280, borderRadius: 14 }} resizeMode="contain" accessibilityLabel="Uploaded sheet" /> : <Btn small title="Open the uploaded file" color={c.cyan} onPress={() => openBlob(imp.evidence_url.replace('/api/v1', ''), toast)} />}
      </Section>
      <Section title="What was read (check each value against the sheet)">
        <Notes list={imp.warnings} />
        {imp.provider === 'none' ? <T size={13} color={c.mute}>Enter the values from the sheet below.</T> : <T size={12} color={c.mute}>Read automatically; values are never trusted until you confirm them.</T>}
        <Field label="Home / side A" value={labels.home} onChangeText={(v) => setLabels((l) => ({ ...l, home: v }))} maxLength={60} />
        <Field label="Away / side B" value={labels.away} onChangeText={(v) => setLabels((l) => ({ ...l, away: v }))} maxLength={60} />
        {kind === 'sets' ? (
          <View style={{ gap: 8 }}>
            <T weight="700">Sets {low('sets') ? <Tag label="check" color={c.sun} /> : null}</T>
            {sets.map((s, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <T style={{ width: 48 }}>Set {i + 1}</T>
                <Counter min={0} max={300} value={s.home} onChange={(v) => setSets((x) => x.map((y, k) => (k === i ? { ...y, home: v } : y)))} />
                <T>–</T>
                <Counter min={0} max={300} value={s.away} onChange={(v) => setSets((x) => x.map((y, k) => (k === i ? { ...y, away: v } : y)))} />
                <Btn small title="Remove" color={c.violet} onPress={() => setSets((x) => x.filter((_, k) => k !== i))} />
              </View>
            ))}
            <Btn small title="+ Add a set" color={c.violet} onPress={() => setSets((x) => [...x, { home: 0, away: 0 }])} />
            <T size={13} color={c.mute}>Sets won: {derived.home}–{derived.away}</T>
          </View>
        ) : kind === 'points_events' ? (
          <View style={{ gap: 8 }}>
            <T weight="700">{rs.periods.label} scores {low('periods') ? <Tag label="check" color={c.sun} /> : null}</T>
            {periods.map((p, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <T style={{ width: 56 }}>{rs.periods.label} {i + 1}</T>
                <Counter min={0} max={999} value={p.home} onChange={(v) => setPeriods((x) => x.map((y, k) => (k === i ? { ...y, home: v } : y)))} />
                <T>–</T>
                <Counter min={0} max={999} value={p.away} onChange={(v) => setPeriods((x) => x.map((y, k) => (k === i ? { ...y, away: v } : y)))} />
                <Btn small title="Remove" color={c.violet} onPress={() => setPeriods((x) => x.filter((_, k) => k !== i))} />
              </View>
            ))}
            {periods.length < rs.periods.count ? <Btn small title={`+ Add ${rs.periods.label.toLowerCase()}`} color={c.violet} onPress={() => setPeriods((x) => [...x, { home: 0, away: 0 }])} /> : null}
            {!periods.length ? (<><Counter label={`Final total ${labels.home || 'home'}`} min={0} max={999} value={totals.home} onChange={(v) => setTotals((t) => ({ ...t, home: v }))} /><Counter label={`Final total ${labels.away || 'away'}`} min={0} max={999} value={totals.away} onChange={(v) => setTotals((t) => ({ ...t, away: v }))} /></>) : <T size={13} color={c.mute}>Total: {derived.home}–{derived.away}</T>}
          </View>
        ) : (
          <>
            <Counter label={`Final ${labels.home || 'home'} ${low('home') ? '(check)' : ''}`} min={0} max={999} value={totals.home} onChange={(v) => setTotals((t) => ({ ...t, home: v }))} />
            <Counter label={`Final ${labels.away || 'away'} ${low('away') ? '(check)' : ''}`} min={0} max={999} value={totals.away} onChange={(v) => setTotals((t) => ({ ...t, away: v }))} />
          </>
        )}
      </Section>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn title="Save as unofficial sheet" loading={busy} onPress={confirm} />
        <Btn title="Discard" color={c.violet} onPress={async () => { try { await api.post(`/tracking/imports/${imp.id}/discard`); } catch { /* already gone */ } setImp(null); setPreview(null); }} />
      </View>
      {linkSheet ? (
        <Sheet visible onClose={() => onDone(linkSheet)} title="Saved">
          <View style={{ gap: 12 }}>
            <T>Saved as <T weight="800">{linkSheet.ref}</T>, unofficial and personal. Want officials to review it as the result of a real game?</T>
            <Btn title="Link to a game" onPress={() => { const s = linkSheet; setLinkSheet(null); setImp(null); onDone(s, { link: true }); }} />
            <Btn title="Keep it unofficial" color={c.violet} onPress={() => onDone(linkSheet)} />
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}

// ----------------------------------------------------------------------------------------------------------- event scoring rules + approval policy
const PRESETS = {
  official: { label: 'Referee or organiser', policy: { mode: 'parallel', requirements: [{ key: 'official_or_organiser', label: 'Referee or organiser', roles: ['official', 'organiser'] }] } },
  league: { label: 'Referee + both managers', policy: { mode: 'parallel', requirements: [{ key: 'official', label: 'Referee', roles: ['official'] }, { key: 'home_manager', label: 'Home manager', roles: ['home_manager'] }, { key: 'away_manager', label: 'Away manager', roles: ['away_manager'] }] } },
  chain: { label: 'Referee, then organiser', policy: { mode: 'sequential', requirements: [{ key: 'official', label: 'Referee or scorer', roles: ['official'] }, { key: 'organiser', label: 'Organiser', roles: ['organiser'] }] } },
};
const sameReqs = (a, b) => JSON.stringify(a.map((r) => [r.key, r.roles])) === JSON.stringify(b.map((r) => [r.key, r.roles]));

export function EventScoringConfig({ eventId: preset }) {
  const { user, toast } = useSession();
  const events = useLoad(() => (preset ? Promise.resolve([]) : api.get('/events', { organizer_id: user.id, limit: 50 })), []);
  const [eventId, setEventId] = useState(preset ?? null);
  if (!preset && events.loading) return <Loading />;
  const list = events.data ?? [];
  return (
    <View style={{ gap: 12 }}>
      <T color={c.mute}>Scoring rules and the approval policy for results proposed from tracking sheets. Only the event's organiser can change them, and rules are locked once a game has been scored.</T>
      {!preset ? (list.length ? <Seg options={list.map((e) => ({ label: e.name, value: e.id }))} value={eventId} onChange={setEventId} /> : <Empty emoji="🏆" title="No events of yours" sub="Event scoring rules are for event organisers." />) : null}
      {eventId ? <RulesEditor key={eventId} eventId={eventId} toast={toast} /> : null}
    </View>
  );
}

function RulesEditor({ eventId, toast }) {
  const rules = useLoad(() => api.get(`/events/${eventId}/scoring-ruleset`), [eventId]);
  const pol = useLoad(() => api.get(`/events/${eventId}/result-approval-policy`), [eventId]);
  const [edit, setEdit] = useState(null);
  const [polEdit, setPolEdit] = useState(null);
  if (rules.error) return <ErrorBox error={rules.error} onRetry={rules.reload} />;
  if (rules.loading || pol.loading || !rules.data || !pol.data) return <Loading />;
  const rs = edit ?? (({ source, ...r }) => r)(rules.data);
  const policy = polEdit ?? pol.data.policy;
  const preset = Object.entries(PRESETS).find(([, v]) => sameReqs(v.policy.requirements, policy.requirements) && v.policy.mode === policy.mode)?.[0] ?? 'custom';
  const saveRules = async () => { try { await api.post(`/events/${eventId}/scoring-template`, { ruleset: rs }); toast('Scoring rules saved'); setEdit(null); rules.reload(); } catch (e) { toast(e.message); } };
  const savePolicy = async () => { try { await api.post(`/events/${eventId}/result-approval-policy`, { policy }); toast('Approval policy saved'); setPolEdit(null); pol.reload(); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 14 }}>
      <Section title="Scoring rules">
        <View style={{ flexDirection: 'row', gap: 6 }}><Tag label={rules.data.source === 'template' ? 'event rules' : "sport's built-in rules"} color={rules.data.source === 'template' ? c.sun : c.violetSoft} /><Tag label={rs.kind.replace('_', ' ')} color={c.cyan} /></View>
        <T weight="800">{rs.label}</T>
        {rs.kind === 'points_events' ? (
          <>
            {rs.events.map((e, i) => <Counter key={e.kind} label={`${e.icon ?? ''} ${e.label} is worth`} suffix=" pts" min={0} max={20} value={e.points} onChange={(v) => setEdit({ ...rs, events: rs.events.map((x, k) => (k === i ? { ...x, points: v } : x)) })} />)}
            <Counter label={`Number of periods (${rs.periods.label.toLowerCase()}s)`} min={1} max={12} value={rs.periods.count} onChange={(v) => setEdit({ ...rs, periods: { ...rs.periods, count: v } })} />
            <T weight="700" size={13}>Can a game end level?</T>
            <Seg options={[{ label: 'Yes', value: true }, { label: 'No', value: false }]} value={rs.draw_allowed} onChange={(v) => setEdit({ ...rs, draw_allowed: v })} />
          </>
        ) : rs.kind === 'sets' ? (
          <>
            <T weight="700" size={13}>Best of</T>
            <Seg options={[1, 3, 5, 7].map((n) => ({ label: String(n), value: n }))} value={rs.sets.best_of} onChange={(v) => setEdit({ ...rs, sets: { ...rs.sets, best_of: v } })} />
            <Counter label="Points to win a set" min={1} max={100} value={rs.sets.points_to_win} onChange={(v) => setEdit({ ...rs, sets: { ...rs.sets, points_to_win: v } })} />
            <T weight="700" size={13}>Win by</T>
            <Seg options={[{ label: '1 point', value: 1 }, { label: '2 points', value: 2 }]} value={rs.sets.win_by} onChange={(v) => setEdit({ ...rs, sets: { ...rs.sets, win_by: v } })} />
          </>
        ) : <T color={c.mute} size={13}>This sport is scored by entering totals on the score sheet.</T>}
        {edit ? <View style={{ flexDirection: 'row', gap: 8 }}><Btn title="Save event rules" onPress={saveRules} /><Btn title="Cancel" color={c.violet} onPress={() => setEdit(null)} /></View> : null}
      </Section>
      <Section title="Who approves a proposed result">
        <Seg options={[...Object.entries(PRESETS).map(([k, v]) => ({ label: v.label, value: k })), ...(preset === 'custom' ? [{ label: 'Custom', value: 'custom' }] : [])]} value={preset} onChange={(k) => k !== 'custom' && setPolEdit({ ...policy, ...PRESETS[k].policy, quorum: null })} />
        <T weight="700" size={13}>Organiser may approve all remaining steps with a reason</T>
        <Seg options={[{ label: 'No', value: false }, { label: 'Yes', value: true }]} value={policy.allow_organiser_override} onChange={(v) => setPolEdit({ ...policy, allow_organiser_override: v })} />
        <T weight="700" size={13}>Anyone signed in may propose a result</T>
        <Seg options={[{ label: 'Yes', value: true }, { label: 'Only people involved in the game', value: false }]} value={policy.allow_public_submission} onChange={(v) => setPolEdit({ ...policy, allow_public_submission: v })} />
        <T size={12} color={c.mute}>{pol.data.source === 'default' ? 'Using the default for this kind of event.' : 'Using this event\'s own policy.'} Proposals already under review keep the policy they started under.</T>
        {polEdit ? <View style={{ flexDirection: 'row', gap: 8 }}><Btn title="Save approval policy" onPress={savePolicy} /><Btn title="Cancel" color={c.violet} onPress={() => setPolEdit(null)} /></View> : null}
      </Section>
    </View>
  );
}
