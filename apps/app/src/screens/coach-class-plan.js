// What a student (or a young person's guardian) sees of a class: the plan the coach shared and what the coach chose to share about how they got on.
// The coach plans, scores and reviews in the class studio (class-studio.js). All text goes through t(); the server decides who may see what.
import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Row, T, Tag, Loading } from '../ui';
import { t } from '../i18n';
import { c } from '../theme';

const KINDS = ['warm_up', 'skill_drill', 'tactical_drill', 'conditioned_game', 'conditioning', 'recovery', 'review', 'custom'];

/** Student (or guardian): the plan the coach shared, and what the coach chose to share about how you got on. */
export function ClassPlanView({ k }) {
  const p = useLoad(() => api.get(`/coach/classes/${k.id}/plan`), [k.id]);
  if (p.error || !p.data) return p.error ? null : <Loading />;
  const d = p.data;
  const told = d.people.filter((x) => x.attendance || x.summary);
  return (
    <View style={{ gap: 10 }}>
      <T weight="800">{t('cp.plan_title')}</T>
      {!d.shared ? <T color={c.mute}>{t('cp.plan_not_shared')}</T> : (
        <View style={{ gap: 8 }}>
          {d.objective ? <T>{d.objective}</T> : null}
          {d.blocks.map((b, i) => <Row key={b.id} title={[i + 1, b.title].join('. ')} sub={[t(`cp.kind.${KINDS.includes(b.kind) ? b.kind : 'custom'}`), b.duration_min ? `${b.duration_min} ${t('cls.min')}` : null, b.instructions].filter(Boolean).join(' · ')} />)}
        </View>
      )}
      {told.length ? <T weight="800" style={{ marginTop: 6 }}>{t('cp.my_progress')}</T> : null}
      {told.map((x) => (
        <View key={x.user_id} style={{ gap: 4 }}>
          {x.name ? <T weight="700">{x.name}</T> : null}
          {x.attendance ? <Tag label={t(`cp.att.${x.attendance}`)} /> : null}
          {x.summary ? <T>{x.summary}</T> : null}
        </View>
      ))}
    </View>
  );
}
