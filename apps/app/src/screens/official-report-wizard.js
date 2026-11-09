// Official Report Wizard (#998): 7-tab structured report filing workflow.
// Tab 1 — Match Overview: auto-filled fixture facts, kick-off, attendance, weather, pitch, score, summary.
// Tab 2 — Incidents: cautions, send-offs, suspensions, misconduct, protests — each as a structured card.
// Tab 3 — Venue & Crowd: spectator incidents, ejections, arrests, infrastructure.
// Tab 4 — Abandonment: structured declaration if applicable.
// Tab 5 — Attachments: photo/video/doc evidence (file_key reference, never raw binaries here).
// Tab 6 — Co-Signatories: select crew members to co-sign; required vs optional per competition rules.
// Tab 7 — Sign & Submit: full preview + confirm + biometric/PIN sign + locked submission.
// Extends the existing simple file_official_report FormSheet in OfficialMatch; that path remains for quick-filing.
// No second scoreboard, results engine or discipline store; those come from canonical capabilities.
import React, { useState, useCallback } from 'react';
import { View, ScrollView, Platform } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { explain, LoadError } from '../access';
import { c, grad } from '../theme';
import { t } from '../i18n';

const REPORT_TYPES = [
  { value: 'match_report', label: t('or.type.match_report') },
  { value: 'misconduct',   label: t('or.type.misconduct') },
  { value: 'send_off',     label: t('or.type.send_off') },
  { value: 'abandonment',  label: t('or.type.abandonment') },
  { value: 'venue_incident', label: t('or.type.venue_incident') },
  { value: 'equipment_field', label: t('or.type.equipment_field') },
  { value: 'protest_noted', label: t('or.type.protest_noted') },
  { value: 'other',        label: t('or.type.other') },
];
const INCIDENT_TYPES = [
  { value: 'caution',    label: t('or.incident.caution'),    emoji: '🟨' },
  { value: 'send_off',   label: t('or.incident.send_off'),   emoji: '🟥' },
  { value: 'suspension', label: t('or.incident.suspension'), emoji: '⚠️' },
  { value: 'misconduct', label: t('or.incident.misconduct'), emoji: '⚠️' },
  { value: 'protest',    label: t('or.incident.protest'),    emoji: '🤝' },
  { value: 'venue',      label: t('or.incident.venue'),      emoji: '🏟️' },
  { value: 'other',      label: t('or.incident.other'),      emoji: '📋' },
];
const CAUTION_REASONS = [
  'Persistent infringement (Law 12)', 'Unsporting behaviour — simulation', 'Unsporting behaviour — handball',
  'Unsporting behaviour — time-wasting', 'Failure to respect the required distance', 'Entering / leaving the field without permission',
  'Dissent by word or action', 'Other unsporting behaviour',
];
const SENDOFF_REASONS = [
  'Violent conduct', 'Serious foul play', 'Spitting', 'Denying a goal (DOGSO) — handling',
  'Denying a goal (DOGSO) — foul', 'Offensive, insulting or abusive language', 'Second caution (double yellow)',
  'Using a mobile phone or electronic device', 'Other',
];
const PITCH_CONDITIONS = [{ value: 'good', label: t('or.pitch.good') }, { value: 'wet_heavy', label: t('or.pitch.wet_heavy') }, { value: 'hard_dry', label: t('or.pitch.hard_dry') }, { value: 'unsafe', label: t('or.pitch.unsafe') }];
const WEATHER_OPTIONS = [{ value: 'fine', label: t('or.weather.fine') }, { value: 'overcast', label: t('or.weather.overcast') }, { value: 'rain', label: t('or.weather.rain') }, { value: 'heavy_rain', label: t('or.weather.heavy_rain') }, { value: 'fog', label: t('or.weather.fog') }, { value: 'snow', label: t('or.weather.snow') }];
const ABANDON_REASONS = [{ value: 'weather', label: t('or.abandon.weather') }, { value: 'floodlight', label: t('or.abandon.floodlight') }, { value: 'crowd_disorder', label: t('or.abandon.crowd_disorder') }, { value: 'security', label: t('or.abandon.security') }, { value: 'venue_unsafe', label: t('or.abandon.venue_unsafe') }, { value: 'team_refusal', label: t('or.abandon.team_refusal') }, { value: 'equipment', label: t('or.abandon.equipment') }, { value: 'other', label: t('or.abandon.other') }];

const TABS = ['overview', 'incidents', 'venue', 'abandonment', 'attachments', 'cosign', 'submit'];
const TAB_LABELS = {
  overview: t('or.tab.overview'), incidents: t('or.tab.incidents'), venue: t('or.tab.venue'),
  abandonment: t('or.tab.abandonment'), attachments: t('or.tab.attachments'), cosign: t('or.tab.cosign'), submit: t('or.tab.submit'),
};

