// Para-sport officials workflow (#1027, R29): class-code context, sport procedure guide, accessibility preferences, incidents.
// Officials see competition sport class codes from para_outcomes only — no medical evidence, no classifier records.
// All features available on iOS, iPadOS, Android and web.
import React, { useState, useCallback } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c, r } from '../theme';
import { t } from '../i18n';

// ------------------------------------------------------------------ helpers

const when = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');

const CLASS_STATUS_COLOR = {
  confirmed: c.limeSoft,
  temporary: c.sunSoft,
  review_required: c.orangeSoft,
  not_eligible: c.redSoft,
  other: c.violetSoft,
};

function ClassChip({ para, accessibilityLabel }) {
  if (!para) return null;
  const color = CLASS_STATUS_COLOR[para.outcome_status] ?? c.violetSoft;
  const label = para.provisional ? `${para.class_code} ${t('para_official.provisional')}` : para.class_code;
  return (
    <Tag
      label={label}
      color={color}
      accessibilityLabel={accessibilityLabel ?? `${t('para_official.class_code')}: ${label}${para.provisional ? `, ${t('para_official.provisional_desc')}` : ''}`}
    />
  );
}

function PrivacyBanner() {
  return (
    <View
      style={{ backgroundColor: c.cyanSoft, borderRadius: r.card, padding: 12, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}
      accessible
      accessibilityRole="text"
      accessibilityLabel={t('para_official.privacy_notice')}
    >
      <T size={18}>🔒</T>
      <View style={{ flex: 1, gap: 2 }}>
        <T size={12} weight="800" color={c.cyan}>{t('para_official.privacy_title')}</T>
        <T size={11} color={c.mute} style={{ lineHeight: 16 }}>{t('para_official.privacy_notice')}</T>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ Tab 1: Para Lineup

function ParaLineupTab({ fixtureId }) {
  const { data, loading, error, reload } = useLoad(() => api.get(`/fixtures/${fixtureId}/para-context`), [fixtureId]);

  if (loading) return <Loading />;
  if (error) return <Empty label={t('error.generic')} />;
  const ctx = data;

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
      <PrivacyBanner />

      {!ctx?.has_para_athletes && (
        <Empty label={t('para_official.no_para_athletes')} />
      )}

      {ctx?.provisional_count > 0 && (
        <Card color={c.sunSoft} accessibilityRole="text">
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <T size={16}>⚠️</T>
            <View style={{ flex: 1, gap: 2 }}>
              <T size={13} weight="800" color={c.sun}>{t('para_official.provisional_warning', { count: ctx.provisional_count })}</T>
              <T size={12} color={c.mute} style={{ lineHeight: 16 }}>{t('para_official.provisional_rule')}</T>
            </View>
          </View>
        </Card>
      )}

      {ctx?.athletes?.length > 0 && (
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <T size={16} weight="800">{t('para_official.lineup_title')}</T>
            {ctx.athletes.some((a) => a.para) && (
              <Tag label={t('para_official.para_event')} color={c.cyanSoft} />
            )}
          </View>

          {ctx.athletes.map((athlete, idx) => (
            <View
              key={athlete.appearance_id}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: idx < ctx.athletes.length - 1 ? 1 : 0, borderBottomColor: c.line }}
              accessible
              accessibilityLabel={[
                athlete.display_name ?? t('common.name_suppressed'),
                athlete.team_name,
                athlete.para ? `${t('para_official.class_code')}: ${athlete.para.class_code}${athlete.para.provisional ? ` (${t('para_official.provisional')})` : ''}` : t('para_official.no_class'),
              ].filter(Boolean).join(', ')}
            >
              <View
                style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}
                accessibilityElementsHidden
              >
                <T size={18}>{athlete.avatar_emoji ?? '👤'}</T>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <T size={15} weight="800" style={{ flex: 1 }} numberOfLines={1}>{athlete.display_name ?? t('common.name_suppressed')}</T>
                  <ClassChip para={athlete.para} />
                </View>
                <T size={12} color={c.mute}>{[athlete.team_name, athlete.appearance_status].filter(Boolean).join(' · ')}</T>
                {athlete.para?.category && (
                  <T size={11} color={c.mute}>{athlete.para.category}</T>
                )}
              </View>
            </View>
          ))}
        </Card>
      )}

      {ctx?.has_para_athletes && (
        <Card color={c.cyanSoft} accessibilityRole="text">
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <T size={14}>👥</T>
            <T size={12} color={c.mute} style={{ flex: 1, lineHeight: 16 }}>{t('para_official.guide_note')}</T>
          </View>
        </Card>
      )}
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Tab 2: Procedure Guide

const PROCEDURE_SECTIONS = [
  { key: 'time_extensions', emoji: '⏱', label: 'para_official.proc_time' },
  { key: 'substitution_limits', emoji: '🔄', label: 'para_official.proc_subs' },
  { key: 'signal_protocols', emoji: '📡', label: 'para_official.proc_signals' },
  { key: 'communication_adaptations', emoji: '🗣️', label: 'para_official.proc_comms' },
  { key: 'equipment_notes', emoji: '🦾', label: 'para_official.proc_equipment' },
  { key: 'other', emoji: '📋', label: 'para_official.proc_other' },
];

function ProcedureTab({ fixtureId }) {
  const [open, setOpen] = useState(null);
  const { data, loading, error } = useLoad(() => api.get(`/fixtures/${fixtureId}/para-procedure`), [fixtureId]);
  const { toast } = useSession();

  const downloadOffline = useCallback(async () => {
    try {
      const { token } = await api.get(`/fixtures/${fixtureId}/offline-para-rules`);
      toast(t('para_official.offline_saved'));
    } catch (e) {
      toast(e.message);
    }
  }, [fixtureId]);

  if (loading) return <Loading />;
  if (error) return <Empty label={t('error.generic')} />;
  const proc = data;

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
      {/* Offline pack download */}
      <View
        style={{ backgroundColor: c.violetSoft, borderRadius: r.card, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}
        accessible
      >
        <T size={18} accessibilityElementsHidden>📥</T>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={13} weight="800">{t('para_official.offline_title')}</T>
          <T size={11} color={c.mute}>{t('para_official.offline_hint')}</T>
        </View>
        <Btn
          title={t('para_official.offline_btn')}
          size="sm"
          variant="outline"
          onPress={downloadOffline}
          accessibilityLabel={t('para_official.offline_btn_label')}
        />
      </View>

      <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5, textTransform: 'uppercase' }}>
        {proc?.sport_name} — {t('para_official.procedure_guide')}
      </T>

      {PROCEDURE_SECTIONS.map(({ key, emoji, label }) => {
        if (!proc?.[key]) return null;
        const isOpen = open === key;
        return (
          <View key={key} style={{ borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: c.line }}>
            <Pressable
              onPress={() => setOpen(isOpen ? null : key)}
              style={{ backgroundColor: c.paper, padding: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
              accessibilityRole="button"
              accessibilityLabel={t(label)}
              accessibilityState={{ expanded: isOpen }}
            >
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', flex: 1 }}>
                <T size={16} accessibilityElementsHidden>{emoji}</T>
                <T size={14} weight="700">{t(label)}</T>
              </View>
              <T size={16} color={c.pink}>{isOpen ? '▾' : '›'}</T>
            </Pressable>
            {isOpen && (
              <View style={{ backgroundColor: c.bg, padding: 14, gap: 8 }} accessibilityRole="text">
                {proc[key].split('. ').filter(Boolean).map((sentence, i) => (
                  <T key={i} size={13} color={c.ink} style={{ lineHeight: 20 }}>{sentence.trim()}{sentence.endsWith('.') ? '' : '.'}</T>
                ))}
              </View>
            )}
          </View>
        );
      })}

      {proc?.source_ref && (
        <Card style={{ padding: 12 }}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <T size={14} accessibilityElementsHidden>📋</T>
            <T size={12} color={c.mute} style={{ flex: 1, lineHeight: 16 }}>{proc.source_ref}</T>
          </View>
        </Card>
      )}

      {proc?.has_overrides && (
        <Tag label={t('para_official.has_overrides')} color={c.pinkSoft} accessibilityLabel={t('para_official.has_overrides_label')} />
      )}
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Tab 3: Accessible Controls

const PREF_FIELDS = [
  { key: 'large_targets', label: 'para_official.pref_large_targets', hint: 'para_official.pref_large_targets_hint' },
  { key: 'high_contrast', label: 'para_official.pref_high_contrast', hint: 'para_official.pref_high_contrast_hint' },
  { key: 'screen_reader', label: 'para_official.pref_screen_reader', hint: 'para_official.pref_screen_reader_hint' },
  { key: 'hearing_loop', label: 'para_official.pref_hearing_loop', hint: 'para_official.pref_hearing_loop_hint' },
  { key: 'haptic_alerts', label: 'para_official.pref_haptic_alerts', hint: 'para_official.pref_haptic_alerts_hint' },
  { key: 'written_comms', label: 'para_official.pref_written_comms', hint: 'para_official.pref_written_comms_hint' },
];

const NEED_KIND_OPTIONS = [
  { value: 'hearing_loop', label: 'para_official.need_hearing_loop' },
  { value: 'large_font', label: 'para_official.need_large_font' },
  { value: 'high_contrast', label: 'para_official.need_high_contrast' },
  { value: 'screen_reader', label: 'para_official.need_screen_reader' },
  { value: 'haptic_alerts', label: 'para_official.need_haptic_alerts' },
  { value: 'written_comms', label: 'para_official.need_written_comms' },
  { value: 'sign_language_interpreter', label: 'para_official.need_sign_language' },
  { value: 'assistive_device', label: 'para_official.need_assistive_device' },
  { value: 'other', label: 'common.other' },
];

function AccessibleControlsTab() {
  const { toast } = useSession();
  const { data, loading, reload } = useLoad(() => api.get('/me/assistive-needs'), []);
  const [prefs, setPrefs] = useState(null);
  const [saving, setSaving] = useState(false);
  const [needSheet, setNeedSheet] = useState(false);
  const [newNeed, setNewNeed] = useState({ kind: '', detail: '', severity: 'required', notes: '' });

  const currentPrefs = prefs ?? data?.prefs ?? {};

  const toggle = (key) => setPrefs((p) => ({ ...(p ?? data?.prefs ?? {}), [key]: !(p ?? data?.prefs ?? {})[key] }));

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/me/assistive-needs', { prefs: currentPrefs, needs: data?.needs ?? [] });
      await reload();
      toast(t('para_official.prefs_saved'));
    } catch (e) {
      toast(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
      <Card color={c.cyanSoft} accessibilityRole="text">
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <T size={14}>ℹ️</T>
          <T size={13} color={c.mute} style={{ flex: 1, lineHeight: 18 }}>{t('para_official.prefs_info')}</T>
        </View>
      </Card>

      <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5, textTransform: 'uppercase' }}>{t('para_official.display_section')}</T>
      <Card>
        {PREF_FIELDS.map((f, idx) => (
          <View key={f.key}>
            <Pressable
              onPress={() => toggle(f.key)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56 }}
              accessibilityRole="switch"
              accessibilityLabel={t(f.label)}
              accessibilityState={{ checked: !!currentPrefs[f.key] }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <T size={14} weight="700">{t(f.label)}</T>
                <T size={12} color={c.mute}>{t(f.hint)}</T>
              </View>
              {/* Toggle switch */}
              <View
                style={{ width: 44, height: 26, borderRadius: 13, backgroundColor: currentPrefs[f.key] ? c.pink : c.line, justifyContent: 'center', padding: 3 }}
                accessibilityElementsHidden
              >
                <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: c.on, alignSelf: currentPrefs[f.key] ? 'flex-end' : 'flex-start' }} />
              </View>
            </Pressable>
            {idx < PREF_FIELDS.length - 1 && <View style={{ height: 1, backgroundColor: c.line }} />}
          </View>
        ))}
      </Card>

      <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5, textTransform: 'uppercase' }}>{t('para_official.assistive_section')}</T>
      <Card>
        {data?.needs?.length > 0
          ? data.needs.map((n, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: i < data.needs.length - 1 ? 1 : 0, borderBottomColor: c.line }}>
                <Tag label={t(NEED_KIND_OPTIONS.find((o) => o.value === n.kind)?.label ?? 'common.other')} color={c.cyanSoft} />
                {n.notes && <T size={12} color={c.mute} style={{ flex: 1 }}>{n.notes}</T>}
              </View>
            ))
          : <T size={13} color={c.mute}>{t('para_official.no_needs')}</T>
        }
        <Btn
          title={t('para_official.add_need')}
          variant="outline"
          size="sm"
          onPress={() => setNeedSheet(true)}
          style={{ marginTop: 8, borderRadius: r.pill }}
          accessibilityLabel={t('para_official.add_need_label')}
        />
      </Card>

      <Btn
        title={t('para_official.save_prefs')}
        onPress={save}
        loading={saving}
        style={{ borderRadius: r.pill }}
        accessibilityLabel={t('para_official.save_prefs_label')}
      />

      <Sheet open={needSheet} onClose={() => setNeedSheet(false)} title={t('para_official.add_need')}>
        <MenuField
          label={t('para_official.need_kind')}
          options={NEED_KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
          value={newNeed.kind}
          onChange={(v) => setNewNeed((n) => ({ ...n, kind: v }))}
        />
        <Field
          label={t('para_official.need_notes')}
          value={newNeed.notes}
          onChangeText={(v) => setNewNeed((n) => ({ ...n, notes: v }))}
          multiline
          maxLength={500}
          placeholder={t('para_official.need_notes_ph')}
          accessibilityLabel={t('para_official.need_notes')}
        />
        <Btn
          title={t('common.save')}
          onPress={async () => {
            if (!newNeed.kind) { toast(t('para_official.need_kind_required')); return; }
            const updatedNeeds = [...(data?.needs ?? []), { kind: newNeed.kind, notes: newNeed.notes || null, severity: 'required' }];
            try {
              await api.post('/me/assistive-needs', { prefs: currentPrefs, needs: updatedNeeds });
              await reload();
              setNeedSheet(false);
              setNewNeed({ kind: '', detail: '', severity: 'required', notes: '' });
              toast(t('para_official.need_added'));
            } catch (e) {
              toast(e.message);
            }
          }}
          style={{ borderRadius: r.pill }}
        />
      </Sheet>
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Tab 4: Incidents

const INCIDENT_KIND_OPTIONS = [
  { value: 'classification_protest', label: 'para_official.incident_protest' },
  { value: 'equipment_non_conformance', label: 'para_official.incident_equipment' },
  { value: 'procedure_breach', label: 'para_official.incident_procedure' },
  { value: 'guide_pairing', label: 'para_official.incident_guide' },
  { value: 'other', label: 'common.other' },
];

const INCIDENT_STATUS_COLOR = {
  open: c.sunSoft,
  under_review: c.cyanSoft,
  resolved: c.mintSoft,
  dismissed: c.violetSoft,
};

function IncidentsTab({ fixtureId, athletes }) {
  const { toast } = useSession();
  const { data, loading, reload } = useLoad(() => api.get(`/fixtures/${fixtureId}/para-incidents`), [fixtureId]);
  const [filing, setFiling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ kind: '', athlete_id: '', class_code: '', description: '' });

  const submit = async () => {
    if (!form.kind) { toast(t('para_official.incident_kind_required')); return; }
    if (!form.description || form.description.length < 10) { toast(t('para_official.incident_desc_required')); return; }
    setSubmitting(true);
    try {
      await api.post(`/fixtures/${fixtureId}/para-incidents`, {
        kind: form.kind,
        description: form.description,
        athlete_id: form.athlete_id || undefined,
        class_code: form.class_code || undefined,
      });
      await reload();
      setFiling(false);
      setForm({ kind: '', athlete_id: '', class_code: '', description: '' });
      toast(t('para_official.incident_filed'));
    } catch (e) {
      toast(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const athleteOptions = (athletes ?? []).map((a) => ({
    value: a.athlete_id,
    label: `${a.display_name ?? '—'} ${a.para?.class_code ? `(${a.para.class_code})` : ''}`,
  }));

  if (loading) return <Loading />;

  const incidents = data?.incidents ?? [];

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
      {incidents.filter((i) => i.status !== 'resolved' && i.status !== 'dismissed').length > 0 && (
        <>
          <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {t('para_official.open_incidents', { count: incidents.filter((i) => ['open','under_review'].includes(i.status)).length })}
          </T>
          {incidents.filter((i) => ['open','under_review'].includes(i.status)).map((inc) => (
            <Card key={inc.id} color={INCIDENT_STATUS_COLOR[inc.status] ?? c.sunSoft}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <Tag label={t(INCIDENT_KIND_OPTIONS.find((o) => o.value === inc.kind)?.label ?? 'common.other')} color={c.sunSoft} />
                <Tag label={t(`para_official.status_${inc.status}`)} color={INCIDENT_STATUS_COLOR[inc.status] ?? c.sunSoft} />
              </View>
              <T size={14} weight="700">{inc.description.slice(0, 120)}{inc.description.length > 120 ? '…' : ''}</T>
              {inc.athlete_name && (
                <T size={12} color={c.mute}>{t('para_official.athlete')}: {inc.athlete_name}{inc.class_code ? ` · ${inc.class_code}` : ''}</T>
              )}
              <T size={11} color={c.mute}>{t('para_official.filed_by', { name: inc.filed_by_name })} · {when(inc.created_at)}</T>
            </Card>
          ))}
        </>
      )}

      <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5, textTransform: 'uppercase' }}>{t('para_official.file_new')}</T>
      <Card>
        <MenuField
          label={t('para_official.incident_kind')}
          options={INCIDENT_KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
          value={form.kind}
          onChange={(v) => setForm((f) => ({ ...f, kind: v }))}
          placeholder={t('para_official.incident_kind_ph')}
          accessibilityLabel={t('para_official.incident_kind')}
        />
        {athleteOptions.length > 0 && (
          <MenuField
            label={t('para_official.athlete_optional')}
            options={[{ value: '', label: t('common.none') }, ...athleteOptions]}
            value={form.athlete_id}
            onChange={(v) => {
              const a = athletes?.find((x) => x.athlete_id === v);
              setForm((f) => ({ ...f, athlete_id: v, class_code: a?.para?.class_code ?? f.class_code }));
            }}
            placeholder={t('para_official.athlete_ph')}
            accessibilityLabel={t('para_official.athlete_optional')}
          />
        )}
        <Field
          label={t('para_official.class_code_shown')}
          value={form.class_code}
          onChangeText={(v) => setForm((f) => ({ ...f, class_code: v }))}
          maxLength={20}
          placeholder={t('para_official.class_code_ph')}
          accessibilityLabel={t('para_official.class_code_shown')}
        />
        <Field
          label={t('para_official.incident_desc')}
          value={form.description}
          onChangeText={(v) => setForm((f) => ({ ...f, description: v }))}
          multiline
          maxLength={2000}
          placeholder={t('para_official.incident_desc_ph')}
          accessibilityLabel={t('para_official.incident_desc')}
        />
        {/* Privacy disclaimer before submit */}
        <View style={{ backgroundColor: c.cyanSoft, borderRadius: 10, padding: 10 }} accessibilityRole="text">
          <T size={11} color={c.mute} style={{ lineHeight: 16 }}>{t('para_official.incident_disclaimer')}</T>
        </View>
        <Btn
          title={t('para_official.submit_incident')}
          onPress={submit}
          loading={submitting}
          style={{ borderRadius: r.pill, backgroundColor: c.violet }}
          accessibilityLabel={t('para_official.submit_incident_label')}
        />
      </Card>

      {incidents.filter((i) => ['resolved','dismissed'].includes(i.status)).length > 0 && (
        <>
          <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 8 }}>{t('para_official.resolved_incidents')}</T>
          {incidents.filter((i) => ['resolved','dismissed'].includes(i.status)).map((inc) => (
            <Card key={inc.id} color={INCIDENT_STATUS_COLOR[inc.status]}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <Tag label={t(INCIDENT_KIND_OPTIONS.find((o) => o.value === inc.kind)?.label ?? 'common.other')} color={c.violetSoft} />
                <Tag label={t(`para_official.status_${inc.status}`)} color={INCIDENT_STATUS_COLOR[inc.status] ?? c.violetSoft} />
              </View>
              <T size={13} color={c.mute}>{inc.description.slice(0, 100)}{inc.description.length > 100 ? '…' : ''}</T>
              {inc.resolution && <T size={12} color={c.ink}>{inc.resolution}</T>}
            </Card>
          ))}
        </>
      )}
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Main screen

const TABS = [
  { key: 'lineup', label: 'para_official.tab_lineup' },
  { key: 'procedure', label: 'para_official.tab_procedure' },
  { key: 'access', label: 'para_official.tab_access' },
  { key: 'incidents', label: 'para_official.tab_incidents' },
];

export function OfficialsPara({ fixtureId, sport, event }) {
  const [tab, setTab] = useState('lineup');
  const { wide } = useLayout();

  // Load lineup once and share between Lineup tab and Incidents tab (for athlete picker)
  const { data: ctx } = useLoad(() => api.get(`/fixtures/${fixtureId}/para-context`), [fixtureId]);

  return (
    <View style={{ flex: 1 }}>
      {/* Match header chip strip */}
      {sport && (
        <View style={{ backgroundColor: c.pink, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <T size={13} color={c.on} weight="700">{sport.emoji} {sport.name}</T>
          {event?.name && <T size={12} color="rgba(255,255,255,0.7)">· {event.name}</T>}
          {ctx?.provisional_count > 0 && (
            <Tag label={`⚠️ ${ctx.provisional_count} ${t('para_official.provisional')}`} color="rgba(255,255,255,0.18)" style={{ color: c.on }} />
          )}
        </View>
      )}

      <Seg
        tabs={TABS.map((x) => ({ key: x.key, label: t(x.label) }))}
        value={tab}
        onChange={setTab}
        style={{ marginHorizontal: 16, marginTop: 12 }}
        accessibilityLabel={t('para_official.tabs_label')}
      />

      <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 12 }}>
        {tab === 'lineup'    && <ParaLineupTab fixtureId={fixtureId} />}
        {tab === 'procedure' && <ProcedureTab fixtureId={fixtureId} />}
        {tab === 'access'    && <AccessibleControlsTab />}
        {tab === 'incidents' && <IncidentsTab fixtureId={fixtureId} athletes={ctx?.athletes} />}
      </View>
    </View>
  );
}

// Default screen export for direct navigation
export default function OfficialsParaScreen({ route }) {
  const { fixtureId, sport, event } = route?.params ?? {};
  const nav = useNav();
  if (!fixtureId) {
    return <Screen title={t('para_official.title')}><Empty label={t('error.generic')} /></Screen>;
  }
  return (
    <Screen title={t('para_official.title')} onBack={() => nav.back()}>
      <OfficialsPara fixtureId={fixtureId} sport={sport} event={event} />
    </Screen>
  );
}
