// Sponsorship rights, inventory & activation lifecycle (#589). One read of an agreement from rights to renewal, an activation calendar and the renewal
// pipeline. These are views over the canonical records served by the API (get_sponsorship_lifecycle, get_sponsorship_activation_calendar,
// list_sponsorship_renewals); nothing is calculated here and no ROI is invented. Every figure shows its provenance: measured, imported or estimated.
import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Card, Chip, Empty, Loading, T, Tag } from '../ui';
import { c } from '../theme';
import { LoadError } from '../access';
import { t } from '../i18n';

const Row = ({ children, gap = 8 }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap, alignItems: 'center' }}>{children}</View>;
const word = (k) => String(k).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const PROV_TONE = { measured: c.lime, imported: c.sunSoft, estimated: c.violetSoft, recorded: c.paper };
export const Prov = ({ p }) => <Tag label={t(`spl.prov.${p}`)} color={PROV_TONE[p] ?? c.paper} />;
const STATE_TONE = { accepted: c.lime, awaiting_review: c.sunSoft, rework: c.pinkSoft, overdue: c.pinkSoft, upcoming: c.violetSoft, open: c.violetSoft, scheduled: c.violetSoft };

/** A bar of delivered against contracted, with the counts in words so it never relies on colour alone. */
function Meter({ done, total }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <View accessible accessibilityLabel={`${done} / ${total}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 120 }}>
      <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}><View style={{ width: `${pct}%`, height: '100%', backgroundColor: c.lime }} /></View>
      <T size={12} weight="800">{done}/{total}</T>
    </View>
  );
}

/** The whole lifecycle of one accepted agreement. `role` is only used to decide wording; the server decides what each side may see. */
export function Lifecycle({ id }) {
  const lc = useLoad(() => api.get(`/sponsorships/${id}/lifecycle`), [id]);
  if (lc.error) return <LoadError error={lc.error} onRetry={lc.reload} />;
  if (!lc.data) return <Loading />;
  const d = lc.data;
  return (
    <View style={{ gap: 12 }}>
      <Card color={c.paper}><View style={{ gap: 8 }}>
        <T weight="800">{t('spl.matrix')}</T>
        {d.matrix.map((m) => (
          <Row key={m.area}><T size={13} style={{ minWidth: 140, flexShrink: 1 }}>{t(`spl.area.${m.area}`)}</T><Meter done={m.delivered} total={m.contracted} /><Prov p={m.provenance} /></Row>))}
      </View></Card>

      <Card color={c.paper}><View style={{ gap: 6 }}>
        <T weight="800">{t('spl.rights')}</T>
        {d.rights.length ? d.rights.map((r) => (
          <View key={r.id} style={{ gap: 2 }}>
            <Row><T size={13} weight="700" style={{ flexShrink: 1 }}>{r.unit_name}</T><Tag label={r.kind_label} color={c.violetSoft} />{r.status === 'released' ? <Tag label={word(r.status)} color={c.pinkSoft} /> : null}</Row>
            <T size={12} color={c.mute}>{word(r.category)} · {r.starts_on} → {r.ends_on}{r.countries.length ? ` · ${r.countries.join(', ')}` : ''}{r.platforms.length ? ` · ${r.platforms.map((p) => t(`spl.platform.${p}`)).join(', ')}` : ''}</T>
          </View>)) : <Empty emoji="🎟" title={t('spl.empty_rights')} sub="" />}
      </View></Card>

      <Card color={c.paper}><View style={{ gap: 6 }}>
        <T weight="800">{t('spl.activation')}</T>
        {d.activation.deliverables.map((x) => (
          <View key={x.id} style={{ gap: 2 }}>
            <Row><T size={13} weight="700" style={{ flexShrink: 1 }}>{x.title}</T><Tag label={word(x.state)} color={STATE_TONE[x.state] ?? c.paper} /></Row>
            <T size={12} color={c.mute}>{t('spl.due')} {x.due_on}{x.owner_name ? ` · ${t('spl.owner')}: ${x.owner_name}` : ''} · {t('spl.evidence', { n: x.evidence_count })}</T>
          </View>))}
        {d.activation.open_tasks.map((x) => <T key={x.id} size={12} color={c.mute}>• {x.title}{x.due_on ? ` · ${t('spl.due')} ${x.due_on}` : ''}{x.assignee_name ? ` · ${x.assignee_name}` : ''}</T>)}
        {!d.activation.deliverables.length && !d.activation.open_tasks.length ? <T size={12} color={c.mute}>{t('spl.empty_activation')}</T> : null}
      </View></Card>

      {d.hospitality.length ? (
        <Card color={c.paper}><View style={{ gap: 6 }}>
          <T weight="800">{t('spl.hospitality')}</T>
          {d.hospitality.map((a) => <Row key={a.id}><T size={13} style={{ flexShrink: 1 }}>{a.label} · {a.product}</T><Meter done={a.issued} total={a.quota} /></Row>)}
        </View></Card>) : null}

      <Card color={c.paper}><View style={{ gap: 6 }}>
        <T weight="800">{t('spl.exposure')}</T>
        <T size={12} color={c.mute}>{t('spl.prov_note')}</T>
        {d.exposure.metrics.map((m) => <Row key={m.key}><T size={13} style={{ flexShrink: 1 }}>{m.label}: {Number(m.value).toLocaleString()}</T><Prov p={m.provenance} /></Row>)}
        {!d.exposure.metrics.length ? <T size={12} color={c.mute}>{t('spl.empty_exposure')}</T> : null}
      </View></Card>

      <Card color={c.paper}><View style={{ gap: 6 }}>
        <T weight="800">{t('spl.renewal_stage')}</T>
        <Row><Tag label={t(`spl.stage.${d.renewal.stage}`)} color={c.violetSoft} />{d.renewal.alert && d.renewal.alert !== 'expired' ? <Tag label={t('spl.expires_in', { days: d.renewal.days_left })} color={c.sunSoft} /> : null}</Row>
      </View></Card>
    </View>
  );
}

/** Deliverables, tasks, rights starting/ending and dues of every agreement you are part of, in date order. */
export function ActivationCalendar() {
  const cal = useLoad(() => api.get('/sponsorship-activation-calendar'), []);
  if (cal.error) return <LoadError error={cal.error} onRetry={cal.reload} />;
  if (!cal.data) return <Loading />;
  if (!cal.data.items.length) return <Empty emoji="🗓" title={t('spl.empty_cal')} sub="" />;
  const days = [...new Set(cal.data.items.map((x) => x.on))];
  return (
    <View style={{ gap: 10 }}>
      {days.map((day) => (
        <Card key={day} color={c.paper}><View style={{ gap: 6 }}>
          <T weight="800">{day}</T>
          {cal.data.items.filter((x) => x.on === day).map((x) => (
            <Row key={`${x.type}-${x.id}`}><Tag label={t(`spl.cal.${x.type}`)} color={STATE_TONE[x.state] ?? c.violetSoft} /><T size={13} style={{ flexShrink: 1 }}>{x.type === 'due' ? t(`spl.area.dues_${x.title}`) : x.title} · {x.sponsor}{x.owner ? ` · ${x.owner}` : ''}</T></Row>))}
        </View></Card>))}
    </View>
  );
}

/** Agreements running out, with the derived pipeline stage and expiry alert. Each side's stated plan comes from the existing renewal assessment. */
export function RenewalPipeline() {
  const list = useLoad(() => api.get('/sponsorship-renewals', { include_renewed: true, limit: 50 }), []);
  if (list.error) return <LoadError error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  if (!list.data.length) return <Empty emoji="🔁" title={t('spl.empty_renew')} sub="" />;
  return (
    <View style={{ gap: 10 }}>
      {list.data.map((r) => (
        <Card key={r.id} color={c.paper}><View style={{ gap: 4 }}>
          <Row><T weight="800" style={{ flexShrink: 1 }}>{r.sponsor_name}{r.agreement_ref ? ` · ${r.agreement_ref}` : ''}</T><Tag label={t(`spl.stage.${r.stage}`)} color={c.violetSoft} />{r.alert && r.alert !== 'expired' ? <Tag label={t('spl.expires_in', { days: r.days_left })} color={c.sunSoft} /> : null}</Row>
          <T size={12} color={c.mute}>{word(r.target_type)} · {r.ends_on}{r.open_dues ? ` · ${t('spl.open_dues', { n: r.open_dues })}` : ''}{r.assessments.map((a) => ` · ${word(a.side)}: ${word(a.intent)}`).join('')}</T>
        </View></Card>))}
    </View>
  );
}
