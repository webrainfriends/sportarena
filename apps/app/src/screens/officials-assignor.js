// REF-R10: Assignor Hub — neutral third-party crew invitation screen.
// Assignors can invite officials for fixtures on behalf of the event organiser.
// Privacy: no fee, PII or roster fields shown to assignors.
import React, { useState, useCallback } from 'react';
import { View, ScrollView, TouchableOpacity } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c, grad } from '../theme';
import { t } from '../i18n';

const OFFICIAL_ROLES = [
  'referee', 'assistant_referee', 'fourth_official', 'video_assistant_referee',
  'reserve_assistant_referee', 'goal_line_official', 'umpire', 'linesman',
  'scorer', 'timekeeper', 'technical_official',
];

function ComplianceChip({ accepted, total, required }) {
  const deficit = required - accepted;
  const color = deficit <= 0 ? c.success : deficit >= 2 ? c.error : c.warning;
  const label = deficit <= 0 ? t('crew.requirements.compliant') : t('crew.requirements.deficit');
  return (
    <View style={{ backgroundColor: color + '22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' }}>
      <T style={{ color, fontSize: 12, fontWeight: '600' }}>{label} ({accepted}/{total})</T>
    </View>
  );
}

function FixtureRow({ fixture, onInvite }) {
  return (
    <Card style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <T style={{ fontWeight: '700', fontSize: 15 }}>{fixture.home_team ?? '—'} vs {fixture.away_team ?? '—'}</T>
          <T style={{ color: c.muted, fontSize: 13, marginTop: 2 }}>
            {fixture.round ? `Round ${fixture.round} · ` : ''}{fixture.scheduled_at ? new Date(fixture.scheduled_at).toLocaleDateString() : ''}
          </T>
        </View>
        <ComplianceChip accepted={fixture.accepted_crew ?? 0} total={fixture.total_crew ?? 0} required={3} />
      </View>
      <View style={{ marginTop: 12 }}>
        <Btn label={t('official.assignor.invite')} size="sm" onPress={() => onInvite(fixture)} />
      </View>
    </Card>
  );
}

function InviteSheet({ visible, fixture, onClose, onDone }) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState(OFFICIAL_ROLES[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const submit = useCallback(async () => {
    if (!userId.trim()) return;
    setLoading(true); setError(null);
    try {
      await api.post('/official-assignor/invite', { fixture_id: fixture.id, user_id: userId.trim(), role });
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [userId, role, fixture, onDone]);

  return (
    <FormSheet visible={visible} onClose={onClose} title={t('official.assignor.invite')}>
      <Section>
        <Field
          label="Official user ID"
          value={userId}
          onChangeText={setUserId}
          placeholder="Paste user ID"
          accessibilityLabel="Official user ID"
          autoCapitalize="none"
        />
        <Field
          label={t('official.assignor.select_role')}
          type="picker"
          value={role}
          onValueChange={setRole}
          options={OFFICIAL_ROLES.map((r) => ({ value: r, label: r.replace(/_/g, ' ') }))}
          accessibilityLabel={t('official.assignor.select_role')}
        />
        {error ? <T style={{ color: c.error, marginTop: 8 }}>{error}</T> : null}
      </Section>
      <Btn label={loading ? '…' : t('official.assignor.invite')} onPress={submit} disabled={loading || !userId.trim()} />
    </FormSheet>
  );
}

export default function OfficialsAssignorScreen({ route }) {
  const { eventId } = route?.params ?? {};
  const [inviteFixture, setInviteFixture] = useState(null);
  const { data, loading, error, reload } = useLoad(() => api.get('/official-assignor/hub', { event_id: eventId }), [eventId]);

  if (loading) return <Loading />;
  if (error) return <LoadError error={error} onRetry={reload} />;

  const { event, fixtures = [], my_invitations = [] } = data ?? {};

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {/* Header */}
        <GradCard gradient={grad.primary} style={{ marginBottom: 20, padding: 20 }}>
          <T style={{ color: '#fff', fontSize: 22, fontWeight: '800' }}>{t('official.assignor.hub')}</T>
          <T style={{ color: '#fff', opacity: 0.85, fontSize: 14, marginTop: 4 }}>{t('official.assignor.hub_subtitle')}</T>
          {event ? (
            <T style={{ color: '#fff', opacity: 0.7, fontSize: 13, marginTop: 8 }}>
              {event.sport_emoji} {event.name} · {event.city}
            </T>
          ) : null}
        </GradCard>

        {/* Fixtures */}
        <Section title="Fixtures">
          {fixtures.length === 0
            ? <Empty label={t('official.assignor.no_grants')} />
            : fixtures.map((f) => (
                <FixtureRow key={f.id} fixture={f} onInvite={setInviteFixture} />
              ))}
        </Section>

        {/* My invitations */}
        <Section title="My Invitations" style={{ marginTop: 20 }}>
          {my_invitations.length === 0
            ? <Empty label="No invitations sent yet" />
            : my_invitations.map((inv) => (
                <Card key={inv.id} style={{ marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <T style={{ fontWeight: '600' }}>{inv.official_name}</T>
                    <T style={{ color: c.muted, fontSize: 12 }}>{inv.role?.replace(/_/g, ' ')} · {new Date(inv.created_at).toLocaleDateString()}</T>
                  </View>
                  <Tag label={inv.status} color={inv.status === 'accepted' ? c.success : c.muted} />
                </Card>
              ))}
        </Section>
      </ScrollView>

      {inviteFixture && (
        <InviteSheet
          visible
          fixture={inviteFixture}
          onClose={() => setInviteFixture(null)}
          onDone={() => { setInviteFixture(null); reload(); }}
        />
      )}
    </Screen>
  );
}
