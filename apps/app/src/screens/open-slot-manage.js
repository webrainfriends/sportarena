// REF-R14: Organiser-facing manage open slots for a fixture.
// Publish slots, review applications (approve/reject), manage waitlist, close slots.
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen, Section, Sheet, T, Tag, Row } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { CalendarPickerField, TimePickerField } from '../pickers';
import { LoadError } from '../access';
import { c, grad, r } from '../theme';
import { Metric, money } from '../federation-ui';
import { t } from '../i18n';

const ROLE_LABEL = {
  referee: 'Referee', umpire: 'Umpire', linesman: 'Assistant Referee', scorer: 'Scorer',
  video_assistant_referee: 'VAR', fourth_official: 'Fourth Official', reserve_assistant_referee: 'Reserve AR',
  shot_clock_operator: 'Shot Clock', timekeeper: 'Timekeeper', goal_line_official: 'Goal-line Official',
  technical_official: 'Technical Official', chair_umpire: 'Chair Umpire', match_commissioner: 'Match Commissioner',
  technical_delegate: 'Technical Delegate', starter: 'Starter', marshal: 'Marshal',
};

const OFFICIAL_ROLES = Object.keys(ROLE_LABEL);

const SLOT_STATUS = {
  draft:     ['⬛ Draft', c.paper],
  open:      ['🟢 Open', c.mintSoft],
  full:      ['🔵 Full', c.cyanSoft],
  closed:    ['⬜ Closed', c.paper],
  cancelled: ['🔴 Cancelled', c.sunSoft],
};

const APP_STATUS = {
  approved:   ['✅ Confirmed', c.mintSoft],
  pending:    ['⏳ Awaiting decision', c.sunSoft],
  waitlisted: ['🕐 Waitlisted', c.cyanSoft],
  rejected:   ['Not approved', c.paper],
  withdrawn:  ['Withdrawn', c.paper],
  cancelled:  ['Cancelled', c.paper],
};

const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const dateShort = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '';

// ─── publish / edit slot sheet ────────────────────────────────────────────────

