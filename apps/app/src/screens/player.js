import React, { useMemo, useState } from 'react';
import { Platform, Pressable, TextInput, View, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Empty, ErrorBox, H1, H2, Loading, Screen, Seg, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, fam, toneFor, day } from '../theme';
import { FavouriteSports } from '../sportpicker';
import { AthleteToday } from './athlete-home';
import { Billboard, Shop, Hire, Insure, useCols } from './marketplace';

const LEVELS = ['beginner', 'amateur', 'semi_pro', 'pro'];
const ROLES = ['athlete', 'coach', 'referee', 'physio', 'doctor'];
const nice = (s) => String(s).replace(/_/g, ' ');
const fmt = (n) => (n === null || n === undefined ? '–' : Number.isInteger(+n) ? String(+n) : (+n).toFixed(1));
const RESULT = { win: ['W', c.lime, c.limeSoft], draw: ['D', c.mute, c.violetSoft], loss: ['L', c.red, '#FFE4E6'] };

const Pill = ({ label, fg = c.mute, bg = c.violetSoft }) => (
  <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' }}>
    <T weight="700" size={11} color={fg} style={{ letterSpacing: 0.3 }}>{label}</T>
  </View>
);

const FormDots = ({ form }) => (
  <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center' }}>
    {form.length === 0 ? <T size={12} color={c.mute}>No matches yet</T> : [...form].reverse().map((r, n) => {
      const [l, fg, bg] = RESULT[r] ?? ['–', c.mute, c.violetSoft];
      return <View key={n} style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}><T weight="800" size={11} color={fg}>{l}</T></View>;
    })}
  </View>
);

const Stat = ({ value, label, tone }) => (
  <View style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 14, backgroundColor: tone ? tone[1] : c.bg }}>
    <T weight="800" size={20} color={tone ? tone[2] : c.ink} style={{ fontVariant: ['tabular-nums'], letterSpacing: -0.4 }}>{value}</T>
    <T weight="700" size={10} color={c.mute} style={{ letterSpacing: 0.9, marginTop: 2 }}>{label}</T>
  </View>
);

/** Parse "goals=2, assists 1" into {goals:2, assists:1}. */
function parseStats(txt) {
  const out = {};
  for (const part of String(txt ?? '').split(/[,\n;]/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z][\w ]*?)\s*[=:\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`Couldn't read "${part}" — use name=number, e.g. goals=2, assists=1`);
    out[m[1].trim().toLowerCase().replace(/\s+/g, '_')] = Number(m[2]);
  }
  return out;
}

// ---------- sport profile card ----------

