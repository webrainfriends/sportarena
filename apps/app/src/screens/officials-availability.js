// Official availability and scheduling preferences (#994): the Availability tab of Officials Home.
// One place for an official's own time: weekly hours (optionally per season), one-off and repeating time off, public holidays, extra open
// windows, buffers, notice, load caps, the sports / levels / roles they prefer and a coarse travel area. Every rule is enforced by the server
// (the same capabilities agents use over MCP); this screen shows what comes back, previews the effect of a change before saving it and
// sends the version it loaded so a change made on another device is never overwritten.
import React, { useMemo, useRef, useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Loading, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MultiMenuField } from '../menu-field';
import { explain, LoadError } from '../access';
import { c } from '../theme';
import { Banner, Metric } from '../federation-ui';
import { Cols, Row2 } from '../federation-bits';
import { addDays, dateTimeIn, fmtMin, localDate, localHHMM, localToIso, longDay, todayIn } from '../vtime';
import { t } from '../i18n';

const DAYS = [1, 2, 3, 4, 5, 6, 0];   // Monday first
const HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22];
const dayName = (d) => t(`oav.day.${d}`);
const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const hrs = (m) => (m % 60 ? (m / 60).toFixed(1) : String(m / 60));
const newKey = () => `av-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const CAT_TONE = { holiday: c.violetSoft, work: c.cyan, family: c.mint, injury: c.red, travel: c.cyan, study: c.mint, faith: c.violetSoft, federation_duty: c.pinkSoft, other_sport: c.mint, personal: c.sun };

/** Which weekday columns an hour row is open, blocked (repeating time off) or both, from the weekly hours and the repeating blocks. */
function gridState(weekly, recurring, today) {
  const live = weekly.filter((w) => (!w.valid_from || w.valid_from <= today) && (!w.valid_to || w.valid_to >= today));
  return (weekday, fromMin, toMinute) => {
    const touches = (x) => toMinute > x.start_minute && x.end_minute > fromMin;
    const open = !live.length ? null : live.some((w) => w.weekday === weekday && touches(w));
    const blocked = recurring.some((r) => r.weekdays?.includes(weekday) && touches(r));
    return { open, blocked };
  };
}

/** The week at a glance: seven days by two-hour bands. Colour is always paired with a legend and each cell has a spoken label. */
export function WeekGrid({ weekly, recurring, today }) {
  const at = useMemo(() => gridState(weekly, recurring, today), [weekly, recurring, today]);
  const anyHours = weekly.length > 0;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 3 }}>
        <View style={{ width: 38 }} />
        {DAYS.map((d) => <View key={d} style={{ flex: 1, alignItems: 'center' }}><T size={11} weight="700" color={c.mute}>{dayName(d)}</T></View>)}
      </View>
      {HOURS.map((h) => (
        <View key={h} style={{ flexDirection: 'row', gap: 3, alignItems: 'center' }}>
          <View style={{ width: 38 }}><T size={10.5} color={c.mute}>{fmtMin(h * 60)}</T></View>
          {DAYS.map((d) => {
            const s = at(d, h * 60, (h + 2) * 60);
            const bg = s.blocked ? c.sunSoft : s.open ? c.mintSoft : s.open === null ? c.violetSoft : c.bg;
            const label = `${dayName(d)} ${fmtMin(h * 60)}: ${s.blocked ? t('oav.grid.blocked') : s.open ? t('oav.grid.open') : s.open === null ? t('oav.grid.any') : t('oav.grid.closed')}`;
            return <View key={d} accessible accessibilityLabel={label} style={{ flex: 1, height: 22, borderRadius: 5, backgroundColor: bg, borderWidth: 1, borderColor: s.blocked ? c.sun : s.open ? c.mint : c.line, alignItems: 'center', justifyContent: 'center' }}>{s.blocked ? <T size={10} weight="800" color={c.sun}>×</T> : null}</View>;
          })}
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap', marginTop: 2 }}>
        {[[anyHours ? c.mintSoft : c.violetSoft, anyHours ? c.mint : c.line, anyHours ? t('oav.grid.open') : t('oav.grid.any')], [c.sunSoft, c.sun, t('oav.grid.blocked')], ...(anyHours ? [[c.bg, c.line, t('oav.grid.closed')]] : [])].map(([bg, bd, l]) => (
          <View key={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: bg, borderWidth: 1, borderColor: bd }} /><T size={11} color={c.mute}>{l}</T></View>
        ))}
      </View>
    </View>
  );
}

/** Twelve weeks of real match load: confirmed (solid) with tentative requests stacked on top, and the weekly cap as a line when one is set. */
function LoadChart({ load, cap }) {
  const max = Math.max(cap ?? 0, ...load.map((w) => w.confirmed + w.tentative), 1);
  const H = 96;
  const total = load.reduce((n, w) => n + w.confirmed, 0);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={t('oav.load.a11y', { total, weeks: load.length })} style={{ gap: 6 }}>
      <View style={{ height: H + 4, flexDirection: 'row', alignItems: 'flex-end', gap: 4 }}>
        {cap ? <View style={{ position: 'absolute', start: 0, end: 0, bottom: (cap / max) * H, height: 1, backgroundColor: c.red }} /> : null}
        {load.map((w, i) => (
          <View key={w.week_start} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: H }}>
            {w.tentative ? <View style={{ width: '100%', height: Math.max(3, (w.tentative / max) * H), backgroundColor: c.sunSoft, borderWidth: 1, borderColor: c.sun, borderTopLeftRadius: 4, borderTopRightRadius: 4 }} /> : null}
            {w.confirmed ? <View style={{ width: '100%', height: Math.max(3, (w.confirmed / max) * H), backgroundColor: i === 6 ? c.pink : c.cyan, borderTopLeftRadius: w.tentative ? 0 : 4, borderTopRightRadius: w.tentative ? 0 : 4 }} /> : null}
            {!w.confirmed && !w.tentative ? <View style={{ width: '100%', height: 2, backgroundColor: c.line }} /> : null}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {load.map((w, i) => <View key={w.week_start} style={{ flex: 1, alignItems: 'center' }}><T size={9.5} weight={i === 6 ? '800' : '500'} color={i === 6 ? c.ink : c.mute}>{w.week_start.slice(8)}</T></View>)}
      </View>
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        {[[c.cyan, t('oav.load.confirmed')], [c.pink, t('oav.load.this_week')], [c.sunSoft, t('oav.load.tentative')], ...(cap ? [[c.red, t('oav.load.cap', { n: cap })]] : [])].map(([bg, l]) => (
          <View key={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: bg }} /><T size={11} color={c.mute}>{l}</T></View>
        ))}
      </View>
    </View>
  );
}

/** Public holidays on record for a country, picked from a searchable list. */
function HolidayPick({ country, value, onChange, taken }) {
  const from = new Date().toISOString().slice(0, 10);
  const q = useLoad(() => (country ? api.get('/holidays', { country, from, to: addDays(from, 400) }) : Promise.resolve([])), [country]);
  if (!country) return <T size={12.5} color={c.mute}>{t('oav.hol.pick_country')}</T>;
  if (!q.data) return q.error ? <T size={12.5} color={c.red}>{explain(q.error)}</T> : <Loading />;
  const open = q.data.filter((h) => !taken.has(h.id));
  if (!open.length) return <Empty emoji="🗓️" title={t('oav.hol.none_title')} sub={q.data.length ? t('oav.hol.all_taken') : t('oav.hol.none_sub')} />;
  return <MultiMenuField label={t('oav.hol.days')} value={value ?? []} onChange={onChange} placeholder={t('common.choose')} options={open.map((h) => ({ value: h.id, label: h.label, sub: longDay(String(h.on_date).slice(0, 10)) }))} hint={t('oav.hol.hint')} />;
}

const repeatLine = (r) => {
  const days = [...(r.weekdays ?? [])].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).map(dayName).join(', ');
  const time = r.all_day || (r.start_minute === 0 && r.end_minute === 1440) ? t('oav.all_day') : `${fmtMin(r.start_minute)}–${fmtMin(r.end_minute)}`;
  return `${r.every_n_weeks > 1 ? t('oav.rep.every_n', { n: r.every_n_weeks }) : t('oav.rep.every')} · ${days} · ${time}`;
};

export function AvailabilityTab({ sports = [], go }) {
  const { toast } = useSession();
  const L = useLayout();
  const q = useLoad(() => api.get('/me/officials/availability'), []);
  const ins = useLoad(() => api.get('/me/officials/availability/insights'), []);
  const [form, setForm] = useState(null);      // { kind, row? }
  const [impact, setImpact] = useState(null);  // { affected, run }
  const [showHistory, setShowHistory] = useState(false);
  const hist = useLoad(() => (showHistory ? api.get('/me/officials/availability/history', { limit: 20 }) : Promise.resolve(null)), [showHistory]);
  const idem = useRef(newKey());
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const { prefs, weekly, time_off: off, recurring, holidays, extra, summary: s, attention, options } = q.data;
  const tz = prefs.timezone, today = todayIn(tz);
  const sportName = (id) => { const x = sports.find((sp) => sp.id === id); return x ? `${x.emoji ?? ''} ${x.name}`.trim() : null; };

  /** Save, say so, reload. A change made on another device (409) reloads the latest version and tells the official to check it. */
  const save = async (fn, msg) => {
    try { const r = await fn(); toast(msg); idem.current = newKey(); await q.reload(); return r; }
    catch (e) { if (e.status === 409) await q.reload(); toast(explain(e)); throw e; }
  };
  /** Dry-run a block on the server first; when it lands on requested or confirmed matches, show them before anything is saved. */
  const guarded = async (previewBody, run) => {
    const dry = await api.post('/me/officials/availability/preview', previewBody);
    if (dry.affected_assignments.length) { setForm(null); setImpact({ affected: dry.affected_assignments, total: dry.total_occurrences, run }); return; }
    await run(); setForm(null);
  };

  const windowsBody = (list) => list.map((w) => ({ weekday: w.weekday, start_minute: w.start_minute, end_minute: w.end_minute, valid_from: w.valid_from ?? null, valid_to: w.valid_to ?? null }));
  const saveWeekly = (list) => save(() => api.post('/me/officials/availability/weekly', { windows: windowsBody(list), expected_version: prefs.version }), t('oav.saved.hours'));

  const blockBody = (v) => {
    const base = { all_day: !!v.all_day, category: v.category || undefined, note: v.note?.trim() || undefined };
    if (v.mode === 'repeat') {
      return { ...base, recurrence: { starts_on: v.from, ends_on: v.to ?? v.from, weekdays: v.days, every_n_weeks: v.every ?? 1, start_minute: v.all_day ? 0 : toMin(v.start), end_minute: v.all_day ? 1440 : toMin(v.end) } };
    }
    const end = v.to ?? v.from;
    return { ...base, starts_at: localToIso(v.from, v.all_day ? '00:00' : v.start, tz), ends_at: v.all_day ? localToIso(addDays(end, 1), '00:00', tz) : localToIso(end, v.end, tz) };
  };
  const submitBlock = async (v) => {
    if (!v.from) throw new Error(t('oav.err.dates'));
    if (v.mode === 'repeat' && !v.days?.length) throw new Error(t('oav.err.days'));
    if (!v.all_day && v.mode === 'repeat' && toMin(v.end) <= toMin(v.start)) throw new Error(t('oav.err.times'));
    const body = blockBody(v);
    if (new Date(body.ends_at ?? 1) <= new Date(body.starts_at ?? 0)) throw new Error(t('oav.err.times'));
    const { note: _n, category: _c, ...shape } = body;
    const editing = form?.row;
    const run = () => save(() => (editing
      ? api.patch(`/me/officials/availability/${editing.id}`, { ...body, category: body.category ?? null, note: body.note ?? null, expected_version: editing.version })
      : api.post('/me/officials/availability/time-off', { ...body, idempotency_key: idem.current })), t('oav.saved.block'));
    await guarded({ time_off: shape }, run);
  };
  const blockInitial = (row) => {
    if (!row) return { mode: form?.kind === 'repeat' ? 'repeat' : 'once', all_day: true, start: '09:00', end: '18:00', days: [], every: 1 };
    if (row.kind === 'recurring') return { mode: 'repeat', all_day: row.all_day, from: row.starts_on, to: row.ends_on, days: row.weekdays, every: row.every_n_weeks, start: fmtMin(row.start_minute), end: fmtMin(Math.min(row.end_minute, 1439)), category: row.category ?? undefined, note: row.note ?? '' };
    const lastDay = row.all_day ? addDays(localDate(row.ends_at, tz), -1) : localDate(row.ends_at, tz);
    return { mode: 'once', all_day: row.all_day, from: localDate(row.starts_at, tz), to: lastDay, start: localHHMM(row.starts_at, tz), end: localHHMM(row.ends_at, tz), category: row.category ?? undefined, note: row.note ?? '' };
  };
  const remove = (row, msg) => save(() => api.post(`/me/officials/availability/${row.id}/remove`, {}), msg);

  const catTag = (cat) => (cat ? <Tag label={t(`oav.cat.${cat}`)} color={CAT_TONE[cat] ?? c.violetSoft} /> : null);
  const rowCard = (key, tags, title, sub, note, actions) => (
    <Card key={key} pad={14}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{tags}</View>
        <T weight="800" size={15}>{title}</T>
        {sub ? <T size={12.5} color={c.mute}>{sub}</T> : null}
        {note ? <T size={12.5} color={c.mute}>🔒 {note}</T> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>{actions}</View>
      </View>
    </Card>
  );
  const act = (title, onPress) => <Btn key={title} small title={title} color={c.paper} ink={c.ink} style={{ minHeight: 44 }} onPress={onPress} />;

  const hoursByDay = DAYS.map((d) => [d, weekly.filter((w) => w.weekday === d)]).filter(([, l]) => l.length);
  const needs = s.conflicts + s.outside_hours;
  const takenHolidays = new Set(holidays.map((h) => h.holiday_day_id));
  const hasBlocks = off.length + recurring.length + holidays.length > 0;

  // ── insights panel ────────────────────────────────────────────────────────
  const insData = ins.data;
  const HINT_ICON = { approaching_cap: '⚠️', back_to_back_weekends: '🔁', heavy_stretch: '🔥' };
  const fmtMoney = (minor, currency) => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100); }
    catch { return `${currency} ${(minor / 100).toFixed(0)}`; }
  };
  const insightsPanel = insData ? (
    <View style={{ gap: 10 }}>
      {/* AI Scheduler Insight pill */}
      {insData.scheduler_hint ? (
        <View style={{ backgroundColor: c.sunSoft, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: c.sun }}>
          <T size={22}>{HINT_ICON[insData.scheduler_hint] ?? '🤖'}</T>
          <View style={{ flex: 1 }}>
            <T weight="800" size={13}>{t(`oav.insights.hint.${insData.scheduler_hint}`)}</T>
            <T size={12} color={c.mute}>{t('oav.insights.ai_note')}</T>
          </View>
        </View>
      ) : (
        <View style={{ backgroundColor: c.mintSoft, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: c.mint }}>
          <T size={22}>✅</T>
          <T weight="800" size={13} style={{ flex: 1 }}>{t('oav.insights.hint.clear')}</T>
        </View>
      )}
      <View style={{ flexDirection: L.tablet ? 'row' : 'column', gap: 10 }}>
        {/* Earnings Forecast */}
        {insData.earnings.length > 0 ? (
          <Card style={L.tablet ? { flex: 1 } : null}>
            <View style={{ gap: 6 }}>
              <T weight="800" size={14}>{t('oav.insights.earnings_title')}</T>
              <T size={11.5} color={c.mute}>{t('oav.insights.earnings_sub')}</T>
              {insData.earnings.map(({ currency, confirmed_minor, tentative_minor, total_minor }) => (
                <View key={currency} style={{ gap: 3, marginTop: 4 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                    <T weight="800" size={22} color={c.cyan}>{fmtMoney(total_minor, currency)}</T>
                    <T size={12} color={c.mute}>{t('oav.insights.total_90')}</T>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <T size={12} color={c.mint}>✓ {fmtMoney(confirmed_minor, currency)} {t('oav.insights.confirmed')}</T>
                    {tentative_minor > 0 ? <T size={12} color={c.sun}>◷ {fmtMoney(tentative_minor, currency)} {t('oav.insights.tentative')}</T> : null}
                  </View>
                </View>
              ))}
            </View>
          </Card>
        ) : null}
        {/* Season Workload ring */}
        <Card style={L.tablet ? { flex: 1 } : null}>
          <View style={{ gap: 6 }}>
            <T weight="800" size={14}>{t('oav.insights.season_title')}</T>
            <T size={11.5} color={c.mute}>{t('oav.insights.season_sub')}</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 4 }}>
              {/* simple arc: ring visualised as a stacked-radius view */}
              <View style={{ width: 64, height: 64, borderRadius: 32, borderWidth: 8, borderColor: c.line, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                <View style={{ position: 'absolute', width: 64, height: 64, borderRadius: 32, borderWidth: 8, borderColor: c.cyan, opacity: (insData.season.pct / 100) }} />
                <T weight="800" size={15}>{insData.season.pct}%</T>
              </View>
              <View style={{ gap: 3 }}>
                <T size={13}><T weight="800" color={c.cyan}>{insData.season.confirmed}</T> {t('oav.insights.s_confirmed')}</T>
                {insData.season.pending > 0 ? <T size={13}><T weight="800" color={c.sun}>{insData.season.pending}</T> {t('oav.insights.s_pending')}</T> : null}
                <T size={12} color={c.mute}>{t('oav.insights.s_total', { n: insData.season.total })}</T>
              </View>
            </View>
          </View>
        </Card>
      </View>
      {/* Smart Open Slots */}
      {insData.week_load.length > 0 ? (
        <Card>
          <View style={{ gap: 6 }}>
            <T weight="800" size={14}>{t('oav.insights.slots_title')}</T>
            <T size={11.5} color={c.mute}>{t('oav.insights.slots_sub')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {insData.week_load.slice(0, 8).map((w) => {
                const total = w.confirmed + w.tentative;
                const cap = prefs.max_per_week;
                const pct = cap ? Math.min(100, Math.round((total / cap) * 100)) : (total >= 5 ? 90 : total * 18);
                const tone = pct >= 80 ? c.redSoft : pct >= 50 ? c.sunSoft : c.mintSoft;
                const ink = pct >= 80 ? c.red : pct >= 50 ? c.sun : c.mint;
                return (
                  <View key={w.week_start} style={{ backgroundColor: tone, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, alignItems: 'center', minWidth: 64 }}>
                    <T weight="800" size={13} color={ink}>{100 - pct}</T>
                    <T size={10} color={c.mute}>{w.week_start.slice(5)}</T>
                    <T size={10} color={c.mute}>{total} {t('oav.insights.slots_booked')}</T>
                  </View>
                );
              })}
            </View>
            <T size={11} color={c.mute}>{t('oav.insights.slots_key')}</T>
          </View>
        </Card>
      ) : null}
    </View>
  ) : ins.error ? null : <Loading />;

  const planner = (
    <Card>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <View style={{ flex: 1 }}><T weight="800" size={16}>{t('oav.week.title')}</T><T size={12} color={c.mute}>{t('oav.week.sub', { tz })}</T></View>
          <Btn small title={t('oav.week.add')} onPress={() => setForm({ kind: 'hours' })} style={{ minHeight: 44 }} />
        </View>
        <WeekGrid weekly={weekly} recurring={recurring} today={today} />
        {hoursByDay.length ? (
          <View style={{ gap: 8 }}>
            {hoursByDay.map(([d, list]) => (
              <View key={d} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <T weight="800" style={{ width: 44 }}>{dayName(d)}</T>
                {list.map((w) => <Chip key={w.id} label={`${fmtMin(w.start_minute)}–${fmtMin(w.end_minute)}${w.valid_from || w.valid_to ? ` · ${t('oav.week.season')}` : ''}  ✕`} onPress={() => saveWeekly(weekly.filter((x) => x.id !== w.id))} />)}
              </View>
            ))}
          </View>
        ) : <T size={12.5} color={c.mute}>{t('oav.week.none')}</T>}
      </View>
    </Card>
  );
  const hasLoad = s.load.some((w) => w.confirmed + w.tentative > 0);
  const loadCard = (
    <Card>
      <View style={{ gap: 12 }}>
        <View><T weight="800" size={16}>{t('oav.load.title')}</T><T size={12} color={c.mute}>{t('oav.load.sub')}</T></View>
        {hasLoad ? <LoadChart load={s.load} cap={prefs.max_per_week} /> : <Empty emoji="📈" title={t('oav.load.empty_title')} sub={t('oav.load.empty_sub')} />}
      </View>
    </Card>
  );

  const prefRows = [
    [t('oav.pref.rules'), [
      [t('oav.pref.timezone'), tz],
      [t('oav.pref.gap'), prefs.buffer_min ? t('oav.n_min', { n: prefs.buffer_min }) : t('oav.none')],
      [t('oav.pref.gap_same'), prefs.buffer_same_venue_min != null ? t('oav.n_min', { n: prefs.buffer_same_venue_min }) : t('oav.pref.same_as_gap')],
      [t('oav.pref.notice'), prefs.min_notice_hours ? t('oav.n_hours', { n: prefs.min_notice_hours }) : t('oav.none')],
      [t('oav.pref.caps'), [prefs.max_per_day ? t('oav.pref.per_day', { n: prefs.max_per_day }) : null, prefs.max_per_week ? t('oav.pref.per_week', { n: prefs.max_per_week }) : null, prefs.max_consecutive_days ? t('oav.pref.in_a_row', { n: prefs.max_consecutive_days }) : null].filter(Boolean).join(' · ') || t('oav.none')],
      [t('oav.pref.outside'), t(`oav.policy.${prefs.outside_hours_policy}`)],
      [t('oav.pref.tentative'), t(`oav.tpolicy.${prefs.tentative_policy}`)],
    ]],
    [t('oav.pref.what'), [
      [t('oav.pref.sports'), prefs.sport_ids.map(sportName).filter(Boolean).join(', ') || t('oav.any')],
      [t('oav.pref.levels'), prefs.levels.map((l) => (options.levels.includes(l) ? t(`oav.level.${l}`) : l)).join(', ') || t('oav.any')],
      [t('oav.pref.roles'), prefs.roles.map((r) => t(`oav.role.${r}`)).join(', ') || t('oav.any')],
      [t('oav.pref.ages'), prefs.age_bands.map((a) => t(`oav.age.${a}`)).join(', ') || t('oav.any')],
    ]],
    [t('oav.pref.travel'), [
      [t('oav.pref.region'), prefs.region || t('oav.not_set')],
      [t('oav.pref.range'), prefs.travel_km ? t('oav.n_km', { n: prefs.travel_km }) : t('oav.not_set')],
      [t('oav.pref.country'), prefs.country || t('oav.not_set')],
    ]],
  ];

  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric value={s.open_minutes_week == null ? t('oav.m.any') : t('oav.m.hours', { n: hrs(s.open_minutes_week) })} label={t('oav.m.open')} tone={c.mintSoft} onPress={() => setForm({ kind: 'hours' })} />
        <Metric value={s.blocked_days_90} label={t('oav.m.blocked')} tone={s.blocked_days_90 ? c.cyanSoft : undefined} />
        <Metric value={s.tentative_holds} label={t('oav.m.tentative')} tone={s.tentative_holds ? c.sunSoft : undefined} onPress={go ? () => go('OfficialsHome', { tab: 'calendar' }) : undefined} />
        <Metric value={s.confirmed_upcoming} label={t('oav.m.confirmed')} />
        <Metric value={s.this_week.cap ? `${s.this_week.confirmed}/${s.this_week.cap}` : s.this_week.confirmed} label={t('oav.m.week')} sub={s.this_week.tentative ? t('oav.m.week_sub', { n: s.this_week.tentative }) : undefined} tone={s.this_week.cap && s.this_week.confirmed >= s.this_week.cap ? c.sunSoft : undefined} />
        <Metric value={needs} label={t('oav.m.attention')} tone={needs ? c.redSoft : undefined} />
      </View>

      {attention.length ? (
        <Card color={c.sunSoft}>
          <View style={{ gap: 8 }}>
            <T weight="800">{t('oav.att.title', { n: attention.length })}</T>
            {attention.map((a) => (
              <Pressable key={`${a.id}${a.issue}`} onPress={go ? () => go('OfficialMatch', { id: a.fixture_id }) : undefined} accessibilityRole="button" accessibilityLabel={[a.event_name, dateTimeIn(a.scheduled_at, tz)].join(', ')} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <T weight="700" size={14}>{a.event_name}</T>
                  <T size={12.5} color={c.mute}>{dateTimeIn(a.scheduled_at, tz)} · {t(`oav.role.${a.role}`)} · {t(a.status === 'accepted' ? 'oav.hold.reserved' : 'oav.hold.tentative')}</T>
                </View>
                <Tag label={t(a.issue === 'time_off' ? 'oav.att.time_off' : 'oav.att.outside')} color={c.sun} />
                <T weight="800" color={c.pink}>›</T>
              </Pressable>
            ))}
            <T size={12} color={c.mute}>{t('oav.att.hint')}</T>
          </View>
        </Card>
      ) : null}

      {insightsPanel ? <Section title={t('oav.insights.title')} color={c.violet}>{insightsPanel}</Section> : null}

      <Cols ratio={[3, 2]} a={planner} b={loadCard} />

      <Section title={t('oav.off.title')} color={c.sun}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <Btn small title={t('oav.off.block')} onPress={() => setForm({ kind: 'once' })} style={{ minHeight: 44 }} />
          <Btn small title={t('oav.off.repeat')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'repeat' })} style={{ minHeight: 44 }} />
          <Btn small title={t('oav.off.holidays')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'holidays' })} style={{ minHeight: 44 }} />
        </View>
        {hasBlocks ? (
          <View style={{ gap: 8, flexDirection: L.tablet ? 'row' : 'column', flexWrap: 'wrap' }}>
            {[
              ...recurring.map((r) => rowCard(r.id, <><Tag label={'🔁 ' + t('oav.rep.tag')} color={c.cyan} />{catTag(r.category)}{r.exclude_dates.length ? <Tag label={t('oav.rep.skipped', { n: r.exclude_dates.length })} color={c.violetSoft} /> : null}</>,
                repeatLine(r), t('oav.rep.span', { from: longDay(r.starts_on), to: longDay(r.ends_on) }), r.note,
                [act(t('oav.edit'), () => setForm({ kind: 'repeat', row: r })), act(t('oav.rep.skip'), () => setForm({ kind: 'skip', row: r })), act(t('oav.remove'), () => remove(r, t('oav.saved.removed')))])),
              ...off.map((o) => rowCard(o.id, <><Tag label={'🌴 ' + t('oav.off.tag')} color={c.sun} />{catTag(o.category)}</>,
                o.all_day ? (localDate(o.starts_at, tz) === addDays(localDate(o.ends_at, tz), -1) ? longDay(localDate(o.starts_at, tz)) : `${longDay(localDate(o.starts_at, tz))} → ${longDay(addDays(localDate(o.ends_at, tz), -1))}`) : `${dateTimeIn(o.starts_at, tz)} → ${dateTimeIn(o.ends_at, tz)}`,
                o.all_day ? t('oav.all_day') : null, o.note,
                [act(t('oav.edit'), () => setForm({ kind: 'once', row: o })), act(t('oav.remove'), () => remove(o, t('oav.saved.removed')))])),
              ...holidays.map((h) => rowCard(h.id, <Tag label={'🎉 ' + t('oav.hol.tag')} color={c.violetSoft} />, h.label ?? t('oav.hol.tag'), longDay(h.starts_on), null,
                [act(t('oav.hol.work'), () => remove(h, t('oav.saved.removed')))])),
            ].map((card) => <View key={card.key} style={L.tablet ? { flexBasis: '48%', flexGrow: 1 } : null}>{card}</View>)}
          </View>
        ) : <Empty emoji="🌴" title={t('oav.off.empty_title')} sub={t('oav.off.empty_sub')} />}
      </Section>

      <Section title={t('oav.extra.title')} color={c.mint} action={t('oav.extra.add')} onAction={() => setForm({ kind: 'extra' })}>
        {extra.length ? <View style={{ gap: 8 }}>{extra.map((x) => rowCard(x.id, <Tag label={'✨ ' + t('oav.extra.tag')} color={c.mint} />, `${dateTimeIn(x.starts_at, tz)} → ${dateTimeIn(x.ends_at, tz)}`, null, null, [act(t('oav.remove'), () => remove(x, t('oav.saved.removed')))]))}</View>
          : <Card color={c.paper} pad={14}><T size={13} color={c.mute}>{t('oav.extra.empty')}</T></Card>}
      </Section>

      <Section title={t('oav.pref.title')} color={c.cyan} action={t('oav.edit')} onAction={() => setForm({ kind: 'prefs' })}>
        <View style={{ gap: 10, flexDirection: L.tablet ? 'row' : 'column', alignItems: 'stretch' }}>
          {prefRows.map(([title, rows]) => (
            <View key={title} style={L.tablet ? { flex: 1 } : null}>
              <Card style={L.tablet ? { flex: 1 } : null}><View style={{ gap: 2 }}><T weight="800" size={15} style={{ marginBottom: 6 }}>{title}</T>{rows.map(([k, v]) => <Row2 key={k} k={k} v={v} />)}</View></Card>
            </View>
          ))}
        </View>
      </Section>

      <Card color={c.violetSoft}>
        <View style={{ gap: 6 }}>
          <T weight="800">🔒 {t('oav.priv.title')}</T>
          <T size={13}>{t('oav.priv.see')}</T>
          <T size={13}>{t('oav.priv.never')}</T>
        </View>
      </Card>

      <Section title={t('oav.hist.title')} color={c.violet} action={showHistory ? t('oav.hist.hide') : t('oav.hist.show')} onAction={() => setShowHistory((x) => !x)}>
        {!showHistory ? <T size={12.5} color={c.mute}>{t('oav.hist.sub')}</T> : !hist.data ? <Loading /> : hist.data.length ? (
          <Card><View style={{ gap: 8 }}>{hist.data.map((h) => (
            <View key={h.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Tag label={t(`oav.hist.${h.action}`)} color={h.action === 'removed' ? c.red : h.action === 'created' ? c.mint : c.cyan} />
              <T size={13} style={{ flex: 1 }}>{t(`oav.hist.e_${h.entity}`)}</T>
              <T size={12} color={c.mute}>{dateTimeIn(h.at, tz)}</T>
            </View>
          ))}</View></Card>
        ) : <T size={12.5} color={c.mute}>{t('oav.hist.empty')}</T>}
      </Section>

      {/* weekly hours */}
      <FormSheet visible={form?.kind === 'hours'} onClose={() => setForm(null)} title={t('oav.f.hours_title')} submitLabel={t('oav.f.add')}
        initial={{ days: [], start: '08:00', end: '18:00' }}
        fields={[
          { key: 'days', label: t('oav.f.days'), type: 'weekdays' },
          { key: 'start', label: t('oav.f.from'), type: 'time', step: 15 },
          { key: 'end', label: t('oav.f.until'), type: 'time', step: 15, endOfDay: true },
          { key: 'seasonal', label: t('oav.f.seasonal'), type: 'switch', hint: t('oav.f.seasonal_hint') },
          { key: 'valid_from', toKey: 'valid_to', label: t('oav.f.season'), type: 'daterange', optional: true, show: (v) => v.seasonal },
        ]}
        onSubmit={async (v) => {
          if (!v.days?.length) throw new Error(t('oav.err.days'));
          const a = toMin(v.start), b = v.end === '24:00' ? 1440 : toMin(v.end);
          if (b <= a) throw new Error(t('oav.err.times'));
          await saveWeekly([...weekly, ...v.days.map((d) => ({ weekday: d, start_minute: a, end_minute: b, valid_from: v.seasonal ? v.valid_from ?? null : null, valid_to: v.seasonal ? v.valid_to ?? v.valid_from ?? null : null }))]);
          setForm(null);
        }} />

      {/* time off: one period or a repeating pattern */}
      <FormSheet visible={form?.kind === 'once' || form?.kind === 'repeat'} onClose={() => setForm(null)} title={form?.row ? t('oav.f.block_edit') : form?.kind === 'repeat' ? t('oav.f.repeat_title') : t('oav.f.block_title')}
        submitLabel={t('oav.f.check_save')} initial={blockInitial(form?.row)} notice={t('oav.f.block_notice')}
        fields={[
          { key: 'all_day', label: t('oav.f.all_day'), type: 'switch' },
          { key: 'from', toKey: 'to', label: form?.kind === 'repeat' ? t('oav.f.between') : t('oav.f.dates'), type: 'daterange', min: today },
          { key: 'days', label: t('oav.f.on_days'), type: 'weekdays', show: () => form?.kind === 'repeat' },
          { key: 'every', label: t('oav.f.every'), type: 'stepper', min: 1, max: 8, suffix: t('oav.f.weeks'), show: () => form?.kind === 'repeat' },
          { key: 'start', label: t('oav.f.from'), type: 'time', step: 15, show: (v) => !v.all_day },
          { key: 'end', label: t('oav.f.until'), type: 'time', step: 15, show: (v) => !v.all_day },
          { key: 'category', label: t('oav.f.category'), type: 'chips', optional: true, options: options.categories.map((k) => ({ value: k, label: t(`oav.cat.${k}`) })), hint: t('oav.f.category_hint') },
          { key: 'note', label: t('oav.f.note'), type: 'multiline', optional: true, hint: t('oav.f.note_hint') },
        ]}
        onSubmit={(v) => submitBlock({ ...v, mode: form?.kind === 'repeat' ? 'repeat' : 'once' })} />

      {/* skip one date of a repeating block */}
      <FormSheet visible={form?.kind === 'skip'} onClose={() => setForm(null)} title={t('oav.f.skip_title')} submitLabel={t('oav.rep.skip')} initial={{}}
        notice={form?.row ? repeatLine(form.row) : undefined}
        fields={[{ key: 'date', label: t('oav.f.skip_date'), type: 'date', min: form?.row?.starts_on, max: form?.row?.ends_on }]}
        onSubmit={async (v) => {
          if (!v.date) throw new Error(t('oav.err.dates'));
          await save(() => api.patch(`/me/officials/availability/${form.row.id}`, { expected_version: form.row.version, skip_dates: [v.date] }), t('oav.saved.skipped'));
          setForm(null);
        }} />

      {/* public holidays from the shared holiday calendar */}
      <FormSheet visible={form?.kind === 'holidays'} onClose={() => setForm(null)} title={t('oav.f.hol_title')} submitLabel={t('oav.f.check_save')} initial={{ country: prefs.country ?? undefined, ids: [] }}
        fields={[
          { key: 'country', label: t('oav.pref.country'), type: 'country' },
          { key: 'ids', type: 'custom', render: ({ v, set }) => <HolidayPick country={v.country} value={v.ids} onChange={(x) => set('ids', x)} taken={takenHolidays} /> },
        ]}
        onSubmit={async (v) => {
          if (!v.ids?.length) throw new Error(t('oav.err.holidays'));
          await guarded({ holiday_ids: v.ids }, () => save(() => api.post('/me/officials/availability/holidays', { holiday_ids: v.ids }), t('oav.saved.holidays')));
        }} />

      {/* an extra open window */}
      <FormSheet visible={form?.kind === 'extra'} onClose={() => setForm(null)} title={t('oav.f.extra_title')} submitLabel={t('oav.f.add')} initial={{ start: '08:00', end: '20:00' }} notice={t('oav.f.extra_notice')}
        fields={[
          { key: 'from', toKey: 'to', label: t('oav.f.dates'), type: 'daterange', min: today },
          { key: 'start', label: t('oav.f.from'), type: 'time', step: 15 },
          { key: 'end', label: t('oav.f.until'), type: 'time', step: 15 },
        ]}
        onSubmit={async (v) => {
          if (!v.from) throw new Error(t('oav.err.dates'));
          const starts_at = localToIso(v.from, v.start, tz), ends_at = localToIso(v.to ?? v.from, v.end, tz);
          if (new Date(ends_at) <= new Date(starts_at)) throw new Error(t('oav.err.times'));
          await save(() => api.post('/me/officials/availability/open', { starts_at, ends_at, idempotency_key: idem.current }), t('oav.saved.extra'));
          setForm(null);
        }} />

      {/* preferences */}
      <FormSheet visible={form?.kind === 'prefs'} onClose={() => setForm(null)} title={t('oav.pref.title')}
        initial={{
          timezone: tz, buffer_min: prefs.buffer_min, same_venue: prefs.buffer_same_venue_min != null, buffer_same_venue_min: prefs.buffer_same_venue_min ?? 0, min_notice_hours: prefs.min_notice_hours ?? 0,
          max_per_day: prefs.max_per_day ?? 0, max_per_week: prefs.max_per_week ?? 0, max_consecutive_days: prefs.max_consecutive_days ?? 0, block_outside: prefs.outside_hours_policy === 'block', one_per_slot: prefs.tentative_policy === 'one_per_slot',
          sport_ids: prefs.sport_ids, levels: prefs.levels, roles: prefs.roles, age_bands: prefs.age_bands, region: prefs.region ?? '', travel_km: prefs.travel_km ?? 0, country: prefs.country ?? undefined,
        }}
        fields={[
          { type: 'section', key: 's1', label: t('oav.pref.rules') },
          { key: 'timezone', label: t('oav.pref.timezone'), type: 'timezone' },
          { key: 'buffer_min', label: t('oav.pref.gap'), type: 'stepper', min: 0, max: 240, step: 15, suffix: t('oav.min'), hint: t('oav.pref.gap_hint') },
          { key: 'same_venue', label: t('oav.pref.same_venue_q'), type: 'switch' },
          { key: 'buffer_same_venue_min', label: t('oav.pref.gap_same'), type: 'stepper', min: 0, max: 240, step: 5, suffix: t('oav.min'), show: (v) => v.same_venue },
          { key: 'min_notice_hours', label: t('oav.pref.notice'), type: 'stepper', min: 0, max: 336, step: 12, suffix: t('oav.h'), hint: t('oav.pref.notice_hint') },
          { key: 'max_per_day', label: t('oav.pref.max_day'), type: 'stepper', min: 0, max: 12, hint: t('oav.pref.zero_none') },
          { key: 'max_per_week', label: t('oav.pref.max_week'), type: 'stepper', min: 0, max: 40 },
          { key: 'max_consecutive_days', label: t('oav.pref.max_row'), type: 'stepper', min: 0, max: 14 },
          { key: 'block_outside', label: t('oav.pref.block_outside'), type: 'switch', hint: t('oav.pref.block_outside_hint') },
          { key: 'one_per_slot', label: t('oav.pref.one_per_slot'), type: 'switch', hint: t('oav.pref.one_per_slot_hint') },
          { type: 'section', key: 's2', label: t('oav.pref.what') },
          { key: 'sport_ids', label: t('oav.pref.sports'), type: 'multimenu', optional: true, placeholder: t('oav.any'), options: sports.map((sp) => ({ value: sp.id, label: `${sp.emoji ?? ''} ${sp.name}`.trim() })), hint: t('oav.pref.sports_hint') },
          { key: 'levels', label: t('oav.pref.levels'), type: 'multimenu', optional: true, placeholder: t('oav.any'), options: options.levels.map((l) => ({ value: l, label: t(`oav.level.${l}`) })) },
          { key: 'roles', label: t('oav.pref.roles'), type: 'multimenu', optional: true, placeholder: t('oav.any'), options: options.roles.map((r) => ({ value: r, label: t(`oav.role.${r}`) })) },
          { key: 'age_bands', label: t('oav.pref.ages'), type: 'multimenu', optional: true, placeholder: t('oav.any'), options: options.age_bands.map((a) => ({ value: a, label: t(`oav.age.${a}`) })) },
          { type: 'section', key: 's3', label: t('oav.pref.travel') },
          { key: 'region', label: t('oav.pref.region'), type: 'region', optional: true, hint: t('oav.pref.region_hint') },
          { key: 'travel_km', label: t('oav.pref.range'), type: 'stepper', min: 0, max: 1000, step: 10, suffix: t('oav.km'), hint: t('oav.pref.zero_none') },
          { key: 'country', label: t('oav.pref.country'), type: 'country', optional: true, hint: t('oav.pref.country_hint') },
        ]}
        onSubmit={async (v) => {
          await save(() => api.post('/me/officials/availability/prefs', {
            timezone: v.timezone, buffer_min: v.buffer_min, buffer_same_venue_min: v.same_venue ? v.buffer_same_venue_min : null, min_notice_hours: v.min_notice_hours,
            max_per_day: v.max_per_day || null, max_per_week: v.max_per_week || null, max_consecutive_days: v.max_consecutive_days || null,
            outside_hours_policy: v.block_outside ? 'block' : 'warn', tentative_policy: v.one_per_slot ? 'one_per_slot' : 'allow',
            sport_ids: v.sport_ids ?? [], levels: v.levels ?? [], roles: v.roles ?? [], age_bands: v.age_bands ?? [], region: v.region || null, travel_km: v.travel_km || null, country: v.country || null,
            expected_version: prefs.version,
          }), t('oav.saved.prefs'));
          setForm(null);
        }} />

      {/* what a block would land on, before it is saved */}
      <Sheet visible={!!impact} onClose={() => setImpact(null)} title={t('oav.imp.title')}
        footer={<View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}><Btn title={t('oav.imp.back')} color={c.paper} ink={c.ink} onPress={() => setImpact(null)} /></View>
          <View style={{ flex: 1 }}><Btn title={t('oav.imp.save')} onPress={async () => { const run = impact.run; setImpact(null); try { await run(); } catch { /* already toasted */ } }} /></View>
        </View>}>
        <ScrollView style={{ maxHeight: 420 }}>
          <View style={{ gap: 10 }}>
            <Banner tone={c.sunSoft}>{t('oav.imp.lead', { n: impact?.affected.length ?? 0 })}</Banner>
            {(impact?.affected ?? []).map((a) => (
              <Card key={a.id} pad={12}>
                <View style={{ gap: 4 }}>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={t(`oav.role.${a.role}`)} color={c.violetSoft} /><Tag label={t(a.status === 'accepted' ? 'oav.hold.reserved' : 'oav.hold.tentative')} color={a.status === 'accepted' ? c.mint : c.sun} /></View>
                  <T weight="800">{a.event_name}</T>
                  <T size={12.5} color={c.mute}>{dateTimeIn(a.scheduled_at, tz)} · {t('oav.n_min', { n: a.duration_min })}</T>
                </View>
              </Card>
            ))}
            <T size={12.5} color={c.mute}>{t('oav.imp.hint')}</T>
          </View>
        </ScrollView>
      </Sheet>
    </View>
  );
}
