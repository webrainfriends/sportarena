// Tools > Scoring & Game Tracking (#416). Anyone can start a sheet, track live, print it and keep it as an unofficial record.
// Linking a sheet to a real game turns it into a result PROPOSAL: it is reviewed by the game's own officials and only then reaches
// the existing score-sheet lifecycle. Scoring rules always come from the server (the canonical engine); nothing is computed here.
import React, { useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { Counter, DateField } from '../pickers';
import { SportSelect } from '../sportpicker';
import { useLayout } from '../layout';
import { c } from '../theme';
import { LinkSheet, ProposalReview, StateTag, UploadFlow, EventScoringConfig } from './scoring-review';

const nice = (s = '') => String(s).replace(/_/g, ' ');
export const OfficialBanner = ({ sheet }) => (
  <View accessible accessibilityRole="text" style={{ backgroundColor: sheet.mode === 'linked' ? c.orangeSoft : c.violetSoft, borderRadius: 14, padding: 10, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
    <T size={18}>{sheet.mode === 'linked' ? '🕓' : '🔒'}</T>
    <T weight="700" size={13} style={{ flex: 1 }}>{sheet.mode === 'linked' ? 'Result proposal: not official until the game\'s officials approve it' : 'Unofficial / standalone: personal tracking, never counted in standings or rankings'}</T>
  </View>
);

export async function openPdf(sheetId, toast, kitId) {
  try {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return toast?.('Printable sheets open in the web app');
    const url = URL.createObjectURL(await api.download(`/tracking/sheets/${sheetId}/pdf${kitId ? `?kit_id=${kitId}` : ''}`));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) { toast?.(e.message); }
}

// ----------------------------------------------------------------------------------------------------------- big touch buttons
function Big({ label, sub, onPress, color = c.pink, disabled }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityLabel={sub ? `${label}, ${sub}` : label}
      style={({ pressed }) => ({ flex: 1, minHeight: 84, borderRadius: 22, backgroundColor: disabled ? c.violetSoft : color, alignItems: 'center', justifyContent: 'center', padding: 8, opacity: pressed ? 0.8 : 1 })}>
      <T size={22} weight="800" color="#fff" style={{ textAlign: 'center' }}>{label}</T>
      {sub ? <T size={12} color="#fff" style={{ textAlign: 'center' }}>{sub}</T> : null}
    </Pressable>
  );
}

// ----------------------------------------------------------------------------------------------------------- live tracker
function Scoreboard({ s, tracker }) {
  const r = s.result, mode = s.template.layout.mode;
  const set = r.current_set ?? (r.sets?.length ? r.sets[r.sets.length - 1] : null);
  return (
    <Card color={c.paper} pad={16}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }} accessibilityLabel={`Score ${r.home ?? 0} to ${r.away ?? 0}`}>
        <T weight="800" size={14} style={{ flex: 1 }} numberOfLines={1}>{s.labels.home}</T>
        <T size={44} weight="800">{mode === 'sets' && set ? `${set.home} – ${set.away}` : `${r.home ?? 0} – ${r.away ?? 0}`}</T>
        <T weight="800" size={14} style={{ flex: 1, textAlign: 'right' }} numberOfLines={1}>{s.labels.away}</T>
      </View>
      {mode === 'sets' ? (
        <View style={{ alignItems: 'center', gap: 4 }}>
          <T color={c.mute} size={13}>Sets {r.home} – {r.away} · best of {s.template.layout.sets.best_of}{r.over ? ' · match decided' : r.current_set ? ` · set ${r.sets.length + 1}` : ''}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>{r.sets.map((x, i) => <Tag key={i} label={`${x.home}-${x.away}`} color={x.winner === 'home' ? c.mint : c.cyan} />)}</View>
        </View>
      ) : null}
      {mode === 'points_events' && r.periods?.length ? <T color={c.mute} size={12} style={{ textAlign: 'center' }}>{r.periods.map((p) => `${s.template.layout.periods.label} ${p.period}: ${p.home}-${p.away}`).join('  ·  ')}</T> : null}
      {tracker ? null : null}
    </Card>
  );
}