function SportCard({ p, width, onOpen, onDefault, onLog, selected }) {
  const tone = toneFor(p.sport_slug);
  const s = p.summary;
  const top = p.metrics.slice(0, 3);
  const line = [p.position, p.jersey_no !== null ? `#${p.jersey_no}` : null, p.club].filter(Boolean).join(' · ');
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [{ width }, pressed ? { opacity: 0.94, transform: [{ scale: 0.99 }] } : null]}>
      <View style={{ backgroundColor: c.paper, borderRadius: 20, borderWidth: p.is_default || selected ? 2 : 1, borderColor: selected ? c.ink : p.is_default ? tone[0] : c.line, overflow: 'hidden', ...(Platform.OS === 'web' ? { boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.07)' } : { elevation: 2 }) }}>
        <View style={{ height: 6, backgroundColor: tone[0] }} />
        <View style={{ padding: 16, gap: 14 }}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: tone[1], alignItems: 'center', justifyContent: 'center' }}>
              <T size={28}>{p.sport_emoji}</T>
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <T weight="800" size={18} style={{ letterSpacing: -0.3 }}>{p.sport}</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Pill label={nice(p.role)} fg={tone[2]} bg={tone[1]} />
                <Pill label={nice(p.level)} />
              </View>
            </View>
            {p.is_default ? <Pill label="★ DEFAULT" fg="#fff" bg={tone[0]} /> : (
              <Pressable onPress={onDefault} hitSlop={8} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}>
                <T weight="700" size={11} color={c.mute}>☆ Make default</T>
              </Pressable>
            )}
          </View>
          {line ? <T size={13} color={c.mute} weight="600">{line}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Stat value={s.matches} label="MATCHES" tone={tone} />
            <Stat value={`${s.wins}-${s.draws}-${s.losses}`} label="W-D-L" />
            <Stat value={fmt(s.avg_rating)} label="AVG RATING" />
          </View>
          {top.length ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {top.map((m) => (
                <View key={m.metric} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5, backgroundColor: c.bg, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 }}>
                  <T weight="800" size={15} style={{ fontVariant: ['tabular-nums'] }}>{fmt(m.total)}</T><T size={12} color={c.mute} weight="600">{nice(m.metric)}</T>
                </View>
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <FormDots form={p.form} />
            <Pressable onPress={onLog} hitSlop={8}><T weight="800" size={13} color={tone[0]}>+ Log match</T></Pressable>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// ---------- add / edit profile forms ----------

function AddProfileSheet({ visible, onClose, onDone, first }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title="Add a sport profile" submitLabel="Add sport"
      fields={[
        { key: 'sport', label: 'Sport', type: 'sport' },
        { key: 'role', label: 'Role', type: 'choice', options: ROLES },
        { key: 'level', label: 'Level', type: 'choice', options: LEVELS },
        { key: 'position', label: 'Position', optional: true, placeholder: 'Striker, Opening bat…' },
        { key: 'jersey_no', label: 'Jersey number', optional: true, type: 'number' },
        { key: 'club', label: 'Club / team', optional: true },
        { key: 'experience_years', label: 'Years playing', optional: true, type: 'number' },
        ...(first ? [] : [{ key: 'make_default', label: 'Make this my default?', type: 'choice', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes — list it first' }] }]),
      ]}
      onSubmit={async ({ make_default, ...v }) => { await api.post('/me/sport-profiles', { ...v, is_default: make_default === 'yes' }); await onDone(); return 'Sport added'; }} />
  );
}

function EditProfileSheet({ p, onClose, onDone }) {
  return (
    <FormSheet visible onClose={onClose} title={`Edit ${p.sport}`}
      initial={{ level: p.level, position: p.position ?? '', jersey_no: p.jersey_no ?? '', club: p.club ?? '', experience_years: p.experience_years ?? '' }}
      fields={[
        { key: 'level', label: 'Level', type: 'choice', options: LEVELS },
        { key: 'position', label: 'Position', optional: true },
        { key: 'jersey_no', label: 'Jersey number', optional: true, type: 'number' },
        { key: 'club', label: 'Club / team', optional: true },
        { key: 'experience_years', label: 'Years playing', optional: true, type: 'number' },
      ]}
      onSubmit={async (v) => { await api.patch(`/me/sport-profiles/${p.id}`, v); await onDone(); return 'Profile updated'; }} />
  );
}

function LogMatchSheet({ p, onClose, onDone }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <FormSheet visible onClose={onClose} title={`Log a ${p.sport} match`} submitLabel="Save match"
      initial={{ played_on: today }}
      fields={[
        { key: 'played_on', label: 'Date (YYYY-MM-DD)' },
        { key: 'opponent', label: 'Opponent', optional: true },
        { key: 'competition', label: 'Competition', optional: true, placeholder: 'League, Cup, Friendly' },
        { key: 'venue', label: 'Venue', optional: true },
        { key: 'score_for', label: 'Your score', optional: true, type: 'number' },
        { key: 'score_against', label: 'Their score', optional: true, type: 'number' },
        { key: 'minutes', label: 'Minutes played', optional: true, type: 'number' },
        { key: 'rating', label: 'Your rating (0–10)', optional: true, type: 'number' },
        { key: 'stats', label: 'Your numbers', optional: true, placeholder: 'goals=2, assists=1', hint: 'name=number pairs, comma separated — any stat your sport tracks.' },
        { key: 'notes', label: 'Notes', optional: true, type: 'multiline' },
      ]}
      onSubmit={async ({ stats, ...v }) => { await api.post('/me/matches', { ...v, sport_profile_id: p.id, stats: parseStats(stats) }); await onDone(); return 'Match saved'; }} />
  );
}

// ---------- dashboard ----------

function MySports() {
  const { push } = useNav();
  const { toast } = useSession();
  const { tablet } = useLayout();
  const { gap, w } = useCols();
  const list = useLoad(() => api.get('/me/sport-profiles'), []);
  const [add, setAdd] = useState(false);
  const [log, setLog] = useState(null);
  const [sel, setSel] = useState(null);
  const profiles = list.data ?? [];
  const totals = useMemo(() => profiles.reduce((a, p) => ({ matches: a.matches + p.summary.matches, wins: a.wins + p.summary.wins }), { matches: 0, wins: 0 }), [profiles]);
  const makeDefault = async (p) => { try { await api.post(`/me/sport-profiles/${p.id}/default`); await list.reload(); toast(`${p.sport} is now your default`); } catch (e) { toast(e.message); } };
  const split = tablet && profiles.length > 0;
  const selId = profiles.find((p) => p.id === sel)?.id ?? profiles[0]?.id;

  const header = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ flexShrink: 1 }}>
        <H1 style={{ fontSize: 30 }}>My sports</H1>
        <T size={14} color={c.mute} style={{ marginTop: 2 }}>{profiles.length ? `${profiles.length} sport${profiles.length > 1 ? 's' : ''} · ${totals.matches} match${totals.matches === 1 ? "" : "es"} · ${totals.wins} win${totals.wins === 1 ? "" : "s"}` : 'One card per sport you play.'}</T>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn small title="Import" color={c.paper} onPress={() => push('ImportMatches', { id: selId ?? profiles[0]?.id })} disabled={!profiles.length} />
        <Btn small title="+ Add sport" onPress={() => setAdd(true)} />
      </View>
    </View>
  );
  const cards = (width) => profiles.map((p) => (
    <SportCard key={p.id} p={p} width={width} selected={split && p.id === selId} onOpen={() => (split ? setSel(p.id) : push('SportProfile', { id: p.id }))} onDefault={() => makeDefault(p)} onLog={() => setLog(p)} />
  ));
  const sheets = (
    <>
      <AddProfileSheet visible={add} onClose={() => setAdd(false)} first={!profiles.length} onDone={list.reload} />
      {log ? <LogMatchSheet p={log} onClose={() => setLog(null)} onDone={list.reload} /> : null}
    </>
  );

  // tablet: master–detail — the cards on the left, the selected sport's page on the right
  if (split) {
    return (
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <View style={{ width: 396, borderRightWidth: 1, borderColor: c.line }}>
          <Screen padBottom={130}>
            {header}
            <View style={{ gap: 14, marginTop: 16 }}>{cards('100%')}</View>
          </Screen>
        </View>
        <View style={{ flex: 1 }}><SportProfile key={selId} id={selId} embedded onChanged={list.reload} onRemoved={() => { setSel(null); list.reload(); }} /></View>
        {sheets}
      </View>
    );
  }
  return (
    <Screen wide>
      {header}
      <View style={{ marginTop: 18 }}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !profiles.length ? (
          <Empty emoji="🏅" title="No sport profiles yet" sub="Add the sports you play to track your matches and performance — one card each, your favourite first." />
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>{cards(w)}</View>
        )}
      </View>
      <Card style={{ marginTop: 18 }}><H2>★ Favourite sports & games</H2><View style={{ marginTop: 8 }}><FavouriteSports /></View></Card>
      {sheets}
    </Screen>
  );
}

