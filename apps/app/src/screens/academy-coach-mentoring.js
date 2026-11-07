// Academy OS P1 / #791: Coach Mentoring — pairings, sessions, goals.
import React, { useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Row, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';

const statusColor = { active: c.green, paused: c.amber, ended: c.mute };

function GoalsList({ goals }) {
  if (!goals || goals.length === 0) return null;
  return (
    <View style={{ marginTop: 8 }}>
      {goals.map((g) => (
        <Row key={g.key} style={{ gap: 8, marginBottom: 4 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: g.status === 'achieved' ? c.green : c.mute, marginTop: 5 }} />
          <T size={13} style={{ flex: 1 }} color={g.status === 'achieved' ? c.mute : c.ink}>{g.label}</T>
          {g.status === 'achieved' && <Tag color={c.green} size="xs">Done</Tag>}
        </Row>
      ))}
    </View>
  );
}

function AgreedActionChips({ actions }) {
  if (!actions || actions.length === 0) return null;
  return (
    <Row style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {actions.map((a, idx) => (
        <Tag key={idx} color={a.status === 'done' ? c.green : a.status === 'cancelled' ? c.mute : c.amber}>
          {a.label}
        </Tag>
      ))}
    </Row>
  );
}

// ── Session Timeline ───────────────────────────────────────────────────────────
function SessionTimeline({ pairingId, mentorId, menteeId, userId }) {
  const [sheet, setSheet] = useState(null);
  const [form, setForm] = useState({});
  const { data: sessions, reload, loading, error } = useLoad(() =>
    api('GET', `/academy/mentor-pairings/${pairingId}/sessions`, { query: { status: 'all', limit: 50 } }),
  );

  const schedule = async () => {
    try {
      await api('POST', `/academy/mentor-pairings/${pairingId}/sessions`, { body: form });
      reload();
      setSheet(null);
    } catch (e) { alert(explain(e)); }
  };

  const complete = async (session) => {
    try {
      await api('POST', `/academy/mentor-sessions/${session.id}/complete`, {
        body: { row_version: session.row_version, agreed_actions: [] },
      });
      reload();
    } catch (e) { alert(explain(e)); }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;

  return (
    <View>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <T weight="700">Sessions</T>
        <Btn label={t('cEdu.mnt.scheduleSession')} size="sm" onPress={() => { setForm({ duration_min: 60 }); setSheet('schedule'); }} />
      </Row>
      {(!sessions || sessions.length === 0) ? (
        <Empty title="No sessions yet." action={{ label: t('cEdu.mnt.scheduleSession'), onPress: () => { setForm({ duration_min: 60 }); setSheet('schedule'); } }} />
      ) : sessions.map((s) => (
        <Card key={s.id} style={{ marginBottom: 8, paddingStart: 12, borderStartWidth: 3, borderStartColor: s.status === 'completed' ? c.green : s.status === 'cancelled' ? c.mute : c.amber }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <T size={13} weight="600">{new Date(s.scheduled_at).toLocaleDateString()}</T>
              <T size={12} color={c.mute}>{s.duration_min} min · {s.status}</T>
            </View>
            {s.status === 'scheduled' && (userId === mentorId || userId === menteeId) && (
              <Btn label={t('cEdu.mnt.completeSession')} size="xs" onPress={() => complete(s)} />
            )}
          </Row>
          <AgreedActionChips actions={s.agreed_actions} />
        </Card>
      ))}
      <FormSheet visible={sheet === 'schedule'} title={t('cEdu.mnt.scheduleSession')} onClose={() => setSheet(null)} onSave={schedule}>
        <T style={{ marginBottom: 4 }}>Scheduled date and time</T>
        {/* scheduled_at datetime picker */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>Duration (minutes)</T>
        {/* duration_min stepper */}
      </FormSheet>
    </View>
  );
}

// ── Pairing Detail ────────────────────────────────────────────────────────────
export function PairingDetail({ pairing, userId, onBack }) {
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      <Btn label="← Back" size="sm" variant="ghost" onPress={onBack} style={{ marginBottom: 12 }} />
      <Card style={{ marginBottom: 16 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View>
            <T weight="700">{t('cEdu.mnt.mentor')}: <T>{pairing.mentor_id}</T></T>
            <T weight="700">{t('cEdu.mnt.mentee')}: <T>{pairing.mentee_id}</T></T>
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('cEdu.mnt.startDate')}: {pairing.starts_on}</T>
            {pairing.ends_on && <T size={12} color={c.mute}>{t('cEdu.mnt.endDate')}: {pairing.ends_on}</T>}
          </View>
          <Tag color={statusColor[pairing.status] ?? c.mute}>{t(`cEdu.mnt.status.${pairing.status}`)}</Tag>
        </Row>
        <T size={12} color={c.mute} style={{ marginTop: 8 }}>Every {pairing.frequency_weeks} weeks</T>
      </Card>
      <T weight="700" style={{ marginBottom: 8 }}>{t('cEdu.mnt.goals')}</T>
      <Card style={{ marginBottom: 16 }}>
        <GoalsList goals={pairing.goals} />
      </Card>
      <SessionTimeline pairingId={pairing.id} mentorId={pairing.mentor_id} menteeId={pairing.mentee_id} userId={userId} />
    </ScrollView>
  );
}

// ── Coach Mentoring Hub ───────────────────────────────────────────────────────
export default function CoachMentoringHub({ org, user, role }) {
  const [sheet, setSheet] = useState(null);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({});
  const { width } = useWindowDimensions();
  const wide = width >= 768;

  const isGovern = role === 'admin' || role === 'owner' || role === 'td';

  const { data: pairings, reload, loading, error } = useLoad(() =>
    api('GET', `/organisations/${org.id}/academy/mentor-pairings`, { query: { status: 'all', limit: 100 } }),
  );

  const createPairing = async () => {
    try {
      await api('POST', `/organisations/${org.id}/academy/mentor-pairings`, { body: form });
      reload();
      setSheet(null);
    } catch (e) { alert(explain(e)); }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;

  if (selected) {
    return <PairingDetail pairing={selected} userId={user?.id} onBack={() => setSelected(null)} />;
  }

  return (
    <View style={{ flex: 1 }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <T size={18} weight="800">{t('cEdu.mnt.title')}</T>
        {isGovern && <Btn label={t('cEdu.mnt.newPairing')} size="sm" onPress={() => { setForm({ frequency_weeks: 2, goals: [] }); setSheet('pairing'); }} />}
      </Row>

      {(!pairings || pairings.length === 0) ? (
        <Empty
          title={t('cEdu.empty.pairings')}
          action={isGovern ? { label: t('cEdu.mnt.newPairing'), onPress: () => { setForm({ frequency_weeks: 2, goals: [] }); setSheet('pairing'); } } : undefined}
        />
      ) : pairings.map((p) => (
        <Pressable key={p.id} onPress={() => setSelected(p)}>
          <Card style={{ marginBottom: 8 }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Row style={{ gap: 8 }}>
                  <Tag color={statusColor[p.status] ?? c.mute}>{t(`cEdu.mnt.status.${p.status}`)}</Tag>
                  <T size={12} color={c.mute}>Every {p.frequency_weeks}w</T>
                </Row>
                <T size={12} color={c.mute} style={{ marginTop: 4 }}>
                  {p.sessions_done ?? 0} sessions done
                  {p.next_session_at ? ` · ${t('cEdu.mnt.nextSession', { date: new Date(p.next_session_at).toLocaleDateString() })}` : ''}
                </T>
                <T size={12} color={c.mute}>
                  {(p.goals ?? []).length} goal{(p.goals ?? []).length !== 1 ? 's' : ''}
                  {' · '}{(p.goals ?? []).filter((g) => g.status === 'achieved').length} achieved
                </T>
              </View>
              <T size={20} color={c.mute}>›</T>
            </Row>
          </Card>
        </Pressable>
      ))}

      <FormSheet visible={sheet === 'pairing'} title={t('cEdu.mnt.newPairing')} onClose={() => setSheet(null)} onSave={createPairing}>
        <T style={{ marginBottom: 4 }}>{t('cEdu.mnt.mentor')}</T>
        {/* mentor_id search-pick */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.mnt.mentee')}</T>
        {/* mentee_id search-pick */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.mnt.startDate')}</T>
        {/* starts_on date picker */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.mnt.frequency')}</T>
        {/* frequency_weeks stepper */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.mnt.goals')}</T>
        {/* goals list builder */}
      </FormSheet>
    </View>
  );
}