function ResultsRows({ s, save }) {
  const [rows, setRows] = useState(() => { const n = s.template.layout.results.rows; return Array.from({ length: n }, (_, i) => s.rows[i] ?? { order: i + 1 }); });
  const set = (i, patch) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <View style={{ gap: 8 }}>
      {rows.map((r, i) => (
        <Card key={i} pad={10}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <View style={{ width: 60 }}><Field label="Lane" value={r.lane ?? ''} onChangeText={(v) => set(i, { lane: v })} maxLength={10} /></View>
            <View style={{ flex: 1 }}><Field label="Participant" value={r.name ?? ''} onChangeText={(v) => set(i, { name: v })} maxLength={80} /></View>
            <View style={{ width: 96 }}><Field label={s.template.layout.results.unit === 'time' ? 'Time' : 'Result'} value={r.result ?? ''} onChangeText={(v) => set(i, { result: v })} maxLength={20} /></View>
          </View>
          <Seg options={[{ label: 'Finished', value: '' }, 'DNS', 'DNF', 'DQ']} value={r.status ?? ''} onChange={(v) => set(i, { status: v })} />
        </Card>
      ))}
      <Btn title="Save results" onPress={() => save(rows.filter((r) => r.name || r.result || r.lane).map((r, i) => ({ ...r, order: i + 1 })))} />
    </View>
  );
}