// ---------- player hub: sections ----------

const SECTIONS = [['today', 'Today', AthleteToday], ['sports', 'My sports', MySports], ['billboard', 'Billboard', Billboard], ['shop', 'Shop', Shop], ['hire', 'Hire', Hire], ['insure', 'Insure', Insure]];
let lastSection = 'today'; // survive pushing into a sport page and coming back

export function PlayerHome() {
  const [sec, setSec] = useState(lastSection);
  const { gutter, contentMax } = useLayout();
  const pick = (v) => { lastSection = v; setSec(v); };
  const Body = SECTIONS.find((x) => x[0] === sec)[2];
  return (
    <View style={{ flex: 1 }}>
      <View style={{ width: '100%', maxWidth: contentMax, alignSelf: 'center', paddingHorizontal: gutter - 0, paddingTop: 8 }}>
        <Seg options={SECTIONS.map(([value, label]) => ({ value, label }))} value={sec} onChange={pick} />
      </View>
      <View style={{ flex: 1 }}><Body key={sec} /></View>
    </View>
  );
}

// ---------- one sport: detail + match log ----------

export function SportProfile({ id, embedded, onChanged, onRemoved }) {
  const { push, back } = useNav();
  const { toast } = useSession();
  const prof = useLoad(() => api.get('/me/sport-profiles'), []);
  const matches = useLoad(() => api.get('/me/matches', { sport_profile_id: id, limit: 100 }), [id]);
  const [edit, setEdit] = useState(false);
  const [log, setLog] = useState(false);
  const p = prof.data?.find((x) => x.id === id);
  const reload = async () => { await Promise.all([prof.reload(), matches.reload()]); onChanged?.(); };

  if (prof.loading && !prof.data) return <Screen><Loading /></Screen>;
  if (prof.error) return <Screen><ErrorBox error={prof.error} onRetry={prof.reload} /></Screen>;
  if (!p) return <Screen><Empty title="Sport profile not found" /></Screen>;
  const tone = toneFor(p.sport_slug);
  const s = p.summary;
  const act = (fn, msg) => async () => { try { await fn(); await reload(); if (msg) toast(msg); } catch (e) { toast(e.message); } };

  return (
    <Screen>
      <View style={{ backgroundColor: tone[0], borderRadius: 22, padding: 20, overflow: 'hidden' }}>
        <View pointerEvents="none" style={{ position: 'absolute', right: -40, top: -60, width: 200, height: 200, borderRadius: 100, backgroundColor: '#fff', opacity: 0.14 }} />
        <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
          <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}><T size={34}>{p.sport_emoji}</T></View>
          <View style={{ flex: 1 }}>
            <T weight="800" size={26} color="#fff" style={{ letterSpacing: -0.6 }}>{p.sport}</T>
            <T size={14} color="#fff" weight="600" style={{ opacity: 0.9 }}>{[nice(p.role), nice(p.level), p.position, p.jersey_no !== null ? `#${p.jersey_no}` : null, p.club].filter(Boolean).join(' · ')}</T>
            {p.is_default ? <View style={{ marginTop: 6 }}><Pill label="★ DEFAULT SPORT" fg={tone[2]} bg="#fff" /></View> : null}
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
          {[[s.matches, 'MATCHES'], [`${s.wins}-${s.draws}-${s.losses}`, 'W-D-L'], [fmt(s.avg_rating), 'AVG RATING'], [s.minutes, 'MINUTES']].map(([v, l]) => (
            <View key={l} style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 14, paddingVertical: 10, alignItems: 'center' }}>
              <T weight="800" size={18} color="#fff" style={{ fontVariant: ['tabular-nums'] }}>{v}</T><T weight="700" size={9.5} color="#fff" style={{ letterSpacing: 0.8, opacity: 0.85 }}>{l}</T>
            </View>
          ))}
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <Btn small title="+ Log match" onPress={() => setLog(true)} />
        <Btn small title="Import CSV" color={c.paper} onPress={() => push('ImportMatches', { id: p.id })} />
        <Btn small title="Edit" color={c.paper} onPress={() => setEdit(true)} />
        {!p.is_default ? <Btn small title="☆ Make default" color={c.paper} onPress={act(() => api.post(`/me/sport-profiles/${p.id}/default`), 'Default updated')} /> : null}
      </View>

      {p.metrics.length ? (
        <>
          <H2 style={{ marginTop: 24 }}>Career numbers</H2>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
            {p.metrics.map((m) => (
              <View key={m.metric} style={{ backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 16, minWidth: 104 }}>
                <T weight="800" size={22} style={{ fontVariant: ['tabular-nums'], letterSpacing: -0.5 }}>{fmt(m.total)}</T>
                <T weight="700" size={11} color={c.mute} style={{ letterSpacing: 0.5 }}>{nice(m.metric).toUpperCase()}</T>
                <T size={11} color={c.mute} style={{ marginTop: 2 }}>best {fmt(m.best)} · {m.matches} match{m.matches === 1 ? '' : 'es'}</T>
              </View>
            ))}
          </View>
        </>
      ) : null}

      <H2 style={{ marginTop: 24 }}>Match log</H2>
      <View style={{ gap: 10, marginTop: 10 }}>
        {matches.loading && !matches.data ? <Loading /> : !matches.data?.length ? (
          <Empty emoji="📋" title="No matches yet" sub="Log one by hand, or import a whole season from a CSV." />
        ) : matches.data.map((m) => {
          const [l, fg, bg] = RESULT[m.result] ?? [null];
          return (
            <Card key={m.id} pad={14}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: bg ?? c.violetSoft, alignItems: 'center', justifyContent: 'center' }}><T weight="800" size={15} color={fg ?? c.mute}>{l ?? '–'}</T></View>
                <View style={{ flex: 1 }}>
                  <T weight="700" size={15}>{m.opponent ? `vs ${m.opponent}` : 'Match'}{m.score_for !== null && m.score_against !== null ? `  ${fmt(m.score_for)}–${fmt(m.score_against)}` : ''}</T>
                  <T size={12} color={c.mute}>{[day(m.played_on + 'T12:00:00'), m.competition, m.venue, m.minutes ? `${m.minutes}'` : null, m.rating !== null ? `★ ${fmt(m.rating)}` : null].filter(Boolean).join(' · ')}</T>
                </View>
                <Pressable hitSlop={10} onPress={act(() => api.del(`/me/matches/${m.id}`), 'Match deleted')}><T size={13} color={c.mute} weight="700">Delete</T></Pressable>
              </View>
              {Object.keys(m.stats).length ? (
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                  {Object.entries(m.stats).map(([k, v]) => <Pill key={k} label={`${fmt(v)} ${nice(k)}`} fg={tone[2]} bg={tone[1]} />)}
                </View>
              ) : null}
              {m.notes ? <T size={13} color={c.mute} style={{ marginTop: 8 }}>{m.notes}</T> : null}
            </Card>
          );
        })}
      </View>

      <View style={{ marginTop: 28, alignItems: 'flex-start' }}>
        <Btn small title="Remove this sport" color={c.paper} ink={c.red} onPress={async () => { try { await api.del(`/me/sport-profiles/${p.id}`); toast('Sport removed'); if (embedded) onRemoved?.(); else back(); } catch (e) { toast(e.message); } }} />
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>Removing a sport also deletes the matches logged under it.</T>
      </View>

      {edit ? <EditProfileSheet p={p} onClose={() => setEdit(false)} onDone={reload} /> : null}
      {log ? <LogMatchSheet p={p} onClose={() => setLog(false)} onDone={reload} /> : null}
    </Screen>
  );
}