function PublishSlotSheet({ fixtureId, eventId, existing, onClose, onDone }) {
  const isEdit = !!existing;
  const [form, setForm] = useState({
    role: existing?.role ?? 'referee',
    slots: existing?.slots ?? 1,
    min_grade: existing?.min_grade ?? '',
    fee_minor: existing?.fee_minor != null ? String(Math.round(existing.fee_minor / 100)) : '',
    fee_currency: existing?.fee_currency ?? 'USD',
    pay_direction: existing?.pay_direction ?? 'organiser_pays',
    approval_mode: existing?.approval_mode ?? 'instant',
    allow_waitlist: existing?.allow_waitlist ?? true,
    reporting_min: String(existing?.reporting_min ?? 30),
    min_experience_months: String(existing?.min_experience_months ?? 0),
    notes: existing?.notes ?? '',
    private_notes: '',
    publish: true,
  });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const ROLE_OPTS = OFFICIAL_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }));
  const CURRENCY_OPTS = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'INR', 'LKR', 'IDR'].map((c) => ({ value: c, label: c }));
  const PAY_OPTS = [{ value: 'organiser_pays', label: t('open_slot.organiser_pays') }, { value: 'official_invoices', label: t('open_slot.official_invoices') }];
  const MODE_OPTS = [{ value: 'instant', label: t('open_slot.approval_mode_instant') }, { value: 'approval', label: t('open_slot.approval_mode_approval') }];

  async function submit() {
    setLoading(true); setErr(null);
    try {
      const feeMajor = form.fee_minor.trim() ? parseFloat(form.fee_minor) : undefined;
      const body = {
        role: form.role, slots: Number(form.slots),
        min_grade: form.min_grade.trim() || undefined,
        fee_minor: feeMajor != null ? Math.round(feeMajor * 100) : undefined,
        fee_currency: feeMajor != null ? form.fee_currency : undefined,
        pay_direction: form.pay_direction, approval_mode: form.approval_mode,
        allow_waitlist: form.allow_waitlist,
        reporting_min: Number(form.reporting_min),
        min_experience_months: Number(form.min_experience_months),
        notes: form.notes.trim() || undefined,
        private_notes: form.private_notes.trim() || undefined,
        publish: form.publish,
      };
      if (isEdit) {
        await api('PATCH', `/open-match-slots/${existing.id}`, body);
      } else {
        await api('POST', `/fixtures/${fixtureId}/open-slots`, body);
      }
      onDone();
    } catch (e) { setErr(e.message); setLoading(false); }
  }

  return (
    <FormSheet onClose={onClose} title={isEdit ? t('open_slot.edit_title') : t('open_slot.publish_title')} onSubmit={submit} loading={loading} submitLabel={form.publish ? t('open_slot.publish_cta') : t('open_slot.save_draft')}>
      <MenuField label={t('open_slot.role_label')} value={form.role} onChange={(v) => set('role', v)} options={ROLE_OPTS} required disabled={isEdit} accessibilityLabel={t('open_slot.role_label')} />
      <Field label={t('open_slot.slots_label')} value={String(form.slots)} onChangeText={(v) => set('slots', Number(v) || 1)} keyboardType="numeric" accessibilityLabel={t('open_slot.slots_label')} />
      <Field label={t('open_slot.min_grade_label')} value={form.min_grade} onChangeText={(v) => set('min_grade', v)} placeholder={t('open_slot.min_grade_placeholder')} accessibilityLabel={t('open_slot.min_grade_label')} />
      <Field label={t('open_slot.reporting_min_label')} value={form.reporting_min} onChangeText={(v) => set('reporting_min', v)} keyboardType="numeric" accessibilityLabel={t('open_slot.reporting_min_label')} />
      <Field label={t('open_slot.experience_label')} value={form.min_experience_months} onChangeText={(v) => set('min_experience_months', v)} keyboardType="numeric" accessibilityLabel={t('open_slot.experience_label')} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field label={t('open_slot.fee_label')} value={form.fee_minor} onChangeText={(v) => set('fee_minor', v)} keyboardType="decimal-pad" style={{ flex: 2 }} accessibilityLabel={t('open_slot.fee_label')} />
        <MenuField label={t('open_slot.currency_label')} value={form.fee_currency} onChange={(v) => set('fee_currency', v)} options={CURRENCY_OPTS} style={{ flex: 1 }} accessibilityLabel={t('open_slot.currency_label')} />
      </View>
      <MenuField label={t('open_slot.pay_direction_label')} value={form.pay_direction} onChange={(v) => set('pay_direction', v)} options={PAY_OPTS} accessibilityLabel={t('open_slot.pay_direction_label')} />
      <MenuField label={t('open_slot.approval_mode_label')} value={form.approval_mode} onChange={(v) => set('approval_mode', v)} options={MODE_OPTS} accessibilityLabel={t('open_slot.approval_mode_label')} />
      <Chip label={t('open_slot.allow_waitlist')} active={form.allow_waitlist} onPress={() => set('allow_waitlist', !form.allow_waitlist)} accessibilityLabel={t('open_slot.allow_waitlist')} />
      <Field label={t('open_slot.notes_label')} value={form.notes} onChangeText={(v) => set('notes', v)} multiline numberOfLines={3} placeholder={t('open_slot.notes_placeholder')} accessibilityLabel={t('open_slot.notes_label')} />
      {!isEdit ? <Field label={t('open_slot.private_notes_label')} value={form.private_notes} onChangeText={(v) => set('private_notes', v)} multiline numberOfLines={2} placeholder={t('open_slot.private_notes_placeholder')} accessibilityLabel={t('open_slot.private_notes_label')} /> : null}
      {!isEdit ? <Chip label={t('open_slot.publish_now')} active={form.publish} onPress={() => set('publish', !form.publish)} accessibilityLabel={t('open_slot.publish_now')} /> : null}
      {err ? <T size={13} color={c.error}>{err}</T> : null}
    </FormSheet>
  );
}