export function Tracker({ id, onClose, openLink }) {
  const { toast } = useSession();
  const L = useLayout();
  const load = useLoad(() => api.get(`/tracking/sheets/${id}`), [id]);
  const [fresh, setFresh] = useState(null);
  const [period, setPeriod] = useState(1);
  const [pending, setPending] = useState([]);
  const [link, setLink] = useState(!!openLink);
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const flushing = useRef(false);
  const kits = useLoad(() => api.get('/brand-kits').catch(() => []), []);
  const [kit, setKit] = useState(null);
  const s = fresh ?? load.data;
  if (load.error) return <ErrorBox error={load.error} onRetry={load.reload} />;
  if (!s) return <Loading />;
  const layout = s.template.layout, live = s.status === 'in_progress';
  const labelOf = (side) => s.labels[side];

  const send = async (e) => {
    try { const r = await api.patch(`/tracking/sheets/${id}`, { add_entry: e }); setFresh(r); setPending((p) => p.filter((x) => x.client_key !== e.client_key)); return true; }
    catch (err) {
      if (err.status && err.status < 500) { setPending((p) => p.filter((x) => x.client_key !== e.client_key)); toast(err.message); return true; }
      return false; // offline or server trouble: keep it, the same client_key makes a retry safe
    }
  };
  const flush = async () => {
    if (flushing.current) return; flushing.current = true;
    try { for (const e of [...pending]) if (!(await send(e))) break; } finally { flushing.current = false; }
  };
  const record = async (kind, side) => {
    const e = { kind, side, period: layout.mode === 'points_events' ? period : undefined, client_key: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` };
    setPending((p) => [...p, e]);
    if (!(await send(e))) toast('Not saved yet. It will be retried; tap Retry when you are back online.');
  };
  const patch = async (body, ok) => { try { setFresh(await api.patch(`/tracking/sheets/${id}`, body)); if (ok) toast(ok); } catch (e) { toast(e.message); } };
  const complete = async () => { setBusy(true); try { setFresh(await api.post(`/tracking/sheets/${id}/complete`)); toast('Saved as a completed sheet'); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const hasLive = s.entries.some((e) => !e.voided_at);
  const recent = [...s.entries].reverse().slice(0, 8);
  const kindLabel = (k) => [...layout.scoring, ...layout.stats].find((x) => x.kind === k)?.label ?? (k === 'point' ? 'Point' : nice(k));
  const tally = (side, kind) => s.result.stats?.[side]?.[kind] ?? 0;

  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flex: 1 }}><H2>{s.title || layout.title}</H2><T color={c.mute} size={12}>{s.ref} · template v{s.template.version}{s.fixture ? ` · ${s.fixture.event_name}` : ''}</T></View>
        <Tag label={live ? 'live' : s.status} color={live ? c.mint : c.violetSoft} />
        <Btn small title="Close" color={c.violet} onPress={onClose} />
      </View>
      <OfficialBanner sheet={s} />
      <Scoreboard s={s} />
      <T size={12} color={c.mute} accessibilityLiveRegion="polite">{pending.length ? `⚠ ${pending.length} not sent yet` : '✓ Saved'}</T>
      {pending.length ? <Btn small title="Retry sending" onPress={flush} color={c.sun} /> : null}

      {live && layout.mode === 'sets' ? <View style={{ flexDirection: 'row', gap: 12 }}><Big label={`+1 ${labelOf('home')}`} onPress={() => record('point', 'home')} disabled={s.result.over} /><Big label={`+1 ${labelOf('away')}`} onPress={() => record('point', 'away')} color={c.violet} disabled={s.result.over} /></View> : null}

      {live && layout.mode === 'points_events' ? (
        <View style={{ gap: 12 }}>
          <Seg options={Array.from({ length: layout.periods.count }, (_, i) => ({ label: `${layout.periods.label} ${i + 1}`, value: i + 1 }))} value={period} onChange={setPeriod} />
          {layout.scoring.map((e) => (
            <View key={e.kind} style={{ flexDirection: 'row', gap: 12 }}>
              <Big label={`${e.icon ?? '+'} ${e.label}`} sub={`${labelOf('home')} · ${tally('home', e.kind)}`} onPress={() => record(e.kind, 'home')} />
              <Big label={`${e.icon ?? '+'} ${e.label}`} sub={`${labelOf('away')} · ${tally('away', e.kind)}`} onPress={() => record(e.kind, 'away')} color={c.violet} />
            </View>
          ))}
        </View>
      ) : null}

      {live && layout.stats.length && layout.mode !== 'results' && layout.mode !== 'manual' ? (
        <Section title="Other events">
          {['home', 'away'].map((side) => (
            <View key={side} style={{ gap: 6 }}>
              <T weight="700" size={12} color={c.mute}>{labelOf(side)}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {layout.stats.map((st) => <Chip key={st.kind} label={`${st.icon ?? ''} ${st.label} · ${tally(side, st.kind)}`.trim()} onPress={() => record(st.kind, side)} />)}
              </View>
            </View>
          ))}
        </Section>
      ) : null}

      {live && layout.mode === 'manual' ? (
        <Card><T weight="800">Final totals</T>
          <Counter label={labelOf('home')} min={0} max={999} value={s.manual_totals?.home ?? 0} onChange={(v) => patch({ manual_totals: { home: v, away: s.manual_totals?.away ?? 0 } })} />
          <Counter label={labelOf('away')} min={0} max={999} value={s.manual_totals?.away ?? 0} onChange={(v) => patch({ manual_totals: { home: s.manual_totals?.home ?? 0, away: v } })} />
        </Card>
      ) : null}
      {live && layout.mode === 'results' ? <ResultsRows s={s} save={(rows) => patch({ rows }, 'Results saved')} /> : null}

      {s.checks.length ? <View style={{ gap: 6 }}>{s.checks.map((k, i) => <T key={i} size={13} color={k.severity === 'error' ? c.orange : c.mute}>{k.severity === 'error' ? '⛔' : '⚠️'} {k.message}</T>)}</View> : null}

      {hasLive || recent.length ? (
        <Section title="Recent entries">
          {recent.map((e) => (
            <T key={e.id} size={13} color={e.voided_at ? c.mute : c.ink} style={e.voided_at ? { textDecorationLine: 'line-through' } : null}>
              #{e.seq} · {e.side ? labelOf(e.side) : ''} {kindLabel(e.kind)}{e.period ? ` · ${layout.periods?.label ?? 'P'} ${e.period}` : ''}{e.voided_at ? ' · undone' : ''}
            </T>
          ))}
        </Section>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {live ? <Btn title="↩︎ Undo last" color={c.violet} disabled={!hasLive} onPress={() => patch({ void_entry: { reason: 'Undone' } })} /> : null}
        {live ? <Btn title="Complete sheet" color={c.mint} loading={busy} onPress={complete} /> : null}
        <Btn title="Download PDF" color={c.cyan} onPress={() => openPdf(id, toast, kit)} />
        {s.status === 'completed' && !s.proposal ? <Btn title="Link to a match" color={c.pink} onPress={() => setLink(true)} /> : null}
      </View>
      {(kits.data ?? []).length ? <View style={{ gap: 4 }}><T size={12} color={c.mute}>PDF branding (from Document Designer). It never changes what the sheet means.</T><Seg options={[{ label: 'Plain', value: null }, ...kits.data.map((k) => ({ label: k.name, value: k.id }))]} value={kit} onChange={setKit} /></View> : null}
      {s.proposal ? <Card onPress={() => setReview(s.proposal.id)}><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>Result proposal · round {s.proposal.round}</T><StateTag s={s.proposal.state} /></View><T color={c.mute} size={12}>Tap to see the review</T></Card> : null}
      {link ? <LinkSheet sheet={s} onClose={() => setLink(false)} onDone={(p) => { setLink(false); setReview(p.id); load.reload(); setFresh(null); }} /> : null}
      {review ? <Sheet visible onClose={() => { setReview(null); setFresh(null); load.reload(); }} title="Result proposal"><ProposalReview id={review} /></Sheet> : null}
    </View>
  );
}

// ----------------------------------------------------------------------------------------------------------- start flow
function Start({ presetFixture, ctx, onStarted, onClose }) {
  const { toast } = useSession();
  const [sport, setSport] = useState(null);
  const [variant, setVariant] = useState(null);
  const [bestOf, setBestOf] = useState(null);
  const [mode, setMode] = useState(presetFixture ? 'link' : 'standalone');
  const [fixture, setFixture] = useState(presetFixture ? { id: presetFixture } : null);
  const [q, setQ] = useState('');
  const [labels, setLabels] = useState({ home: '', away: '' });
  const [tpl, setTpl] = useState('starter');
  const [date, setDate] = useState(null);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const templates = useLoad(() => (sport ? api.get('/tracking/templates', { sport, variant: variant ?? undefined, best_of: bestOf ?? undefined }) : Promise.resolve(null)), [sport, variant, bestOf]);
  const cands = useLoad(() => (mode === 'link' && sport && !presetFixture ? api.get('/tracking/link-candidates', { sport, q: q.trim() || undefined, around: date ? new Date(`${date}T12:00:00`).toISOString() : undefined, days: date ? 1 : 7 }) : Promise.resolve([])), [mode, sport, q, date]);
  const t = templates.data;
  const body = () => ({ ...(sport ? { sport } : {}), variant: variant ?? undefined, best_of: bestOf ?? undefined, ...(tpl !== 'starter' ? { template_id: tpl } : {}), ...(mode === 'link' ? { fixture_id: fixture?.id } : { labels: { home: labels.home || undefined, away: labels.away || undefined } }), ...(date ? { occurred_at: new Date(`${date}T12:00:00`).toISOString() } : {}), ...(ctx ?? {}) });
  const go = async (print) => {
    if (mode === 'link' && !fixture) { toast('Pick the game first'); return; }
    setBusy(true);
    try {
      const s = await api.post('/tracking/sheets', body());
      if (print) await openPdf(s.id, toast);
      onStarted(s, print);
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const suggest = async () => {
    try {
      const r = await api.post('/tracking/templates/prepare', { sport, variant: variant ?? undefined, brief: brief.trim() || undefined });
      if (r.source !== 'ai') { toast('AI is not available, so the standard governed sheet is used'); return; }
      const d = await api.post('/tracking/templates', { name: `AI layout: ${brief.trim().slice(0, 50)}`, sport, variant: t?.starter.variant, best_of: bestOf ?? undefined, customise: r.customise, from_ai: true });
      await api.post(`/tracking/templates/${d.id}/publish`);
      await templates.reload(); setTpl(d.id); toast(`Layout ready: ${r.explanation}`);
    } catch (e) { toast(e.message); }
  };
  return (
    <Sheet visible onClose={onClose} title="New sheet">
      <View style={{ gap: 14 }}>
        {presetFixture ? <T color={c.mute} size={13}>For the selected game. Its rules and team names come from the event.</T> : <SportSelect label="1 · Sport" value={sport} onChange={(v) => { setSport(v); setVariant(null); setBestOf(null); setTpl('starter'); }} />}
        {t ? (
          <>
            <T weight="700" size={13}>2 · Format</T>
            <Seg options={t.variants} value={variant ?? t.starter.variant} onChange={setVariant} />
            {t.starter.formats && mode === 'standalone' ? <Seg options={t.starter.formats.map((n) => ({ label: `Best of ${n}`, value: n }))} value={bestOf ?? t.starter.ruleset.sets.best_of} onChange={setBestOf} /> : null}
          </>
        ) : null}
        {sport || presetFixture ? (
          <>
            <T weight="700" size={13}>3 · Is this for a real SportArena game?</T>
            <Seg options={[{ label: 'Just for me (standalone)', value: 'standalone' }, { label: 'Link to a game', value: 'link' }]} value={mode} onChange={setMode} />
            {mode === 'standalone' ? (
              <View style={{ gap: 8 }}>
                <Field label="Home / side A (optional)" value={labels.home} onChangeText={(v) => setLabels((l) => ({ ...l, home: v }))} maxLength={60} />
                <Field label="Away / side B (optional)" value={labels.away} onChangeText={(v) => setLabels((l) => ({ ...l, away: v }))} maxLength={60} />
                <DateField label="Game date" value={date} onChange={setDate} optional />
              </View>
            ) : presetFixture ? <Tag label="Game selected" color={c.mint} /> : (
              <View style={{ gap: 8 }}>
                <Field label="Search by team or event" value={q} onChangeText={setQ} placeholder="e.g. Rovers" />
                <DateField label="Played on" value={date} onChange={setDate} optional />
                {cands.loading ? <Loading /> : (cands.data ?? []).length ? cands.data.map((g) => (
                  <Card key={g.id} onPress={() => setFixture(g)} color={fixture?.id === g.id ? c.violetSoft : c.paper} pad={12}>
                    <T weight="800">{g.home_name} vs {g.away_name}</T>
                    <T size={12} color={c.mute}>{g.event_name} · {new Date(g.scheduled_at).toLocaleString()}{g.open_proposal ? ` · a result proposal is already open (${nice(g.open_proposal)})` : ''}</T>
                  </Card>
                )) : <Empty emoji="🔎" title="No matching games" sub="Only games in public events around that date are listed." />}
              </View>
            )}
            <T weight="700" size={13}>4 · Template</T>
            {t ? <Seg options={[{ label: 'Standard (governed)', value: 'starter' }, ...t.templates.map((x) => ({ label: x.name, value: x.id }))]} value={tpl} onChange={setTpl} /> : null}
            <Field label="Describe what to track (optional, AI may arrange the layout)" value={brief} onChangeText={setBrief} maxLength={300} placeholder="U12 football, track fouls and cards" />
            {brief.trim() ? <Btn small title="Suggest layout" color={c.violet} onPress={suggest} /> : null}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn title="Start live tracker" loading={busy} onPress={() => go(false)} />
              <Btn title="Download PDF to print" color={c.cyan} loading={busy} onPress={() => go(true)} />
            </View>
          </>
        ) : null}
      </View>
    </Sheet>
  );
}

// ----------------------------------------------------------------------------------------------------------- my sheets / templates
function MySheets({ onOpen, initialState }) {
  const [status, setStatus] = useState(initialState ?? 'all');
  const [mode, setMode] = useState('all');
  const [sport, setSport] = useState(null);
  const q = { status: status === 'all' ? undefined : status, mode: mode === 'all' ? undefined : mode, sport: sport ?? undefined, limit: 50 };
  const list = useLoad(() => api.get('/tracking/sheets', q), [status, mode, sport]);
  return (
    <View style={{ gap: 12 }}>
      <Seg options={[{ label: 'All', value: 'all' }, { label: 'In progress', value: 'in_progress' }, { label: 'Completed', value: 'completed' }]} value={status} onChange={setStatus} />
      <Seg options={[{ label: 'Any kind', value: 'all' }, { label: 'Standalone', value: 'standalone' }, { label: 'Linked', value: 'linked' }]} value={mode} onChange={setMode} />
      <SportSelect label="Sport" value={sport} onChange={setSport} optional allLabel="All sports" />
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading ? <Loading /> : !(list.data ?? []).length ? <Empty emoji="🧮" title="No sheets yet" sub="Start a new sheet or upload a completed one." /> : list.data.map((s) => (
        <Card key={s.id} onPress={() => onOpen(s.id)} accessibilityLabel={`${s.title || s.sport_name} ${s.ref}`} pad={14}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <T size={24}>{s.sport_emoji}</T>
            <View style={{ flex: 1 }}>
              <T weight="800">{s.title || `${s.labels?.home ?? 'Home'} vs ${s.labels?.away ?? 'Away'}`}</T>
              <T size={12} color={c.mute}>{s.sport_name} · {new Date(s.occurred_at).toLocaleDateString()} · {s.ref}</T>
            </View>
            <T size={20} weight="800">{s.score ? `${s.score.home}–${s.score.away}` : '–'}</T>
          </View>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <Tag label={nice(s.status)} color={s.status === 'in_progress' ? c.mint : c.violetSoft} />
            <Tag label={s.mode === 'linked' ? 'Linked' : 'Unofficial'} color={s.mode === 'linked' ? c.sun : c.violetSoft} />
            {s.provenance !== 'live' ? <Tag label={`from ${s.provenance}`} color={c.cyan} /> : null}
            {s.proposal_state ? <StateTag s={s.proposal_state} /> : null}
          </View>
        </Card>
      ))}
    </View>
  );
}

function Templates() {
  const { toast } = useSession();
  const [sport, setSport] = useState(null);
  const list = useLoad(() => (sport ? api.get('/tracking/templates', { sport }) : Promise.resolve(null)), [sport]);
  const [name, setName] = useState('');
  const [hidden, setHidden] = useState([]);
  const [notes, setNotes] = useState('');
  const [orientation, setOrientation] = useState('portrait');
  const [paper, setPaper] = useState('A4');
  const run = async (fn, ok) => { try { await fn(); toast(ok); list.reload(); } catch (e) { toast(e.message); } };
  const t = list.data;
  const create = () => run(async () => { const d = await api.post('/tracking/templates', { name: name.trim(), sport, variant: t.starter.variant, customise: { hidden_stats: hidden, notes_fields: notes.trim() ? [notes.trim()] : [], orientation, paper } }); await api.post(`/tracking/templates/${d.id}/publish`); setName(''); setHidden([]); setNotes(''); }, 'Template published');
  return (
    <View style={{ gap: 12 }}>
      <T color={c.mute} size={13}>A template changes what is shown and how it prints. It never changes the scoring rules, and published versions never change.</T>
      <SportSelect label="Sport" value={sport} onChange={setSport} />
      {t ? (
        <>
          <Section title="Your templates">
            {t.templates.length ? t.templates.map((x) => (
              <Card key={x.id} pad={12}><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>{x.name} · v{x.current_version}</T><Btn small title="Retire" color={c.violet} onPress={() => run(() => api.post(`/tracking/templates/${x.id}/retire`), 'Template retired')} /></View></Card>
            )) : <Empty emoji="📐" title="No saved templates" sub="The standard governed sheet is always available." />}
          </Section>
          <Section title="New template">
            <Field label="Name" value={name} onChangeText={setName} maxLength={80} />
            <T weight="700" size={13}>Show these stats (scoring events are always shown)</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {t.starter.layout.stats.map((st) => <Chip key={st.kind} label={st.label} active={!hidden.includes(st.kind)} onPress={() => setHidden((h) => (h.includes(st.kind) ? h.filter((k) => k !== st.kind) : [...h, st.kind]))} />)}
            </View>
            <Field label="Extra notes box (custom, not an official field)" value={notes} onChangeText={setNotes} maxLength={40} />
            <Seg options={[{ label: 'Portrait', value: 'portrait' }, { label: 'Landscape', value: 'landscape' }]} value={orientation} onChange={setOrientation} />
            <Seg options={['A4', 'Letter']} value={paper} onChange={setPaper} />
            <Btn title="Save and publish" disabled={name.trim().length < 2} onPress={create} />
          </Section>
        </>
      ) : null}
    </View>
  );
}

// ----------------------------------------------------------------------------------------------------------- awaiting review
function Awaiting({ onOpen }) {
  const list = useLoad(() => api.get('/tracking/awaiting-review'), []);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (list.loading) return <Loading />;
  if (!list.data.length) return <Empty emoji="✅" title="Nothing waiting for you" sub="Proposals for games you officiate, run or manage appear here." />;
  return list.data.map((p) => (
    <Card key={p.id} onPress={() => onOpen(p.id)} pad={14}>
      <T weight="800">{p.home_name} vs {p.away_name}</T>
      <T size={12} color={c.mute}>{p.event_name} · proposes {p.payload.home_score}–{p.payload.away_score}</T>
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}><Tag label={p.action === 'apply' ? 'ready to apply' : 'needs your review'} color={p.action === 'apply' ? c.mint : c.sun} /><StateTag s={p.state} /></View>
    </Card>
  ));
}

// ----------------------------------------------------------------------------------------------------------- the tool
const TILES = [
  ['start', '➕', 'Start new sheet', 'Pick a sport and track live or print'],
  ['continue', '▶️', 'Continue live sheet', 'Sheets still in progress'],
  ['upload', '📷', 'Upload completed sheet', 'Photo, scan or PDF'],
  ['mine', '🗂️', 'My sheets', 'Drafts, completed and linked'],
  ['templates', '📐', 'Templates', 'Layouts for your sport'],
  ['awaiting', '🧾', 'Awaiting my review', 'Proposed results to review'],
  ['rules', '⚙️', 'Event scoring rules', 'Rules and approval policy for your event'],
];

export function ScoringTool({ fixtureId, eventId, contextType, contextId, tab: tab0, sheetId, proposalId, importId }) {
  const { push } = useNav();
  const L = useLayout();
  const counts = useLoad(() => Promise.all([api.get('/tracking/sheets', { status: 'in_progress', limit: 50 }), api.get('/tracking/awaiting-review').catch(() => [])]), []);
  const [tab, setTab] = useState(tab0 ?? (importId ? 'upload' : fixtureId ? 'start' : 'home'));
  const [open, setOpen] = useState(sheetId ?? null);
  const [review, setReview] = useState(proposalId ?? null);
  const [linkAfter, setLinkAfter] = useState(false);
  const ctx = contextType && contextId ? { context_type: contextType, context_id: contextId } : undefined;
  const inProgress = counts.data?.[0]?.length ?? 0, waiting = counts.data?.[1]?.length ?? 0;
  const badge = { continue: inProgress, awaiting: waiting };
  const back = () => { setTab('home'); setOpen(null); counts.reload(); };
  const started = (s) => { setTab('home'); setOpen(s.id); counts.reload(); };

  return (
    <Screen>
      {!open && tab === 'home' ? <H1>Scoring & Game Tracking</H1> : null}
      {open ? <Tracker id={open} onClose={back} openLink={linkAfter} /> : tab === 'home' ? (
        <>
          <T color={c.mute}>Anyone can score or track. Only a game's own officials can turn tracking into an official result.</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {TILES.map(([k, icon, title, sub]) => (
              <Card key={k} onPress={() => setTab(k === 'continue' ? 'mine' : k)} accessibilityLabel={`${title}${badge[k] ? `, ${badge[k]}` : ''}. ${sub}`} style={{ width: L.tablet ? '31%' : '47%', flexGrow: 1 }} pad={14}>
                <T size={28}>{icon}</T><T weight="800">{title}</T><T size={12} color={c.mute}>{sub}</T>
                {badge[k] ? <Tag label={String(badge[k])} color={k === 'awaiting' ? c.cyan : c.sun} /> : null}
              </Card>
            ))}
          </View>
        </>
      ) : (
        <>
          <Btn small title="← Scoring & Game Tracking" color={c.violet} onPress={back} style={{ alignSelf: 'flex-start' }} />
          {tab === 'start' ? <Start presetFixture={fixtureId} ctx={ctx} onStarted={started} onClose={back} /> : null}
          {tab === 'mine' ? <MySheets onOpen={(id) => setOpen(id)} initialState={tab0 === 'mine' ? 'in_progress' : undefined} /> : null}
          {tab === 'templates' ? <Templates /> : null}
          {tab === 'upload' ? <UploadFlow resumeId={importId} onDone={(s, o) => { setTab('home'); setOpen(s.id); setLinkAfter(!!o?.link); counts.reload(); }} /> : null}
          {tab === 'awaiting' ? <Awaiting onOpen={(id) => setReview(id)} /> : null}
          {tab === 'rules' ? <EventScoringConfig eventId={eventId} /> : null}
        </>
      )}
      {review ? <Sheet visible onClose={() => { setReview(null); counts.reload(); }} title="Result proposal"><ProposalReview id={review} onChanged={counts.reload} onOpenScoreSheet={(fid) => { setReview(null); push('ScoreSheet', { id: fid }); }} /></Sheet> : null}
    </Screen>
  );
}