// ---------- bulk import ----------

const TEMPLATE = 'played_on,opponent,competition,venue,result,score_for,score_against,minutes,rating,goals,assists\n2026-09-08,Blue Stars,League,Home ground,win,2,0,90,7.5,1,1\n2026-09-15,Red Hawks,League,Away,draw,1,1,75,6.0,0,0\n';

export function ImportMatches({ id }) {
  const { back } = useNav();
  const { toast } = useSession();
  const list = useLoad(() => api.get('/me/sport-profiles'), []);
  const [sel, setSel] = useState(id);
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [prev, setPrev] = useState(null);
  const [err, setErr] = useState(null);
  const profiles = list.data ?? [];
  const target = sel ?? profiles[0]?.id;

  const pickFile = () => {
    if (Platform.OS !== 'web') return;
    const el = document.createElement('input');
    el.type = 'file'; el.accept = '.csv,text/csv,text/plain';
    el.onchange = async () => { const f = el.files?.[0]; if (f) { setCsv(await f.text()); setPrev(null); setErr(null); } };
    el.click();
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' })); a.download = 'sportarena-matches-template.csv'; a.click();
  };
  const run = async (dry) => {
    setErr(null); setBusy(true);
    try {
      const r = await api.post('/me/matches/import', { sport_profile_id: target, csv, dry_run: dry });
      if (dry) setPrev(r); else { toast(`Imported ${r.imported} match${r.imported === 1 ? '' : 'es'}${r.skipped ? ` · ${r.skipped} duplicates skipped` : ''}`); back(); }
    } catch (e) { setErr(e.message); setPrev(e.details ? { errors: e.details, failed: true } : null); } finally { setBusy(false); }
  };
  const tooBig = csv.length > 80000;

  return (
    <Screen>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>BULK IMPORT</T>
      <H1 style={{ fontSize: 28 }}>Import match performance</H1>
      <T size={14} color={c.mute} style={{ marginTop: 4 }}>Add a whole season in one go from a CSV. Up to 500 matches per file.</T>

      <Card style={{ marginTop: 16 }}>
        <T weight="800" size={13}>1 · Pick the sport</T>
        {list.loading && !list.data ? <Loading /> : (
          <Seg options={profiles.map((p) => ({ value: p.id, label: `${p.sport_emoji} ${p.sport}${p.role !== 'athlete' ? ` (${p.role})` : ''}` }))} value={target} onChange={(v) => { setSel(v); setPrev(null); }} />
        )}
      </Card>

      <Card style={{ marginTop: 12 }}>
        <T weight="800" size={13}>2 · Your file</T>
        <T size={12.5} color={c.mute} style={{ marginTop: 4, lineHeight: 18 }}>
          First row is the header. <T weight="700" size={12.5}>played_on</T> (YYYY-MM-DD) is required. Optional: opponent, competition, venue, result (win/draw/loss — or worked out from the score), score_for, score_against, minutes, rating (0–10), notes. Any other column — goals, assists, runs, wickets… — is saved as a number for that match.
        </T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {Platform.OS === 'web' ? <Btn small title="Choose CSV file" color={c.paper} onPress={pickFile} /> : null}
          {Platform.OS === 'web' ? <Btn small title="Download template" color={c.paper} onPress={download} /> : <Btn small title="Use template" color={c.paper} onPress={() => { setCsv(TEMPLATE); setPrev(null); }} />}
        </View>
        <TextInput multiline value={csv} onChangeText={(x) => { setCsv(x); setPrev(null); setErr(null); }} placeholder={'…or paste CSV here\nplayed_on,opponent,goals\n2026-09-08,Blue Stars,2'} placeholderTextColor="#94A3B8" autoCapitalize="none" autoCorrect={false}
          style={[fam, { marginTop: 12, minHeight: 150, borderWidth: 1.5, borderColor: c.line, borderRadius: 12, padding: 12, fontSize: 13, color: c.ink, backgroundColor: c.bg, textAlignVertical: 'top' }, Platform.OS === 'web' && { outlineStyle: 'none', fontFamily: 'ui-monospace, Menlo, monospace' }]} />
        {tooBig ? <T size={12} color={c.red} weight="700" style={{ marginTop: 6 }}>That's over the 80,000 character limit — split the file into seasons.</T> : null}
      </Card>

      {err && !prev?.failed ? <T color={c.red} weight="700" style={{ marginTop: 12 }}>{err}</T> : null}
      {prev ? (
        <Card style={{ marginTop: 12 }} color={prev.errors?.length ? c.orangeSoft : c.paper}>
          <T weight="800" size={13}>3 · Check</T>
          {prev.failed ? <T weight="700" style={{ marginTop: 6 }}>{err}</T> : <T weight="700" style={{ marginTop: 6 }}>{prev.importable} of {prev.rows} rows ready to import{prev.skipped ? ` · ${prev.skipped} already logged (skipped)` : ''}{prev.errors.length ? ` · ${prev.errors.length} with problems` : ''}</T>}
          {prev.errors?.slice(0, 8).map((e) => <T key={e.row} size={12.5} color={c.red} style={{ marginTop: 4 }}>Row {e.row}: {e.errors.join('; ')}</T>)}
          {prev.errors?.length > 8 ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>…and {prev.errors.length - 8} more</T> : null}
          {prev.errors?.length ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Fix these rows and check again — nothing is imported until every row is valid.</T> : null}
          {prev.preview?.map((m) => <T key={m.row} size={12.5} color={c.mute} style={{ marginTop: 4 }}>{m.played_on} · {m.opponent ?? '—'}{m.result ? ` · ${m.result}` : ''}{Object.keys(m.stats).length ? ` · ${Object.entries(m.stats).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}</T>)}
        </Card>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <Btn title="Check file" color={c.paper} onPress={() => run(true)} loading={busy} disabled={!csv.trim() || !target || tooBig} style={{ flex: 1 }} />
        <Btn title={prev?.importable ? `Import ${prev.importable}` : 'Import'} onPress={() => run(false)} loading={busy} disabled={!prev || prev.failed || prev.errors?.length || !prev.importable} style={{ flex: 1 }} />
      </View>
    </Screen>
  );
}
