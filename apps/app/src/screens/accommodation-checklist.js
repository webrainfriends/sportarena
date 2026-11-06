// PS-03: Staff actionable accommodation checklist for a session.
// Derived from consented operational flags only. No diagnosis or clinical data.
// Staff can mark items as arranged and add an arrangement note.
// Every load is audit-logged and visible to the athlete.
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useSession } from '../session';
import { useLoad } from '../hooks';
import { explain, LoadError } from '../access';
import { Btn, Card, Empty, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { needLabel } from './academy-inclusion';

const TYPE_COLOR = {
  access: c.cyan, equipment: c.sun, support_person: c.pink,
  transport: c.orange, communication: c.mint, schedule: c.lime,
};

export function AccommodationChecklist({ sessionId, sessionTitle }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/academy/sessions/${sessionId}/accommodation-checklist`), [sessionId]);
  const [arranging, setArranging] = useState(null);

  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;

  const { athletes, total_items, arranged_items } = d.data;
  const pct = total_items ? Math.round((arranged_items / total_items) * 100) : 100;

  const markArranged = async (v) => {
    try {
      await api.post(`/accommodation-checklist/${arranging.checklist_item_id}/arrange`, { arranged: !arranging.arranged, arrangement_note: v.note });
      toast(arranging.arranged ? t('inc.ck_unarranged') : t('inc.ck_arranged'));
      setArranging(null); d.reload();
    } catch (e) { throw new Error(explain(e)); }
  };

  const arrangeFields = [
    { key: 'note', label: t('inc.ck_note_label'), type: 'multiline', optional: true, maxLength: 300, hint: t('inc.ck_note_hint') },
  ];

  return (
    <View style={{ gap: 12 }}>
      {/* session hero */}
      <View style={{ backgroundColor: c.pink, borderRadius: 16, padding: 16, gap: 6 }}>
        <T size={11} weight="700" color="rgba(255,255,255,0.7)" style={{ textTransform: 'uppercase', letterSpacing: 0.8 }}>{t('inc.ck_title')}</T>
        <T weight="800" size={17} color="#FFF">{sessionTitle ?? t('inc.ck_session')}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 }}>
          <View style={{ flex: 1, height: 6, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 999, overflow: 'hidden' }}>
            <View style={{ width: `${pct}%`, height: '100%', backgroundColor: '#FFF', borderRadius: 999 }} />
          </View>
          <T size={13} color="#FFF" weight="700">{t('inc.ck_progress', { arranged: arranged_items, total: total_items })}</T>
        </View>
      </View>

      {/* by-type summary */}
      {total_items > 0 ? (
        <Card>
          <T weight="700" size={13} style={{ marginBottom: 8 }}>{t('inc.ck_by_type')}</T>
          {buildTypeSummary(athletes).map(({ type, arranged, total }) => (
            <View key={type} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}>
              <T size={13}>{t(`inc.type_${type}`)}</T>
              <Tag label={`${arranged}/${total}`} color={arranged === total ? c.lime : c.sun} />
            </View>
          ))}
        </Card>
      ) : null}

      {/* athletes */}
      {!athletes.length ? (
        <Card><Empty emoji="✅" title={t('inc.ck_empty_title')} sub={t('inc.ck_empty_sub')} /></Card>
      ) : athletes.map((a) => (
        <Card key={a.athlete_id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <View style={{ gap: 2 }}>
              <T weight="700" size={15}>{a.athlete_name}</T>
            </View>
            <Tag label={t('inc.ck_athlete_progress', { arranged: a.arranged_count, total: a.total_count })}
              color={a.arranged_count === a.total_count ? c.lime : c.sun} />
          </View>
          {a.items.map((item) => (
            <View key={item.need_key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.line }}>
              <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: item.arranged ? c.lime : c.line, backgroundColor: item.arranged ? c.lime : 'transparent', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {item.arranged ? <T size={13} weight="800" color="#FFF">✓</T> : null}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T size={14} weight="600">{needLabel(item.need_key)}</T>
                {item.arranged && item.arrangement_note ? (
                  <T size={12} color={c.mute}>{item.arrangement_note}</T>
                ) : !item.arranged ? (
                  <T size={12} color={c.orange}>{t('inc.ck_pending')}</T>
                ) : null}
              </View>
              {item.checklist_item_id ? (
                <Btn small title={item.arranged ? t('inc.ck_undo') : t('inc.ck_mark_done')}
                  color={item.arranged ? c.mute : c.sun}
                  onPress={() => setArranging(item)}
                  accessibilityLabel={item.arranged ? t('inc.ck_undo_a11y', { need: needLabel(item.need_key) }) : t('inc.ck_mark_done_a11y', { need: needLabel(item.need_key) })} />
              ) : null}
            </View>
          ))}
        </Card>
      ))}

      {/* operational disclaimer */}
      <Card style={{ backgroundColor: c.redSoft }}>
        <T size={12} color={c.red} weight="600">{t('inc.ck_disclaimer')}</T>
      </Card>

      {arranging ? (
        <FormSheet visible={!!arranging} onClose={() => setArranging(null)}
          title={arranging.arranged ? t('inc.ck_undo') : t('inc.ck_mark_done')}
          fields={arrangeFields} submitLabel={arranging.arranged ? t('inc.ck_undo') : t('inc.ck_mark_done')}
          onSubmit={markArranged} initial={{ note: arranging.arrangement_note ?? '' }} />
      ) : null}
    </View>
  );
}

function buildTypeSummary(athletes) {
  const map = {};
  for (const a of athletes) {
    for (const item of a.items) {
      if (!map[item.type]) map[item.type] = { type: item.type, arranged: 0, total: 0 };
      map[item.type].total++;
      if (item.arranged) map[item.type].arranged++;
    }
  }
  return Object.values(map).sort((a, b) => a.arranged - b.arranged);
}
