// Analytics (#596): the one home for governed cross-domain KPIs. Explore a metric for any scope you may read, drill down to the source records,
// build and share dashboards, export (CSV / XLSX / branded PDF) and schedule reports. Every number comes from the server's semantic layer, which
// decides what you may see and states the definition version, freshness and data-quality warnings, so this screen never computes or hard-codes a figure.
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { DateRangeField } from '../pickers';
import { EntityPicker } from '../entity-picker';
import { SportsMulti, useSports } from '../sportpicker';
import { saveExport } from '../open-file';

const PRESETS = [{ value: 'last_7', label: '7 days' }, { value: 'last_30', label: '30 days' }, { value: 'last_90', label: '90 days' }, { value: 'year_to_date', label: 'This year' }, { value: 'custom', label: 'Pick dates' }];
const CADENCE = [{ value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }];
const FORMATS = [{ value: 'pdf', label: 'PDF' }, { value: 'xlsx', label: 'XLSX' }, { value: 'csv', label: 'CSV' }];
const DIM = { sport: 'Sport', event: 'Event', venue: 'Venue', team: 'Team', month: 'Month', channel: 'Channel' };
const SHARE = [{ value: 'private', label: 'Only me' }, { value: 'organisation', label: 'An organisation' }, { value: 'roles', label: 'Roles' }];
const ROLE_CHOICES = ['organizer', 'venue_manager', 'coach', 'sponsor', 'referee', 'physio'];
const FRESH = { current: [c.lime, 'Current'], stale: [c.sunSoft, 'Stale'], no_records: [c.paper, 'No records'] };
const SCOPE_WORD = { platform: 'Platform', organisation: 'Organisation', venue: 'Venue', event: 'Event', team: 'Team', sponsor: 'Brand' };

const money = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
/** The headline text(s) of a result or group: money is one line per currency, never summed. */
export const headline = (r) => {
  if (r.unit === 'money') return r.amounts?.length ? r.amounts.map((a) => money(a.cents, a.currency)) : ['0'];
  if (r.unit === 'percent') return [r.suppressed ? 'Hidden' : r.value == null ? '—' : `${r.value}%`];
  return [String(r.value ?? 0)];
};
const toneOf = (w) => (w.severity === 'warn' ? c.sunSoft : c.paper);

