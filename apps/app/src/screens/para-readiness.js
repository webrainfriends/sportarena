// PS-10 (#840): Accessible tournament operational-readiness gate.
// ParaReadinessDashboard: organiser/venue/official view — Arena dark theme, event console tab.
// ParaAthleteAccess: athlete-facing operational access info — Dusk theme.
// API-first: all state from /events/:id/ops/para-readiness and related endpoints.
// Works on iOS, iPadOS, Android and web. 44pt touch targets, RTL-safe, accessible labels.
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { A, ABtn, ACard, AChip, AEmpty, ASection, AStat, AT, ATag } from '../arena';
import { Card, ErrorBox, Loading, T, Tag, Field } from '../ui';
import { FormSheet } from '../FormSheet';
import { useDo } from './console-utils';
import { c } from '../theme';
import { t } from '../i18n';

// ---------------------------------------------------------------- state colours

const STATE_TONE = { met: A.green, open: A.red, waived: A.mute, exception: A.sun };
const STATE_LABEL = { met: '✅', open: '⛔', waived: '—', exception: '⚠️' };
const CAT_ICON = {
  accessible_facilities: '♿',
  classification: '🏷️',
  support_roles: '🤝',
  medical: '🏥',
  equipment: '🪑',
  transport_access: '🚌',
  communication: '📢',
};
const CAT_ORDER = ['accessible_facilities','classification','support_roles','medical','equipment','transport_access','communication'];

// ---------------------------------------------------------------- small helpers

const Row = ({ children }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
const Divider = () => <View style={{ height: 1, backgroundColor: A.line, marginVertical: 4 }} />;
const SBadge = ({ critical }) => critical
  ? <View style={{ backgroundColor: `${A.red}33`, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}><AT size={10} weight="900" color={A.red}>{t('pr.safety_critical')}</AT></View>
  : null;

function ReadinessBar({ percent, canOpen, blockers }) {
  const green = percent === 100;
  return (
    <View accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }}
      accessibilityLabel={t('pr.bar_a11y', { percent, blockers })}>
      <View style={{ height: 10, backgroundColor: A.line, borderRadius: 5, overflow: 'hidden', marginBottom: 6 }}>
        <View style={{ width: `${percent}%`, height: '100%', backgroundColor: green ? A.green : percent >= 60 ? A.sun : A.red, borderRadius: 5 }} />
      </View>
      <Row>
        <AT size={22} weight="900" color={green ? A.green : A.red}>{percent}%</AT>
        <AT size={13} weight="600" color={A.mute} style={{ alignSelf: 'flex-end', marginBottom: 2 }}>
          {canOpen ? t('pr.gate_clear') : t('pr.gate_blocked', { n: blockers })}
        </AT>
      </Row>
    </View>
  );
}

// ---------------------------------------------------------------- Requirement card

