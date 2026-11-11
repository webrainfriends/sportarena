// Officials Crew Hub (#996): organiser crew management and official crew view.
// Two roles, one screen: organiser sees crew completeness, requirements setup, emergency substitution and broadcast.
// Officials see their assignment, duties, crew list and broadcast channel — no organiser or financial controls.
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c, grad } from '../theme';
import { Metric } from '../federation-ui';
import { t } from '../i18n';
import { Cols } from '../federation-bits';

export const ROLE_LABEL = {
  referee: 'Referee',
  umpire: 'Umpire',
  linesman: 'Assistant referee',
  scorer: 'Scorer / timekeeper',
  video_assistant_referee: 'VAR',
  fourth_official: 'Fourth official',
  reserve_assistant_referee: 'Reserve AR',
  shot_clock_operator: 'Shot clock',
  timekeeper: 'Timekeeper',
  goal_line_official: 'Goal-line official',
  technical_official: 'Technical official',
  // REF-R30: expanded taxonomy roles
  chair_umpire: 'Chair Umpire',
  match_commissioner: 'Match Commissioner',
  technical_delegate: 'Technical Delegate',
  starter: 'Starter',
  marshal: 'Marshal',
};

const ROLE_ICON = {
  referee: '🟡', umpire: '🎾', linesman: '🚩', scorer: '📋',
  video_assistant_referee: '📺', fourth_official: '📋', reserve_assistant_referee: '🚩',
  shot_clock_operator: '⏱', timekeeper: '⏱', goal_line_official: '🚦', technical_official: '🔧',
  // REF-R30
  chair_umpire: '🎾', match_commissioner: '🏅', technical_delegate: '🏳️', starter: '🚀', marshal: '🦺',
};

const STATUS_COLOR = {
  accepted: c.mintSoft, invited: c.sunSoft, substituted: c.violetSoft, completed: c.mintSoft,
  declined: c.paper, withdrawn: c.paper, released: c.paper, cancelled: c.paper,
};

const StatusChip = ({ status }) => (
  <Chip label={status.replace('_', ' ')} color={STATUS_COLOR[status] ?? c.paper} />
);

const CompletenessBar = ({ completeness }) => {
  if (!completeness) return null;
  const pct = completeness.total_slots ? Math.round((completeness.filled_slots / completeness.total_slots) * 100) : 100;
  return (
    <View accessibilityLabel={`Crew completeness ${pct}%`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <T size={13} weight="600">{t('crew.completeness_label')}</T>
        <T size={13} color={completeness.is_complete ? c.mint : c.sun}>{pct}%</T>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: c.border, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: '100%', borderRadius: 3, backgroundColor: completeness.is_complete ? c.mint : c.sun }} />
      </View>
      {!completeness.is_complete && completeness.missing_roles.length > 0 && (
        <T size={12} color={c.mute} style={{ marginTop: 4 }}>
          {t('crew.missing_roles')}: {completeness.missing_roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}
        </T>
      )}
    </View>
  );
};