const Banner = ({ tone = c.sunSoft, children, action, onAction }) => (
  <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <T size={13} style={{ flex: 1 }}>{children}</T>
    {action ? <Btn small title={action} color={c.paper} ink={c.ink} onPress={onAction} /> : null}
  </View>
);
const Wrap = ({ children, gap = 8 }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>{children}</View>;

/** Freshness per source plus every data-quality warning, in plain words. */
function Quality({ result }) {
  const bad = result.sources.filter((s) => s.status !== 'current');
  return (
    <View style={{ gap: 8 }}>
      {result.warnings.map((w) => <View key={w.code} accessibilityRole="alert" style={{ backgroundColor: toneOf(w), borderRadius: 12, padding: 10 }}><T size={12}>{w.severity === 'warn' ? '⚠️ ' : 'ℹ️ '}{w.text}</T></View>)}
      <Wrap gap={6}>{result.sources.map((s) => <Tag key={s.key} label={`${s.label}: ${FRESH[s.status][1]}${s.latest_at ? ` · ${String(s.latest_at).slice(0, 10)}` : ''}`} color={FRESH[s.status][0]} />)}</Wrap>
      {!bad.length && !result.warnings.length ? <T size={12} color={c.mute}>All sources are current and no data-quality issues were found.</T> : null}
    </View>
  );
}

/** Definition, version history and provenance: where the number comes from. */
function DefinitionSheet({ metricKey, onClose }) {
  const d = useLoad(() => (metricKey ? api.get(`/analytics/metrics/${metricKey}`) : Promise.resolve(null)), [metricKey]);
  const m = d.data;
  return (
    <Sheet visible={!!metricKey} onClose={onClose} title={m?.label ?? 'Definition'}>
      {d.loading && !m ? <Loading /> : m ? (
        <View style={{ gap: 10 }}>
          <T size={13}>{m.formula}</T>
          <Wrap><Tag label={`Version ${m.version}`} /><Tag label={`Owner: ${m.owner}`} color={c.paper} /><Tag label={m.domain} color={c.paper} /></Wrap>
          <T size={12} color={c.mute}>Sources: {m.provenance.map((p) => p.label).join(' · ')}</T>
          <T size={12} color={c.mute}>Can be split by: {m.dimensions.map((x) => DIM[x]).join(', ')}. Reported for: {m.scopes.map((x) => SCOPE_WORD[x]).join(', ')}.</T>
          {m.quality_checks.length ? <T size={12} color={c.mute}>Checked for: {m.quality_checks.map((q2) => q2.text).join('; ')}.</T> : null}
          <T size={11} color={c.mute} selectable>Definition fingerprint {m.definition_hash.slice(0, 16)}</T>
          <T weight="800" size={13}>Version history</T>
          {m.versions.map((v) => <T key={v.version} size={12} color={c.mute}>v{v.version} · {String(v.published_at).slice(0, 10)} · {v.change_note ?? ''}</T>)}
        </View>) : null}
    </Sheet>
  );
}

/** The records a number is made of, from the same facts as the number. */
function RecordsSheet({ open, onClose, metric, query, group }) {
  const { push } = useNav();
  const [offset, setOffset] = useState(0);
  const PAGE = 15;
  useEffect(() => { setOffset(0); }, [open, metric, JSON.stringify(query), group?.key]);
  const r = useLoad(() => (open ? api.get(`/analytics/metrics/${metric}/records`, { ...query, ...(group ? { group_by: query.group_by, group_key: group.key ?? '' } : { group_by: undefined }), limit: PAGE, offset }) : Promise.resolve(null)), [open, metric, JSON.stringify(query), group?.key, offset]);
  const d = r.data;
  return (
    <Sheet visible={open} onClose={onClose} title={group ? `Records · ${group.label}` : 'Records behind this number'}>
      {r.error ? <LoadError error={r.error} onRetry={r.reload} /> : r.loading && !d ? <Loading /> : d ? (
        <View style={{ gap: 10 }}>
          <T size={12} color={c.mute}>{d.total_records} records{d.reconciles_to.distinct_subjects !== undefined ? ` for ${d.reconciles_to.distinct_subjects} distinct` : ''} · these reconcile to the figure{d.reconciles_to.amounts ? `: ${d.reconciles_to.amounts.map((a) => money(a.cents, a.currency)).join(' · ')}` : d.reconciles_to.value != null ? `: ${d.reconciles_to.value}%` : ''}. Opening this list is logged.</T>
          {!d.records.length ? <Empty emoji="🔎" title="No records" sub="Nothing falls in this scope and period." /> : d.records.map((x, i) => (
            <Card key={`${x.rec_id}-${i}`} color={c.paper} accessibilityLabel={`${x.label}, ${String(x.at).slice(0, 10)}`}>
              <View style={{ gap: 4 }}>
                <T weight="800" size={14}>{x.label}</T>
                <Wrap gap={6}>
                  <Tag label={String(x.at).slice(0, 10)} color={c.paper} />
                  {x.currency ? <Tag label={money(Number(x.amount), x.currency)} /> : null}
                  {x.den != null ? <Tag label={`${Math.round(x.num)} of ${Math.round(x.den)}`} /> : null}
                  {x.channel ? <Tag label={x.channel.replace(/_/g, ' ')} color={c.paper} /> : null}
                  {x.flag_text ? <Tag label={x.flag_text} color={c.sunSoft} /> : null}
                </Wrap>
                {x.link_kind && x.link_id ? <Btn small title="Open the source record" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => { onClose(); push(x.link_kind, { id: x.link_id }); }} /> : null}
              </View>
            </Card>))}
          {d.total_records > PAGE ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Btn small title="Previous" color={c.paper} ink={c.ink} disabled={offset === 0 || r.loading} onPress={() => setOffset(Math.max(0, offset - PAGE))} />
              <T size={12} color={c.mute}>{offset + 1}–{Math.min(offset + PAGE, d.total_records)} of {d.total_records}</T>
              <Btn small title="Next" color={c.paper} ink={c.ink} disabled={offset + PAGE >= d.total_records || r.loading} onPress={() => setOffset(offset + PAGE)} />
            </View>) : null}
        </View>) : null}
    </Sheet>
  );
}

const scopePick = (scopes, value, onChange, label = 'What to report on') => (
  <EntityPicker label={label} noun="organisation, venue, event, team or brand" value={value} onChange={(v) => onChange(v.slice(-1))} options={scopes.map((s) => ({ id: `${s.type}:${s.id ?? ''}`, label: s.label, sub: s.sub, emoji: undefined }))} />
);
const scopeOf = (scopes, picked) => scopes.find((s) => `${s.type}:${s.id ?? ''}` === picked[0]?.id);

