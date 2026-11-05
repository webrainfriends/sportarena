// Para classification in competition (PS-02, #832): the class the governing body issued (#488), shown where it is used. Athlete/guardian: where my class applies;
// organiser: category check, entries needing attention, provisional participation; officials: the permitted per-match summary frozen at lock. Every rule and every
// read is enforced by the API (REST / OpenAPI / MCP): this screen only calls it and never types, infers or edits a class. One React Native codebase: iOS, iPadOS, Android, web.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { A, ABtn, ACard, AEmpty, ASection, AStat, AT, ATag } from '../arena';
import { Card, ErrorBox, Loading, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { useDo } from './console-utils';
import { c } from '../theme';
import { t } from '../i18n';

const TONE = { eligible: c.limeSoft, pending: c.sunSoft, ineligible: c.redSoft, unknown: c.cyanSoft, provisional: c.cyanSoft, confirmed: c.limeSoft, not_eligible: c.redSoft };
const short = (d) => (d ? String(d).slice(0, 10) : '—');
/** The single, plain-language line for a check: decision word (never colour alone) + reason. */
const word = (x) => (x?.source?.kind === 'para_provisional' ? t('pc.provisional') : t(`pc.dec.${x?.decision ?? 'unknown'}`));
const Row = ({ children }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{children}</View>;
export const ParaNote = () => <View style={{ backgroundColor: c.cyanSoft, borderRadius: 14, padding: 12 }} accessible accessibilityRole="text"><T size={12} color={c.ink}>{t('pc.note')}</T></View>;

function ClassLine({ s }) {
  if (!s?.class_code) return null;
  return <T size={12} color={c.mute}>{[s.class_code, s.class_status && t(`para.status.${s.class_status}`), s.authority, s.version != null ? t('pc.rules_v', { v: s.version }) : null, s.decision_ref].filter(Boolean).join(' · ')}</T>;
}

/** Athlete / guardian: every entry the class applies to, with the class frozen at entry and the class in force now. */
export function ParaEntries({ athleteId }) {
  const { tablet } = useLayout();
  const d = useLoad(() => api.get('/me/para-entries', athleteId ? { athlete_id: athleteId } : {}), [athleteId]);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const list = d.data.entries;
  return (
    <View style={{ gap: 10 }}>
      <T size={18} weight="800" accessibilityRole="header">{t('pc.where')}</T>
      {!list.length ? (
        <Card pad={18} style={{ gap: 6 }}><T weight="800">{t('pc.none_title')}</T><T size={13} color={c.mute}>{t('pc.none_sub')}</T></Card>
      ) : (
        <Row>{list.map((x) => (
          <Card key={x.registration_id} pad={16} style={{ flexGrow: 1, flexBasis: tablet ? 340 : '100%', gap: 6 }} accessibilityLabel={[x.event, x.category, word(x.live), x.live.reason].filter(Boolean).join(', ')}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <T weight="800" style={{ flexShrink: 1 }}>{[x.event, x.category].filter(Boolean).join(' · ')}</T>
              <Tag label={word(x.live)} color={TONE[x.live.source?.kind === 'para_provisional' ? 'provisional' : x.live.decision]} />
            </View>
            <T size={13} color={c.ink}>{x.live.reason}</T>
            <ClassLine s={x.live.source} />
            {x.accepted_classes.length ? <T size={12} color={c.mute}>{t('pc.accepts', { list: x.accepted_classes.join(', ') })}</T> : null}
            {x.frozen.map((f) => <T key={f.stage} size={12} color={c.mute}>{t('pc.frozen_at', { stage: t(`pc.stage.${f.stage}`), cls: f.source?.class_code ?? '—', day: short(f.at) })}</T>)}
          </Card>))}
        </Row>)}
      <ParaNote />
    </View>
  );
}

/** Organiser: summary, entries needing attention, the category check and policy-approved provisional participation. */
export function ParaDesk({ id, setup }) {
  const { toast } = useSession();
  const sum = useLoad(() => api.get(`/events/${id}/para/summary`, { limit: 100 }), [id]);
  const regs = useLoad(() => api.get(`/events/${id}/registrations`, { limit: 200 }), [id]);
  const [check, setCheck] = useState(false), [prov, setProv] = useState(null), [res, setRes] = useState(null);
  const act = useDo(sum.reload);
  if (sum.error) return <ErrorBox error={sum.error} onRetry={sum.reload} />;
  if (!sum.data) return <Loading />;
  const k = sum.data.counts, allow = !!setup?.policy?.rules?.allow_provisional;
  const cats = (setup?.divisions ?? []).filter((x) => !x.archived_at).map((x) => ({ value: x.id, label: x.name }));
  const people = [...new Map((Array.isArray(regs.data) ? regs.data : regs.data?.registrations ?? []).map((r) => [r.user_id, { value: r.user_id, label: r.display_name }])).values()];
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <AStat icon="♿" value={k.entries} label={t('pc.k_entries')} />
        <AStat icon="✅" value={k.confirmed} label={t('pc.k_confirmed')} />
        <AStat icon="⏳" value={k.pending} label={t('pc.k_pending')} tone={k.pending ? A.sun : undefined} />
        <AStat icon="🕒" value={k.provisional} label={t('pc.provisional')} />
        <AStat icon="⛔" value={k.not_eligible} label={t('pc.k_blocked')} tone={k.not_eligible ? A.red : undefined} />
      </View>
      <ABtn small tone="neon" title={t('pc.check_title')} onPress={() => setCheck(true)} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t('pc.check_title')} />
      {res ? (
        <ACard tone={res.result?.decision === 'ineligible' ? A.red : undefined} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><AT weight="800" style={{ flexShrink: 1 }}>{res.athlete}</AT><ATag label={res.result ? word(res.result) : t('pc.not_used')} /></View>
          <AT size={13}>{res.result?.reason ?? t('pc.not_used_sub')}</AT>
          {res.result?.source?.class_code ? <AT size={12} color={A.mute}>{[res.result.source.class_code, res.result.source.authority, res.result.source.version != null ? t('pc.rules_v', { v: res.result.source.version }) : null, res.result.source.decision_ref].filter(Boolean).join(' · ')}</AT> : null}
          <AT size={12} color={A.mute}>{res.accepted_classes.length ? t('pc.accepts', { list: res.accepted_classes.join(', ') }) : t('pc.any_class')}</AT>
        </ACard>) : null}
      <ASection title={t('pc.attention')} sub={t('pc.attention_sub')} />
      {!sum.data.attention.length ? <AEmpty emoji="🛡️" title={t('pc.attention_none')} sub={t('pc.attention_none_sub')} /> : sum.data.attention.map((a) => (
        <ACard key={a.registration_id} style={{ gap: 6 }} accessibilityLabel={[a.athlete, word(a)].join(', ')}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><AT weight="800" style={{ flexShrink: 1 }}>{a.athlete}</AT><ATag label={a.bucket === 'provisional' ? t('pc.provisional') : t(`pc.bucket.${a.bucket}`)} /></View>
          <AT size={13} color={A.mute}>{[a.category, a.reason].filter(Boolean).join(' · ')}</AT>
          {allow && a.bucket === 'pending' ? <ABtn small tone="ghost" title={t('pc.prov_grant')} onPress={() => setProv(a)} style={{ alignSelf: 'flex-start' }} /> : null}
        </ACard>))}
      <FormSheet visible={check} onClose={() => setCheck(false)} title={t('pc.check_title')} submitLabel={t('pc.check_go')} initial={{}}
        fields={[
          { key: 'user_id', label: t('pc.athlete'), type: 'multimenu', max: 1, options: people, placeholder: t('pc.athlete_ph') },
          { key: 'division_id', label: t('pc.category'), type: 'multimenu', max: 1, options: cats, placeholder: t('pc.category_ph'), optional: true },
          { key: 'on', label: t('pc.on_date'), type: 'date', optional: true }]}
        onSubmit={async (v) => { const r = await api.get(`/events/${id}/para/check`, { user_id: [].concat(v.user_id)[0], ...(v.division_id?.length ? { division_id: [].concat(v.division_id)[0] } : {}), ...(v.on ? { on: v.on } : {}) }); setRes(r); return t('pc.checked'); }} />
      <FormSheet visible={!!prov} onClose={() => setProv(null)} title={t('pc.prov_title')} submitLabel={t('pc.prov_grant')} initial={{}}
        fields={[{ key: 'valid_until', label: t('pc.valid_until'), type: 'date' }, { key: 'reason', label: t('pc.prov_reason'), multiline: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/para/provisional`, { user_id: prov.user_id, reason: v.reason, valid_until: v.valid_until }); sum.reload(); return t('pc.prov_done'); }} />
      <ParaNote />
    </>
  );
}

/** Match officials and staff: the class, status, rules version and decision reference frozen at lock. Nothing else, and nothing here can change a class. */
export function FixtureParaSummary({ fixtureId }) {
  const d = useLoad(() => api.get(`/fixtures/${fixtureId}/para`), [fixtureId]);
  if (d.error) return d.error.status === 404 || d.error.status === 403 ? null : <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return null;
  const rows = d.data.players.filter((p) => p.stage === 'lock' || p.stage === 'start');
  if (!rows.length) return null; // classification is not in play for this match (or squads are not locked yet): nothing to show
  return (
    <View style={{ gap: 8 }}>
      <T size={16} weight="800" accessibilityRole="header">{t('pc.match_title')}</T>
      {rows.map((p, i) => (
        <Card key={`${p.athlete}${i}`} pad={12} style={{ gap: 4 }} accessibilityLabel={[p.athlete, p.source?.class_code, t(`pc.status.${p.status}`)].filter(Boolean).join(', ')}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800" style={{ flexShrink: 1 }}>{p.athlete}</T><Tag label={p.source?.kind === 'para_provisional' ? t('pc.provisional') : t(`pc.status.${p.status}`)} color={TONE[p.status === 'pass' ? 'eligible' : p.status === 'fail' ? 'ineligible' : 'pending']} /></View>
          <T size={12} color={c.mute}>{[p.team, p.source?.class_code, p.source?.authority, p.source?.version != null ? t('pc.rules_v', { v: p.source.version }) : null, p.source?.decision_ref].filter(Boolean).join(' · ') || p.reason}</T>
        </Card>))}
      <ParaNote />
    </View>
  );
}
