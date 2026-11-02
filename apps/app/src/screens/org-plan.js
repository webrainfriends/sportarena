// What the organisation's plan covers and where it stands: a banner while the platform team reviews the organisation, and the plan usage card
// (academies, teams, staff seats). The server owns every number and every refusal; this only shows them. Everyone tagged as staff of the
// umbrella organisation or any of its academies is covered by the one plan.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Section, Sheet, T, Tag } from '../ui';
import { t } from '../i18n';
import { c } from '../theme';
import { PlanPicker } from './plans-billing';

const LIMITS = [['academies', 'op.academies'], ['teams', 'op.teams'], ['staff_seats', 'op.staff']];
const BANNER = { pending: ['op.pending', c.sun], rejected: ['op.rejected', c.red], suspended: ['op.suspended', c.red] };

/** Shown to owners and admins until the platform team has approved the organisation. */
export function PlanBanner({ o }) {
  const b = BANNER[o.approval_status];
  if (!b) return null;
  return (
    <View accessible accessibilityRole="alert" accessibilityLabel={t(b[0])} style={{ marginTop: 10, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: b[1], backgroundColor: c.paper, gap: 4 }}>
      <T weight="800" color={b[1]}>{t(b[0])}</T>
      {o.approval_status === 'pending' ? <T size={13} color={c.mute}>{t('op.pending_sub')}</T> : null}
      {o.approval_note ? <T size={13}>{t('op.note', { note: o.approval_note })}</T> : null}
    </View>
  );
}

function Bar({ used, limit, name }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = limit != null && used >= limit ? c.red : limit != null && pct >= 80 ? c.sun : c.lime;
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={name} accessibilityValue={limit ? { min: 0, max: limit, now: used } : undefined} style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden', marginTop: 6 }}>
      <View style={{ height: 8, width: `${limit ? pct : 0}%`, backgroundColor: tone }} />
    </View>
  );
}

/** Plan and usage for owners, admins and finance. The umbrella organisation holds the plan; its academies share it. */
export function PlanCard({ o, archived }) {
  const plan = useLoad(() => api.get(`/organisations/${o.id}/plan`), [o.id]);
  const [pick, setPick] = useState(false);
  if (!plan.data) return null;
  const p = plan.data;
  return (
    <Section title={t('op.title')} color={c.cyan}>
      {p.plan?.plan_key ? <Tag label={p.plan.plan_key.replace(/[_.]/g, ' ')} /> : null}
      {LIMITS.map(([key, label]) => {
        const l = p.limits.find((x) => x.key === key) ?? {};
        const text = !l.governed ? t('op.not_in_plan') : l.limit == null ? t('op.no_limit', { used: l.used ?? 0 }) : t('op.used_of', { used: l.used ?? 0, limit: l.limit });
        return (
          <View key={key} style={{ paddingVertical: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <T weight="800">{t(label)}</T>
              <T color={l.over_limit ? c.red : c.mute} size={13}>{text}</T>
            </View>
            <Bar used={l.used ?? 0} limit={l.governed ? l.limit : 0} name={[t(label), text].join(': ')} />
          </View>
        );
      })}
      <T size={12} color={c.mute}>{t('op.covered')}</T>
      {!archived && p.is_umbrella ? <Btn small title={t('op.upgrade')} onPress={() => setPick(true)} style={{ marginTop: 8, alignSelf: 'flex-start' }} accessibilityLabel={t('op.upgrade')} /> : null}
      <Sheet visible={pick} onClose={() => { setPick(false); plan.reload(); }} title={t('op.title')}>
        <PlanPicker subjectType="organisation" subjectId={p.umbrella_organisation_id} subjectName={o.name} />
      </Sheet>
    </Section>
  );
}
