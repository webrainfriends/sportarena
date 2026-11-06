// Team volunteer self-signup and coordinator dashboard (feature 1).
// Tabs: Open Positions | My Duties | Coordinator (manager only)
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { FormSheet } from '../FormSheet';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, H2, HScroll, Loading, Row, Screen, Section, T, Tag } from '../ui';
import { c, r } from '../theme';
import { t } from '../i18n';

const CAT_COLORS = {
  general: c.violet, check_in: c.cyan, coaching_assistant: c.pink,
  first_aid: c.red, transport: c.sun, admin: c.lime,
};
const CATS = ['general','check_in','coaching_assistant','first_aid','transport','admin'];
const SHIRT_SIZES = ['XS','S','M','L','XL','XXL'].map(s => ({ value: s, label: s }));

function FillMeter({ filled, capacity }) {
  return (
    <View style={{ flexDirection: 'row', gap: 3, marginVertical: 4 }}>
      {Array.from({ length: capacity }).map((_, i) => (
        <View key={i} style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: i < filled ? c.lime : c.line }} />
      ))}
    </View>
  );
}

function PositionCard({ pos, onApply }) {
  const filled = Number(pos.filled_count ?? 0);
  const isFull = filled >= pos.capacity;
  const myStatus = pos.my_status;
  return (
    <Card pad={14} accessibilityLabel={pos.title}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <T weight="700" style={{ flex: 1 }}>{pos.title}</T>
        <Tag label={t(`vol.role.${pos.role_category}`)} color={CAT_COLORS[pos.role_category] ?? c.violet} />
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 4 }}>
        {t('vol.shift')}: {new Date(pos.shift_start).toLocaleString()} – {new Date(pos.shift_end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </T>
      <FillMeter filled={filled} capacity={pos.capacity} />
      <T size={12} color={c.mute}>{t('vol.filled_of', { filled, capacity: pos.capacity })}</T>
      {pos.meal_provided ? <T size={12} color={c.lime} style={{ marginTop: 2 }}>🍽 {t('vol.pos_meal')}</T> : null}
      <View style={{ marginTop: 10 }}>
        {!myStatus && !isFull && (
          <Btn small title={t('vol.apply')} color={c.pink} onPress={() => onApply(pos)} />
        )}
        {myStatus === 'pending' && <Tag label={t('vol.pending_badge')} color={c.sun} />}
        {myStatus === 'approved' && <Tag label={t('vol.applied')} color={c.lime} />}
        {myStatus === 'withdrawn' && <Tag label={t('vol.application_withdrawn')} color={c.mute} />}
        {isFull && !myStatus && <Tag label={t('cpool.full')} color={c.mute} />}
      </View>
    </Card>
  );
}

