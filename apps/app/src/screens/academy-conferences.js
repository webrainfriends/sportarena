// Academy OS P1 (#796): Structured Guardian Conferences & Academy Reviews.
// Staff-side ConferencesDesk: schedule, agenda, evidence, decisions, outcome reports.
// Guardian-side GuardianConferences: view, respond, acknowledge.
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { t as tr } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { FormSheet } from '../FormSheet';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Section, StatPill, T, Tag } from '../ui';
import { c } from '../theme';
import { Split } from './academy-ui';
import { dateTimeIn } from '../vtime';

const KIND_LABEL = {
  annual_review: 'Annual Review', termly: 'Termly', progress_check: 'Progress Check',
  welfare: 'Welfare', emergency: 'Emergency', guardian_request: 'Guardian Request', other: 'Other',
};
const STATUS_COLOR = {
  draft: c.mute, scheduled: c.cyanSoft, confirmed: c.mintSoft, in_progress: c.sunSoft,
  completed: c.lime, cancelled: c.red, rescheduled: c.orangeSoft,
};
const LOC_LABEL = { in_person: 'In person', video: 'Video call', phone: 'Phone', hybrid: 'Hybrid' };
const DECISION_KIND_LABEL = { decision: 'Decision', action: 'Action', recommendation: 'Recommendation', follow_up: 'Follow-up', concern_noted: 'Concern noted' };

function ConfStatusTag({ status }) {
  return <Tag label={status.replace('_', ' ')} color={STATUS_COLOR[status] ?? c.mute} />;
}

// =====================================================================
// STAFF-SIDE: ConferencesDesk
// =====================================================================

/** Main staff-facing conference management surface embedded in Academy → Families → Athlete. */
export function ConferencesBlock({ o, planId }) {
  const list = useLoad(() => api.get(`/orgs/${o.id}/conferences`, { plan_id: planId, limit: 50 }), [o.id, planId]);
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const { toast } = useSession();

  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;

  const upcoming = list.data.filter((c) => !['completed', 'cancelled'].includes(c.status));
  const past = list.data.filter((c) => ['completed', 'cancelled'].includes(c.status));

  return (
    <View style={{ gap: 10 }}>
      <CreateConferenceSheet orgId={o.id} planId={planId} visible={creating} onClose={() => setCreating(false)} onDone={() => { setCreating(false); list.reload(); toast(tr('conf.created')); }} />
      {open && <ConferenceDetail orgId={o.id} conf={open} onClose={() => setOpen(null)} onRefresh={() => { setOpen(null); list.reload(); }} role="staff" />}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T weight="800" size={15}>{tr('conf.title')}</T>
        <Btn small title={tr('conf.schedule')} color={c.pink} onPress={() => setCreating(true)} />
      </View>
      {upcoming.length ? upcoming.map((conf) => (
        <ConferenceRow key={conf.id} conf={conf} onPress={() => setOpen(conf)} />
      )) : <Empty emoji="📅" title={tr('conf.empty')} sub={tr('conf.empty_sub')} />}
      {past.length ? (
        <View style={{ marginTop: 6 }}>
          <T size={12} weight="700" color={c.mute} style={{ marginBottom: 6 }}>{tr('conf.past')}</T>
          {past.map((conf) => <ConferenceRow key={conf.id} conf={conf} onPress={() => setOpen(conf)} />)}
        </View>
      ) : null}
    </View>
  );
}

function ConferenceRow({ conf, onPress }) {
  return (
    <Card pad={12} onPress={onPress} accessibilityLabel={conf.title}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="700" size={14}>{conf.title}</T>
          <T size={12} color={c.mute}>{KIND_LABEL[conf.kind] ?? conf.kind} · {LOC_LABEL[conf.location_type] ?? conf.location_type}</T>
          {conf.scheduled_at ? <T size={12} color={c.mute}>{dateTimeIn(conf.scheduled_at)} · {conf.duration_minutes} min</T> : <T size={12} color={c.orangeSoft}>Date TBD</T>}
        </View>
        <ConfStatusTag status={conf.status} />
      </View>
    </Card>
  );
}

