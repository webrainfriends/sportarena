import React, { useMemo, useState } from 'react';
import { Platform, Pressable, TextInput, View, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, H1, H2, Loading, Screen, Seg, T } from '../ui';
import { HScroll } from '../pickers';
import { FormSheet } from '../FormSheet';
import { LinearGradient } from 'expo-linear-gradient';
import { c, fam, day } from '../theme';
import { sportTheme, recordOf, recordLabel } from '../sport-theme';
import { FavouriteSports } from '../sportpicker';
import { RecordsSection } from './performance';
import { Billboard, Shop, Insure, useCols } from './marketplace';
import { Hire } from './coaching';

const LEVELS = ['beginner', 'amateur', 'semi_pro', 'pro'];
const ROLES = ['athlete', 'coach', 'referee', 'physio', 'doctor'];
/** Roles that play, coach or officiate a sport; physios, doctors and sponsors serve everyone and need no sport attached. */
const SPORT_ROLES = ['athlete', 'coach', 'referee'];
const nice = (s) => String(s).replace(/_/g, ' ');
const fmt = (n) => (n === null || n === undefined ? '–' : Number.isInteger(+n) ? String(+n) : (+n).toFixed(1));
const RESULT = { win: ['W', c.lime, c.limeSoft], draw: ['D', c.mute, c.violetSoft], loss: ['L', c.red, c.redSoft] };

const Pill = ({ label, fg = c.mute, bg = c.violetSoft }) => (
  <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' }}>
    <T weight="700" size={11} color={fg} style={{ letterSpacing: 0.3 }}>{label}</T>
  </View>
);