// ─── decide application sheet ─────────────────────────────────────────────────

function DecideSheet({ app, onClose, onDone }) {
  const [decision, setDecision] = useState(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    if (!decision) return;
    setLoading(true); setErr(null);
    try {
      await api('POST', `/open-slot-applications/${app.id}/decide`, { decision, note: note.trim() || undefined });
      onDone();
    } catch (e) { setErr(e.message); setLoading(false); }
  }

  return (
    <Sheet onClose={onClose} title={t('open_slot.decide_title')}>
      <ScrollView style={{ padding: 16 }}>
        <Card color={c.paper} style={{ padding: 12, marginBottom: 12, gap: 6 }}>
          <T weight="700" size={15}>{app.display_name}</T>
          <T size={12} color={c.mute}>{t('open_slot.applied_at')}: {when(app.applied_at)}</T>
          {app.eligibility_snapshot?.factors ? <EligSummary factors={app.eligibility_snapshot.factors} /> : null}
        </Card>
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
          <Btn label={t('open_slot.approve_cta')} color={decision === 'approve' ? c.pink : c.paper} onPress={() => setDecision('approve')} style={{ flex: 1 }} accessibilityLabel={t('open_slot.approve_cta')} />
          <Btn label={t('open_slot.reject_cta')} color={decision === 'reject' ? c.violet : c.paper} onPress={() => setDecision('reject')} style={{ flex: 1 }} accessibilityLabel={t('open_slot.reject_cta')} />
        </View>
        {decision === 'reject' ? (
          <Field label={t('open_slot.rejection_note')} value={note} onChangeText={setNote} multiline numberOfLines={2} placeholder={t('open_slot.rejection_note_placeholder')} style={{ marginBottom: 12 }} />
        ) : null}
        {err ? <T size={13} color={c.error} style={{ marginBottom: 8 }}>{err}</T> : null}
        <Btn label={t('open_slot.confirm_decision')} color={c.pink} loading={loading} disabled={!decision} onPress={submit} accessibilityLabel={t('open_slot.confirm_decision')} />
        <Btn label={t('common.back')} color={c.paper} onPress={onClose} style={{ marginTop: 8 }} accessibilityLabel={t('common.back')} />
      </ScrollView>
    </Sheet>
  );
}

function EligSummary({ factors = [] }) {
  const all = factors.every((f) => f.state === 'eligible');
  return (
    <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
      <Tag label={all ? '✅ All checks passed' : '⚠️ Has ineligible factors'} color={all ? c.mintSoft : c.sunSoft} />
    </View>
  );
}

// ─── slot detail card with applicant list ─────────────────────────────────────

