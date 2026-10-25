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

// ----------------------------------------------------------------------------------------------------------- link a heat sheet to a session
/** Heat, field and race sheets: pick the session, match each row to an entry (lanes are matched for you), and send it as a proposal. */
export function SessionLinkSheet({ sheet, onClose, onDone }) {
  const { toast } = useSession();
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(null);
  const [map, setMap] = useState({});
  const [busy, setBusy] = useState(false);
  const cands = useLoad(() => api.get('/tracking/session-candidates', { sheet_id: sheet.id, q: q.trim() || undefined }), [q]);
  const rows = (sheet.rows ?? []).map((r, i) => ({ ...r, i })).filter((r) => r.name || r.result || r.status || r.lane);
  const choose = (g) => {
    setPick(g);
    // lanes printed on the sheet usually match the session's lanes, so start from that
    const auto = {};
    for (const r of rows) { const e = g.entries.find((x) => r.lane && String(x.lane) === String(r.lane)); if (e) auto[r.i] = e.id; }
    setMap(auto);
  };
  const used = new Set(Object.values(map));
  const complete = pick && rows.length && rows.every((r) => map[r.i]) && pick.entries.every((e) => used.has(e.id));
  const submit = async () => {
    setBusy(true);
    try { onDone(await api.post(`/tracking/sheets/${sheet.id}/session-proposals`, { session_id: pick.id, mapping: rows.map((r) => ({ row: r.i, entry_id: map[r.i] })) })); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Link to a heat or session">
      <View style={{ gap: 12 }}>
        <Card color={c.orangeSoft} pad={12}><T weight="700" size={13}>This sends your results as a proposal. The programme's results do not change until the organiser (and any official the event requires) approves it.</T></Card>
        <Field label="Search by event, discipline or heat" value={q} onChangeText={setQ} />
        {cands.loading ? <Loading /> : (cands.data ?? []).length ? cands.data.map((g) => (
          <Card key={g.id} onPress={() => choose(g)} color={pick?.id === g.id ? c.violetSoft : c.paper} pad={12} accessibilityLabel={`${g.label} ${g.discipline}`}>
            <T weight="800">{g.discipline} · {g.label}</T>
            <T size={12} color={c.mute}>{g.event_name}{g.scheduled_at ? ` · ${new Date(g.scheduled_at).toLocaleString()}` : ''} · {nice(g.status)}{g.open_proposal ? ` · a proposal is already open (${nice(g.open_proposal)})` : ''}</T>
          </Card>
        )) : <Empty emoji="🔎" title="No sessions found" sub="Only heats, finals and races of the same sport, in events you can see, are listed." />}
        {pick ? (
          <View style={{ gap: 10 }}>
            <T weight="700" size={13}>Match each row of your sheet to the person in the session</T>
            {rows.map((r) => (
              <Card key={r.i} pad={10}>
                <T weight="800" size={13}>{r.lane ? `Lane ${r.lane} · ` : ''}{r.name || `Row ${r.i + 1}`}{r.result ? ` · ${r.result}` : r.status ? ` · ${r.status}` : ''}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {pick.entries.map((e) => <Chip key={e.id} label={`${e.lane ? `Lane ${e.lane}` : 'Entry'}${e.name ? ` · ${e.name}` : ''}`} active={map[r.i] === e.id} onPress={() => setMap((m) => ({ ...m, [r.i]: m[r.i] === e.id ? undefined : e.id }))} />)}
                </View>
              </Card>
            ))}
            <T size={12} color={c.mute}>{complete ? 'Everyone is matched.' : 'Match every row and every person. Use DNS on the sheet for anyone who did not start.'}</T>
            <Btn title="Send as proposal" disabled={!complete} loading={busy} onPress={submit} />
          </View>
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
      {p.kind === 'session' ? <View><H2>{p.session.label} · {p.session.discipline}</H2><T color={c.mute} size={12}>{p.payload.ruleset} · session {nice(p.session.status)} · round {p.round}</T></View> : <View><H2>{p.fixture.home_name} vs {p.fixture.away_name}</H2><T color={c.mute} size={12}>{p.fixture.event_name} · {p.ruleset.label} rules pinned by the event · round {p.round}</T></View>}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><StateTag s={p.state} />{p.stale ? <Tag label="stale: re-submit needed" color={c.orange} /> : null}<Tag label={`submitted by ${p.submitter_name}`} color={c.violetSoft} /></View>

      {p.kind === 'session' ? (
        <Card pad={14}>
          <View style={{ flexDirection: 'row' }}><Cell bold>Lane / athlete</Cell><Cell bold>Proposed</Cell><Cell bold>Recorded now</Cell></View>
          {p.payload.rows.map((r) => {
            const entry = p.current.entries.find((e) => e.id === r.entry_id) ?? null;
            return (
              <View key={r.row} style={{ flexDirection: 'row' }}>
                <Cell>{r.lane ? `Lane ${r.lane} · ` : ''}{r.name || `Row ${r.row + 1}`}</Cell>
                <Cell bold>{r.status === 'finished' ? `${r.mark ?? r.value}` : r.status.toUpperCase()}</Cell>
                <Cell>{entry && entry.status !== 'registered' ? `${entry.status === 'finished' ? entry.value : entry.status.toUpperCase()}` : 'not recorded'}</Cell>
              </View>
            );
          })}
        </Card>
      ) : null}
      {p.kind === 'session' ? null : <Card pad={14}>
        <View style={{ flexDirection: 'row' }}><Cell bold> </Cell><Cell bold>Proposed</Cell><Cell bold>Official now</Cell></View>
        <View style={{ flexDirection: 'row' }}><Cell>Score</Cell><Cell bold>{pay.home_score}–{pay.away_score}</Cell><Cell>{official}</Cell></View>
        {cur.live_log ? <View style={{ flexDirection: 'row' }}><Cell>Live match log</Cell><Cell> </Cell><Cell>{cur.live_log.home}–{cur.live_log.away} ({cur.live_log.events} events)</Cell></View> : null}
        {pay.sets?.length ? <View style={{ flexDirection: 'row' }}><Cell>Sets</Cell><Cell>{pay.sets.map((s) => `${s.home}-${s.away}`).join(', ')}</Cell><Cell> </Cell></View> : null}
        {pay.periods?.length ? <View style={{ flexDirection: 'row' }}><Cell>By period</Cell><Cell>{pay.periods.map((s) => `${s.home}-${s.away}`).join(', ')}</Cell><Cell> </Cell></View> : null}
      </Card>}

      <Notes list={p.warnings} />

      {p.evidence ? <Btn small title="Open the uploaded sheet (evidence)" color={c.cyan} onPress={() => openBlob(p.evidence.url.replace('/api/v1', ''), toast)} /> : <T size={12} color={c.mute}>{p.kind === 'session' ? `Results written on sheet ${p.sheet.ref}.` : `Tracked live on screen (${p.sheet.ref}); ${p.sheet.entries.length} recent entries recorded.`}</T>}

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
            <T size={13} color={c.mute}>{p.kind === 'session' ? 'Applying records these results for the session through the normal results path. Places are worked out from the marks, and the values recorded before are kept with this proposal.' : 'Applying opens a draft score sheet for this game. It still needs the usual sign-offs, approval and publication before it becomes official.'}</T>
            {p.needs_reconcile ? <Field label="Why does this replace the live log or published result? (organiser)" value={reason} onChangeText={setReason} maxLength={500} /> : null}
            <Btn title={p.kind === 'session' ? 'Record these results' : 'Apply to the score sheet'} loading={busy} onPress={async () => { const r = await run(() => api.post(`/tracking/proposals/${id}/apply`, { reconcile_reason: reason.trim() || undefined }), p.kind === 'session' ? 'Results recorded' : 'Draft score sheet opened'); if (r && p.kind !== 'session') onOpenScoreSheet?.(p.fixture_id ?? p.fixture.id); }} />
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

/** Build your own approval steps: who must approve, in what order, and how many approvals are enough (quorum). Roles are resolved from the game's own assignments. */
function PolicyEditor({ policy, onChange }) {
  const reqs = policy.requirements;
  const setReq = (i, patch) => onChange({ ...policy, requirements: reqs.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const toggle = (i, role) => { const roles = reqs[i].roles.includes(role) ? reqs[i].roles.filter((x) => x !== role) : [...reqs[i].roles, role]; if (roles.length) setReq(i, { roles }); };
  const quorum = policy.quorum && policy.quorum <= reqs.length ? policy.quorum : null;
  return (
    <View style={{ gap: 10 }}>
      <T weight="700" size={13}>Approval steps</T>
      {reqs.map((r, i) => (
        <Card key={r.key} pad={12}>
          <Field label={`Step ${i + 1} name`} value={r.label ?? ''} onChangeText={(v) => setReq(i, { label: v })} maxLength={40} />
          <T size={12} color={c.mute}>Who can approve this step (any of them)</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{Object.entries(ROLE).map(([k, l]) => <Chip key={k} label={l} active={r.roles.includes(k)} onPress={() => toggle(i, k)} />)}</View>
          {reqs.length > 1 ? <Btn small title="Remove step" color={c.violet} onPress={() => onChange({ ...policy, requirements: reqs.filter((_, k) => k !== i), quorum: null })} style={{ alignSelf: 'flex-start' }} /> : null}
        </Card>
      ))}
      {reqs.length < 6 ? <Btn small title="+ Add a step" color={c.violet} onPress={() => onChange({ ...policy, requirements: [...reqs, { key: `step_${reqs.length + 1}_${Math.random().toString(36).slice(2, 5)}`, label: '', roles: ['official'] }] })} style={{ alignSelf: 'flex-start' }} /> : null}
      <T weight="700" size={13}>Order</T>
      <Seg options={[{ label: 'In any order', value: 'parallel' }, { label: 'One after another', value: 'sequential' }]} value={policy.mode} onChange={(mode) => onChange({ ...policy, mode })} />
      {reqs.length > 1 ? (
        <>
          <T weight="700" size={13}>How many approvals are enough</T>
          <Seg options={[{ label: 'Every step', value: 0 }, ...Array.from({ length: reqs.length - 1 }, (_, k) => ({ label: `${k + 1} of ${reqs.length}`, value: k + 1 }))]} value={quorum ?? 0} onChange={(v) => onChange({ ...policy, quorum: v || null })} />
        </>
      ) : null}
    </View>
  );
}

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

const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

const CRICKET_INNINGS = { T10: 2, T20: 2, ODI: 2, Test: 4 };
const CRICKET_OVERS = { T10: 10, T20: 20, ODI: 50, Test: null };

/** The editable fields of a ruleset, shared by the event rules editor and the governed match-format editor. */
export function RulesetFields({ rs, onChange }) {
  return (
    <>
        {rs.kind === 'points_events' ? (
          <>
            {rs.events.map((e, i) => <Counter key={e.kind} label={`${e.icon ?? ''} ${e.label} is worth`} suffix=" pts" min={0} max={20} value={e.points} onChange={(v) => onChange({ ...rs, events: rs.events.map((x, k) => (k === i ? { ...x, points: v } : x)) })} />)}
            <Counter label={`Number of periods (${rs.periods.label.toLowerCase()}s)`} min={1} max={12} value={rs.periods.count} onChange={(v) => onChange({ ...rs, periods: { ...rs.periods, count: v } })} />
            <T weight="700" size={13}>Can a game end level?</T>
            <Seg options={[{ label: 'Yes', value: true }, { label: 'No', value: false }]} value={rs.draw_allowed} onChange={(v) => onChange({ ...rs, draw_allowed: v })} />
          </>
        ) : rs.kind === 'sets' ? (
          <>
            <T weight="700" size={13}>Best of</T>
            <Seg options={[1, 3, 5, 7].map((n) => ({ label: String(n), value: n }))} value={rs.sets.best_of} onChange={(v) => onChange({ ...rs, sets: { ...rs.sets, best_of: v } })} />
            <Counter label="Points to win a set" min={1} max={100} value={rs.sets.points_to_win} onChange={(v) => onChange({ ...rs, sets: { ...rs.sets, points_to_win: v } })} />
            <T weight="700" size={13}>Win by</T>
            <Seg options={[{ label: '1 point', value: 1 }, { label: '2 points', value: 2 }]} value={rs.sets.win_by} onChange={(v) => onChange({ ...rs, sets: { ...rs.sets, win_by: v } })} />
          </>
        ) : rs.kind === 'cricket' ? (
          <>
            <T weight="700" size={13}>Format</T>
            <Seg options={['T10', 'T20', 'ODI', 'Test'].map((f) => ({ label: f, value: f }))} value={rs.cricket.format} onChange={(f) => onChange({ ...rs, label: `Cricket ${f}`, periods: { count: CRICKET_INNINGS[f], label: 'Innings' }, cricket: { ...rs.cricket, format: f, innings: CRICKET_INNINGS[f], overs: CRICKET_OVERS[f], bowler_max: CRICKET_OVERS[f] ? Math.floor(CRICKET_OVERS[f] / 5) : null, free_hit: f !== 'Test', follow_on: f === 'Test' ? 200 : null, min_overs_day: f === 'Test' ? 90 : null, days: f === 'Test' ? 5 : null } })} />
            {rs.cricket.overs ? <Counter label="Overs per innings" min={1} max={50} value={rs.cricket.overs} onChange={(v) => onChange({ ...rs, cricket: { ...rs.cricket, overs: v, bowler_max: Math.max(1, Math.floor(v / 5)) } })} /> : <Counter label="Follow-on margin (runs)" min={50} max={400} step={10} value={rs.cricket.follow_on ?? 200} onChange={(v) => onChange({ ...rs, cricket: { ...rs.cricket, follow_on: v } })} />}
            {rs.cricket.bowler_max ? <Counter label="Most overs per bowler" min={1} max={rs.cricket.overs ?? 50} value={rs.cricket.bowler_max} onChange={(v) => onChange({ ...rs, cricket: { ...rs.cricket, bowler_max: v } })} /> : null}
            <T weight="700" size={13}>Penalty runs for a wide or no-ball</T>
            <Seg options={[{ label: '1 run', value: 1 }, { label: '2 runs', value: 2 }]} value={rs.cricket.wide_runs} onChange={(v) => onChange({ ...rs, cricket: { ...rs.cricket, wide_runs: v, noball_runs: v } })} />
            <T size={12} color={c.mute}>Cricket is scored ball by ball in Tools. The score, wickets, extras and result are worked out from the balls.</T>
          </>
        ) : <T color={c.mute} size={13}>This sport is scored by entering totals on the score sheet.</T>}
    </>
  );
}

/** Governed match formats of a sport (newest version of each) that an organiser can adopt instead of typing their own rules. */
function Formats({ sport, onPick, onStandard }) {
  const f = useLoad(() => (sport ? api.get('/ruleset-versions', { sport }) : Promise.resolve({ versions: [] })), [sport]);
  const latest = Object.values((f.data?.versions ?? []).reduce((m, v) => ({ ...m, [v.format_key]: m[v.format_key]?.version > v.version ? m[v.format_key] : v }), {}));
  return (
    <View style={{ gap: 6 }}>
      <T weight="700" size={13}>Start from the standard or a governed match format</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Chip label="Standard rules" onPress={onStandard} />{latest.map((v) => <Chip key={v.id} label={`${v.label} · v${v.version}`} onPress={() => onPick(v)} />)}</View>
    </View>
  );
}

function RulesEditor({ eventId, toast }) {
  const rules = useLoad(() => api.get(`/events/${eventId}/scoring-ruleset`), [eventId]);
  const pol = useLoad(() => api.get(`/events/${eventId}/result-approval-policy`), [eventId]);
  const [edit, setEdit] = useState(null);
  const [polEdit, setPolEdit] = useState(null);
  const [customPolicy, setCustomPolicy] = useState(false);
  if (rules.error) return <ErrorBox error={rules.error} onRetry={rules.reload} />;
  if (rules.loading || pol.loading || !rules.data || !pol.data) return <Loading />;
  const rs = edit ?? (({ source, version, format_key, sport, standard, ...r }) => r)(rules.data);
  const policy = polEdit ?? pol.data.policy;
  const preset = Object.entries(PRESETS).find(([, v]) => sameReqs(v.policy.requirements, policy.requirements) && v.policy.mode === policy.mode)?.[0] ?? 'custom';
  const useFormat = async (f) => { try { await api.post(`/events/${eventId}/scoring-template`, { ruleset_version_id: f.id }); toast(`${f.label} v${f.version} applied`); setEdit(null); rules.reload(); } catch (e) { toast(e.message); } };
  const useStandard = async () => { try { await api.post(`/events/${eventId}/scoring-template`, { ruleset: rules.data.standard }); toast('Standard rules applied'); setEdit(null); rules.reload(); } catch (e) { toast(e.message); } };
  const saveRules = async () => { try { await api.post(`/events/${eventId}/scoring-template`, { ruleset: rs }); toast('Scoring rules saved'); setEdit(null); rules.reload(); } catch (e) { toast(e.message); } };
  const savePolicy = async () => { try { await api.post(`/events/${eventId}/result-approval-policy`, { policy }); toast('Approval policy saved'); setPolEdit(null); pol.reload(); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 14 }}>
      <Section title="Scoring rules">
        <View style={{ flexDirection: 'row', gap: 6 }}><Tag label={rules.data.source === 'template' ? 'event rules' : rules.data.source === 'governed' ? 'governed rules' : "sport's built-in rules"} color={rules.data.source === 'template' ? c.sun : c.violetSoft} />{rules.data.version ? <Tag label={`${rules.data.format_key?.replace(/_/g, ' ') ?? 'format'} v${rules.data.version}`} color={c.mint} /> : null}<Tag label={rs.kind.replace('_', ' ')} color={c.cyan} /></View>
        <T weight="800">{rs.label}</T>
        {(() => { const { source, version, format_key, sport, standard, ...cur } = rules.data; return standard && canon(cur) !== canon(standard) ? <Tag label="differs from standard" color={c.orange} /> : null; })()}
        <Formats sport={rules.data.sport} onPick={useFormat} onStandard={useStandard} />
        <RulesetFields rs={rs} onChange={setEdit} />
        {edit ? <View style={{ flexDirection: 'row', gap: 8 }}><Btn title="Save event rules" onPress={saveRules} /><Btn title="Cancel" color={c.violet} onPress={() => setEdit(null)} /></View> : null}
      </Section>
      <Section title="Who approves a proposed result">
        <Seg options={[...Object.entries(PRESETS).map(([k, v]) => ({ label: v.label, value: k })), { label: 'Custom', value: 'custom' }]} value={customPolicy ? 'custom' : preset} onChange={(k) => { if (k === 'custom') { setCustomPolicy(true); setPolEdit(policy); } else { setCustomPolicy(false); setPolEdit({ ...policy, ...PRESETS[k].policy, quorum: null }); } }} />
        {customPolicy || preset === 'custom' ? <PolicyEditor policy={policy} onChange={setPolEdit} /> : null}
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