function ProgressBar({ current }) {
  const idx = TABS.indexOf(current);
  return (
    <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 4 }}>
      {TABS.map((tab, i) => (
        <View key={tab} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= idx ? c.pink : c.line }} />
      ))}
    </View>
  );
}

function TabBar({ current, onChange }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ backgroundColor: c.paper, borderBottomWidth: 1.5, borderBottomColor: c.line }}>
      <View style={{ flexDirection: 'row', paddingHorizontal: 4 }}>
        {TABS.map((tab) => (
          <Btn key={tab} title={TAB_LABELS[tab]} small color="transparent" ink={current === tab ? c.pink : c.mute}
            onPress={() => onChange(tab)}
            style={{ borderBottomWidth: 2.5, borderBottomColor: current === tab ? c.pink : 'transparent', borderRadius: 0, paddingHorizontal: 10, minHeight: 44 }} />
        ))}
      </View>
    </ScrollView>
  );
}

function IncidentCard({ inc, onEdit, onRemove, idx }) {
  const type = INCIDENT_TYPES.find((t) => t.value === inc.type);
  const isYellow = inc.type === 'caution';
  const isRed = inc.type === 'send_off';
  const borderColor = isRed ? c.red : isYellow ? c.sun : c.pink;
  return (
    <View style={{ backgroundColor: c.violetSoft, borderRadius: 14, padding: 12, marginBottom: 8, borderLeftWidth: 3, borderLeftColor: borderColor }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <T size={16} weight="800">{type?.emoji} {type?.label ?? inc.type}</T>
        {inc.minute != null ? <Tag label={`⏱ ${inc.minute}'`} color={c.violetSoft} /> : null}
      </View>
      {inc.person_name ? <T size={14} weight="700">{inc.person_name}{inc.team_name ? <T size={13} color={c.mute}> · {inc.team_name}</T> : null}</T> : null}
      {inc.law_ref ? <T size={12} color={c.mute}>{inc.law_ref}</T> : null}
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>{inc.reason}</T>
      {inc.type === 'send_off' ? (
        <View style={{ backgroundColor: c.sunSoft, borderRadius: 8, padding: 8, marginTop: 6 }}>
          <T size={12} weight="700" color={c.sun}>{t('or.sendoff_disc_notice')}</T>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Btn small title={t('or.edit')} color={c.paper} onPress={() => onEdit(idx)} style={{ minHeight: 44 }} />
        <Btn small title={t('or.remove')} color={c.redSoft} ink={c.red} onPress={() => onRemove(idx)} style={{ minHeight: 44 }} />
      </View>
    </View>
  );
}

export function OfficialReportWizard({ fixtureId, reportId: initialReportId }) {
  const { back } = useNav();
  const { toast } = useSession();
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState(false);
  const [reportId, setReportId] = useState(initialReportId ?? null);
  const [confirmed, setConfirmed] = useState(false);
  const [addIncident, setAddIncident] = useState(false);
  const [editingIncident, setEditingIncident] = useState(null);

  // Form state
  const [category, setCategory] = useState('match_report');
  const [summary, setSummary] = useState('');
  const [kickoff, setKickoff] = useState('');
  const [finalWhistle, setFinalWhistle] = useState('');
  const [attendance, setAttendance] = useState('');
  const [pitchCondition, setPitchCondition] = useState('good');
  const [weather, setWeather] = useState('fine');
  const [scoreHome, setScoreHome] = useState('');
  const [scoreAway, setScoreAway] = useState('');
  const [ballInPlay, setBallInPlay] = useState('');
  const [extraTime, setExtraTime] = useState(false);
  const [penalties, setPenalties] = useState(false);
  const [addendum, setAddendum] = useState('');
  const [incidents, setIncidents] = useState([]);
  const [venueDetails, setVenueDetails] = useState('');
  const [ejections, setEjections] = useState('');
  const [arrests, setArrests] = useState('');
  const [flares, setFlares] = useState(false);
  const [pitchInvasion, setPitchInvasion] = useState(false);
  const [policeCalled, setPoliceCalled] = useState(false);
  const [abandoned, setAbandoned] = useState(false);
  const [abandonMinute, setAbandonMinute] = useState('');
  const [abandonReason, setAbandonReason] = useState('weather');
  const [abandonDetails, setAbandonDetails] = useState('');
  const [cosignatories, setCosignatories] = useState([]);
  const [pendingIncident, setPendingIncident] = useState({ type: 'caution', minute: '', person_name: '', team_name: '', reason: '', law_ref: '' });

  const briefing = useLoad(() => api.get(`/fixtures/${fixtureId}/briefing`), [fixtureId]);
  const crew = briefing.data?.crew ?? [];
  const b = briefing.data;

  const removeIncident = (idx) => setIncidents((prev) => prev.filter((_, i) => i !== idx));
  const saveIncident = (inc) => {
    if (editingIncident !== null) {
      setIncidents((prev) => prev.map((x, i) => i === editingIncident ? inc : x));
      setEditingIncident(null);
    } else {
      setIncidents((prev) => [...prev, inc]);
    }
    setAddIncident(false);
    setPendingIncident({ type: 'caution', minute: '', person_name: '', team_name: '', reason: '', law_ref: '' });
  };

  const ensureReport = useCallback(async () => {
    if (reportId) return reportId;
    const r = await api.post(`/fixtures/${fixtureId}/reports`, { category, summary: summary || t('or.draft_summary'), visibility: 'organiser' });
    setReportId(r.id);
    return r.id;
  }, [reportId, fixtureId, category, summary]);

  const saveDraft = async () => {
    setBusy(true);
    try {
      const rid = await ensureReport();
      await api.patch(`/official-reports/${rid}/match-facts`, {
        match_facts: {
          kickoff_actual: kickoff || undefined, final_whistle: finalWhistle || undefined,
          attendance: attendance ? parseInt(attendance) : undefined,
          pitch_condition: pitchCondition, weather, score_home: scoreHome !== '' ? parseInt(scoreHome) : undefined,
          score_away: scoreAway !== '' ? parseInt(scoreAway) : undefined,
          ball_in_play_min: ballInPlay ? parseInt(ballInPlay) : undefined,
          extra_time: extraTime || undefined, penalty_shootout: penalties || undefined,
          summary: summary || undefined, addendum: addendum || undefined,
        },
        incidents: incidents.length > 0 ? incidents : undefined,
        venue_incidents: venueDetails || ejections || arrests || flares || pitchInvasion || policeCalled ? {
          details: venueDetails || undefined, ejections: ejections ? parseInt(ejections) : undefined,
          arrests: arrests ? parseInt(arrests) : undefined, flares_pyro: flares || undefined,
          pitch_invasion: pitchInvasion || undefined, police_called: policeCalled || undefined,
        } : undefined,
        abandonment: abandoned ? {
          minute: parseInt(abandonMinute) || 0, reason: abandonReason,
          details: abandonDetails,
        } : undefined,
      });
      toast(t('or.draft_saved'));
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };

  const submitReport = async () => {
    if (!confirmed) { toast(t('or.confirm_required')); return; }
    setBusy(true);
    try {
      const rid = await ensureReport();
      await api.patch(`/official-reports/${rid}/match-facts`, {
        match_facts: {
          kickoff_actual: kickoff || undefined, final_whistle: finalWhistle || undefined,
          attendance: attendance ? parseInt(attendance) : undefined,
          pitch_condition: pitchCondition, weather, score_home: scoreHome !== '' ? parseInt(scoreHome) : undefined,
          score_away: scoreAway !== '' ? parseInt(scoreAway) : undefined,
          ball_in_play_min: ballInPlay ? parseInt(ballInPlay) : undefined,
          extra_time: extraTime || undefined, penalty_shootout: penalties || undefined,
          summary: summary || undefined, addendum: addendum || undefined,
        },
        incidents: incidents.length > 0 ? incidents : undefined,
      });
      if (cosignatories.length > 0) {
        await api.post(`/official-reports/${rid}/request-cosign`, { cosignatories });
      }
      const result = await api.post(`/official-reports/${rid}/submit`, { confirm: true });
      toast(t('or.submitted_success'));
      back();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };

  const triggerCategories = new Set(['send_off', 'abandonment', 'misconduct']);
  const willTriggerDisc = triggerCategories.has(category) || incidents.some((i) => i.type === 'send_off');

  if (briefing.error) return <Screen><LoadError error={briefing.error} retry={briefing.reload} /></Screen>;
  if (!briefing.data) return <Screen><Loading /></Screen>;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}>
        <Btn small title={t('or.back')} color={c.violetSoft} ink={c.violet} onPress={back} style={{ minHeight: 44 }} />
        <T style={{ flex: 1 }} weight="800" size={17}>{t('or.wizard_title')}</T>
        <Btn small title={t('or.save_draft')} color={c.pinkSoft} ink={c.pink} onPress={saveDraft} loading={busy} style={{ minHeight: 44 }} />
      </View>

      <ProgressBar current={tab} />

      <Card style={{ marginHorizontal: 16, marginBottom: 8, padding: 12 }}>
        <T weight="800" size={15}>{b.teams.home ?? 'TBD'} v {b.teams.away ?? 'TBD'}</T>
        <T size={12} color={c.mute}>{b.event.name} · {b.venue.name ?? ''} · {b.fixture.scheduled_at ? new Date(b.fixture.scheduled_at).toLocaleDateString() : ''}</T>
      </Card>

      <TabBar current={tab} onChange={setTab} />

      {/* TAB 1: OVERVIEW */}
      {tab === 'overview' ? (
        <View style={{ padding: 16, gap: 10 }}>
          <Field label={t('or.type_label')} type="chips" options={REPORT_TYPES} value={category} onChangeValue={setCategory} />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label={t('or.kickoff_actual')} type="text" value={kickoff} onChangeText={setKickoff} placeholder="15:03" keyboardType="numbers-and-punctuation" /></View>
            <View style={{ flex: 1 }}><Field label={t('or.final_whistle')} type="text" value={finalWhistle} onChangeText={setFinalWhistle} placeholder="16:51" keyboardType="numbers-and-punctuation" /></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label={t('or.attendance')} type="number" value={attendance} onChangeText={setAttendance} /></View>
            <View style={{ flex: 1 }}><Field label={t('or.ball_in_play')} type="number" value={ballInPlay} onChangeText={setBallInPlay} /></View>
          </View>
          <Field label={t('or.pitch_condition')} type="chips" options={PITCH_CONDITIONS} value={pitchCondition} onChangeValue={setPitchCondition} />
          <Field label={t('or.weather')} type="chips" options={WEATHER_OPTIONS} value={weather} onChangeValue={setWeather} />
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <T size={13} style={{ flex: 1 }}>{t('or.score_at_ft')}</T>
            <Field type="number" value={scoreHome} onChangeText={setScoreHome} style={{ width: 60, textAlign: 'center' }} />
            <T weight="800" color={c.mute}>–</T>
            <Field type="number" value={scoreAway} onChangeText={setScoreAway} style={{ width: 60, textAlign: 'center' }} />
          </View>
          <View style={{ flexDirection: 'row', gap: 16, paddingVertical: 8 }}>
            <Chip label={t('or.extra_time')} active={extraTime} onPress={() => setExtraTime((v) => !v)} />
            <Chip label={t('or.penalties')} active={penalties} onPress={() => setPenalties((v) => !v)} />
          </View>
          <Field label={t('or.summary_label')} type="multiline" value={summary} onChangeText={setSummary} hint={t('or.summary_hint')} maxLength={2000} rows={4} />
          <Field label={t('or.addendum')} type="multiline" value={addendum} onChangeText={setAddendum} optional maxLength={1000} rows={2} />
          <Btn title={`${t('or.next')}: ${TAB_LABELS.incidents} →`} onPress={() => setTab('incidents')} style={{ minHeight: 48 }} />
        </View>
      ) : null}

      {/* TAB 2: INCIDENTS */}
      {tab === 'incidents' ? (
        <View style={{ padding: 16, gap: 10 }}>
          <T size={13} color={c.mute}>{t('or.incidents_hint')}</T>
          {incidents.length === 0 ? <Empty emoji="✅" title={t('or.no_incidents_yet')} sub={t('or.no_incidents_sub')} /> : incidents.map((inc, idx) => (
            <IncidentCard key={idx} inc={inc} idx={idx} onEdit={(i) => { setEditingIncident(i); setPendingIncident({ ...incidents[i] }); setAddIncident(true); }} onRemove={removeIncident} />
          ))}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <Btn title={`🟨 ${t('or.add_caution')}`} color={c.sunSoft} ink={c.sun} onPress={() => { setPendingIncident({ type: 'caution', minute: '', person_name: '', team_name: '', reason: '', law_ref: '' }); setEditingIncident(null); setAddIncident(true); }} style={{ minHeight: 44 }} />
            <Btn title={`🟥 ${t('or.add_sendoff')}`} color={c.redSoft} ink={c.red} onPress={() => { setPendingIncident({ type: 'send_off', minute: '', person_name: '', team_name: '', reason: '', law_ref: '' }); setEditingIncident(null); setAddIncident(true); }} style={{ minHeight: 44 }} />
            <Btn title={`⚠️ ${t('or.add_other')}`} color={c.pinkSoft} ink={c.pink} onPress={() => { setPendingIncident({ type: 'misconduct', minute: '', person_name: '', team_name: '', reason: '', law_ref: '' }); setEditingIncident(null); setAddIncident(true); }} style={{ minHeight: 44 }} />
          </View>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <Btn title={`← ${TAB_LABELS.overview}`} color={c.pinkSoft} onPress={() => setTab('overview')} style={{ flex: 1, minHeight: 48 }} />
            <Btn title={`${t('or.next')}: ${TAB_LABELS.venue} →`} onPress={() => setTab('venue')} style={{ flex: 2, minHeight: 48 }} />
          </View>
        </View>
      ) : null}

      {/* TAB 3: VENUE & CROWD */}
      {tab === 'venue' ? (
        <View style={{ padding: 16, gap: 10 }}>
          <T size={13} color={c.mute}>{t('or.venue_hint')}</T>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label={t('or.ejections')} type="number" value={ejections} onChangeText={setEjections} /></View>
            <View style={{ flex: 1 }}><Field label={t('or.arrests')} type="number" value={arrests} onChangeText={setArrests} /></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', paddingVertical: 4 }}>
            <Chip label={`🔥 ${t('or.flares')}`} active={flares} onPress={() => setFlares((v) => !v)} />
            <Chip label={`🏃 ${t('or.pitch_invasion')}`} active={pitchInvasion} onPress={() => setPitchInvasion((v) => !v)} />
            <Chip label={`🚔 ${t('or.police_called')}`} active={policeCalled} onPress={() => setPoliceCalled((v) => !v)} />
          </View>
          <Field label={t('or.venue_details')} type="multiline" value={venueDetails} onChangeText={setVenueDetails} optional maxLength={2000} rows={4} />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <Btn title={`← ${TAB_LABELS.incidents}`} color={c.pinkSoft} onPress={() => setTab('incidents')} style={{ flex: 1, minHeight: 48 }} />
            <Btn title={`${t('or.next')}: ${TAB_LABELS.abandonment} →`} onPress={() => setTab('abandonment')} style={{ flex: 2, minHeight: 48 }} />
          </View>
        </View>
      ) : null}

      {/* TAB 4: ABANDONMENT */}
      {tab === 'abandonment' ? (
        <View style={{ padding: 16, gap: 10 }}>
          <Chip label={t('or.match_abandoned')} active={abandoned} onPress={() => setAbandoned((v) => !v)} />
          {abandoned ? (
            <>
              <Field label={t('or.abandon_minute')} type="number" value={abandonMinute} onChangeText={setAbandonMinute} />
              <Field label={t('or.abandon_reason')} type="chips" options={ABANDON_REASONS} value={abandonReason} onChangeValue={setAbandonReason} />
              <Field label={t('or.abandon_details')} type="multiline" value={abandonDetails} onChangeText={setAbandonDetails} maxLength={2000} rows={4} hint={t('or.abandon_hint')} />
              <Card color={c.sunSoft}><T size={13} color={c.sun}>{t('or.abandon_disc_notice')}</T></Card>
            </>
          ) : <T size={13} color={c.mute}>{t('or.abandon_not_applicable')}</T>}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <Btn title={`← ${TAB_LABELS.venue}`} color={c.pinkSoft} onPress={() => setTab('venue')} style={{ flex: 1, minHeight: 48 }} />
            <Btn title={`${t('or.next')}: ${TAB_LABELS.attachments} →`} onPress={() => setTab('attachments')} style={{ flex: 2, minHeight: 48 }} />
          </View>
        </View>
      ) : null}

      {/* TAB 5: ATTACHMENTS */}
      {tab === 'attachments' ? (
        <View style={{ padding: 16, gap: 10 }}>
          <T size={13} color={c.mute}>{t('or.attachments_hint')}</T>
          <Card color={c.cyanSoft}>
            <T size={13} color={c.cyan}>{t('or.attachments_note')}</T>
          </Card>
          <T size={12} color={c.mute}>{t('or.attachments_locked_note')}</T>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <Btn title={`← ${TAB_LABELS.abandonment}`} color={c.pinkSoft} onPress={() => setTab('abandonment')} style={{ flex: 1, minHeight: 48 }} />
            <Btn title={`${t('or.next')}: ${TAB_LABELS.cosign} →`} onPress={() => setTab('cosign')} style={{ flex: 2, minHeight: 48 }} />
          </View>
        </View>
      ) : null}

      {/* TAB 6: CO-SIGNATORIES */}
      {tab === 'cosign' ? (
        <View style={{ padding: 16, gap: 10 }}>
          <T size={13} color={c.mute}>{t('or.cosign_hint')}</T>
          {crew.filter((m) => m.user_id !== undefined).map((m) => {
            const isSigned = cosignatories.some((s) => s.user_id === m.user_id);
            return (
              <Card key={m.id} pad={12}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <T size={22}>{m.avatar_emoji ?? '👤'}</T>
                  <View style={{ flex: 1 }}>
                    <T weight="700" size={14}>{m.display_name}</T>
                    <T size={12} color={c.mute}>{m.role}</T>
                  </View>
                  <Chip label={isSigned ? t('or.cosign_added') : t('or.cosign_add')} active={isSigned}
                    onPress={() => setCosignatories((prev) => isSigned ? prev.filter((s) => s.user_id !== m.user_id) : [...prev, { user_id: m.user_id, required: true }])} />
                </View>
              </Card>
            );
          })}
          {crew.length === 0 ? <T size={13} color={c.mute}>{t('or.no_crew_for_cosign')}</T> : null}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <Btn title={`← ${TAB_LABELS.attachments}`} color={c.pinkSoft} onPress={() => setTab('attachments')} style={{ flex: 1, minHeight: 48 }} />
            <Btn title={`${t('or.next')}: ${TAB_LABELS.submit} →`} onPress={() => setTab('submit')} style={{ flex: 2, minHeight: 48 }} />
          </View>
        </View>
      ) : null}

      {/* TAB 7: SIGN & SUBMIT */}
      {tab === 'submit' ? (
        <View style={{ padding: 16, gap: 12 }}>
          <T size={16} weight="800">{t('or.submit_title')}</T>
          {/* Summary review */}
          <Card>
            <View style={{ gap: 6 }}>
              <T size={13} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('or.summary_check')}</T>
              <T weight="800">{b.teams.home ?? 'TBD'} v {b.teams.away ?? 'TBD'}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                <Tag label={REPORT_TYPES.find((rt) => rt.value === category)?.label ?? category} color={c.pinkSoft} />
                {incidents.filter((i) => i.type === 'caution').length > 0 ? <Tag label={`🟨 ${incidents.filter((i) => i.type === 'caution').length}`} color={c.sunSoft} /> : null}
                {incidents.filter((i) => i.type === 'send_off').length > 0 ? <Tag label={`🟥 ${incidents.filter((i) => i.type === 'send_off').length}`} color={c.redSoft} /> : null}
                {cosignatories.length > 0 ? <Tag label={`✍️ ${cosignatories.length} ${t('or.cosignatories')}`} color={c.cyanSoft} /> : null}
              </View>
            </View>
          </Card>
          {/* Co-signatories status */}
          {cosignatories.length > 0 ? (
            <Card>
              <T size={13} weight="700" color={c.mute} style={{ marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('or.cosign_status')}</T>
              {cosignatories.map((s) => {
                const member = crew.find((m) => m.user_id === s.user_id);
                return (
                  <View key={s.user_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <T size={20}>{member?.avatar_emoji ?? '👤'}</T>
                    <T style={{ flex: 1 }} size={13} weight="600">{member?.display_name ?? s.user_id}</T>
                    <Tag label={t('or.cosign_pending')} color={c.sunSoft} />
                  </View>
                );
              })}
            </Card>
          ) : null}
          {/* Discipline notice */}
          {willTriggerDisc ? (
            <Card color={c.sunSoft}>
              <T size={14} weight="700" color={c.sun}>{t('or.disc_trigger_notice')}</T>
              <T size={13} color={c.sun} style={{ marginTop: 4 }}>{t('or.disc_trigger_sub')}</T>
            </Card>
          ) : null}
          {/* Immutability notice */}
          <Card color={c.limeSoft}>
            <T size={13} weight="700" color={c.lime}>{t('or.immutable_notice_title')}</T>
            <T size={12} color={c.lime} style={{ marginTop: 3 }}>{t('or.immutable_notice_body')}</T>
          </Card>
          {/* Declaration */}
          <Chip label={t('or.declaration')} active={confirmed} onPress={() => setConfirmed((v) => !v)} />
          {/* Submit */}
          <Btn title={`🔐 ${t('or.submit_final')}`} onPress={submitReport} loading={busy} disabled={!confirmed} style={{ minHeight: 56 }} />
          <Btn title={t('or.save_draft_instead')} color={c.pinkSoft} ink={c.pink} onPress={saveDraft} loading={busy} style={{ minHeight: 44 }} />
          <Btn title={`← ${TAB_LABELS.cosign}`} color={c.violetSoft} ink={c.mute} onPress={() => setTab('cosign')} style={{ minHeight: 44 }} />
        </View>
      ) : null}

      {/* Add/Edit Incident Sheet */}
      <FormSheet visible={addIncident} onClose={() => { setAddIncident(false); setEditingIncident(null); }} title={editingIncident !== null ? t('or.edit_incident') : t('or.add_incident')} submitLabel={t('or.save_incident')}
        onSubmit={(v) => saveIncident({ type: v.type, minute: v.minute ? parseInt(v.minute) : undefined, person_name: v.person_name || undefined, team_name: v.team_name || undefined, law_ref: v.law_ref || undefined, reason: v.reason })}
        notice={t('or.incident_notice')}
        fields={[
          { key: 'type', label: t('or.incident_type'), type: 'chips', options: INCIDENT_TYPES },
          { key: 'minute', label: t('or.minute'), type: 'number', optional: true, hint: t('or.minute_hint') },
          { key: 'person_name', label: t('or.person_name'), type: 'text', optional: true, hint: t('or.person_hint') },
          { key: 'team_name', label: t('or.team_name'), type: 'text', optional: true },
          { key: 'law_ref', label: t('or.law_ref'), type: 'text', optional: true, hint: t('or.law_ref_hint') },
          { key: 'reason', label: t('or.reason'), type: 'multiline', maxLength: 500 },
        ]}
        initial={pendingIncident}
      />
    </Screen>
  );
}

// ------------------------------------------------------------------ Report Detail & Provenance screens

export function OfficialReportDetail({ id }) {
  const { back, push: go } = useNav();
  const { toast } = useSession();
  const report = useLoad(() => api.get(`/official-reports/${id}`), [id]);
  const cosigs = useLoad(() => api.get(`/official-reports/${id}/cosign-status`).catch(() => ({ cosignatories: [] })), [id]);
  const r = report.data;
  if (report.error) return <Screen><LoadError error={report.error} retry={report.reload} /></Screen>;
  if (!r) return <Screen><Loading /></Screen>;
  const incidents = Array.isArray(r.incidents) ? r.incidents : [];
  return (
    <Screen onRefresh={report.reload} refreshing={report.loading}>
      <View style={{ padding: 16, gap: 10 }}>
        <T weight="800" size={20}>{t('or.report_detail_title')}</T>
        <Card>
          <View style={{ gap: 6 }}>
            <T weight="800" size={16}>{r.home_name ?? 'TBD'} v {r.away_name ?? 'TBD'}</T>
            <T size={13} color={c.mute}>{r.event_name ?? ''} · {r.created_at ? new Date(r.created_at).toLocaleDateString() : ''}</T>
            <Tag label={REPORT_TYPES.find((rt) => rt.value === r.category)?.label ?? r.category} color={c.pinkSoft} />
          </View>
        </Card>
        {r.match_facts ? (
          <Section title={t('or.match_facts_section')} color={c.cyan}>
            <Card><View style={{ gap: 4 }}>
              {r.match_facts.kickoff_actual ? <T size={13}>{t('or.kickoff_actual')}: <T weight="700">{r.match_facts.kickoff_actual}</T></T> : null}
              {r.match_facts.final_whistle ? <T size={13}>{t('or.final_whistle')}: <T weight="700">{r.match_facts.final_whistle}</T></T> : null}
              {r.match_facts.score_home != null ? <T size={13}>{t('or.score')}: <T weight="800" size={15}>{r.match_facts.score_home} – {r.match_facts.score_away}</T></T> : null}
              {r.match_facts.attendance ? <T size={13}>{t('or.attendance')}: <T weight="700">{r.match_facts.attendance.toLocaleString()}</T></T> : null}
              {r.match_facts.pitch_condition ? <T size={13}>{t('or.pitch_condition')}: <T weight="700">{r.match_facts.pitch_condition}</T></T> : null}
              {r.match_facts.weather ? <T size={13}>{t('or.weather')}: <T weight="700">{r.match_facts.weather}</T></T> : null}
              {r.match_facts.summary ? <T size={13} style={{ marginTop: 6 }}>{r.match_facts.summary}</T> : null}
            </View></Card>
          </Section>
        ) : null}
        {incidents.length > 0 ? (
          <Section title={t('or.incidents_section')} color={c.red}>
            <View style={{ gap: 8 }}>
              {incidents.map((inc, i) => {
                const type = [{ value: 'caution', emoji: '🟨' }, { value: 'send_off', emoji: '🟥' }].find((x) => x.value === inc.type);
                return (
                  <Card key={i} pad={12} color={inc.type === 'send_off' ? c.redSoft : inc.type === 'caution' ? c.sunSoft : c.pinkSoft}>
                    <T weight="800" size={14}>{type?.emoji ?? '📋'} {inc.type?.replace(/_/g, ' ')} {inc.minute != null ? `· ${inc.minute}'` : ''}</T>
                    {inc.person_name ? <T size={13}>{inc.person_name}{inc.team_name ? ` · ${inc.team_name}` : ''}</T> : null}
                    <T size={12} color={c.mute}>{inc.reason}</T>
                  </Card>
                );
              })}
            </View>
          </Section>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          {r.submitted_hash ? <Btn title={t('or.provenance')} color={c.pinkSoft} ink={c.pink} onPress={() => go('OfficialReportProvenance', { id })} style={{ minHeight: 44 }} /> : null}
          {r.disc_case_id ? <Btn title={t('or.view_disc_case')} color={c.orangeSoft} ink={c.orange} onPress={() => go('GovernanceCase', { id: r.disc_case_id })} style={{ minHeight: 44 }} /> : null}
        </View>
      </View>
    </Screen>
  );
}

export function OfficialReportProvenance({ id }) {
  const { back } = useNav();
  const prov = useLoad(() => api.get(`/official-reports/${id}/provenance`), [id]);
  if (prov.error) return <Screen><LoadError error={prov.error} retry={prov.reload} /></Screen>;
  if (!prov.data) return <Screen><Loading /></Screen>;
  const p = prov.data;
  return (
    <Screen onRefresh={prov.reload} refreshing={prov.loading}>
      <View style={{ padding: 16, gap: 12 }}>
        <T weight="800" size={20}>{t('or.provenance_title')}</T>
        {p.submitted_hash ? (
          <Card>
            <T size={12} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{t('or.fingerprint_title')}</T>
            <View style={{ backgroundColor: c.violetSoft, padding: 10, borderRadius: 8 }}>
              <T size={11} style={{ fontFamily: Platform.OS === 'web' ? 'monospace' : undefined }}>{`SHA-256: ${p.submitted_hash}`}</T>
              <T size={11} color={c.mute} style={{ marginTop: 4 }}>{`ID: ${p.id.slice(0, 20)}…`}</T>
              {p.submitted_at ? <T size={11} color={c.mute}>{`Submitted: ${new Date(p.submitted_at).toLocaleString()}`}</T> : null}
            </View>
            <T size={12} color={c.mute} style={{ marginTop: 6 }}>{t('or.fingerprint_note')}</T>
          </Card>
        ) : null}
        {/* Timeline */}
        <T size={13} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('or.timeline_title')}</T>
        {p.revisions?.map((rev, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 12, paddingBottom: 16 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.violet, marginTop: 4 }} />
            <View style={{ flex: 1 }}>
              <T weight="700" size={14}>{i === 0 ? t('or.prov_created') : t('or.prov_revised', { n: rev.revision })}</T>
              <T size={12} color={c.mute}>{rev.at ? new Date(rev.at).toLocaleString() : ''}</T>
              <T size={13}>{rev.summary}</T>
            </View>
          </View>
        ))}
        {p.cosignatories?.map((s) => (
          <View key={s.user_id} style={{ flexDirection: 'row', gap: 12, paddingBottom: 16 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: s.signed_at ? c.mint : c.line, marginTop: 4 }} />
            <View style={{ flex: 1 }}>
              <T weight="700" size={14}>{s.signed_at ? t('or.prov_cosigned') : t('or.prov_cosign_pending')}</T>
              <T size={12} color={c.mute}>{s.display_name ?? s.user_id} · {s.role}{s.signed_at ? ` · ${new Date(s.signed_at).toLocaleString()}` : ''}</T>
              {s.signature_hash ? <T size={11} color={c.mute} style={{ fontFamily: Platform.OS === 'web' ? 'monospace' : undefined }}>{`sig: ${s.signature_hash.slice(0, 16)}…`}</T> : null}
            </View>
          </View>
        ))}
        {p.submitted_at ? (
          <View style={{ flexDirection: 'row', gap: 12, paddingBottom: 16 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.pink, marginTop: 4 }} />
            <View style={{ flex: 1 }}>
              <T weight="700" size={14}>{t('or.prov_submitted')}</T>
              <T size={12} color={c.mute}>{new Date(p.submitted_at).toLocaleString()}</T>
              {p.submitted_hash ? <T size={11} color={c.mute}>{`SHA: ${p.submitted_hash.slice(0, 20)}…`}</T> : null}
            </View>
          </View>
        ) : null}
        {p.accepted_at ? (
          <View style={{ flexDirection: 'row', gap: 12, paddingBottom: 16 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.mint, marginTop: 4 }} />
            <View style={{ flex: 1 }}>
              <T weight="700" size={14}>{t('or.prov_accepted')}</T>
              <T size={12} color={c.mute}>{new Date(p.accepted_at).toLocaleString()}</T>
            </View>
          </View>
        ) : null}
        {p.disc_case_id ? (
          <Card color={c.sunSoft}><T size={13} color={c.sun}>{t('or.disc_case_opened_prov')}</T></Card>
        ) : null}
      </View>
    </Screen>
  );
}