function SlotDetail({ slot, onEdit, onClose: onCloseSlot, onReload }) {
  const [decideApp, setDecideApp] = useState(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [closingLoading, setClosingLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [statusLabel, statusColor] = SLOT_STATUS[slot.status] ?? [slot.status, c.paper];
  const mode = slot.approval_mode;

  async function doClose() {
    setClosingLoading(true); setErr(null);
    try { await api('POST', `/open-match-slots/${slot.id}/close`); onReload(); setCloseConfirm(false); }
    catch (e) { setErr(e.message); setClosingLoading(false); }
  }

  const pending = slot.applications?.filter((a) => a.status === 'pending') ?? [];
  const approved = slot.applications?.filter((a) => a.status === 'approved') ?? [];
  const waitlisted = slot.applications?.filter((a) => a.status === 'waitlisted') ?? [];

  return (
    <Card style={{ marginBottom: 14 }} accessibilityLabel={`${ROLE_LABEL[slot.role] ?? slot.role} slot, ${statusLabel}`}>
      <View style={{ gap: 10 }}>
        {/* header */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Tag label={ROLE_LABEL[slot.role] ?? slot.role} color={c.violetSoft} />
            <Tag label={statusLabel} color={statusColor} />
            {mode === 'instant' ? <Tag label="⚡ Instant claim" color={c.mintSoft} /> : <Tag label="⏳ Approval required" color={c.sunSoft} />}
            {slot.allow_waitlist ? <Tag label="🕐 Waitlist on" color={c.cyanSoft} /> : null}
            {slot.fee_minor != null ? <Tag label={`💰 ${money(slot.fee_minor, slot.fee_currency)}`} color={c.mintSoft} /> : null}
          </View>
          <T size={13} weight="700" color={c.mute}>{slot.filled}/{slot.slots}</T>
        </View>
        {/* progress bar */}
        <View style={{ height: 4, borderRadius: 2, backgroundColor: c.paper, overflow: 'hidden' }}>
          <View style={{ height: 4, width: `${Math.round((slot.filled / slot.slots) * 100)}%`, backgroundColor: c.pink, borderRadius: 2 }} />
        </View>
        {slot.min_grade ? <T size={12} color={c.mute}>{t('open_slot.min_grade')}: {slot.min_grade}</T> : null}
        {slot.notes ? <T size={12} color={c.mute}>{slot.notes}</T> : null}
        {slot.private_notes ? <T size={12} color={c.violet} style={{ fontStyle: 'italic' }}>🔒 {slot.private_notes}</T> : null}
        {/* applicants (approval mode) */}
        {mode === 'approval' && pending.length > 0 ? (
          <View style={{ gap: 6 }}>
            <T size={13} weight="700">{t('open_slot.pending_title')} ({pending.length})</T>
            {pending.map((app) => (
              <Card key={app.id} color={c.sunSoft} style={{ padding: 10 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <T weight="700" size={14}>{app.display_name}</T>
                    <T size={12} color={c.mute}>{t('open_slot.applied_at')}: {when(app.applied_at)}</T>
                    {app.eligibility_snapshot?.factors ? <EligSummary factors={app.eligibility_snapshot.factors} /> : null}
                  </View>
                  <Btn label={t('open_slot.decide_cta')} color={c.pink} size="sm" onPress={() => setDecideApp(app)} accessibilityLabel={t('open_slot.decide_cta')} />
                </View>
              </Card>
            ))}
          </View>
        ) : null}
        {/* approved */}
        {approved.length > 0 ? (
          <View style={{ gap: 4 }}>
            <T size={13} weight="700">{t('open_slot.approved_title')} ({approved.length})</T>
            {approved.map((app) => (
              <View key={app.id} style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <Tag label={`✅ ${app.display_name}`} color={c.mintSoft} />
              </View>
            ))}
          </View>
        ) : null}
        {/* waitlisted */}
        {waitlisted.length > 0 ? (
          <View style={{ gap: 4 }}>
            <T size={13} weight="700">{t('open_slot.waitlist_title')} ({waitlisted.length})</T>
            {waitlisted.map((app) => (
              <Tag key={app.id} label={`#${app.waitlist_position} ${app.display_name}`} color={c.cyanSoft} />
            ))}
          </View>
        ) : null}
        {/* actions */}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          {['draft', 'open', 'full'].includes(slot.status) ? (
            <Btn label={t('open_slot.edit_cta')} color={c.paper} size="sm" onPress={() => onEdit(slot)} accessibilityLabel={t('open_slot.edit_cta')} />
          ) : null}
          {['open', 'full'].includes(slot.status) ? (
            <Btn label={t('open_slot.close_cta')} color={c.paper} size="sm" onPress={() => setCloseConfirm(true)} accessibilityLabel={t('open_slot.close_cta')} />
          ) : null}
        </View>
        {closeConfirm ? (
          <Card color={c.sunSoft} style={{ padding: 10, gap: 8 }}>
            <T weight="700" size={13}>{t('open_slot.close_confirm')}</T>
            {err ? <T size={12} color={c.error}>{err}</T> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn label={t('open_slot.close_yes')} color={c.pink} loading={closingLoading} onPress={doClose} size="sm" accessibilityLabel={t('open_slot.close_yes')} />
              <Btn label={t('common.cancel')} color={c.paper} onPress={() => setCloseConfirm(false)} size="sm" accessibilityLabel={t('common.cancel')} />
            </View>
          </Card>
        ) : null}
      </View>
      {decideApp ? (
        <DecideSheet app={decideApp} onClose={() => setDecideApp(null)} onDone={() => { setDecideApp(null); onReload(); }} />
      ) : null}
    </Card>
  );
}

// ─── main screen ──────────────────────────────────────────────────────────────

export function OpenSlotManage({ route }) {
  const { fixtureId, fixtureName, eventId } = route?.params ?? {};
  const [addSlot, setAddSlot] = useState(false);
  const [editSlot, setEditSlot] = useState(null);

  const { data, loading, error, reload } = useLoad(
    () => api('GET', `/fixtures/${fixtureId}/open-slots`),
    [fixtureId],
  );

  const totalOpen = data?.reduce((n, s) => n + (s.status === 'open' ? 1 : 0), 0) ?? 0;
  const totalPending = data?.reduce((n, s) => n + (s.pending_applications ?? 0), 0) ?? 0;
  const totalFilled = data?.reduce((n, s) => n + (s.filled ?? 0), 0) ?? 0;

  if (loading) return <Screen title={t('open_slot.manage_title')} back><Loading /></Screen>;
  if (error) return <Screen title={t('open_slot.manage_title')} back><LoadError onRetry={reload} /></Screen>;

  return (
    <Screen title={t('open_slot.manage_title')} back accessibilityLabel={t('open_slot.manage_title')}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        {/* hero */}
        {fixtureName ? <H1 style={{ marginBottom: 2 }}>{fixtureName}</H1> : null}

        {/* metrics strip */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16, marginTop: 8 }}>
          <Metric label={t('open_slot.metric_slots')} value={data?.length ?? 0} sub={t('open_slot.metric_slots_sub')} color={c.pinkSoft} />
          <Metric label={t('open_slot.metric_open')} value={totalOpen} sub={t('open_slot.metric_open_sub')} color={c.mintSoft} />
          <Metric label={t('open_slot.metric_filled')} value={totalFilled} sub={t('open_slot.metric_filled_sub')} color={c.cyanSoft} />
          <Metric label={t('open_slot.metric_pending_apps')} value={totalPending} sub={t('open_slot.metric_pending_apps_sub')} color={c.sunSoft} />
        </View>

        {/* slots */}
        {!data?.length ? (
          <Empty title={t('open_slot.manage_empty')} subtitle={t('open_slot.manage_empty_sub')} />
        ) : (
          data.map((slot) => (
            <SlotDetail key={slot.id} slot={slot} onEdit={(s) => setEditSlot(s)} onReload={reload} />
          ))
        )}

        {/* add slot */}
        <Btn
          label={t('open_slot.add_slot_cta')} color={c.pink} style={{ marginTop: 8 }}
          onPress={() => setAddSlot(true)}
          accessibilityLabel={t('open_slot.add_slot_cta')}
        />
      </ScrollView>

      {addSlot ? (
        <PublishSlotSheet fixtureId={fixtureId} eventId={eventId} onClose={() => setAddSlot(false)} onDone={() => { setAddSlot(false); reload(); }} />
      ) : null}
      {editSlot ? (
        <PublishSlotSheet fixtureId={fixtureId} eventId={eventId} existing={editSlot} onClose={() => setEditSlot(null)} onDone={() => { setEditSlot(null); reload(); }} />
      ) : null}
    </Screen>
  );
}
