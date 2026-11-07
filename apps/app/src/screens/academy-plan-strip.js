// Read-only strip for the event console's Teams tab (#786): the academy season plans that link this event, with squad and conflict counts.
// Teams, seeding and invitations stay in the event console; this only reports and links back to Competition & Squads. It renders nothing for
// an event no academy plan links to, or for a caller without academy schedule access (the server returns an empty list).
import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { T, Tag } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';

export function AcademyPlanStrip({ eventId, onOpen }) {
  const r = useLoad(() => api.get(`/events/${eventId}/academy-plans`).catch(() => ({ items: [] })), [eventId]);
  const items = r.data?.items ?? [];
  if (!items.length) return null;
  return (
    <View style={{ gap: 8 }} accessibilityRole="summary">
      {items.map((x) => (
        <View key={`${x.plan_id}${x.team_id}`} accessible accessibilityLabel={t('cp.strip.a11y', { team: x.team_name, plan: x.plan_name })}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: 12, borderRadius: 16, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, borderLeftWidth: 4, borderLeftColor: c.pink, minHeight: 56 }}>
          <View style={{ flex: 1, minWidth: 180 }}>
            <T weight="800">{t('cp.strip.title', { plan: x.plan_name, team: x.team_name })}</T>
            <T size={12} color={c.mute}>{t('cp.strip.sub', { n: x.open_conflicts })}</T>
          </View>
          <Tag label={x.squad_published_at ? t('cp.squad.published') : t('cp.squad.draft')} color={x.squad_published_at ? c.limeSoft : c.violetSoft} />
          {x.blocking_conflicts ? <Tag label={t('cp.kpi.blocking', { n: x.blocking_conflicts })} color={c.redSoft} /> : null}
          {onOpen ? <T size={13} weight="700" color={c.pink} accessibilityRole="link" onPress={onOpen} style={{ minHeight: 44, textAlignVertical: 'center' }}>{t('cp.strip.open')}</T> : null}
        </View>
      ))}
    </View>
  );
}