const FormDots = ({ form }) => (
  <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center', flexWrap: 'wrap', flexShrink: 1 }}>
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

/** Make a sport profile the default (the one shown first on Home and the player card). One helper for every screen that lists profiles. */
export function useMakeDefault(reload) {
  const { toast } = useSession();
  return async (p) => { try { await api.post(`/me/sport-profiles/${p.id}/default`); await reload(); toast(`${p.sport} is now your default`); } catch (e) { toast(e.message); } };
}

// ---------- sport profile card ----------

export function SportCard({ p, width, onOpen, onDefault, onLog, selected }) {
  const th = sportTheme(p.sport_slug);
  const tone = th.tone;
  const s = p.summary;
  const top = p.metrics.slice(0, 3);
  const line = [p.position, p.jersey_no !== null ? `#${p.jersey_no}` : null, p.club].filter(Boolean).join(' · ');
  const R = th.radius;
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [{ width }, pressed ? { opacity: 0.94, transform: [{ scale: 0.99 }] } : null]}>
      <View style={{ backgroundColor: c.paper, borderRadius: R, borderWidth: p.is_default || selected ? 2 : 1, borderColor: selected ? c.ink : p.is_default ? tone[0] : c.line, overflow: 'hidden', ...(Platform.OS === 'web' ? { boxShadow: `0 1px 2px rgba(15,23,42,0.04), 0 10px 28px ${tone[0]}2E` } : { elevation: 3 }) }}>
        <LinearGradient colors={th.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: 14, overflow: 'hidden' }}>
          <T size={92} style={{ position: 'absolute', right: -6, bottom: -26, opacity: 0.16 }} pointerEvents="none">{th.motif}</T>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <View style={{ width: 50, height: 50, borderRadius: Math.min(R - 6, 25), backgroundColor: 'rgba(255,255,255,0.24)', alignItems: 'center', justifyContent: 'center' }}>
              <T size={27}>{p.sport_emoji}</T>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T weight="800" size={19} color="#fff" numberOfLines={1} style={{ letterSpacing: -0.4 }}>{p.sport}</T>
              <T size={12} weight="600" color="#fff" numberOfLines={1} style={{ opacity: 0.88 }}>{nice(p.role)} · {nice(p.level)}</T>
            </View>
            <T size={22} color="#fff" style={{ opacity: 0.8 }}>›</T>
          </View>
          <T size={12} weight="600" color="#fff" numberOfLines={1} style={{ opacity: 0.85, marginTop: 10, fontStyle: 'italic' }}>{th.vibe}</T>
        </LinearGradient>
        <View style={{ padding: 14, gap: 12 }}>
          {line ? <T size={13} color={c.mute} weight="600">{line}</T> : null}
          {p.official_summary?.matches ? <Pill label={`✓ ${p.official_summary.matches} OFFICIAL · ${s.matches - p.official_summary.matches} LOGGED BY YOU`} fg={tone[2]} bg={tone[1]} /> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Stat value={s.matches} label={th.noun} tone={tone} />
            <Stat value={recordOf(th, s)} label={recordLabel(th, s)} />
            <Stat value={fmt(s.avg_rating)} label="RATING" />
          </View>
          {top.length ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {top.map((m) => (
                <View key={m.metric} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5, backgroundColor: tone[1], borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 }}>
                  <T weight="800" size={15} color={tone[2]} style={{ fontVariant: ['tabular-nums'] }}>{fmt(m.total)}</T><T size={12} color={tone[2]} weight="600">{nice(m.metric)}</T>
                </View>
              ))}
            </View>
          ) : null}
          {s.matches > 0 ? <FormDots form={p.form} /> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable onPress={onLog} style={{ flex: 1, minHeight: 44, borderRadius: Math.min(R - 6, 14), backgroundColor: tone[1], alignItems: 'center', justifyContent: 'center' }}>
              <T weight="800" size={13.5} color={tone[2]}>+ Log {th.one}</T>
            </Pressable>
            {p.is_default ? (
              <View style={{ flex: 1, minHeight: 44, borderRadius: Math.min(R - 6, 14), backgroundColor: tone[0], alignItems: 'center', justifyContent: 'center' }}><T weight="800" size={13} color="#fff">★ Default</T></View>
            ) : (
              <Pressable onPress={onDefault} style={{ flex: 1, minHeight: 44, borderRadius: Math.min(R - 6, 14), borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
                <T weight="700" size={13} color={c.mute}>☆ Make default</T>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Pressable>
  );
}

/** Compact one-line sport row — the rail on wide screens, where the selected sport's full page sits beside it. */
function SportRow({ p, selected, onPress }) {
  const th = sportTheme(p.sport_slug);
  const tone = th.tone;
  const s = p.summary;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: Math.min(th.radius, 20), backgroundColor: selected ? tone[1] : c.paper, borderWidth: selected ? 2 : 1, borderColor: selected ? tone[0] : c.line, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, backgroundColor: tone[0] }} />
        <LinearGradient colors={th.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: 44, height: 44, borderRadius: Math.min(th.radius - 4, 14), marginLeft: 4, alignItems: 'center', justifyContent: 'center' }}><T size={24}>{p.sport_emoji}</T></LinearGradient>
        <View style={{ flex: 1 }}>
          <T weight="800" size={16} color={selected ? tone[2] : c.ink} numberOfLines={1}>{p.sport}</T>
          <T size={12} color={c.mute} numberOfLines={1}>{nice(p.role)} · {nice(p.level)} · {s.matches} {s.matches === 1 ? th.one : th.one === 'match' ? 'matches' : `${th.one}s`}</T>
        </View>
        {p.is_default ? <T size={16} color={tone[0]}>★</T> : null}
      </View>
    </Pressable>
  );
}

// ---------- add / edit profile forms ----------

