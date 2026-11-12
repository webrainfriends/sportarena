// Patient daily exercise routine player (#210).
// Loads today's session log entries, lets the patient log completions with dose, pain and exertion.
// Offline-safe: idempotency key generated client-side and sent with every log.
import React, { useState } from 'react';
import { View, ScrollView, TouchableOpacity } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Section, T, Tag } from '../ui';
import { Counter } from '../pickers';
import { c, day } from '../theme';
import { t } from '../i18n';

const PAIN_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const EXERTION_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function PainPicker({ value, onChange, label }) {
  return (
    <View style={{ gap: 6 }}>
      <T size={12} color={c.mute}>{label}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {PAIN_LEVELS.map((n) => (
          <TouchableOpacity
            key={n}
            accessibilityLabel={`${label} ${n}`}
            accessibilityRole="button"
            onPress={() => onChange(n)}
            style={{
              width: 36, height: 44, borderRadius: 8,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: value === n ? c.violet : c.line,
            }}
          >
            <T size={13} weight={value === n ? '800' : '400'} color={value === n ? c.white : c.ink}>{n}</T>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function ExerciseCard({ session, onLogged }) {
  const { toast } = useSession();
  const [expanded, setExpanded] = useState(false);
  const [sets, setSets] = useState(session.sets ?? 3);
  const [reps, setReps] = useState(session.reps ?? 10);
  const [exertion, setExertion] = useState(null);
  const [painBefore, setPainBefore] = useState(null);
  const [painAfter, setPainAfter] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [flareup, setFlareup] = useState(false);

  const checkFlareup = (val) => {
    setPainAfter(val);
    if (val >= 7) setFlareup(true);
  };

  const submit = async () => {
    if (exertion == null) { toast(t('physio.routine.exertion_required')); return; }
    setSubmitting(true);
    try {
      const key = `${session.id}-${Date.now()}`;
      await api.post(`/physio/sessions/${session.id}/log`, {
        actual_sets: sets, actual_reps: reps, exertion_score: exertion,
        pain_before: painBefore, pain_after: painAfter,
        offline_idempotency_key: key,
      });
      toast(t('physio.routine.logged'));
      onLogged?.();
    } catch (e) {
      toast(e.message ?? t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  const done = !!session.log_id;

  return (
    <Card pad={12} color={done ? c.mintSoft : c.paper}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={session.exercise_name ?? t('physio.routine.exercise')}
        onPress={() => setExpanded((x) => !x)}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800">{session.exercise_name ?? t('physio.routine.exercise')}</T>
          <T size={12} color={c.mute}>
            {t('physio.routine.sets_reps', { sets: session.sets ?? 3, reps: session.reps ?? 10 })}
            {session.hold_sec ? `  ·  ${t('physio.routine.hold')}: ${session.hold_sec}s` : ''}
            {session.rest_sec ? `  ·  ${t('physio.routine.rest')}: ${session.rest_sec}s` : ''}
          </T>
        </View>
        {done ? <Tag label={t('common.done')} color={c.mintSoft} /> : <Tag label={t('physio.routine.pending')} color={c.violetSoft} />}
      </TouchableOpacity>

      {expanded && !done && (
        <View style={{ gap: 12, marginTop: 12 }}>
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <Counter label={t('physio.routine.sets')} value={sets} onChange={setSets} min={1} max={20} />
            <Counter label={t('physio.routine.reps')} value={reps} onChange={setReps} min={1} max={100} />
          </View>

          <PainPicker label={t('physio.routine.pain_before')} value={painBefore} onChange={setPainBefore} />

          <View style={{ gap: 6 }}>
            <T size={12} color={c.mute}>{t('physio.routine.exertion')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {EXERTION_LEVELS.map((n) => (
                <TouchableOpacity
                  key={n}
                  accessibilityLabel={`${t('physio.routine.exertion')} ${n}`}
                  accessibilityRole="button"
                  onPress={() => setExertion(n)}
                  style={{
                    width: 36, height: 44, borderRadius: 8,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: exertion === n ? c.pink : c.line,
                  }}
                >
                  <T size={13} weight={exertion === n ? '800' : '400'} color={exertion === n ? c.white : c.ink}>{n}</T>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <PainPicker label={t('physio.routine.pain_after')} value={painAfter} onChange={checkFlareup} />

          {flareup && (
            <Card pad={12} color={c.orangeSoft}>
              <T weight="800" color={c.orange}>{t('physio.routine.flareup')}</T>
            </Card>
          )}

          <Btn
            title={submitting ? t('common.loading') : t('physio.routine.complete')}
            color={c.violet}
            disabled={submitting}
            onPress={submit}
            accessibilityLabel={t('physio.routine.complete')}
          />
        </View>
      )}
    </Card>
  );
}

export function PhysioRoutine({ patientId }) {
  const today = new Date().toISOString().slice(0, 10);
  const sessions = useLoad(() => api.get('/physio/sessions/today'), [today]);

  if (sessions.loading && !sessions.data) return <Loading />;
  if (sessions.error) return <ErrorBox error={sessions.error} onRetry={sessions.reload} />;

  const items = sessions.data ?? [];

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 32 }}>
      <Card pad={12} color={c.violetSoft}>
        <T weight="900" size={16}>{t('physio.routine.title')}</T>
        <T size={12} color={c.mute}>{t('physio.routine.exercise_count', { count: items.length })}</T>
      </Card>

      {items.length === 0 ? (
        <Empty emoji="🏃" title={t('physio.routine.empty_title')} sub={t('physio.routine.empty_sub')} />
      ) : (
        items.map((s) => (
          <ExerciseCard key={s.id} session={s} onLogged={sessions.reload} />
        ))
      )}
    </ScrollView>
  );
}

export default PhysioRoutine;