export function TeamVolunteers({ teamId, isManager }) {
  const [tab, setTab] = useState('positions');
  const [catFilter, setCatFilter] = useState(null);
  const [applyTarget, setApplyTarget] = useState(null);
  const [applyData, setApplyData] = useState({});
  const { toast } = useSession();

  const positions = useLoad(
    () => api.get(`/teams/${teamId}/volunteer-positions`, catFilter ? { category: catFilter } : {}),
    [teamId, catFilter]
  );
  const duties = useLoad(() => api.get('/me/volunteer-schedule'), []);
  const dashboard = useLoad(
    () => isManager ? api.get(`/teams/${teamId}/volunteer-dashboard`) : Promise.resolve(null),
    [teamId, isManager]
  );

  const tabs = [
    { key: 'positions', label: t('vol.positions') },
    { key: 'duties', label: t('vol.my_duties') },
    ...(isManager ? [{ key: 'coord', label: t('vol.coordinator') }] : []),
  ];

  const handleApply = async (data) => {
    await api.post(`/volunteer-positions/${applyTarget.id}/apply`, data);
    positions.reload();
    return t('vol.application_sent');
  };

  return (
    <Screen title={t('vol.title')}>
      <HScroll style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
        {tabs.map(tb => <Chip key={tb.key} label={tb.label} active={tab === tb.key} onPress={() => setTab(tb.key)} />)}
      </HScroll>

      {tab === 'positions' && (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <HScroll>
            <Chip label="All" active={!catFilter} onPress={() => setCatFilter(null)} />
            {CATS.map(cat => <Chip key={cat} label={t(`vol.role.${cat}`)} active={catFilter === cat} onPress={() => setCatFilter(cat)} />)}
          </HScroll>
          {positions.loading && !positions.data ? <Loading /> :
           positions.error ? <ErrorBox error={positions.error} onRetry={positions.reload} /> :
           positions.data?.positions?.length === 0 ?
             <Empty emoji="🙋" title={t('vol.empty_positions')} sub={t('vol.empty_positions_sub')} /> :
             positions.data?.positions?.map(p => <PositionCard key={p.id} pos={p} onApply={setApplyTarget} />)
          }
          {isManager && (
            <Btn title={t('vol.create_position')} color={c.pink} onPress={() => toast('Coming soon: use the coordinator tab')} />
          )}
        </ScrollView>
      )}

      {tab === 'duties' && (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          {duties.loading && !duties.data ? <Loading /> :
           duties.error ? <ErrorBox error={duties.error} onRetry={duties.reload} /> :
           duties.data?.schedule?.length === 0 ?
             <Empty emoji="📋" title={t('vol.empty_duties')} sub={t('vol.empty_duties_sub')} /> :
             duties.data?.schedule?.map(app => (
               <Card key={app.id} pad={14} accessibilityLabel={app.title}>
                 <T weight="700">{app.title}</T>
                 <T size={12} color={c.mute}>{app.team_name} · {new Date(app.shift_start).toLocaleString()}</T>
                 {app.location ? <T size={12} color={c.mute}>📍 {app.location}</T> : null}
                 <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                   {app.checked_in_at && !app.checked_out_at && <Tag label={t('vol.checked_in')} color={c.lime} />}
                   {app.checked_out_at && <Tag label={`${t('vol.hours_logged')}: ${Number(app.hours_logged ?? 0).toFixed(1)}h`} color={c.cyan} />}
                 </View>
               </Card>
             ))
          }
        </ScrollView>
      )}

      {tab === 'coord' && isManager && (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          {dashboard.loading && !dashboard.data ? <Loading /> :
           dashboard.error ? <ErrorBox error={dashboard.error} onRetry={dashboard.reload} /> : (
            <>
              <Btn title={t('vol.broadcast')} color={c.violet} onPress={() => toast('Broadcast sheet coming soon')} />
              <Section title={t('vol.leaderboard')} color={c.pink}>
                {(dashboard.data?.leaderboard ?? []).map((v, i) => (
                  <Card key={v.id} pad={12} accessibilityLabel={v.display_name}>
                    <Row>
                      <T weight="800" color={c.mute} style={{ width: 24 }}>#{i + 1}</T>
                      <Avatar user={v} size={28} />
                      <T style={{ flex: 1, marginLeft: 8 }}>{v.display_name}</T>
                      <T weight="700" color={c.lime}>{Number(v.total_hours ?? 0).toFixed(1)}h</T>
                    </Row>
                  </Card>
                ))}
              </Section>
              <Section title={`${t('vol.pending')} (${dashboard.data?.pending_count ?? 0})`} color={c.sun}>
                <T size={13} color={c.mute}>Manage applications from the Positions tab.</T>
              </Section>
            </>
          )}
        </ScrollView>
      )}

      <FormSheet
        visible={!!applyTarget}
        onClose={() => setApplyTarget(null)}
        title={t('vol.apply')}
        initial={{ shirt_size: '', note: '' }}
        fields={[
          { key: 'shirt_size', label: t('vol.shirt_size'), type: 'menu', options: SHIRT_SIZES },
          { key: 'note', label: t('vol.apply_note'), type: 'text', multiline: true },
        ]}
        onSubmit={handleApply}
      />
    </Screen>
  );
}