// ------------------------------------------------------------------ Explore
function Explore({ scopes, metrics, dashboards, onSaved }) {
  const { toast } = useSession();
  const sports = useSports();
  const [picked, setPicked] = useState([]);
  const [key, setKey] = useState(null);
  const [preset, setPreset] = useState('last_30');
  const [range, setRange] = useState({});
  const [sportSlugs, setSportSlugs] = useState([]);
  const [groupBy, setGroupBy] = useState(null);
  const [sheet, setSheet] = useState(null); // 'def' | 'records' | 'add'
  const [group, setGroup] = useState(null);
  const [busy, setBusy] = useState(false);
  const scope = scopeOf(scopes, picked);
  useEffect(() => { if (!picked.length && scopes.length) setPicked([{ id: `${scopes[0].type}:${scopes[0].id ?? ''}`, label: scopes[0].label }]); }, [scopes.length]);
  const usable = metrics.filter((m) => !scope || m.scopes.includes(scope.type));
  useEffect(() => { if (usable.length && !usable.some((m) => m.key === key)) setKey(usable[0].key); }, [scope?.type, scopes.length, metrics.length]);
  const metric = metrics.find((m) => m.key === key);
  useEffect(() => { if (groupBy && metric && !metric.dimensions.includes(groupBy)) setGroupBy(null); }, [key]);
  const sportIds = sportSlugs.map((slug) => (sports.data ?? []).find((x) => x.slug === slug)?.id).filter(Boolean);
  const ready = scope && metric && (preset !== 'custom' || (range.from && range.to));
  const query = useMemo(() => ({ scope_type: scope?.type, scope_id: scope?.id ?? undefined, preset, ...(preset === 'custom' ? { from: range.from, to: range.to } : {}), ...(sportIds.length ? { sport_ids: sportIds.join(',') } : {}), ...(groupBy ? { group_by: groupBy } : {}) }), [scope?.type, scope?.id, preset, range.from, range.to, sportIds.join(','), groupBy]);
  const res = useLoad(() => (ready ? api.get(`/analytics/metrics/${key}/value`, query) : Promise.resolve(null)), [key, JSON.stringify(query), ready]);
  const r = res.data;
  const exportAs = async (format) => {
    setBusy(true);
    try { await saveExport(await api.get('/analytics/export', { key, ...query, format })); toast(`Exported as ${format.toUpperCase()}`); } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  if (!scopes.length) return <Empty emoji="📊" title="Nothing to report on yet" sub="Analytics appears for organisations, venues, events, teams and brands you run or hold a role in. Once you do, pick one here." />;
  return (
    <View style={{ gap: 14 }}>
      {scopePick(scopes, picked, (v) => { setPicked(v); setGroupBy(null); })}
      <View style={{ gap: 6 }}>
        <T weight="600" size={12} color={c.mute}>METRIC</T>
        <Wrap>{usable.map((m) => <Chip key={m.key} label={m.label} active={m.key === key} onPress={() => setKey(m.key)} />)}</Wrap>
        {scope && usable.length < metrics.length ? <T size={11} color={c.mute}>{metrics.length - usable.length} metrics are not reported for a {SCOPE_WORD[scope.type].toLowerCase()} and are hidden.</T> : null}
      </View>
      {metric && !metric.point_in_time ? (
        <View style={{ gap: 8 }}>
          <T weight="600" size={12} color={c.mute}>PERIOD</T>
          <Wrap>{PRESETS.map((p) => <Chip key={p.value} label={p.label} active={preset === p.value} onPress={() => setPreset(p.value)} />)}</Wrap>
          {preset === 'custom' ? <DateRangeField label="Between" from={range.from} to={range.to} onChange={setRange} /> : null}
        </View>) : metric ? <T size={12} color={c.mute}>{metric.label} is a position as of now, so no period applies.</T> : null}
      {metric?.dimensions.includes('sport') ? <SportsMulti label="Sports" optional value={sportSlugs} onChange={setSportSlugs} /> : null}
      {metric ? (
        <View style={{ gap: 6 }}>
          <T weight="600" size={12} color={c.mute}>SPLIT BY</T>
          <Wrap><Chip label="Nothing" active={!groupBy} onPress={() => setGroupBy(null)} />{metric.dimensions.map((dm) => <Chip key={dm} label={DIM[dm]} active={groupBy === dm} onPress={() => setGroupBy(dm)} />)}</Wrap>
        </View>) : null}

      {res.error ? <LoadError error={res.error} onRetry={res.reload} /> : res.loading && !r ? <Loading /> : r ? (
        <View style={{ gap: 12 }}>
          <Card color={c.paper} accessibilityLabel={`${r.definition.label}: ${headline(r).join(', ')}`}>
            <View style={{ gap: 6 }}>
              <T size={12} color={c.mute}>{r.definition.label} · {r.scope.label} · {r.definition.point_in_time ? 'as of now' : `${r.range.from} to ${r.range.to}`}</T>
              {headline(r).map((h) => <T key={h} size={34} weight="800" style={{ letterSpacing: -1 }}>{h}</T>)}
              {r.unit === 'percent' && r.denominator ? <T size={12} color={c.mute}>{Math.round(r.numerator)} of {Math.round(r.denominator)}</T> : null}
              <T size={11} color={c.mute} selectable>Definition v{r.definition.version} · ref {r.reference} · computed {new Date(r.computed_at).toLocaleTimeString()}</T>
              <Wrap>
                <Btn small title="How it is defined" color={c.paper} ink={c.ink} onPress={() => setSheet('def')} />
                {r.definition.drilldown ? <Btn small title="Records behind it" color={c.violet} onPress={() => { setGroup(null); setSheet('records'); }} /> : null}
                <Btn small title="Refresh" color={c.paper} ink={c.ink} onPress={res.reload} />
              </Wrap>
            </View>
          </Card>
          <Quality result={r} />
          {r.groups ? (
            <Section title={`By ${DIM[r.group_by].toLowerCase()}`} color={c.cyan}>
              {!r.groups.length ? <T size={12} color={c.mute}>No groups in this period.</T> : r.groups.map((g) => (
                <Card key={String(g.key)} color={c.paper} onPress={r.definition.drilldown ? () => { setGroup({ key: g.key, label: g.label }); setSheet('records'); } : undefined} accessibilityLabel={`${g.label}: ${headline({ ...g, unit: r.unit }).join(', ')}`}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <T weight="700" style={{ flex: 1 }}>{g.label}</T>
                    <View style={{ alignItems: 'flex-end' }}>{headline({ ...g, unit: r.unit }).map((h) => <T key={h} weight="800">{h}</T>)}</View>
                  </View>
                </Card>))}
            </Section>) : null}
          <Section title="Export and share" color={c.violet}>
            <T size={12} color={c.mute}>Built from exactly this result, under your current role.</T>
            <Wrap>
              {FORMATS.map((f) => <Btn key={f.value} small title={f.label} color={c.violet} loading={busy} onPress={() => exportAs(f.value)} />)}
              <Btn small title="Add to a dashboard" color={c.pink} onPress={() => setSheet('add')} />
            </Wrap>
          </Section>
        </View>) : metric && scope ? null : <Empty emoji="🧭" title="Pick what to report on" sub="Choose a scope and a metric above." />}

      <DefinitionSheet metricKey={sheet === 'def' ? key : null} onClose={() => setSheet(null)} />
      <RecordsSheet open={sheet === 'records'} onClose={() => setSheet(null)} metric={key} query={query} group={group} />
      <AddTileSheet open={sheet === 'add'} onClose={() => setSheet(null)} dashboards={dashboards.filter((d) => d.mine)} tile={ready ? { metric: key, scope_type: scope.type, scope_id: scope.id ?? undefined, group_by: groupBy ?? undefined } : null} period={{ preset, range }} sportIds={sportIds} onSaved={() => { setSheet(null); onSaved(); }} />
    </View>
  );
}

/** Put the tile you are looking at on one of your dashboards, or start a new one with it. */
function AddTileSheet({ open, onClose, dashboards, tile, period, sportIds, onSaved }) {
  const { toast } = useSession();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async (d) => {
    setBusy(true);
    try {
      if (d) {
        const full = await api.get(`/analytics/dashboards/${d.id}`);
        await api.patch(`/analytics/dashboards/${d.id}`, { row_version: full.dashboard.row_version, widgets: [...full.dashboard.widgets, tile] });
      } else {
        await api.post('/analytics/dashboards', { title: title.trim(), range_preset: period.preset, ...(period.preset === 'custom' ? { range_from: period.range.from, range_to: period.range.to } : {}), sport_ids: sportIds, widgets: [tile] });
      }
      toast('Added to the dashboard'); setTitle(''); onSaved();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={open} onClose={onClose} title="Add to a dashboard">
      <View style={{ gap: 10 }}>
        {dashboards.map((d) => <Card key={d.id} color={c.paper} onPress={() => add(d)} accessibilityLabel={`Add to ${d.title}`}><T weight="700">{d.title}</T><T size={12} color={c.mute}>{d.tile_count} tiles</T></Card>)}
        <T weight="800" size={13}>Or start a new dashboard</T>
        <Field label="Title" value={title} onChangeText={setTitle} maxLength={80} />
        <Btn title="Create with this tile" disabled={title.trim().length < 1} loading={busy} onPress={() => add(null)} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Dashboards
function TileCard({ t, width }) {
  const [sheet, setSheet] = useState(null);
  const w = t.widget;
  if (!t.result) {
    return (
      <View style={{ width, padding: 6 }}><Card color={c.paper} accessibilityLabel={`${w.title ?? w.metric}: not available to you`}>
        <T weight="800" size={13}>{w.title ?? w.metric.replace(/_/g, ' ')}</T>
        <T size={12} color={c.mute}>🔒 {t.error.message}</T>
      </Card></View>
    );
  }
  const r = t.result;
  const hot = r.warnings.filter((x) => x.severity === 'warn').length + r.sources.filter((s) => s.status === 'stale').length;
  return (
    <View style={{ width, padding: 6 }}>
      <Card color={c.paper} onPress={() => setSheet('def')} accessibilityLabel={`${w.title ?? r.definition.label}, ${r.scope.label}: ${headline(r).join(', ')}. Open definition`}>
        <View style={{ gap: 4 }}>
          <T size={12} color={c.mute}>{w.title ?? r.definition.label}</T>
          {headline(r).map((h) => <T key={h} size={26} weight="800" style={{ letterSpacing: -0.6 }}>{h}</T>)}
          <T size={11} color={c.mute}>{r.scope.label} · {r.definition.point_in_time ? 'as of now' : `${r.range.from} → ${r.range.to}`}</T>
          {r.groups?.slice(0, 3).map((g) => <T key={String(g.key)} size={12}>{g.label}: {headline({ ...g, unit: r.unit }).join(' · ')}</T>)}
          <Wrap gap={6}>{hot ? <Tag label={`${hot} to check`} color={c.sunSoft} /> : <Tag label="Clean" color={c.lime} />}<Tag label={`v${r.definition.version}`} color={c.paper} /></Wrap>
        </View>
      </Card>
      <DefinitionSheet metricKey={sheet === 'def' ? w.metric : null} onClose={() => setSheet(null)} />
    </View>
  );
}

function DashboardView({ id, asOf, onBack, scopes, onChanged }) {
  const { toast } = useSession();
  const L = useLayout();
  const d = useLoad(() => api.get(`/analytics/dashboards/${id}`, asOf ? { as_of: asOf } : {}), [id, asOf]);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(false);
  const x = d.data;
  const cols = L.width >= 1000 ? 3 : L.tablet ? 2 : 1;
  const tileWidth = `${100 / cols}%`;
  const exportAs = async (format) => {
    setBusy(true);
    try { await saveExport(await api.get('/analytics/export', { dashboard_id: id, format, ...(asOf ? { as_of: asOf } : {}) })); toast(`Exported as ${format.toUpperCase()}`); } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  if (d.error) return <View style={{ gap: 10 }}><Btn small title="‹ Dashboards" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} /><LoadError error={d.error} onRetry={d.reload} /></View>;
  if (!x) return <Loading />;
  const dash = x.dashboard;
  return (
    <View style={{ gap: 12 }}>
      <Btn small title="‹ Dashboards" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <View style={{ gap: 4 }}>
        <T size={22} weight="800">{dash.title}</T>
        <T size={12} color={c.mute}>{dash.visibility === 'private' ? 'Private' : dash.visibility === 'organisation' ? 'Shared with an organisation' : `Shared with ${dash.roles.join(', ')}`}{dash.mine ? ' · yours' : ' · shared with you'} · {PRESETS.find((p) => p.value === dash.range_preset)?.label}{asOf ? ` · as of ${asOf}` : ''}</T>
      </View>
      {x.quality.hidden ? <Banner tone={c.paper}>{x.quality.hidden} {x.quality.hidden === 1 ? 'tile is' : 'tiles are'} hidden because your role cannot read {x.quality.hidden === 1 ? 'its' : 'their'} scope. Nobody else’s numbers are shown in their place.</Banner> : null}
      {!x.quality.clean && x.quality.readable ? <Banner>{x.quality.warnings} data-quality {x.quality.warnings === 1 ? 'warning' : 'warnings'} and {x.quality.stale_sources} stale {x.quality.stale_sources === 1 ? 'source' : 'sources'} across these tiles. Open a tile to see them.</Banner> : null}
      {!dash.widgets.length ? <Empty emoji="🧩" title="No tiles yet" sub="Open Explore, pick a metric and choose “Add to a dashboard”." /> : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 }}>{x.tiles.map((t) => <TileCard key={t.widget.id} t={t} width={tileWidth} />)}</View>)}
      <Section title="Export and deliver" color={c.violet}>
        <Wrap>
          {FORMATS.map((f) => <Btn key={f.value} small title={f.label} color={c.violet} loading={busy} onPress={() => exportAs(f.value)} />)}
          {dash.mine ? <Btn small title="Schedule delivery" color={c.pink} onPress={() => setSheet('schedule')} /> : null}
          {dash.mine ? <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setSheet('edit')} /> : null}
          {dash.mine ? <Btn small title="Archive" color={c.paper} ink={c.ink} onPress={async () => { try { await api.post(`/analytics/dashboards/${id}/archive`, {}); toast('Dashboard archived'); onChanged(); onBack(); } catch (e) { toast(explain(e)); } }} /> : null}
          <Btn small title="Refresh" color={c.paper} ink={c.ink} onPress={d.reload} />
        </Wrap>
      </Section>
      <ScheduleSheet open={sheet === 'schedule'} onClose={() => setSheet(null)} dashboardId={id} onSaved={() => { setSheet(null); onChanged(); }} />
      <DashboardForm open={sheet === 'edit'} onClose={() => setSheet(null)} scopes={scopes} existing={dash} onSaved={() => { setSheet(null); d.reload(); onChanged(); }} />
    </View>
  );
}