export function AddProfileSheet({ visible, onClose, onDone, first, sport }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title="Add a sport profile" submitLabel="Add sport" initial={sport ? { sport } : undefined}
      fields={[
        { key: 'sport', label: 'Sport', type: 'sport' },
        { key: 'role', label: 'Role', type: 'choice', options: ROLES },
        { key: 'level', label: 'Level', type: 'choice', options: LEVELS },
        { key: 'position', label: 'Position', optional: true, placeholder: 'Striker, Opening bat…' },
        { key: 'jersey_no', label: 'Jersey number', optional: true, type: 'number' },
        { key: 'club', label: 'Club / team', optional: true },
        { key: 'experience_years', label: 'Years playing', optional: true, type: 'number' },
        { key: 'license_no', label: 'Licence number', optional: true },
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

/** The columns for every match type of the sport (AI-tailored, IPTC-grounded on the server); one request per type, cached server-side. */
async function loadTemplates(slug) {
  const first = await api.get(`/sports/${slug}/match-template`);
  if (first.match_types.length < 2) return [first];
  return Promise.all(first.match_types.map((t) => api.get(`/sports/${slug}/match-template`, { match_type: t })));
}

const TYPE_LABELS = { t20: 'T20', odi: 'ODI' };
const typeLabel = (t) => TYPE_LABELS[t] ?? nice(t).replace(/^./, (x) => x.toUpperCase());

function LogMatchSheet({ p, onClose, onDone }) {
  const today = new Date().toISOString().slice(0, 10);
  const tpl = useLoad(() => loadTemplates(p.sport_slug), [p.sport_slug]);
  const templates = tpl.data ?? [];
  const labels = templates[0]?.score_labels ?? { score_for: 'Your score', score_against: 'Their score' };
  const types = templates[0]?.match_types ?? [];
  const typed = types.length > 1;
  const columnFields = templates.flatMap((t) => t.columns.map((col) => ({
    key: `stat:${t.match_type ?? ''}:${col.key}`, label: col.label, type: col.kind === 'decimal' ? 'number' : 'stepper', optional: true, min: 0, max: col.max ?? 999,
    show: (v) => !typed || v.match_type === t.match_type,
  })));
  return (
    <FormSheet visible onClose={onClose} title={`Log a ${p.sport} match`} submitLabel="Save match"
      initial={{ played_on: today, match_type: types[0] }}
      fields={[
        { key: 'played_on', label: 'Date', type: 'date', max: today },
        ...(typed ? [{ key: 'match_type', label: 'Match type', type: 'chips', options: types.map((t) => ({ value: t, label: typeLabel(t) })) }] : []),
        { key: 'opponent', label: 'Opponent', optional: true },
        { key: 'competition', label: 'Competition', optional: true, placeholder: 'League, Cup, Friendly' },
        { key: 'venue', label: 'Venue', optional: true },
        { key: 'score_for', label: labels.score_for, optional: true, type: 'number' },
        { key: 'score_against', label: labels.score_against, optional: true, type: 'number' },
        { key: 'minutes', label: 'Minutes played', optional: true, type: 'number' },
        { key: 'rating', label: 'Your rating (0–10)', optional: true, type: 'number' },
        ...(columnFields.length ? [{ key: 'stats_section', type: 'section', label: 'Your numbers' }, ...columnFields] : []),
        { key: 'notes', label: 'Notes', optional: true, type: 'multiline' },
      ]}
      onSubmit={async (v) => {
        const stats = {}, body = {};
        for (const [k, x] of Object.entries(v)) {
          if (k.startsWith('stat:')) { const n = Number(x); if (n > 0) stats[k.split(':')[2]] = n; } else body[k] = x;
        }
        await api.post('/me/matches', { ...body, sport_profile_id: p.id, stats });
        await onDone();
        return 'Match saved';
      }} />
  );
}

// ---------- dashboard ----------

function MySports() {
  const { push } = useNav();
  const { user } = useSession();
  const noSportNeeded = !(user.roles ?? []).some((r) => SPORT_ROLES.includes(r));
  const { width: winW, phone } = useLayout();
  const { gap, w } = useCols();
  const list = useLoad(() => api.get('/me/sport-profiles'), []);
  const detected = useLoad(() => api.get('/me/detected-sports'), []);
  const [add, setAdd] = useState(false);
  const [addSport, setAddSport] = useState(null);
  const [log, setLog] = useState(null);
  const [sel, setSel] = useState(null);
  const profiles = list.data ?? [];
  const totals = useMemo(() => profiles.reduce((a, p) => ({ matches: a.matches + p.summary.matches, wins: a.wins + p.summary.wins }), { matches: 0, wins: 0 }), [profiles]);
  const makeDefault = useMakeDefault(list.reload);
  const split = winW >= 1024 && profiles.length > 0;
  const selId = profiles.find((p) => p.id === sel)?.id ?? profiles[0]?.id;

  const header = (
    <View style={{ gap: 12 }}>
      <View>
        <H1 style={{ fontSize: phone ? 26 : 30 }}>My sports</H1>
        <T size={14} color={c.mute} style={{ marginTop: 2 }}>{profiles.length ? `${profiles.length} sport${profiles.length > 1 ? 's' : ''} · ${totals.matches} match${totals.matches === 1 ? '' : 'es'} · ${totals.wins} win${totals.wins === 1 ? '' : 's'}` : 'One card per sport you play.'}</T>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn small title="+ Add sport" onPress={() => setAdd(true)} style={{ flex: 1 }} />
        <Btn small title="Import matches" color={c.paper} onPress={() => push('ImportMatches', { id: selId ?? profiles[0]?.id })} disabled={!profiles.length} style={{ flex: 1 }} />
      </View>
    </View>
  );
  const found = (detected.data ?? []).map((d) => (
    <Card key={d.sport_slug} pad={14}>
      <T weight="800" size={14}>{d.sport_emoji} {d.sport} — played on Gotmygame</T>
      <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{d.matches} official match{d.matches === 1 ? '' : 'es'} · {d.wins}-{d.draws}-{d.losses}{d.last_played ? ` · last ${day(d.last_played + 'T12:00:00')}` : ''}. Add the sport to see them on its card — nothing else is filled in for you.</T>
      <View style={{ marginTop: 10, alignItems: 'flex-start' }}><Btn small title={`+ Add ${d.sport}`} onPress={() => { setAddSport(d.sport_slug); setAdd(true); }} /></View>
    </Card>
  ));
  const cards = (width) => profiles.map((p) => (
    <SportCard key={p.id} p={p} width={width} selected={split && p.id === selId} onOpen={() => (split ? setSel(p.id) : push('SportProfile', { id: p.id }))} onDefault={() => makeDefault(p)} onLog={() => setLog(p)} />
  ));
  const sheets = (
    <>
      <AddProfileSheet visible={add} sport={addSport} onClose={() => { setAdd(false); setAddSport(null); }} first={!profiles.length} onDone={async () => { await Promise.all([list.reload(), detected.reload()]); }} />
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
            <View style={{ gap: 10, marginTop: 16 }}>
              {found}
              {profiles.map((p) => <SportRow key={p.id} p={p} selected={p.id === selId} onPress={() => setSel(p.id)} />)}
            </View>
          </Screen>
        </View>
        <View style={{ flex: 1 }}><SportProfile key={selId} id={selId} embedded onChanged={list.reload} onRemoved={() => { setSel(null); list.reload(); }} /></View>
        {sheets}
      </View>
    );
  }
  return (
    <Screen>
      {header}
      <View style={{ marginTop: 18 }}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !profiles.length && noSportNeeded ? (
          <Empty emoji="🩺" title="No sport needed" sub="Physios, doctors and sponsors work across all sports, so nothing has to be attached to a sport. Add a sport only if you also play, coach or officiate." />
        ) : !profiles.length ? (
          <Empty emoji="🏅" title="No sport profiles yet" sub="Add the sports you play — matches you log yourself and games you play in through Gotmygame events appear on each card automatically." />
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>{cards(w)}</View>
        )}
        {found.length > 0 && !split ? <View style={{ gap: 10, marginTop: 14 }}>{found}</View> : null}
      </View>
      <Card style={{ marginTop: 18 }}><H2>★ Favourite sports & games</H2><View style={{ marginTop: 8 }}><FavouriteSports /></View></Card>
      {sheets}
    </Screen>
  );
}

// ---------- player hub: sections ----------

const SECTIONS = [['sports', 'My sports', MySports], ['billboard', 'Billboard', Billboard], ['shop', 'Shop', Shop], ['hire', 'Hire', Hire], ['insure', 'Insure', Insure]];
let lastSection = 'sports'; // survive pushing into a sport page and coming back

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
  const { phone } = useLayout();
  const { toast } = useSession();
  const prof = useLoad(() => api.get('/me/sport-profiles'), []);
  const [src, setSrc] = useState('all');
  const [season, setSeason] = useState('all');
  const matches = useLoad(() => api.get('/me/matches', { sport_profile_id: id, source: src, limit: 100 }), [id, src]);
  const [edit, setEdit] = useState(false);
  const [note, setNote] = useState(null);
  const [linking, setLinking] = useState(null);
  const [log, setLog] = useState(false);
  const p = prof.data?.find((x) => x.id === id);
  const reload = async () => { await Promise.all([prof.reload(), matches.reload()]); onChanged?.(); };

  if (prof.loading && !prof.data) return <Screen><Loading /></Screen>;
  if (prof.error) return <Screen><ErrorBox error={prof.error} onRetry={prof.reload} /></Screen>;
  if (!p) return <Screen><Empty title="Sport profile not found" /></Screen>;
  const th = sportTheme(p.sport_slug);
  const tone = th.tone;
  const s = p.summary;
  const seasons = [...new Set((matches.data ?? []).map((m) => m.played_on.slice(0, 4)))];
  const shown = (matches.data ?? []).filter((m) => season === 'all' || m.played_on.startsWith(season));
  const act = (fn, msg) => async () => { try { await fn(); await reload(); if (msg) toast(msg); } catch (e) { toast(e.message); } };

  return (
    <Screen>
      <LinearGradient colors={th.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: th.radius + 4, padding: phone ? 16 : 20, overflow: 'hidden' }}>
        <T size={phone ? 150 : 190} pointerEvents="none" style={{ position: 'absolute', right: -12, top: -18, opacity: 0.16 }}>{th.motif}</T>
        <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
          <View style={{ width: phone ? 56 : 64, height: phone ? 56 : 64, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}><T size={phone ? 30 : 34}>{p.sport_emoji}</T></View>
          <View style={{ flex: 1 }}>
            <T weight="800" size={phone ? 24 : 26} color="#fff" numberOfLines={1} style={{ letterSpacing: -0.6 }}>{p.sport}</T>
            <T size={14} color="#fff" weight="600" style={{ opacity: 0.9 }}>{[nice(p.role), nice(p.level), p.position, p.jersey_no !== null ? `#${p.jersey_no}` : null, p.club].filter(Boolean).join(' · ')}</T>
            {p.is_default ? <View style={{ marginTop: 6 }}><Pill label="★ DEFAULT SPORT" fg={tone[2]} bg="#fff" /></View> : null}
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 14 }}>
          {[[s.matches, th.noun], [recordOf(th, s), recordLabel(th, s)], [fmt(s.avg_rating), 'RATING'], [s.minutes, 'MINUTES']].map(([v, l]) => (
            <View key={l} style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 14, paddingVertical: 10, alignItems: 'center' }}>
              <T weight="800" size={18} color="#fff" style={{ fontVariant: ['tabular-nums'] }}>{v}</T><T weight="700" size={9.5} color="#fff" style={{ letterSpacing: 0.8, opacity: 0.85 }}>{l}</T>
            </View>
          ))}
        </View>
      </LinearGradient>

      <View style={{ gap: 8, marginTop: 14 }}>
        <Btn title={`+ Log ${th.one}`} color={tone[0]} onPress={() => setLog(true)} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn small title="Import CSV" color={c.paper} onPress={() => push('ImportMatches', { id: p.id })} style={{ flex: 1 }} />
          <Btn small title="Edit" color={c.paper} onPress={() => setEdit(true)} style={{ flex: 1 }} />
          {!p.is_default ? <Btn small title="☆ Default" color={c.paper} onPress={act(() => api.post(`/me/sport-profiles/${p.id}/default`), 'Default updated')} style={{ flex: 1 }} /> : null}
        </View>
      </View>

      {p.metrics.length ? (
        <>
          <H2 style={{ marginTop: 24 }}>Career numbers</H2>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
            {p.metrics.map((m) => (
              <View key={m.metric} style={{ backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14, ...(phone ? { flexBasis: '47%', flexGrow: 1 } : { minWidth: 104 }) }}>
                <T weight="800" size={22} style={{ fontVariant: ['tabular-nums'], letterSpacing: -0.5 }}>{fmt(m.total)}</T>
                <T weight="700" size={11} color={c.mute} style={{ letterSpacing: 0.5 }}>{nice(m.metric).toUpperCase()}</T>
                <T size={11} color={c.mute} style={{ marginTop: 2 }}>best {fmt(m.best)} · {m.matches} match{m.matches === 1 ? '' : 'es'}</T>
              </View>
            ))}
          </View>
        </>
      ) : null}

      <H2 style={{ marginTop: 24 }}>Personal records</H2>
      <View style={{ marginTop: 10 }}><RecordsSection sport={p.sport_slug} /></View>

      <H2 style={{ marginTop: 24 }}>Match log</H2>
      <View style={{ marginTop: 10 }}>
        <Seg options={[{ value: 'all', label: 'All' }, { value: 'official', label: `Official${p.official_summary?.matches ? ` · ${p.official_summary.matches}` : ''}` }, { value: 'self', label: 'My logs' }]} value={src} onChange={setSrc} />
      </View>
      {seasons.length > 1 ? <View style={{ marginTop: 10 }}><HScroll><Chip label="All seasons" active={season === 'all'} onPress={() => setSeason('all')} />{seasons.map((y) => <Chip key={y} label={y} active={season === y} onPress={() => setSeason(y)} />)}</HScroll></View> : null}
      <View style={{ gap: 10, marginTop: 10 }}>
        {matches.loading && !matches.data ? <Loading /> : !shown.length ? (
          <Empty emoji="📋" title="No matches yet" sub="Matches you log yourself or play in through Gotmygame events will appear here automatically." />
        ) : shown.map((m) => {
          const [l, fg, bg] = RESULT[m.result] ?? [null];
          const official = m.provenance.startsWith('official');
          const tag = official ? (m.event_id ? 'Verified competition' : 'Official match') : m.provenance === 'imported' ? 'Imported by you' : 'Logged by you';
          const title = m.kind === 'competition' ? (m.title ?? 'Competition') : m.opponent ? `vs ${m.opponent}` : (m.title ?? 'Match');
          return (
            <Card key={m.id} pad={14}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: bg ?? c.violetSoft, alignItems: 'center', justifyContent: 'center' }}><T weight="800" size={15} color={fg ?? c.mute}>{l ?? (m.rank ? `#${m.rank}` : '–')}</T></View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T weight="700" size={15} numberOfLines={2}>{title}{m.score_for !== null && m.score_against !== null ? `  ${fmt(m.score_for)}–${fmt(m.score_against)}` : ''}</T>
                  <T size={12} color={c.mute}>{[day(m.played_on + 'T12:00:00'), m.competition, m.venue, m.minutes ? `${m.minutes}'` : null, m.rating !== null ? `★ ${fmt(m.rating)} (your rating)` : null].filter(Boolean).join(' · ')}</T>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
                <Pill label={(official ? '✓ ' : '') + tag.toUpperCase()} fg={official ? tone[2] : c.mute} bg={official ? tone[1] : c.violetSoft} />
                {m.linked_match_id ? <Pill label="LINKED TO YOUR LOG" /> : null}
                {Object.entries(m.stats).map(([k, v]) => <Pill key={k} label={`${fmt(v)} ${nice(k)}`} fg={tone[2]} bg={tone[1]} />)}
              </View>
              {m.notes ? <T size={13} color={c.mute} style={{ marginTop: 8 }}>{m.notes}</T> : null}
              <View style={{ flexDirection: 'row', columnGap: 18, rowGap: 12, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderColor: c.line }}>
                {official ? (
                  <>
                    {m.fixture_id ? <Pressable hitSlop={10} onPress={() => push('MatchCentre', { id: m.fixture_id })}><T size={13} weight="700" color={tone[0]}>View match</T></Pressable> : null}
                    {m.event_id ? <Pressable hitSlop={8} onPress={() => push('Event', { id: m.event_id })}><T size={13} weight="700" color={tone[0]}>View event</T></Pressable> : null}
                    <Pressable hitSlop={8} onPress={() => setNote(m)}><T size={13} weight="700" color={c.mute}>{m.notes || m.rating !== null ? 'Edit my note' : 'Add my note / rating'}</T></Pressable>
                    <Pressable hitSlop={8} onPress={() => push('Support', {})}><T size={13} weight="700" color={c.mute}>Report wrong result</T></Pressable>
                  </>
                ) : (
                  <>
                    <Pressable hitSlop={8} onPress={async () => { try { const cand = await api.get(`/me/matches/${m.id}/link-candidates`); if (!cand.length) toast('No official match found for that day'); else setLinking({ m, cand }); } catch (e) { toast(e.message); } }}><T size={13} weight="700" color={tone[0]}>Link to official match</T></Pressable>
                    <Pressable hitSlop={10} onPress={act(() => api.del(`/me/matches/${m.id}`), 'Match removed')}><T size={13} color={c.mute} weight="700">Remove</T></Pressable>
                  </>
                )}
                {m.linked_match_id ? <Pressable hitSlop={8} onPress={act(() => api.post(`/me/matches/${m.linked_match_id}/unlink`), 'Unlinked — your log counts on its own again')}><T size={13} weight="700" color={c.mute}>Unlink</T></Pressable> : null}
              </View>
            </Card>
          );
        })}
      </View>

      <View style={{ marginTop: 32, paddingTop: 18, borderTopWidth: 1, borderColor: c.line, gap: 8 }}>
        <Btn small title="Remove this sport" color={c.paper} ink={c.red} onPress={async () => { try { await api.del(`/me/sport-profiles/${p.id}`); toast('Sport removed'); if (embedded) onRemoved?.(); else back(); } catch (e) { toast(e.message); } }} style={{ alignSelf: phone ? 'stretch' : 'flex-start' }} />
        <T size={12} color={c.mute}>Removing a sport deletes the matches you logged under it. Official matches stay on your history and reappear if you add the sport again.</T>
      </View>

      {edit ? <EditProfileSheet p={p} onClose={() => setEdit(false)} onDone={reload} /> : null}
      {log ? <LogMatchSheet p={p} onClose={() => setLog(false)} onDone={reload} /> : null}
      {note ? (
        <FormSheet visible onClose={() => setNote(null)} title="Your note on this match" submitLabel="Save"
          initial={{ rating: note.rating ?? '', notes: note.notes ?? '' }}
          fields={[{ key: 'rating', label: 'Your rating (0–10)', optional: true, type: 'number', hint: 'Private to you. Never changes the official result.' }, { key: 'notes', label: 'Notes', optional: true, type: 'multiline' }]}
          onSubmit={async (v) => { await api.post(`/me/official-matches/${note.source_type}/${note.source_id}/note`, { rating: v.rating === '' || v.rating === undefined ? null : Number(v.rating), notes: v.notes || null }); await reload(); return 'Note saved'; }} />
      ) : null}
      {linking ? (
        <FormSheet visible onClose={() => setLinking(null)} title="Link to the official match" submitLabel="Link — count it once"
          fields={[{ key: 'pick', label: 'This looks like an official match already in Gotmygame. Link them so it is counted once.', type: 'choice', options: linking.cand.map((x) => ({ value: `${x.source_type}:${x.source_id}`, label: `${day(x.played_on + 'T12:00:00')} · ${x.opponent ? `vs ${x.opponent}` : x.title ?? 'Match'}${x.competition ? ` · ${x.competition}` : ''}` })) }]}
          onSubmit={async ({ pick }) => { const [source_type, source_id] = pick.split(':'); await api.post(`/me/matches/${linking.m.id}/link`, { source_type, source_id }); await reload(); return 'Linked'; }} />
      ) : null}
    </Screen>
  );
}