function CreateConferenceSheet({ orgId, planId, visible, onClose, onDone }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={tr('conf.schedule')}
      initial={{ kind: 'annual_review', location_type: 'video', duration_minutes: 60, family_visible: true }}
      fields={[
        { key: 'title', label: tr('conf.field.title'), type: 'text', placeholder: tr('conf.field.title_ph'), required: true },
        { key: 'kind', label: tr('conf.field.kind'), type: 'menu', options: Object.entries(KIND_LABEL).map(([v, l]) => ({ value: v, label: l })) },
        { key: 'scheduled_at', label: tr('conf.field.scheduled_at'), type: 'datetime' },
        { key: 'duration_minutes', label: tr('conf.field.duration'), type: 'number', hint: tr('conf.field.duration_hint') },
        { key: 'location_type', label: tr('conf.field.location'), type: 'menu', options: Object.entries(LOC_LABEL).map(([v, l]) => ({ value: v, label: l })) },
        { key: 'location_detail', label: tr('conf.field.location_detail'), type: 'text', placeholder: tr('conf.field.location_detail_ph') },
        { key: 'agenda', label: tr('conf.field.agenda'), type: 'textarea', placeholder: tr('conf.field.agenda_ph') },
        { key: 'family_visible', label: tr('conf.field.family_visible'), type: 'switch', hint: tr('conf.field.family_visible_hint') },
      ]}
      onSubmit={async (v) => { await api.post(`/orgs/${orgId}/conferences`, { ...v, plan_id: planId }); onDone(); }} />
  );
}

// =====================================================================
// Conference Detail — staff side
// =====================================================================

function ConferenceDetail({ orgId, conf: initialConf, onClose, onRefresh, role }) {
  const { toast } = useSession();
  const detail = useLoad(() => api.get(`/orgs/${orgId}/conferences/${initialConf.id}`), [orgId, initialConf.id]);
  const attendees = useLoad(() => api.get(`/orgs/${orgId}/conferences/${initialConf.id}/attendees`).catch(() => []), [orgId, initialConf.id]);
  const [addingItem, setAddingItem] = useState(false);
  const [addingDecision, setAddingDecision] = useState(false);
  const [inviting, setInviting] = useState(false);

  if (detail.error) return <ErrorBox error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Loading />;
  const conf = detail.data;
  const isStaff = role === 'staff';

  const cancel = async () => {
    try { await api.post(`/orgs/${orgId}/conferences/${conf.id}/cancel`); toast(tr('conf.cancelled')); onRefresh(); }
    catch (e) { toast(e.message); }
  };

  const generate = async () => {
    try { await api.post(`/orgs/${orgId}/conferences/${conf.id}/report`); toast(tr('conf.report_generated')); detail.reload(); }
    catch (e) { toast(e.message); }
  };

  return (
    <FormSheet visible title={conf.title} onClose={onClose} footer={
      isStaff && conf.status !== 'completed' && conf.status !== 'cancelled' ? (
        <View style={{ gap: 8 }}>
          {conf.status !== 'completed' ? <Btn title={tr('conf.mark_complete')} color={c.lime} onPress={async () => { try { await api.patch(`/orgs/${orgId}/conferences/${conf.id}`, { status: 'completed' }); toast(tr('conf.completed')); onRefresh(); } catch (e) { toast(e.message); } }} /> : null}
          <Btn title={tr('conf.cancel')} color={c.mute} onPress={cancel} />
        </View>
      ) : null
    }>
      <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <ConfStatusTag status={conf.status} />
          <Tag label={KIND_LABEL[conf.kind] ?? conf.kind} color={c.cyanSoft} />
          <Tag label={conf.family_visible ? tr('conf.family_visible') : tr('conf.staff_only')} color={conf.family_visible ? c.mintSoft : c.mute} />
        </View>
        {conf.scheduled_at ? <T size={13}>{dateTimeIn(conf.scheduled_at)} · {conf.duration_minutes} min · {LOC_LABEL[conf.location_type] ?? conf.location_type}{conf.location_detail ? ` — ${conf.location_detail}` : ''}</T> : <T size={13} color={c.orangeSoft}>{tr('conf.no_date')}</T>}

        {/* Agenda */}
        {conf.agenda ? (
          <View style={{ gap: 4 }}>
            <T weight="700" size={12} color={c.mute}>{tr('conf.agenda')}</T>
            <T size={13}>{conf.agenda}</T>
          </View>
        ) : null}

        {/* Staff notes — never shown for guardian role */}
        {isStaff && conf.staff_notes ? (
          <View style={{ backgroundColor: c.sunSoft, borderRadius: 8, padding: 10, gap: 4 }}>
            <T weight="700" size={12} color={c.mute}>{tr('conf.staff_notes')}</T>
            <T size={13}>{conf.staff_notes}</T>
          </View>
        ) : null}

        {/* Attendees */}
        <Section title={tr('conf.attendees')} action={isStaff ? { label: tr('conf.invite'), onPress: () => setInviting(true) } : undefined}>
          {attendees.data?.length ? attendees.data.map((a) => (
            <Row key={a.id} title={`${a.role.replace('_', ' ')}`} sub={`${a.user_id}`} right={<Tag label={a.status} color={a.status === 'confirmed' ? c.mintSoft : a.status === 'declined' ? c.red : undefined} />} />
          )) : <T size={13} color={c.mute}>{tr('conf.no_attendees')}</T>}
        </Section>

        {/* Agenda items */}
        <AgendaSection orgId={orgId} confId={conf.id} isStaff={isStaff} adding={addingItem} setAdding={setAddingItem} />

        {/* Decisions */}
        <DecisionsSection orgId={orgId} confId={conf.id} isStaff={isStaff} role={role} adding={addingDecision} setAdding={setAddingDecision} />

        {/* Outcome */}
        {conf.outcome_summary ? (
          <View style={{ gap: 4 }}>
            <T weight="700" size={12} color={c.mute}>{tr('conf.outcome')}</T>
            <T size={13}>{conf.outcome_summary}</T>
          </View>
        ) : null}

        {/* Generate report button */}
        {isStaff ? (
          <Btn title={tr('conf.generate_report')} color={c.paper} ink={c.ink} onPress={generate} />
        ) : null}
      </ScrollView>

      {/* Sub-sheets */}
      <InviteSheet orgId={orgId} confId={conf.id} visible={inviting} onClose={() => setInviting(false)} onDone={() => { setInviting(false); attendees.reload(); }} />
    </FormSheet>
  );
}

