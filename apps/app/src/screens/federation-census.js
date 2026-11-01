// Federation extras (#703): the census. Members, new members, renewals and the renewal rate for a governing body and the bodies recognised under it, read
// through the governed KPI layer (the same figure, definition and export everywhere), split by body, region, sport, club, age band, gender, standing or month.
// It is an aggregate: counts below 5 are hidden (and the next smallest figure with them), and nothing is ever listed person by person. Lives as a tab of the
// existing Federation Home; there is no second console. Phone, tablet, desktop and web share this one layout.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, Loading, Section, Seg, T } from '../ui';
import { DateField } from '../pickers';
import { MenuField, MultiMenuField } from '../menu-field';
import { useSports } from '../sportpicker';
import { saveExport } from '../open-file';
import { explain, LoadError } from '../access';
import { Banner, Metric } from '../federation-ui';
import { Bar, Cols, SwitchRow } from '../federation-bits';
import { c } from '../theme';
import { locale } from '../locale';
import { t } from '../i18n';

const MEASURES = ['members', 'new_members', 'licence_renewals', 'renewal_rate'];
const MEASURE_KEY = { members: 'fedx.census.m.members', new_members: 'fedx.census.m.new', licence_renewals: 'fedx.census.m.renewals', renewal_rate: 'fedx.census.m.rate' };
const DIMS = ['region', 'body', 'sport', 'club', 'age_band', 'gender', 'status', 'month'];
const todayIso = () => new Date().toISOString().slice(0, 10);
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const fmt = (v, unit) => (v === null || v === undefined ? t('fedx.census.hidden') : unit === 'percent' ? `${v}%` : Number(v).toLocaleString(locale));

export function CensusTab({ id }) {
  const { toast } = useSession();
  const sports = useSports();
  const [measure, setMeasure] = useState('members');
  const [by, setBy] = useState('region');
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(todayIso());
  const [sportIds, setSportIds] = useState([]);
  const [showDef, setShowDef] = useState(false);
  const [busy, setBusy] = useState(null);
  const query = useMemo(() => ({ scope_type: 'federation', scope_id: id, preset: 'custom', from, to, ...(sportIds.length ? { sport_ids: sportIds.join(',') } : {}) }), [id, from, to, sportIds]);
  const res = useLoad(() => (to >= from ? api.get(`/analytics/metrics/${measure}/value`, { ...query, ...(by ? { group_by: by } : {}) }) : Promise.resolve(null)), [measure, by, query]);
  const d = res.data;
  const groups = (d?.groups ?? []);
  const max = Math.max(1, ...groups.map((g) => g.value ?? 0));
  const percent = d?.unit === 'percent';
  const hidden = !!(d?.suppressed || groups.some((g) => g.suppressed));
  const bad = to < from;
  const exportAs = (format) => async () => {
    setBusy(format);
    try { await saveExport(await api.get('/analytics/export', { key: measure, ...query, ...(by ? { group_by: by } : {}), format })); } catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };
  return (
    <View style={{ gap: 12 }}>
      <Banner tone={c.cyanSoft}>{t('fedx.census.aggregate')}</Banner>
      <Cols
        a={<>
          <Seg options={MEASURES.map((m) => ({ value: m, label: t(MEASURE_KEY[m]) }))} value={measure} onChange={setMeasure} />
          <View style={{ gap: 12, marginTop: 12 }}>
            <MenuField label={t('fedx.census.by')} value={by} onChange={setBy} options={DIMS.map((x) => ({ value: x, label: t(`fedx.census.dim.${x}`) }))} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
              <View style={{ flexGrow: 1, flexBasis: 160 }}><DateField label={t('fedx.census.from')} value={from} onChange={(v) => v && setFrom(v)} max={to} /></View>
              <View style={{ flexGrow: 1, flexBasis: 160 }}><DateField label={t('fedx.census.to')} value={to} onChange={(v) => v && setTo(v)} min={from} /></View>
            </View>
            <MultiMenuField label={t('fedx.census.sports')} value={sportIds} onChange={setSportIds} options={(sports.data ?? []).map((s) => ({ value: s.id, label: `${s.emoji ?? ''} ${s.name}`.trim() }))} placeholder={t('common.all')} />
          </View>
        </>}
        b={<>
          {bad ? <Banner tone={c.pinkSoft}>{t('fedx.census.badRange')}</Banner> : null}
          {res.error && !d ? <LoadError error={res.error} onRetry={res.reload} /> : null}
          {!d && !res.error && !bad ? <Loading /> : null}
          {d ? (
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                <Metric value={fmt(d.value, d.unit)} label={t(MEASURE_KEY[measure])} sub={percent && d.denominator ? `${d.numerator} / ${d.denominator}` : undefined} tone={d.suppressed ? c.violetSoft : undefined} />
              </View>
              {hidden ? <Banner tone={c.sunSoft}>{t('fedx.census.hiddenNote')}</Banner> : null}
              <Section title={t('fedx.census.byTitle', { dim: t(`fedx.census.dim.${by}`) })} color={c.mint}>
                {groups.length ? (
                  <Card color={c.paper}>
                    <View style={{ gap: 12 }}>
                      {groups.map((g) => (g.value === null || g.value === undefined
                        ? <View key={String(g.key)} style={{ flexDirection: 'row', justifyContent: 'space-between' }} accessible accessibilityLabel={`${g.label}: ${t('fedx.census.hidden')}`}><T size={13} weight="600">{g.label}</T><T size={13} color={c.mute}>🔒 {t('fedx.census.hidden')}</T></View>
                        : <Bar key={String(g.key)} label={g.label} value={g.value} max={percent ? 100 : max} sub={percent && g.denominator ? `${g.numerator} / ${g.denominator}` : undefined} />))}
                    </View>
                  </Card>) : <Empty emoji="📊" title={t('fedx.census.empty')} />}
              </Section>
              <SwitchRow label={t('fedx.census.definition')} sub={d.definition.owner} value={showDef} onChange={setShowDef} />
              {showDef ? <Card color={c.paper}><T size={13}>{d.definition.formula}</T><T size={11} color={c.mute} style={{ marginTop: 8 }}>{t('fedx.census.version', { version: d.metric.version, ref: d.reference })}</T></Card> : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {['csv', 'xlsx', 'pdf'].map((f) => <Btn key={f} small color={c.paper} ink={c.ink} title={`${t('fedx.census.export')} ${f.toUpperCase()}`} loading={busy === f} onPress={exportAs(f)} accessibilityLabel={`${t('fedx.census.export')} ${f.toUpperCase()}`} />)}
              </View>
            </View>
          ) : null}
        </>} />
    </View>
  );
}
