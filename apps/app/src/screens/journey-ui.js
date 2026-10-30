// Athlete 360 journey (#571): the controls and views that make an athlete's career readable in one place. Every row carries an origin
// (verified / entered by the athlete / external); the same views serve the Athlete 360, the period comparison and the shared portfolio.
// The UI only calls /graph and /passport; filters and figures are decided on the server.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, H2, Loading, Row, T, Tag } from '../ui';
import { DateRangeField, addDays, todayLocal } from '../pickers';
import { MenuField } from '../menu-field';
import { c } from '../theme';

export const ORIGIN = { verified: ['✓ Verified', c.mint], user_entered: ['✎ Entered by athlete', c.sun], external: ['⇄ External', c.violetSoft] };
const day = (s) => (s ? new Date(`${String(s).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** The glyph and the words both say where a row comes from, so colour is never the only signal. */
export const OriginTag = ({ origin }) => (ORIGIN[origin] ? <Tag label={ORIGIN[origin][0]} color={ORIGIN[origin][1]} /> : null);

export function OriginLegend({ origins }) {
  if (!origins) return null;
  return (
    <Card color={c.violetSoft} pad={12}>
      <T size={12} weight="700" color={c.mute}>WHERE A ROW COMES FROM</T>
      <View style={{ gap: 6, marginTop: 6 }}>
        {Object.entries(origins).map(([k, text]) => (
          <View key={k} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}><OriginTag origin={k} /><T size={12} color={c.mute} style={{ flex: 1, minWidth: 200 }}>{text}</T></View>
        ))}
      </View>
    </Card>
  );
}

const cell = { flexGrow: 1, flexBasis: 240 };
const periodOptions = (stints) => [
  ...stints.filter((m) => m.org_season_id).map((m) => ({ value: `season:${m.org_season_id}`, label: `${m.season_label ?? 'Season'} · ${m.club}`, sub: 'Season' })),
  ...stints.map((m) => ({ value: m.id, label: m.club, sub: `${m.sport} · ${m.starts_on?.slice(0, 4)}–${m.current ? 'now' : m.ends_on?.slice(0, 4)}` })),
];
const summary = (f, sports, stints) => [
  f.sport ? sports.find((s) => s.slug === f.sport)?.name : null,
  f.period ? periodOptions(stints).find((o) => o.value === f.period)?.label : null,
  f.from ? `${f.from} → ${f.to}` : null,
].filter(Boolean).join(' · ');
/** Sport, season or club stint, and dates: all optional, all picked (never typed). A stint or season sets the period itself, so choosing one clears the dates and the other way round. Folded away until needed so the records stay in view on a phone. */
export function JourneyFilters({ f, setF, sports, stints }) {
  const [open, setOpen] = useState(false);
  const periods = periodOptions(stints);
  const on = filtered(f);
  return (
    <View style={{ marginTop: 10, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title={open ? 'Hide filters ▲' : 'Filters ▼'} color={c.paper} ink={c.ink} onPress={() => setOpen(!open)} accessibilityLabel={open ? 'Hide the sport, season and date filters' : 'Show the sport, season and date filters'} />
        <T size={13} color={on ? c.ink : c.mute} weight={on ? '700' : '500'} style={{ flex: 1, minWidth: 160 }}>{on ? summary(f, sports, stints) : 'Whole career · all sports'}</T>
        {on ? <Btn small title="Clear" color={c.paper} ink={c.ink} onPress={() => setF({ sport: '', period: '' })} accessibilityLabel="Clear all filters" /> : null}
      </View>
      {open ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <View style={cell}><MenuField label="Sport" title="Sport" value={f.sport} placeholder="All sports" options={[{ value: '', label: 'All sports' }, ...sports.map((s) => ({ value: s.slug, label: s.name }))]} onChange={(sport) => setF({ ...f, sport })} /></View>
          {periods.length ? <View style={cell}><MenuField label="Season or club stint" title="Season or club stint" value={f.period} placeholder="Whole career" options={[{ value: '', label: 'Whole career' }, ...periods]} onChange={(period) => setF({ ...f, period, from: undefined, to: undefined })} /></View> : null}
          <View style={cell}><DateRangeField label="Dates" optional from={f.from} to={f.to} onChange={({ from, to }) => setF({ ...f, from, to, period: '' })} /></View>
        </View>
      ) : null}
    </View>
  );
}

/** API parameters for the current filters. */
export function filterQuery(f) {
  return {
    sport: f.sport || undefined, from: f.from, to: f.to,
    membership_id: f.period && !f.period.startsWith('season:') ? f.period : undefined,
    season_id: f.period?.startsWith('season:') ? f.period.slice(7) : undefined,
  };
}
export const filtered = (f) => !!(f.sport || f.period || f.from);

// ------------------------------------------------------------------ comparison
const PERIOD_KEYS = ['from', 'to', 'membership_id', 'season_id'];
const blank = { period: '' };
const params = (p, prefix) => ({ ...Object.fromEntries(PERIOD_KEYS.map((k) => [`${prefix}_${k}`, filterQuery(p)[k]])) });
const ready = (p) => !!((p.from && p.to) || p.period);
const arrow = (n) => (n > 0 ? `▲ +${n}` : n < 0 ? `▼ −${Math.abs(n)}` : '= no change');

function PeriodPick({ title, p, setP, stints }) {
  const options = periodOptions(stints);
  return (
    <Card pad={14} style={{ flexGrow: 1, flexBasis: 280 }}>
      <H2>{title}</H2>
      <View style={{ gap: 10, marginTop: 8 }}>
        {options.length ? <MenuField label="Season or club stint" title={`${title}: season or club stint`} value={p.period} placeholder="Pick a stint or season" options={[{ value: '', label: 'Choose dates instead' }, ...options]} onChange={(period) => setP({ period, from: undefined, to: undefined })} /> : null}
        <DateRangeField label="Dates" optional from={p.from} to={p.to} onChange={({ from, to }) => setP({ from, to, period: '' })} />
      </View>
    </Card>
  );
}

/** Two development periods side by side. Nothing is pre-filled with example values: the quick pick uses today's date. */
export function JourneyCompare({ id, stints, sport }) {
  const [a, setA] = useState(blank);
  const [b, setB] = useState(blank);
  const go = ready(a) && ready(b);
  const key = JSON.stringify([a, b, sport]);
  const r = useLoad(() => (go ? api.get(`/graph/athletes/${id}/compare`, { sport: sport || undefined, ...params(a, 'a'), ...params(b, 'b') }) : Promise.resolve(null)), [id, key]);
  const quick = () => { const t = todayLocal(); const y = addDays(t, -365); setB({ from: y, to: t, period: '' }); setA({ from: addDays(y, -366), to: addDays(y, -1), period: '' }); };
  const d = r.data;
  return (
    <View style={{ gap: 12 }}>
      <T size={13} color={c.mute}>Pick any two periods of this athlete's career: seasons, club stints or dates.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <PeriodPick title="Period A" p={a} setP={setA} stints={stints} />
        <PeriodPick title="Period B" p={b} setP={setB} stints={stints} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="Last 12 months vs the year before" color={c.paper} ink={c.ink} onPress={quick} accessibilityLabel="Compare the last 12 months with the 12 months before" />
        {go ? <Btn small title="Swap A and B" color={c.paper} ink={c.ink} onPress={() => { setA(b); setB(a); }} accessibilityLabel="Swap period A and period B" /> : null}
      </View>
      {!go ? <Empty emoji="⚖️" title="Choose two periods" sub="Both need a season, a club stint or a start and end date." />
        : r.loading && !d ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : d ? (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {['a', 'b'].map((k) => (
                <Card key={k} pad={12} style={{ flexGrow: 1, flexBasis: 240 }}>
                  <T weight="800">Period {k.toUpperCase()}{d.periods[k].label ? ` · ${d.periods[k].label}` : ''}</T>
                  <T size={13} color={c.mute}>{day(d.periods[k].from)} – {day(d.periods[k].to)}{d.periods[k].sport ? ` · ${d.periods[k].sport}` : ''}</T>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    <T size={12} color={c.mute}>{d.periods[k].rows} records</T>
                    {Object.entries(d.periods[k].by_origin).filter(([, n]) => n).map(([o, n]) => <Tag key={o} label={`${n} ${ORIGIN[o][0].slice(2).toLowerCase()}`} color={ORIGIN[o][1]} />)}
                  </View>
                </Card>
              ))}
            </View>
            {d.metrics.map((m) => (
              <Row key={m.key} title={m.label} sub={`A ${m.a}${m.unit ? ` ${m.unit}` : ''} · B ${m.b}${m.unit ? ` ${m.unit}` : ''}`}
                right={<View style={{ alignItems: 'flex-end' }}><T weight="800" color={m.change > 0 ? c.mint : m.change < 0 ? c.sun : c.mute}>{arrow(m.change)}</T>{m.change_pct !== null ? <T size={12} color={c.mute}>{m.change_pct > 0 ? '+' : ''}{m.change_pct}%</T> : null}</View>} />
            ))}
            {d.hidden_domains.length ? <T size={12} color={c.mute}>🔒 Not shown to you: {d.hidden_domains.join(', ')}</T> : null}
            <T size={12} color={c.mute}>{d.note}</T>
            <OriginLegend origins={d.origins} />
          </View>
        ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ portfolio (the passport's journey section)
export function PortfolioJourney({ journey }) {
  if (!journey) return null;
  return (
    <Card pad={16}>
      <H2>Career & development timeline</H2>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        {Object.entries(journey.by_origin).filter(([, n]) => n).map(([o, n]) => <Tag key={o} label={`${n} ${ORIGIN[o][0].slice(2).toLowerCase()}`} color={ORIGIN[o][1]} />)}
      </View>
      {journey.items.length ? journey.items.map((it, i) => (
        <View key={`${it.domain}${it.at}${it.type}${i}`} style={{ marginTop: 12, gap: 4 }}>
          <T weight="700">{it.title}</T>
          <T size={13} color={c.mute}>{[day(it.at), it.summary].filter(Boolean).join(' · ')}</T>
          <View style={{ alignSelf: 'flex-start' }}><OriginTag origin={it.origin} /></View>
        </View>
      )) : <T size={13} color={c.mute} style={{ marginTop: 8 }}>Nothing recorded yet.</T>}
      <View style={{ marginTop: 12 }}><OriginLegend origins={journey.origins} /></View>
    </Card>
  );
}