function AgendaSection({ orgId, confId, isStaff, adding, setAdding }) {
  const items = useLoad(() => api.get(`/orgs/${orgId}/conferences/${confId}/agenda`).catch(() => []), [orgId, confId]);
  const { toast } = useSession();
  return (
    <Section title={tr('conf.agenda_items')} action={isStaff ? { label: tr('conf.add_item'), onPress: () => setAdding(true) } : undefined}>
      {items.data?.length ? items.data.map((item, n) => (
        <Row key={item.id} title={`${n + 1}. ${item.title}`} sub={`${item.kind.replace('_', ' ')}${item.time_minutes ? ` · ${item.time_minutes} min` : ''}`} />
      )) : <T size={13} color={c.mute}>{tr('conf.no_agenda')}</T>}
      <FormSheet visible={adding} onClose={() => setAdding(false)} title={tr('conf.add_item')}
        initial={{ kind: 'general', time_minutes: 10 }}
        fields={[
          { key: 'title', label: tr('conf.item.title'), type: 'text', required: true },
          { key: 'kind', label: tr('conf.item.kind'), type: 'menu', options: ['review_domain','objective_progress','welfare','guardian_concern','admin','aob','general'].map((k) => ({ value: k, label: k.replace('_', ' ') })) },
          { key: 'description', label: tr('conf.item.desc'), type: 'textarea' },
          { key: 'time_minutes', label: tr('conf.item.time'), type: 'number' },
        ]}
        onSubmit={async (v) => { await api.post(`/orgs/${orgId}/conferences/${confId}/agenda`, v); setAdding(false); items.reload(); return tr('conf.item_added'); }} />
    </Section>
  );
}