function ScheduleSheet({ open, onClose, dashboardId, onSaved }) {
  const { toast, user } = useSession();
  const [cadence, setCadence] = useState('weekly');
  const [format, setFormat] = useState('pdf');
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.post('/analytics/schedules', { dashboard_id: dashboardId, cadence, format, recipient_ids: [user.id, ...people.map((p) => p.id)] }); toast('Delivery scheduled'); onSaved(); } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={open} onClose={onClose} title="Schedule delivery">
      <View style={{ gap: 12 }}>
        <T size={12} color={c.mute}>Each person is notified (no figures in the message) and opens the report with their own access at that moment. They must be able to open this dashboard, so share it with them first.</T>
        <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>HOW OFTEN</T><Seg options={CADENCE} value={cadence} onChange={setCadence} /></View>
        <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>FILE FORMAT</T><Seg options={FORMATS} value={format} onChange={setFormat} /></View>
        <EntityPicker label="Also send to" multi optional value={people} onChange={setPeople} />
        <Btn title="Start delivering tomorrow" loading={busy} onPress={save} />
      </View>
    </Sheet>
  );
}

/** Create or edit a dashboard: title, who can open it, the period, sports and tiles. */
function DashboardForm({ open, onClose, scopes, existing, onSaved }) {
  const { toast } = useSession();
  const metrics = useLoad(() => api.get('/analytics/metrics'), []);
  const sports = useSports();
  const orgs = scopes.filter((s) => s.type === 'organisation');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [visibility, setVisibility] = useState(existing?.visibility ?? 'private');
  const [org, setOrg] = useState(existing?.organisation_id ? orgs.filter((o) => o.id === existing.organisation_id).map((o) => ({ id: o.id, label: o.label })) : []);
  const [roles, setRoles] = useState(existing?.roles ?? []);
  const [preset, setPreset] = useState(existing?.range_preset ?? 'last_30');
  const [range, setRange] = useState(existing?.range_from ? { from: existing.range_from, to: existing.range_to } : {});
  const [slugs, setSlugs] = useState((existing?.sport_ids ?? []).map((i) => (sports.data ?? []).find((x) => x.id === i)?.slug).filter(Boolean));
  const [tiles, setTiles] = useState(existing?.widgets ?? []);
  const [mKey, setMKey] = useState(null);
  const [tScope, setTScope] = useState([]);
  const [busy, setBusy] = useState(false);
  const sc = scopeOf(scopes, tScope);
  const usable = (metrics.data ?? []).filter((m) => !sc || m.scopes.includes(sc.type));
  const label = (k) => (metrics.data ?? []).find((m) => m.key === k)?.label ?? k;
  const addTile = () => { setTiles([...tiles, { id: Math.random().toString(36).slice(2, 10), metric: mKey, scope_type: sc.type, scope_id: sc.id ?? undefined }]); setMKey(null); };
  const save = async () => {
    setBusy(true);
    try {
      const body = { title: title.trim(), visibility, organisation_id: visibility === 'organisation' ? org[0]?.id : undefined, roles: visibility === 'roles' ? roles : [], range_preset: preset,
        ...(preset === 'custom' ? { range_from: range.from, range_to: range.to } : {}), sport_ids: slugs.map((s) => (sports.data ?? []).find((x) => x.slug === s)?.id).filter(Boolean), widgets: tiles.map((t) => ({ ...t, scope_id: t.scope_id ?? undefined, group_by: t.group_by ?? undefined, title: t.title ?? undefined })) };
      if (existing) await api.patch(`/analytics/dashboards/${existing.id}`, { ...body, row_version: existing.row_version }); else await api.post('/analytics/dashboards', body);
      toast('Dashboard saved'); onSaved();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const ok = title.trim() && (visibility !== 'organisation' || org.length) && (visibility !== 'roles' || roles.length) && (preset !== 'custom' || (range.from && range.to));
  return (
    <Sheet visible={open} onClose={onClose} title={existing ? 'Edit dashboard' : 'New dashboard'}>
      <View style={{ gap: 14 }}>
        <Field label="Title" value={title} onChangeText={setTitle} maxLength={80} />
        <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>WHO CAN OPEN IT</T><Seg options={SHARE} value={visibility} onChange={setVisibility} />
          <T size={11} color={c.mute}>Sharing shares the recipe, not the numbers: everyone sees only what their own role allows.</T></View>
        {visibility === 'organisation' ? <EntityPicker label="Organisation" noun="organisation" value={org} onChange={(v) => setOrg(v.slice(-1))} options={orgs.map((o) => ({ id: o.id, label: o.label, sub: o.sub }))} /> : null}
        {visibility === 'roles' ? <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>ROLES</T><Wrap>{ROLE_CHOICES.map((r) => <Chip key={r} label={r.replace('_', ' ')} active={roles.includes(r)} onPress={() => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])} />)}</Wrap></View> : null}
        <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>PERIOD FOR EVERY TILE</T><Wrap>{PRESETS.map((p) => <Chip key={p.value} label={p.label} active={preset === p.value} onPress={() => setPreset(p.value)} />)}</Wrap>
          {preset === 'custom' ? <DateRangeField label="Between" from={range.from} to={range.to} onChange={setRange} /> : null}</View>
        <SportsMulti label="Sports" optional value={slugs} onChange={setSlugs} />
        <View style={{ gap: 8 }}>
          <T weight="800" size={14}>Tiles ({tiles.length}/12)</T>
          {tiles.map((t) => <Card key={t.id} color={c.paper}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ flex: 1 }}><T weight="700">{label(t.metric)}</T><T size={12} color={c.mute}>{scopes.find((s) => s.type === t.scope_type && (s.id ?? null) === (t.scope_id ?? null))?.label ?? SCOPE_WORD[t.scope_type]}{t.group_by ? ` · by ${DIM[t.group_by].toLowerCase()}` : ''}</T></View>
            <Btn small title="Remove" color={c.paper} ink={c.ink} onPress={() => setTiles(tiles.filter((x) => x.id !== t.id))} /></View></Card>)}
          {tiles.length < 12 ? (
            <Card color={c.paper}><View style={{ gap: 10 }}>
              <T weight="700" size={13}>Add a tile</T>
              {scopePick(scopes, tScope, (v) => { setTScope(v); setMKey(null); }, 'Scope')}
              <Wrap>{usable.map((m) => <Chip key={m.key} label={m.label} active={mKey === m.key} onPress={() => setMKey(m.key)} />)}</Wrap>
              <Btn small title="Add tile" disabled={!mKey || !sc} onPress={addTile} />
            </View></Card>) : null}
        </View>
        <Btn title={existing ? 'Save changes' : 'Create dashboard'} disabled={!ok} loading={busy} onPress={save} />
      </View>
    </Sheet>
  );
}