function ReqCard({ item, onSignOff, onException, role }) {
  const tone = STATE_TONE[item.state] ?? A.mute;
  const icon = STATE_LABEL[item.state] ?? '?';
  const canAct = role === 'organiser' || role === 'lead';
  return (
    <ACard tone={item.is_safety_critical && item.state === 'open' ? A.red : undefined}
      style={{ gap: 6, paddingHorizontal: 14, paddingVertical: 12 }}
      accessibilityLabel={`${item.title}, ${t(`pr.state.${item.state}`)}, ${item.detail}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <AT size={14} weight="700" style={{ flex: 1 }}>{item.title}</AT>
        <ATag label={`${icon} ${t(`pr.state.${item.state}`)}`} color={tone} />
      </View>
      <Row>
        {item.is_safety_critical && <SBadge critical />}
        {item.derived && <View style={{ backgroundColor: `${A.cyan}22`, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}><AT size={10} weight="700" color={A.cyan}>{t('pr.derived')}</AT></View>}
      </Row>
      <AT size={12} weight="500" color={A.mute}>{item.detail}</AT>
      {item.exception && (
        <AT size={11} color={A.sun}>{t('pr.exception_valid', { until: item.exception.valid_until ?? t('pr.indefinite') })}</AT>
      )}
      {item.changed_since_signoff && <AT size={11} color={A.sun}>{t('pr.changed_alert')}</AT>}
      {item.signoff_at && <AT size={11} color={A.mute}>{t('pr.signed', { who: item.signoff_by_name ?? '—', when: String(item.signoff_at).slice(0, 10) })}</AT>}
      {canAct && item.state === 'open' && (
        <Row>
          {!item.derived && <ABtn small tone="neon" title={t('pr.sign_off')} onPress={() => onSignOff(item)} accessibilityLabel={t('pr.sign_off_a11y', { title: item.title })} />}
          <ABtn small tone="ghost" title={t('pr.exception')} onPress={() => onException(item)} accessibilityLabel={t('pr.exception_a11y', { title: item.title })} />
        </Row>
      )}
    </ACard>
  );
}

// ---------------------------------------------------------------- Sign-off sheet

function SignOffSheet({ item, eventId, onClose, onDone }) {
  const [val, setVal] = useState({ evidence_ref: '', note: '' });
  const { doing, run, err } = useDo(onDone);
  if (!item) return null;
  return (
    <FormSheet visible={!!item} onClose={onClose} title={t('pr.signoff_title')}
      submitLabel={t('pr.signoff_submit')} submitting={doing} error={err}
      onSubmit={() => run(() => api.post(`/events/${eventId}/ops/para-readiness/signoff`, { requirement_id: item.id, evidence_ref: val.evidence_ref, note: val.note || undefined }))}>
      <AT size={16} weight="700">{item?.title}</AT>
      {item?.is_safety_critical && <SBadge critical />}
      <AT size={12} color={A.mute} style={{ marginTop: 4 }}>{t('pr.signoff_note')}</AT>
      <Field label={t('pr.evidence_ref')} value={val.evidence_ref} onChangeText={(v) => setVal((p) => ({ ...p, evidence_ref: v }))}
        placeholder={t('pr.evidence_placeholder')} returnKeyType="next" accessibilityLabel={t('pr.evidence_ref')} />
      <Field label={t('pr.signoff_note_label')} value={val.note} onChangeText={(v) => setVal((p) => ({ ...p, note: v }))}
        placeholder={t('pr.signoff_note_ph')} multiline numberOfLines={3} accessibilityLabel={t('pr.signoff_note_label')} />
    </FormSheet>
  );
}

// ---------------------------------------------------------------- Exception sheet

function ExceptionSheet({ item, eventId, onClose, onDone }) {
  const [val, setVal] = useState({ justification: '', evidence_ref: '', second_officer_id: '', valid_until: '' });
  const { doing, run, err } = useDo(onDone);
  if (!item) return null;
  const needsOfficer = item?.is_safety_critical;
  return (
    <FormSheet visible={!!item} onClose={onClose} title={t('pr.exc_title')}
      submitLabel={t('pr.exc_submit')} submitting={doing} error={err}
      onSubmit={() => run(() => api.post(`/events/${eventId}/ops/para-readiness/exceptions`, {
        requirement_id: item.id, justification: val.justification, evidence_ref: val.evidence_ref || undefined,
        second_officer_id: needsOfficer ? val.second_officer_id : undefined, valid_until: val.valid_until || undefined,
      }))}>
      <AT size={16} weight="700">{item?.title}</AT>
      {item?.is_safety_critical && <View style={{ gap: 4 }}><SBadge critical /><AT size={12} color={A.red}>{t('pr.exc_critical_warning')}</AT></View>}
      <Field label={t('pr.exc_justification')} value={val.justification} onChangeText={(v) => setVal((p) => ({ ...p, justification: v }))}
        placeholder={t('pr.exc_justification_ph')} multiline numberOfLines={5} accessibilityLabel={t('pr.exc_justification')} />
      <Field label={t('pr.evidence_ref')} value={val.evidence_ref} onChangeText={(v) => setVal((p) => ({ ...p, evidence_ref: v }))}
        placeholder={t('pr.evidence_placeholder')} accessibilityLabel={t('pr.evidence_ref')} />
      {needsOfficer && (
        <Field label={t('pr.second_officer')} value={val.second_officer_id} onChangeText={(v) => setVal((p) => ({ ...p, second_officer_id: v }))}
          placeholder={t('pr.second_officer_ph')} accessibilityLabel={t('pr.second_officer')} />
      )}
      <Field label={t('pr.valid_until')} value={val.valid_until} onChangeText={(v) => setVal((p) => ({ ...p, valid_until: v }))}
        placeholder="YYYY-MM-DD" accessibilityLabel={t('pr.valid_until')} />
    </FormSheet>
  );
}

// ---------------------------------------------------------------- Notify sheet

const ROLES = ['organiser','venue','official','athlete'];
function NotifySheet({ eventId, visible, onClose, onDone }) {
  const [val, setVal] = useState({ role: 'athlete', message: '', contingency_plan: '' });
  const { doing, run, err } = useDo(onDone);
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('pr.notify_title')}
      submitLabel={t('pr.notify_submit')} submitting={doing} error={err}
      onSubmit={() => run(() => api.post(`/events/${eventId}/ops/para-readiness/notify`, { role: val.role, message: val.message, contingency_plan: val.contingency_plan || undefined }))}>
      <AT size={12} color={A.mute}>{t('pr.notify_role')}</AT>
      <Row style={{ marginTop: 4 }}>
        {ROLES.map((r) => (
          <AChip key={r} label={t(`pr.role.${r}`)} active={val.role === r} onPress={() => setVal((p) => ({ ...p, role: r }))} accessibilityLabel={t(`pr.role.${r}`)} />
        ))}
      </Row>
      <Field label={t('pr.notify_message')} value={val.message} onChangeText={(v) => setVal((p) => ({ ...p, message: v }))}
        multiline numberOfLines={4} accessibilityLabel={t('pr.notify_message')} />
      <Field label={t('pr.contingency_plan')} value={val.contingency_plan} onChangeText={(v) => setVal((p) => ({ ...p, contingency_plan: v }))}
        multiline numberOfLines={4} placeholder={t('pr.contingency_ph')} accessibilityLabel={t('pr.contingency_plan')} />
    </FormSheet>
  );
}

// ---------------------------------------------------------------- Exceptions list panel

function ExceptionsPanel({ eventId }) {
  const data = useLoad(() => api.get(`/events/${eventId}/ops/para-readiness/exceptions`), [eventId]);
  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;
  const rows = data.data ?? [];
  if (!rows.length) return <AEmpty emoji="📋" title={t('pr.no_exceptions')} sub={t('pr.no_exceptions_sub')} />;
  return (
    <View style={{ gap: 10 }}>
      {rows.map((e) => (
        <ACard key={e.id} tone={e.status === 'approved' ? A.sun : e.status === 'rejected' ? A.red : undefined} style={{ gap: 5 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <AT size={13} weight="700" style={{ flex: 1 }}>{e.requirement_title}</AT>
            <ATag label={t(`pr.exc_status.${e.status}`)} />
          </View>
          {e.is_safety_critical && <SBadge critical />}
          <AT size={12} color={A.mute}>{e.justification}</AT>
          {e.evidence_ref && <AT size={11} color={A.mute}>{t('pr.evidence_ref')}: {e.evidence_ref}</AT>}
          {e.second_officer_name && <AT size={11} color={A.mute}>{t('pr.second_officer')}: {e.second_officer_name}</AT>}
          {e.rejection_reason && <AT size={12} color={A.red}>{t('pr.rejection_reason')}: {e.rejection_reason}</AT>}
          <AT size={11} color={A.mute}>{t('pr.raised_by')}: {e.approved_by_name} · {String(e.created_at).slice(0, 10)}</AT>
        </ACard>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- MAIN DASHBOARD

/** Main para-sport readiness dashboard for the event console. Role: 'organiser' | 'lead' | 'crew'. */
export function ParaReadinessDashboard({ eventId, role = 'organiser' }) {
  const { tablet } = useLayout();
  const data = useLoad(() => api.get(`/events/${eventId}/ops/para-readiness`), [eventId]);
  const [signOff, setSignOff] = useState(null);
  const [exception, setException] = useState(null);
  const [notify, setNotify] = useState(false);
  const [tab, setTab] = useState('checklist');
  const { reload } = data;

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const r = data.data;
  const grouped = CAT_ORDER.map((cat) => ({
    cat, icon: CAT_ICON[cat] ?? '♿',
    items: (r.items ?? []).filter((i) => i.para_category === cat),
  })).filter((g) => g.items.length > 0);

  const tabs = [
    { key: 'checklist', label: t('pr.tab_checklist') },
    { key: 'exceptions', label: t('pr.tab_exceptions') },
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: A.bg }} contentContainerStyle={{ padding: tablet ? 24 : 16, gap: 14 }}>
      {/* KPI strip */}
      <Row>
        <AStat icon="♿" value={r.total} label={t('pr.stat_total')} />
        <AStat icon="✅" value={r.met} label={t('pr.stat_met')} tone={r.met === r.total && r.total > 0 ? A.green : undefined} />
        <AStat icon="⛔" value={r.safety_critical_open} label={t('pr.stat_critical')} tone={r.safety_critical_open ? A.red : undefined} />
        <AStat icon="⚠️" value={r.exceptions_pending} label={t('pr.stat_pending_exc')} tone={r.exceptions_pending ? A.sun : undefined} />
      </Row>

      {/* Readiness gate */}
      <ACard tone={r.can_open ? A.green : A.red} style={{ gap: 10 }}>
        <ReadinessBar percent={r.percent} canOpen={r.can_open} blockers={r.safety_critical_open} />
        {!r.can_open && r.blockers?.length > 0 && (
          <View style={{ gap: 4 }}>
            <AT size={12} weight="700" color={A.red}>{t('pr.blockers_label')}</AT>
            {r.blockers.map((b) => <AT key={b.id} size={12} color={A.red} style={{ paddingStart: 8 }}>• {b.title}</AT>)}
          </View>
        )}
      </ACard>

      {/* Action bar */}
      {(role === 'organiser' || role === 'lead') && (
        <Row>
          <ABtn small tone="neon" title={t('pr.notify_btn')} onPress={() => setNotify(true)} accessibilityLabel={t('pr.notify_btn')} />
          <ABtn small tone="ghost" title={t('pr.add_standards')} onPress={() => api.post(`/events/${eventId}/ops/para-readiness/requirements/standard`).then(reload)} accessibilityLabel={t('pr.add_standards')} />
        </Row>
      )}

      {/* Tabs */}
      <Row>
        {tabs.map((tb) => (
          <AChip key={tb.key} label={tb.label} active={tab === tb.key} onPress={() => setTab(tb.key)} accessibilityLabel={tb.label} />
        ))}
      </Row>

      {tab === 'checklist' && (
        grouped.length === 0
          ? <AEmpty emoji="♿" title={t('pr.empty_title')} sub={t('pr.empty_sub')} />
          : grouped.map(({ cat, icon, items }) => (
            <View key={cat} style={{ gap: 8 }}>
              <ASection title={`${icon} ${t(`pr.cat.${cat}`)}`} sub={`${items.filter((i) => i.state === 'met' || i.state === 'exception').length}/${items.length}`} />
              {items.map((item) => (
                <ReqCard key={item.id} item={item} onSignOff={setSignOff} onException={setException} role={role} />
              ))}
            </View>
          ))
      )}

      {tab === 'exceptions' && <ExceptionsPanel eventId={eventId} />}

      <SignOffSheet item={signOff} eventId={eventId} onClose={() => setSignOff(null)} onDone={() => { setSignOff(null); reload(); }} />
      <ExceptionSheet item={exception} eventId={eventId} onClose={() => setException(null)} onDone={() => { setException(null); reload(); }} />
      <NotifySheet eventId={eventId} visible={notify} onClose={() => setNotify(false)} onDone={() => setNotify(false)} />
    </ScrollView>
  );
}

// ---------------------------------------------------------------- ATHLETE ACCESS VIEW

/** Athlete / participant: operational access information only (accessible entrance, parking, transport, communication). No clinical data. */
export function ParaAthleteAccess({ eventId }) {
  const data = useLoad(() => api.get(`/events/${eventId}/para/athlete-access`), [eventId]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const d = data.data;
  const grouped = {};
  for (const item of d.items ?? []) {
    (grouped[item.category] = grouped[item.category] ?? []).push(item);
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Card style={{ backgroundColor: c.cyanSoft ?? `${c.pink}11`, borderRadius: 14, padding: 14, gap: 6 }} accessible accessibilityRole="text">
        <T size={14} weight="700" color={c.ink}>{t('pr.access_title')}</T>
        <T size={12} color={c.mute}>{t('pr.access_note')}</T>
      </Card>

      {Object.keys(grouped).length === 0
        ? <View style={{ alignItems: 'center', padding: 32 }}>
            <T size={36}>♿</T>
            <T size={16} weight="700" color={c.ink} style={{ marginTop: 12 }}>{t('pr.access_empty_title')}</T>
            <T size={13} color={c.mute} style={{ textAlign: 'center', marginTop: 6 }}>{t('pr.access_empty_sub')}</T>
          </View>
        : Object.entries(grouped).map(([cat, items]) => (
          <View key={cat} style={{ gap: 8 }}>
            <T size={13} weight="700" color={c.mute}>{`${CAT_ICON[cat] ?? '♿'} ${t(`pr.cat.${cat}`)}`}</T>
            {items.map((item, idx) => (
              <Card key={idx} style={{ borderRadius: 14, padding: 14, gap: 4, backgroundColor: c.paper }} accessible accessibilityRole="text" accessibilityLabel={`${item.title}, ${t('pr.access_confirmed')}`}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <T size={14} weight="600" color={c.ink} style={{ flex: 1 }}>{item.title}</T>
                  <Tag label={t('pr.access_confirmed')} color={c.lime ?? '#34D399'} />
                </View>
                {item.confirmed_at && <T size={11} color={c.mute}>{t('pr.confirmed_at', { date: String(item.confirmed_at).slice(0, 10) })}</T>}
              </Card>
            ))}
          </View>
        ))
      }
    </ScrollView>
  );
}