function DecisionsSection({ orgId, confId, isStaff, role, adding, setAdding }) {
  const all = useLoad(() => api.get(`/orgs/${orgId}/conferences/${confId}/decisions`).catch(() => []), [orgId, confId]);
  const visible = role === 'guardian' ? (all.data ?? []).filter((d) => d.visible_to_guardian) : (all.data ?? []);
  return (
    <Section title={tr('conf.decisions')} action={isStaff ? { label: tr('conf.add_decision'), onPress: () => setAdding(true) } : undefined}>
      {visible.length ? visible.map((d) => (
        <Card key={d.id} pad={10} style={{ marginBottom: 4 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
            <View style={{ flex: 1 }}>
              <T weight="700" size={12} color={c.mute}>{DECISION_KIND_LABEL[d.kind] ?? d.kind}</T>
              <T size={13}>{d.body}</T>
              {d.deadline_on ? <T size={11} color={c.mute}>{tr('conf.due')} {d.deadline_on}</T> : null}
            </View>
            <Tag label={d.status} color={d.status === 'done' ? c.lime : d.status === 'in_progress' ? c.cyanSoft : undefined} />
          </View>
        </Card>
      )) : <T size={13} color={c.mute}>{tr('conf.no_decisions')}</T>}
      {isStaff ? (
        <FormSheet visible={adding} onClose={() => setAdding(false)} title={tr('conf.add_decision')}
          initial={{ kind: 'action', visible_to_guardian: false }}
          fields={[
            { key: 'kind', label: tr('conf.dec.kind'), type: 'menu', options: Object.entries(DECISION_KIND_LABEL).map(([v, l]) => ({ value: v, label: l })) },
            { key: 'body', label: tr('conf.dec.body'), type: 'textarea', required: true },
            { key: 'responsible_user_id', label: tr('conf.dec.responsible'), type: 'text', placeholder: tr('conf.dec.responsible_ph') },
            { key: 'deadline_on', label: tr('conf.dec.deadline'), type: 'date' },
            { key: 'visible_to_guardian', label: tr('conf.dec.visible'), type: 'switch', hint: tr('conf.dec.visible_hint') },
          ]}
          onSubmit={async (v) => { await api.post(`/orgs/${orgId}/conferences/${confId}/decisions`, v); setAdding(false); all.reload(); return tr('conf.decision_added'); }} />
      ) : null}
    </Section>
  );
}

function InviteSheet({ orgId, confId, visible, onClose, onDone }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={tr('conf.invite_attendee')}
      initial={{ role: 'guardian' }}
      fields={[
        { key: 'user_id', label: tr('conf.att.user'), type: 'text', placeholder: tr('conf.att.user_ph'), required: true, hint: tr('conf.att.user_hint') },
        { key: 'role', label: tr('conf.att.role'), type: 'menu', options: ['lead_coach','coach','guardian','admin','athlete','external'].map((r) => ({ value: r, label: r.replace('_', ' ') })) },
        { key: 'notes', label: tr('conf.att.notes'), type: 'textarea' },
      ]}
      onSubmit={async (v) => { await api.post(`/orgs/${orgId}/conferences/${confId}/attendees`, v); onDone(); return tr('conf.invited'); }} />
  );
}

// =====================================================================
// GUARDIAN-SIDE: GuardianConferences
// =====================================================================

/** Renders all upcoming and past conferences where the caller is an invited guardian. */
export function GuardianConferences({ orgId }) {
  const list = useLoad(() => api.get('/me/guardian-conferences', { limit: 50 }), []);
  const [open, setOpen] = useState(null);
  const { toast } = useSession();

  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;

  const confs = orgId ? list.data.filter((c) => c.org_id === orgId) : list.data;
  const upcoming = confs.filter((c) => !['completed', 'cancelled'].includes(c.status));
  const past = confs.filter((c) => ['completed', 'cancelled'].includes(c.status));

  return (
    <View style={{ gap: 10 }}>
      {open ? <GuardianConferenceDetail orgId={open.org_id} conf={open} onClose={() => { setOpen(null); list.reload(); }} toast={toast} /> : null}
      {!confs.length ? (
        <Empty emoji="📋" title={tr('conf.guardian.empty')} sub={tr('conf.guardian.empty_sub')} />
      ) : (
        <>
          {upcoming.map((conf) => <GuardianConfRow key={conf.id} conf={conf} onPress={() => setOpen(conf)} />)}
          {past.length ? (
            <View style={{ marginTop: 6 }}>
              <T size={12} weight="700" color={c.mute} style={{ marginBottom: 6 }}>{tr('conf.past')}</T>
              {past.map((conf) => <GuardianConfRow key={conf.id} conf={conf} onPress={() => setOpen(conf)} />)}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function GuardianConfRow({ conf, onPress }) {
  const acked = !!conf.acknowledged_at;
  return (
    <Card pad={12} onPress={onPress} accessibilityLabel={conf.title}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 2 }}>
          {conf.athlete ? <T size={11} weight="700" color={c.mute}>{conf.athlete.display_name}</T> : null}
          <T weight="700" size={14}>{conf.title}</T>
          <T size={12} color={c.mute}>{KIND_LABEL[conf.kind] ?? conf.kind}{conf.scheduled_at ? ` · ${dateTimeIn(conf.scheduled_at)}` : ''}</T>
          {conf.guardian_decision_count > 0 ? <T size={11} color={c.cyanSoft}>{conf.guardian_decision_count} {tr('conf.decisions_for_you')}</T> : null}
        </View>
        <View style={{ gap: 4, alignItems: 'flex-end' }}>
          <ConfStatusTag status={conf.status} />
          {conf.status === 'completed' && !acked ? <Tag label={tr('conf.ack_needed')} color={c.orangeSoft} /> : null}
          {acked ? <Tag label={tr('conf.acked')} color={c.lime} /> : null}
        </View>
      </View>
    </Card>
  );
}

function GuardianConferenceDetail({ orgId, conf: initialConf, onClose, toast }) {
  const detail = useLoad(() => api.get(`/orgs/${orgId}/conferences/${initialConf.id}`), [orgId, initialConf.id]);
  const [acked, setAcked] = useState(!!initialConf.acknowledged_at);
  const [acking, setAcking] = useState(false);

  const acknowledge = async () => {
    setAcking(true);
    try {
      await api.post(`/orgs/${orgId}/conferences/${initialConf.id}/acknowledge`);
      setAcked(true);
      toast(tr('conf.ack_done'));
    } catch (e) { toast(e.message); } finally { setAcking(false); }
  };

  const downloadReport = async () => {
    try {
      const r = await api.get(`/orgs/${orgId}/conferences/${initialConf.id}/report`);
      toast(`${tr('conf.report_ready')} ${r.download_url}`);
    } catch (e) { toast(e.message); }
  };

  if (!detail.data) return <Loading />;
  const conf = detail.data;

  return (
    <FormSheet visible title={conf.title} onClose={onClose}
      footer={conf.status === 'completed' && !acked ? (
        <Btn title={tr('conf.ack_cta')} color={c.pink} loading={acking} onPress={acknowledge} />
      ) : acked ? (
        <Btn title={tr('conf.download_report')} color={c.paper} ink={c.ink} onPress={downloadReport} />
      ) : null}
    >
      <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <ConfStatusTag status={conf.status} />
          <Tag label={KIND_LABEL[conf.kind] ?? conf.kind} color={c.cyanSoft} />
        </View>
        {conf.scheduled_at ? <T size={13}>{dateTimeIn(conf.scheduled_at)} · {conf.duration_minutes} min · {LOC_LABEL[conf.location_type]}{conf.location_detail ? ` — ${conf.location_detail}` : ''}</T> : <T size={13} color={c.orangeSoft}>{tr('conf.no_date')}</T>}
        {conf.agenda ? (
          <View style={{ gap: 4 }}>
            <T weight="700" size={12} color={c.mute}>{tr('conf.agenda')}</T>
            <T size={13}>{conf.agenda}</T>
          </View>
        ) : null}
        <DecisionsSection orgId={orgId} confId={conf.id} isStaff={false} role="guardian" adding={false} setAdding={() => {}} />
        {conf.outcome_summary ? (
          <View style={{ gap: 4 }}>
            <T weight="700" size={12} color={c.mute}>{tr('conf.outcome')}</T>
            <T size={13}>{conf.outcome_summary}</T>
          </View>
        ) : null}
        {acked ? <T size={12} color={c.lime}>{tr('conf.acked_on')} {dateTimeIn(initialConf.acknowledged_at)}</T> : null}
      </ScrollView>
    </FormSheet>
  );
}