function Dashboards({ scopes, dashboards, reload, openId, setOpenId }) {
  const [form, setForm] = useState(false);
  if (openId) return <DashboardView id={openId} scopes={scopes} onBack={() => setOpenId(null)} onChanged={reload} />;
  return (
    <View style={{ gap: 12 }}>
      <Btn title="New dashboard" color={c.pink} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {!dashboards.length ? <Empty emoji="🧩" title="No dashboards yet" sub="Build one from the metrics you can read, share it with an organisation or role, and schedule it." /> : dashboards.map((d) => (
        <Card key={d.id} color={c.paper} onPress={() => setOpenId(d.id)} accessibilityLabel={`Open dashboard ${d.title}`}>
          <View style={{ gap: 4 }}>
            <T weight="800" size={16}>{d.title}</T>
            <Wrap gap={6}><Tag label={`${d.tile_count} tiles`} color={c.paper} /><Tag label={d.mine ? 'Yours' : 'Shared with you'} color={d.mine ? c.violetSoft : c.lime} /><Tag label={d.visibility === 'private' ? 'Private' : d.visibility === 'organisation' ? 'Organisation' : 'Roles'} color={c.paper} /></Wrap>
          </View>
        </Card>))}
      <DashboardForm open={form} onClose={() => setForm(false)} scopes={scopes} onSaved={() => { setForm(false); reload(); }} />
    </View>
  );
}