// ---------- bulk import ----------

/** CSV header for the sport: the common columns plus this sport's own stat columns (no example rows — nothing invented). */
const csvTemplate = (cols) => `${['played_on', 'match_type', 'opponent', 'competition', 'venue', 'result', 'score_for', 'score_against', 'minutes', 'rating', ...cols].join(',')}\n`;

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
  const sport = profiles.find((x) => x.id === target)?.sport_slug;
  const tpl = useLoad(() => (sport ? api.get(`/sports/${sport}/match-template`) : Promise.resolve(null)), [sport]);
  const statCols = (tpl.data?.columns ?? []).map((x) => x.key);
  const TEMPLATE = csvTemplate(statCols);

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
          First row is the header. <T weight="700" size={12.5}>played_on</T> (YYYY-MM-DD) is required. Optional: opponent, competition, venue, result (win/draw/loss — or worked out from the score), score_for, score_against, minutes, rating (0–10), notes. Also match_type{tpl.data?.match_types?.length > 1 ? ` (${tpl.data.match_types.join(', ')})` : ''}. {statCols.length ? <>This sport's number columns: <T weight="700" size={12.5}>{statCols.join(', ')}</T>.</> : 'Any other column is saved as a number for that match.'}
        </T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {Platform.OS === 'web' ? <Btn small title="Choose CSV file" color={c.paper} onPress={pickFile} /> : null}
          {Platform.OS === 'web' ? <Btn small title="Download template" color={c.paper} onPress={download} /> : <Btn small title="Use template" color={c.paper} onPress={() => { setCsv(TEMPLATE); setPrev(null); }} />}
        </View>
        <TextInput multiline value={csv} onChangeText={(x) => { setCsv(x); setPrev(null); setErr(null); }} placeholder={`…or paste CSV here\n${TEMPLATE}`} placeholderTextColor="#94A3B8" autoCapitalize="none" autoCorrect={false}
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