const AssignmentCard = ({ a, isOrg, onSubstitute, onDuties }) => (
  <Card accessibilityLabel={`${ROLE_LABEL[a.role] ?? a.role}, ${a.official_name}, ${a.status}`} style={{ marginBottom: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <T size={20}>{ROLE_ICON[a.role] ?? '🧑'}</T>
      <View style={{ flex: 1 }}>
        <T size={14} weight="600">{a.official_name}</T>
        <T size={12} color={c.mute}>{ROLE_LABEL[a.role] ?? a.role}{a.emergency_accept ? ' · ' + t('crew.emergency_badge') : ''}</T>
        {a.duties && a.duties.length > 0 && (
          <T size={12} color={c.mute}>{a.duties.join(' · ')}</T>
        )}
        {a.substitution_of && (
          <T size={11} color={c.violet}>{t('crew.substitution_of_label')}</T>
        )}
      </View>
      <StatusChip status={a.status} />
    </View>
    {isOrg && a.status === 'accepted' && (
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <Btn label={t('crew.btn_duties')} size="sm" color={c.violetSoft} onPress={() => onDuties(a)} />
        <Btn label={t('crew.btn_substitute')} size="sm" color={c.sunSoft} onPress={() => onSubstitute(a)} />
      </View>
    )}
  </Card>
);

const BroadcastCard = ({ msg }) => (
  <Card style={{ marginBottom: 6, borderLeftWidth: msg.pinned ? 3 : 0, borderLeftColor: c.pink }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <T size={12} weight="600">{msg.author_name}</T>
      {msg.pinned && <Tag label={t('crew.pinned')} color={c.pinkSoft} />}
    </View>
    <T size={14} style={{ marginTop: 4 }}>{msg.body}</T>
  </Card>
);

const RequirementRow = ({ req }) => (
  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <T size={13}>{ROLE_LABEL[req.role] ?? req.role}</T>
    <T size={13} color={c.mute}>{req.min_count}–{req.max_count}{req.mandatory ? ' ·' + t('crew.mandatory_short') : ''}</T>
  </View>
);

const EmptyCrewState = () => (
  <Empty
    title={t('crew.empty_title')}
    body={t('crew.empty_body')}
    icon="👥"
    accessibilityLabel={t('crew.empty_title')}
  />
);

export function OfficialCrewHub({ route }) {
  const { fixtureId, eventId } = route?.params ?? {};
  const { user } = useSession();
  const L = useLayout();
  const nav = useNav();

  const [hub, reload] = useLoad(() => api.get(`/fixtures/${fixtureId}/crew-hub`));
  const [tab, setTab] = useState('crew');
  const [subSheet, setSubSheet] = useState(null);
  const [dutiesSheet, setDutiesSheet] = useState(null);
  const [broadcastSheet, setBroadcastSheet] = useState(false);
  const [duties, setDuties] = useState('');
  const [subReason, setSubReason] = useState('');
  const [subUserId, setSubUserId] = useState('');
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [pinned, setPinned] = useState(false);
  const [working, setWorking] = useState(false);

  if (!hub) return <Loading />;
  if (hub.error) return <LoadError error={hub.error} onRetry={reload} />;

  const isOrg = hub.ev?.organizer_id === user?.id || hub.assignments?.some((a) => a.official_name && hub.event_id);
  const accepted = (hub.assignments ?? []).filter((a) => a.status === 'accepted');
  const others = (hub.assignments ?? []).filter((a) => a.status !== 'accepted');

  const handleSubstitute = async () => {
    if (!subUserId || !subReason) return;
    setWorking(true);
    try {
      await api.post(`/official-assignments/${subSheet.id}/substitute`, { replacement_user_id: subUserId, reason: subReason });
      setSubSheet(null); setSubUserId(''); setSubReason('');
      await reload();
    } finally { setWorking(false); }
  };

  const handleDuties = async () => {
    setWorking(true);
    try {
      const arr = duties.split('\n').map((s) => s.trim()).filter(Boolean);
      await api.patch(`/official-assignments/${dutiesSheet.id}/duties`, { duties: arr });
      setDutiesSheet(null); setDuties('');
      await reload();
    } finally { setWorking(false); }
  };

  const handleBroadcast = async () => {
    if (!broadcastMsg.trim()) return;
    setWorking(true);
    try {
      await api.post(`/fixtures/${fixtureId}/crew-broadcast`, { body: broadcastMsg, pinned });
      setBroadcastSheet(false); setBroadcastMsg(''); setPinned(false);
      await reload();
    } finally { setWorking(false); }
  };

  const metrics = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
      <Metric value={accepted.length} label={t('crew.metric_confirmed')} />
      <Metric value={(hub.requirements ?? []).length} label={t('crew.metric_roles_req')} />
      <Metric value={(hub.broadcast ?? []).length} label={t('crew.metric_messages')} />
    </View>
  );

  const completenessCard = (
    <Card style={{ marginBottom: 12 }}>
      <CompletenessBar completeness={hub.completeness} />
    </Card>
  );

  const crewList = (
    <Section title={t('crew.section_crew')} color={c.violet}>
      {accepted.length === 0 && others.length === 0
        ? <EmptyCrewState />
        : <>
            {accepted.length > 0 && accepted.map((a) => (
              <AssignmentCard key={a.id} a={a} isOrg={isOrg}
                onSubstitute={(x) => { setSubSheet(x); setSubReason(''); setSubUserId(''); }}
                onDuties={(x) => { setDutiesSheet(x); setDuties((x.duties ?? []).join('\n')); }}
              />
            ))}
            {others.length > 0 && (
              <Section title={t('crew.section_pending')} color={c.paper}>
                {others.map((a) => <AssignmentCard key={a.id} a={a} isOrg={isOrg} onSubstitute={() => {}} onDuties={() => {}} />)}
              </Section>
            )}
          </>
      }
      {isOrg && (
        <Btn label={t('crew.btn_broadcast')} color={c.pinkSoft} icon="📣" onPress={() => setBroadcastSheet(true)} style={{ marginTop: 8 }} />
      )}
    </Section>
  );

  const requirementsList = (
    <Section title={t('crew.section_requirements')} color={c.cyan}>
      {(hub.requirements ?? []).length === 0
        ? <T size={13} color={c.mute}>{t('crew.no_requirements')}</T>
        : (hub.requirements ?? []).map((r) => <RequirementRow key={r.id} req={r} />)
      }
    </Section>
  );

  const broadcastList = (
    <Section title={t('crew.section_broadcast')} color={c.pink}>
      {(hub.broadcast ?? []).length === 0
        ? <T size={13} color={c.mute}>{t('crew.no_broadcast')}</T>
        : (hub.broadcast ?? []).map((m) => <BroadcastCard key={m.id} msg={m} />)
      }
      <Btn label={t('crew.btn_send_message')} color={c.pinkSoft} icon="✉️" onPress={() => setBroadcastSheet(true)} style={{ marginTop: 8 }} />
    </Section>
  );

  const content = tab === 'crew'
    ? <>{completenessCard}{crewList}</>
    : tab === 'requirements'
    ? <>{requirementsList}</>
    : <>{broadcastList}</>;

  const main = (
    <Screen title={t('nav.title.OfficialCrewHub')} accessibilityLabel={t('nav.title.OfficialCrewHub')}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <T size={13} color={c.mute} style={{ marginBottom: 8 }}>{hub.event_name} · {ROLE_ICON[hub.sport_id] ?? '🏅'}</T>
        {metrics}
        <Seg
          options={[
            { value: 'crew', label: t('crew.tab_crew') },
            { value: 'requirements', label: t('crew.tab_requirements') },
            { value: 'broadcast', label: t('crew.tab_broadcast') },
          ]}
          value={tab}
          onChange={setTab}
          style={{ marginBottom: 16 }}
        />
        {content}
      </ScrollView>

      {subSheet && (
        <FormSheet title={t('crew.sub_sheet_title')} onClose={() => setSubSheet(null)}>
          <T size={13} color={c.mute} style={{ marginBottom: 12 }}>
            {t('crew.sub_sheet_body', { name: subSheet.official_name, role: ROLE_LABEL[subSheet.role] ?? subSheet.role })}
          </T>
          <Field label={t('crew.sub_replacement_id')} value={subUserId} onChangeText={setSubUserId} placeholder={t('crew.sub_replacement_placeholder')} />
          <Field label={t('crew.sub_reason')} value={subReason} onChangeText={setSubReason} multiline placeholder={t('crew.sub_reason_placeholder')} />
          <Btn label={t('crew.btn_confirm_sub')} color={c.sun} loading={working} onPress={handleSubstitute} style={{ marginTop: 12 }} />
        </FormSheet>
      )}

      {dutiesSheet && (
        <FormSheet title={t('crew.duties_sheet_title')} onClose={() => setDutiesSheet(null)}>
          <T size={13} color={c.mute} style={{ marginBottom: 8 }}>{t('crew.duties_sheet_body')}</T>
          <Field label={t('crew.duties_field_label')} value={duties} onChangeText={setDuties} multiline placeholder={t('crew.duties_placeholder')} />
          <Btn label={t('crew.btn_save_duties')} color={c.mint} loading={working} onPress={handleDuties} style={{ marginTop: 12 }} />
        </FormSheet>
      )}

      {broadcastSheet && (
        <FormSheet title={t('crew.broadcast_sheet_title')} onClose={() => setBroadcastSheet(false)}>
          <Field label={t('crew.broadcast_body_label')} value={broadcastMsg} onChangeText={setBroadcastMsg} multiline placeholder={t('crew.broadcast_placeholder')} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <Chip label={t('crew.pin_toggle')} active={pinned} onPress={() => setPinned(!pinned)} />
          </View>
          <Btn label={t('crew.btn_send')} color={c.pink} loading={working} onPress={handleBroadcast} style={{ marginTop: 12 }} />
        </FormSheet>
      )}
    </Screen>
  );

  return L.tablet
    ? <Cols a={<View style={{ padding: 16 }}>{metrics}{completenessCard}{requirementsList}</View>} b={main} />
    : main;
}