// ------------------------------------------------------------------ Reports
function Reports({ openRun, setOpenRun, scopes }) {
  const { toast } = useSession();
  const runs = useLoad(() => api.get('/analytics/runs', { limit: 25 }), []);
  const schedules = useLoad(() => api.get('/analytics/schedules', { limit: 50 }), []);
  if (openRun) return <RunView id={openRun} onBack={() => setOpenRun(null)} scopes={scopes} />;
  const act = async (s, body) => { try { await api.patch(`/analytics/schedules/${s.id}`, { row_version: s.row_version, ...body }); schedules.reload(); } catch (e) { toast(explain(e)); schedules.reload(); } };
  return (
    <View style={{ gap: 14 }}>
      <Section title="Ready for you" color={c.cyan}>
        {runs.error ? <LoadError error={runs.error} onRetry={runs.reload} /> : runs.loading && !runs.data ? <Loading /> : !(runs.data ?? []).length ? <Empty emoji="📬" title="No reports delivered yet" sub="Scheduled reports appear here when they are ready. The message never contains figures; you open the report with your own access." /> : runs.data.map((r) => (
          <Card key={r.id} color={c.paper} onPress={() => setOpenRun(r.id)} accessibilityLabel={`Open ${r.dashboard_title} as of ${r.period_on}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ flex: 1 }}><T weight="800">{r.dashboard_title}</T><T size={12} color={c.mute}>As of {r.period_on}</T></View>
              {r.status !== 'delivered' ? <Tag label="Skipped: no access" color={c.sunSoft} /> : <Tag label="Ready" color={c.lime} />}</View>
          </Card>))}
      </Section>
      <Section title="Your schedules" color={c.violet}>
        {!(schedules.data ?? []).length ? <T size={12} color={c.mute}>None yet. Open a dashboard and choose “Schedule delivery”.</T> : schedules.data.map((s) => (
          <Card key={s.id} color={c.paper}>
            <View style={{ gap: 6 }}>
              <T weight="800">{s.dashboard_title}</T>
              <T size={12} color={c.mute}>{s.cadence} · {s.format.toUpperCase()} · {s.recipient_ids.length} {s.recipient_ids.length === 1 ? 'person' : 'people'} · next {s.next_run_on}{s.paused_at ? ' · paused' : ''}</T>
              <Wrap><Btn small title={s.paused_at ? 'Resume' : 'Pause'} color={c.paper} ink={c.ink} onPress={() => act(s, { paused: !s.paused_at })} /><Btn small title="Stop" color={c.paper} ink={c.ink} onPress={() => act(s, { archived: true })} /></Wrap>
            </View>
          </Card>))}
      </Section>
    </View>
  );
}

function RunView({ id, onBack }) {
  const L = useLayout();
  const d = useLoad(() => api.get(`/analytics/runs/${id}`), [id]);
  const x = d.data;
  if (d.error) return <View style={{ gap: 10 }}><Btn small title="‹ Reports" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} /><LoadError error={d.error} onRetry={d.reload} /></View>;
  if (!x) return <Loading />;
  const cols = L.width >= 1000 ? 3 : L.tablet ? 2 : 1;
  return (
    <View style={{ gap: 12 }}>
      <Btn small title="‹ Reports" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <T size={22} weight="800">{x.dashboard.title}</T>
      <T size={12} color={c.mute}>As of {x.run.period_on}, computed now with your access.</T>
      {x.run.definitions_changed_since.length ? <Banner>A definition changed since this report was prepared: {x.run.definitions_changed_since.map((k) => k.replace(/_/g, ' ')).join(', ')}. Figures use the current version.</Banner> : null}
      {x.quality.hidden ? <Banner tone={c.paper}>{x.quality.hidden} tile(s) are hidden because your role cannot read them.</Banner> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 }}>{x.tiles.map((t) => <TileCard key={t.widget.id} t={t} width={`${100 / cols}%`} />)}</View>
    </View>
  );
}

// ------------------------------------------------------------------ Metrics (the catalogue)
function Catalogue({ metrics }) {
  const [open, setOpen] = useState(null);
  const by = metrics.reduce((a, m) => { (a[m.domain] ??= []).push(m); return a; }, {});
  return (
    <View style={{ gap: 14 }}>
      <T size={13} color={c.mute}>One governed definition per shared KPI. Every dashboard, export, report and module quotes these, so the same metric for the same scope and period is the same number everywhere.</T>
      {Object.entries(by).map(([domain, list]) => (
        <Section key={domain} title={domain} color={c.cyan}>
          {list.map((m) => (
            <Card key={m.key} color={c.paper} onPress={() => setOpen(m.key)} accessibilityLabel={`${m.label}, version ${m.version}. Open definition`}>
              <View style={{ gap: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={15} style={{ flex: 1 }}>{m.label}</T><Tag label={`v${m.version}`} /></View>
                <T size={12} color={c.mute} numberOfLines={3}>{m.formula}</T>
                <T size={11} color={c.mute}>Owner: {m.owner} · {m.scopes.map((x) => SCOPE_WORD[x]).join(', ')}</T>
              </View>
            </Card>))}
        </Section>))}
      <DefinitionSheet metricKey={open} onClose={() => setOpen(null)} />
    </View>
  );
}

// ------------------------------------------------------------------ screen
const TABS = [{ value: 'explore', label: 'Explore' }, { value: 'dashboards', label: 'Boards' }, { value: 'reports', label: 'Reports' }, { value: 'metrics', label: 'Metrics' }];
export function Analytics({ tab: first = 'explore', run: firstRun }) {
  const [tab, setTab] = useState(first);
  const [openId, setOpenId] = useState(null);
  const [openRun, setOpenRun] = useState(firstRun ?? null);
  const scopes = useLoad(() => api.get('/analytics/scopes'), []);
  const metrics = useLoad(() => api.get('/analytics/metrics'), []);
  const dashboards = useLoad(() => api.get('/analytics/dashboards'), []);
  const err = scopes.error || metrics.error;
  return (
    <Screen refreshing={scopes.loading && !!scopes.data} onRefresh={() => { scopes.reload(); dashboards.reload(); }} wide>
      <H1>Analytics</H1>
      <T size={13} color={c.mute}>Governed KPIs across participation, finance, sponsorship and venues. Each number states its definition, source freshness and any data-quality issue.</T>
      <Seg options={TABS} value={tab} onChange={(t) => { setTab(t); setOpenId(null); setOpenRun(null); }} />
      {err ? <LoadError error={err} onRetry={() => { scopes.reload(); metrics.reload(); }} /> : !scopes.data || !metrics.data ? <Loading /> : (
        tab === 'explore' ? <Explore scopes={scopes.data} metrics={metrics.data} dashboards={dashboards.data ?? []} onSaved={dashboards.reload} />
          : tab === 'dashboards' ? <Dashboards scopes={scopes.data} dashboards={dashboards.data ?? []} reload={dashboards.reload} openId={openId} setOpenId={setOpenId} />
            : tab === 'reports' ? <Reports openRun={openRun} setOpenRun={setOpenRun} scopes={scopes.data} />
              : <Catalogue metrics={metrics.data} />)}
    </Screen>
  );
}
