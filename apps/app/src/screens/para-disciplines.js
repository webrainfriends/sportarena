// Para / adaptive disciplines (PS-01 #831): discovery of the para sports of the single sports catalogue and of the governed rule versions behind them.
// Read-only for everyone signed in; rule versions are drafted, submitted and approved by the governing body in the Authority tab of the same screen.
// A competition class is an administrative sporting classification, never a medical diagnosis. No rule text is invented here: everything is read from the API.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { Card, Chip, Empty, ErrorBox, Field, Loading, T, Tag } from '../ui';
import { Kpi } from './academy-ui';
import { c } from '../theme';
import { t } from '../i18n';
import { PARA_PROGRAMMES } from '../sportpicker';

const STATES = ['governed', 'awaiting', 'deprecated', 'gap'];
const TONE = { governed: c.limeSoft, awaiting: c.sunSoft, deprecated: c.orangeSoft, gap: c.redSoft };
const day = (d) => (d ? String(d).slice(0, 10) : '—');
const Line = ({ k, v }) => (v ? <View style={{ gap: 2 }}><T size={11} weight="800" color={c.mute}>{k}</T><T size={13}>{v}</T></View> : null);

function Version({ v }) {
  return (
    <Card pad={14} style={{ gap: 8 }} accessibilityLabel={`${v.authority} ${t('ps.version_n', { n: v.version })}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800">{v.authority} · {t('ps.version_n', { n: v.version })}{v.discipline ? ` · ${v.discipline}` : ''}</T>
        <Tag label={v.deprecated_at ? t('ps.state.deprecated') : t(`ps.approval.${v.approval_status}`)} color={v.deprecated_at ? c.orangeSoft : v.approval_status === 'approved' ? c.limeSoft : c.sunSoft} />
      </View>
      <T size={13} color={c.mute}>{v.title}</T>
      <Line k={t('ps.publisher')} v={v.publisher} />
      <Line k={t('ps.source')} v={v.source_url ?? v.source_ref} />
      <Line k={t('ps.effective')} v={`${day(v.effective_from)}${v.effective_to ? ` → ${day(v.effective_to)}` : ''}`} />
      <Line k={t('ps.scope')} v={`${v.scope_countries?.length ? v.scope_countries.join(', ') : t('ps.worldwide')}${v.scope_competitions?.length ? ` · ${v.scope_competitions.join(', ')}` : ''}`} />
      <Line k={t('ps.categories')} v={v.event_categories?.join(' · ')} />
      <Line k={t('ps.adaptations')} v={v.adaptations?.join(' · ')} />
      <Line k={t('ps.roles')} v={v.permitted_roles?.join(' · ')} />
      <Line k={t('ps.classes')} v={v.classes?.map((k) => k.code).join(' · ')} />
      <Tag label={v.classification_required ? t('ps.class_req') : t('ps.class_not_req')} color={c.cyanSoft} />
      {v.history?.length ? <Line k={t('ps.history')} v={v.history.map((h) => `${day(h.at)} ${h.action}`).join(' · ')} /> : null}
    </Card>
  );
}

function Detail({ slug }) {
  const d = useLoad(() => api.get(`/para/sports/${slug}`), [slug]);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const { sport, versions, contexts } = d.data;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 6 }}>
        <T size={20} weight="800" accessibilityRole="header">{sport.emoji} {sport.name}</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {sport.programmes?.filter((p) => PARA_PROGRAMMES.includes(p)).map((p) => <Tag key={p} label={t(`ps.prog_${p}`)} color={c.pinkSoft} />)}
          <Tag label={t(`ps.state.${sport.state}`)} color={TONE[sport.state]} />
        </View>
        {sport.base_name ? <T size={12} color={c.mute}>{t('ps.base', { sport: sport.base_name })}</T> : null}
      </View>
      {versions.length ? versions.map((v) => <Version key={v.id} v={v} />) : <T size={13} color={c.mute}>{t('ps.no_rules')}</T>}
      <T weight="800" size={12} color={c.mute}>{t('ps.contexts')}</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{contexts.map((x) => <Tag key={x.key} label={t(`ps.ctx.${x.key}`)} color={c.violetSoft} />)}</View>
      <T size={12} color={c.mute}>{t('ps.ctx_hint')}</T>
    </View>
  );
}

export function ParaDisciplines() {
  const { tablet } = useLayout();
  const [q, setQ] = useState(''), [state, setState] = useState(null), [prog, setProg] = useState(null), [pick, setPick] = useState(null);
  const cat = useLoad(() => api.get('/para/coverage', { para: true, ...(q.trim() ? { q: q.trim() } : {}), ...(state ? { state } : {}), ...(prog ? { programme: prog } : {}) }), [q, state, prog]);
  const sum = cat.data?.summary;
  const sel = pick ?? (tablet ? cat.data?.sports?.[0]?.slug : null);
  const pct = sum?.para_sports ? Math.round((sum.governed / sum.para_sports) * 100) : 0;
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <Kpi label={t('ps.kpi_sports')} value={String(sum?.para_sports ?? '—')} sub={t('ps.kpi_sports_sub')} />
        <Kpi label={t('ps.kpi_governed')} value={String(sum?.governed ?? '—')} sub={t('ps.kpi_governed_sub')} />
        <Kpi label={t('ps.kpi_awaiting')} value={String(sum?.awaiting ?? '—')} sub={t('ps.kpi_awaiting_sub')} />
        <Kpi label={t('ps.kpi_gap')} value={String(sum?.gap ?? '—')} sub={t('ps.kpi_gap_sub')} />
      </View>
      <View accessible accessibilityLabel={t('ps.coverage', { pct })} style={{ gap: 4 }}>
        <View style={{ height: 10, borderRadius: 5, backgroundColor: c.line, overflow: 'hidden' }}><View style={{ width: `${pct}%`, height: 10, backgroundColor: c.lime }} /></View>
        <T size={12} color={c.mute}>{t('ps.coverage', { pct })}</T>
      </View>
      <Field value={q} onChangeText={setQ} placeholder={t('ps.search')} accessibilityLabel={t('ps.search')} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label={t('ps.f_all')} active={!state} onPress={() => setState(null)} />
        {STATES.map((s) => <Chip key={s} label={t(`ps.state.${s}`)} active={state === s} onPress={() => setState(s)} />)}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label={t('ps.prog_all')} active={!prog} onPress={() => setProg(null)} />
        {PARA_PROGRAMMES.map((p) => <Chip key={p} label={t(`ps.prog_${p}`)} active={prog === p} onPress={() => setProg(p)} />)}
      </View>
      {cat.error ? <ErrorBox error={cat.error} onRetry={cat.reload} /> : !cat.data ? <Loading /> : (
        <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}>
          <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', gap: 8 }}>
            {cat.data.sports.length ? cat.data.sports.map((s) => (
              <Card key={s.slug} pad={12} onPress={() => setPick(s.slug)} color={sel === s.slug ? c.violetSoft : c.paper} accessibilityLabel={`${s.name} ${t(`ps.state.${s.state}`)}`}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 32 }}>
                  <T size={20}>{s.emoji}</T><T weight="800" style={{ flex: 1 }}>{s.name}</T><Tag label={t(`ps.state.${s.state}`)} color={TONE[s.state]} />
                </View>
                {!tablet && sel === s.slug ? <View style={{ marginTop: 10 }}><Detail slug={s.slug} /></View> : null}
              </Card>
            )) : <Empty emoji="♿" title={t('ps.empty_title')} sub={t('ps.empty_sub')} />}
          </View>
          {tablet && sel ? <View style={{ flex: 1.3 }}><Card pad={16}><Detail slug={sel} /></Card></View> : null}
        </View>
      )}
    </View>
  );
}
