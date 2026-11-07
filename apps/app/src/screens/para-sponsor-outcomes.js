// PS-27: Privacy-preserving para-sport sponsorship outcomes and impact.
// Three components:
//   ParaSponsorOutcomes — sponsor/admin view of programme delivery dashboard and reports
//   ParaAthleteStoryConsent — athlete story consent workspace (create/edit/withdraw)
//   ParaImpactReport — immutable impact report viewer (sponsor + admin, role-switches)
import React, { useState, useCallback } from 'react';
import { View, FlatList, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Screen, Section, Seg, T, Tag, H1, H2, Field } from '../ui';
import { MenuField, MultiMenuField } from '../menu-field';
import { FormSheet } from '../FormSheet';
import { Sheet } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';
import { useNav } from '../nav';
import { useLayout } from '../layout';

const word = (k) => String(k ?? '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const pct = (n) => n == null ? '—' : `${Math.round(n * 100)}%`;
const fmt = (p, cur) => { if (p == null) return '—'; try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur ?? 'USD' }); return f.format(p / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return String(p); } };
const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;

const SECTION_KEY_OPTIONS = [
  { value: 'journey', label: t('para.outcomes.story.section.journey') },
  { value: 'training', label: t('para.outcomes.story.section.training') },
  { value: 'competition', label: t('para.outcomes.story.section.competition') },
  { value: 'milestones', label: t('para.outcomes.story.section.milestones') },
  { value: 'equipment', label: t('para.outcomes.story.section.equipment') },
  { value: 'goals', label: t('para.outcomes.story.section.goals') },
  { value: 'gratitude', label: t('para.outcomes.story.section.gratitude') },
  { value: 'community', label: t('para.outcomes.story.section.community') },
  { value: 'challenge', label: t('para.outcomes.story.section.challenge') },
  { value: 'other', label: t('para.outcomes.story.section.other') },
];

// ------------------------------------------------------------------ shared sub-components

function PrivacyNotice({ style }) {
  return (
    <Card color={c.bg} style={[{ borderWidth: 1, borderColor: c.line }, style]}>
      <T size={11} color={c.mute} accessibilityRole="note">
        {t('para.outcomes.privacy_notice')}
      </T>
    </Card>
  );
}

function SuppressedBanner({ k = 5 }) {
  return (
    <View
      accessibilityRole="alert"
      style={{ backgroundColor: c.sunSoft, borderRadius: 12, padding: 12, marginBottom: 12 }}
    >
      <T size={13} color={c.ink}>{t('para.outcomes.suppressed_notice', { k })}</T>
    </View>
  );
}

function MetricTile({ label, value, tone }) {
  return (
    <Card color={c.paper} style={{ flex: 1, minWidth: 120, alignItems: 'center', paddingVertical: 16 }}>
      <T size={24} weight="800" color={tone ?? c.pink}>{value ?? '—'}</T>
      <T size={11} color={c.mute} style={{ textAlign: 'center', marginTop: 2 }}>{label}</T>
    </Card>
  );
}

function MetricStrip({ tiles, wide }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: wide ? 'nowrap' : 'wrap', marginBottom: 16 }}>
      {tiles.map((tile) => (
        <MetricTile key={tile.label} {...tile} />
      ))}
    </View>
  );
}

function SuppressCell({ data, label }) {
  if (!data) return <T size={13} color={c.mute}>—</T>;
  if (data.suppressed) return <T size={13} color={c.sun}>{t('para.outcomes.report.suppressed_cell', { k: data.k ?? 5 })}</T>;
  return <T size={15} weight="700" color={c.ink}>{data.value ?? '—'}</T>;
}

// ------------------------------------------------------------------ ParaSponsorOutcomes

export function ParaSponsorOutcomes({ programmeId }) {
  const { wide } = useLayout();
  const nav = useNav();
  const [storiesOpen, setStoriesOpen] = useState(false);

  const snap = useLoad(() => api.get(`/para-sport-sponsorship-outcomes/programme-snapshots/${programmeId}`), [programmeId]);
  const stories = useLoad(() => storiesOpen ? api.get('/para-sport-sponsorship-outcomes/stories', { programme_id: programmeId }) : null, [storiesOpen, programmeId]);

  if (snap.loading && !snap.data) return <Screen><Loading /></Screen>;
  if (snap.error) return <Screen><ErrorBox error={snap.error} onRetry={snap.reload} /></Screen>;
  const d = snap.data;

  const hasSuppressed = [
    d.delivery_evidence?.delivery_evidence,
    d.training_attendance?.athletes_attended,
    d.competition_results?.athletes_competed,
    d.development_milestones?.achieved,
  ].some((x) => x?.suppressed);

  const attendancePct = (() => {
    const att = d.training_attendance?.athletes_attended?.value;
    const enr = d.enrolled_total;
    if (!att || !enr) return null;
    return pct(att / enr);
  })();

  return (
    <Screen
      title={t('para.outcomes.sponsor.title')}
      onRefresh={snap.reload}
      refreshing={snap.loading}
    >
      {hasSuppressed && <SuppressedBanner k={d.cohort_k_min} />}

      <MetricStrip
        wide={wide}
        tiles={[
          { label: t('para.outcomes.sponsor.enrolled_total'), value: d.enrolled_total, tone: c.violet },
          { label: t('para.outcomes.sponsor.evidence_confirmed'), value: d.delivery_evidence?.confirmed_count?.value ?? '—' },
          { label: t('para.outcomes.sponsor.attendance_rate'), value: attendancePct },
          { label: t('para.outcomes.sponsor.milestones_achieved'), value: d.development_milestones?.achieved?.value ?? '—', tone: c.lime },
        ]}
      />

      <Section title={t('para.outcomes.sponsor.delivery_title')}>
        <Card color={c.paper}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T color={c.mute} size={12}>{t('para.outcomes.sponsor.total_evidence')}</T>
              <SuppressCell data={d.delivery_evidence?.delivery_evidence} />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T color={c.mute} size={12}>{t('para.outcomes.sponsor.confirmed_evidence')}</T>
              <SuppressCell data={d.delivery_evidence?.confirmed_count} />
            </View>
          </View>
        </Card>
        {d.source_warnings?.map((w, idx) => (
          <View key={idx} accessibilityRole="alert" style={{ backgroundColor: c.sunSoft, borderRadius: 10, padding: 10, marginTop: 6 }}>
            <T size={12} color={c.ink}>{w.warning}</T>
          </View>
        ))}
      </Section>

      <Section title={t('para.outcomes.sponsor.training_title')}>
        <Card color={c.paper}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T color={c.mute} size={12}>{t('para.outcomes.sponsor.athletes_attended')}</T>
              <SuppressCell data={d.training_attendance?.athletes_attended} />
            </View>
            {d.training_attendance?.denominator && (
              <T size={12} color={c.mute}>{d.training_attendance.denominator}</T>
            )}
          </View>
        </Card>
      </Section>

      <Section title={t('para.outcomes.sponsor.competition_title')}>
        <Card color={c.paper}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T color={c.mute} size={12}>{t('para.outcomes.sponsor.athletes_competed')}</T>
            <SuppressCell data={d.competition_results?.athletes_competed} />
          </View>
        </Card>
      </Section>

      <Section title={t('para.outcomes.sponsor.milestones_title')}>
        <Card color={c.paper}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T color={c.mute} size={12}>{t('para.outcomes.sponsor.milestones_achieved')}</T>
            <SuppressCell data={d.development_milestones?.achieved} />
          </View>
        </Card>
      </Section>

      <Section title={t('para.outcomes.sponsor.stories_title')}>
        <Card color={c.paper}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T color={c.mute} size={12}>{t('para.outcomes.sponsor.approved_stories_count')}</T>
            <T size={15} weight="700">{d.approved_stories?.count ?? 0}</T>
          </View>
          {(d.approved_stories?.count ?? 0) > 0 && (
            <Btn
              label={t('para.outcomes.sponsor.view_stories')}
              color={c.paper}
              style={{ marginTop: 10 }}
              onPress={() => setStoriesOpen(true)}
            />
          )}
        </Card>
      </Section>

      <Btn
        label={t('para.outcomes.sponsor.view_reports')}
        onPress={() => nav.push('ParaImpactReport', { programmeId })}
        style={{ marginTop: 8, marginBottom: 16 }}
      />

      <PrivacyNotice style={{ marginBottom: 24 }} />

      <Sheet open={storiesOpen} onClose={() => setStoriesOpen(false)} title={t('para.outcomes.sponsor.stories_title')}>
        {stories.loading && <Loading />}
        {stories.data?.stories?.map((s) => (
          <Card key={s.id} color={c.bg} style={{ marginBottom: 8 }}>
            <T weight="700">{s.title}</T>
            <T size={12} color={c.mute}>{s.athlete_ref} · {s.sections?.length ?? 0} {t('para.outcomes.story.sections_count', { n: s.sections?.length ?? 0 })}</T>
            {s.expires_on && <Chip label={t('para.outcomes.story.expires', { date: fmtDate(s.expires_on) })} color={c.sunSoft} style={{ marginTop: 4 }} />}
          </Card>
        ))}
        {stories.data?.stories?.length === 0 && <Empty emoji="📖" title={t('para.outcomes.sponsor.no_stories')} sub="" />}
      </Sheet>
    </Screen>
  );
}

// ------------------------------------------------------------------ StoryForm (shared for create/edit)

function StoryForm({ story, programmeId, onDone }) {
  const [title, setTitle] = useState(story?.title ?? '');
  const [sections, setSections] = useState(
    story?.sections?.length ? story.sections.map((s) => ({ ...s })) : [{ section_key: 'journey', heading: '', body: '', approved: false, sort_order: 0 }],
  );
  const [expiresOn, setExpiresOn] = useState(story?.expires_on ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { toast } = useSession();

  const addSection = () => setSections((prev) => [...prev, { section_key: 'other', heading: '', body: '', approved: false, sort_order: prev.length }]);
  const removeSection = (idx) => setSections((prev) => prev.filter((_, i) => i !== idx));
  const updateSection = (idx, key, val) => setSections((prev) => prev.map((s, i) => i === idx ? { ...s, [key]: val } : s));

  const submit = async () => {
    if (!title.trim()) { setErr(t('para.outcomes.story.title_required')); return; }
    if (sections.some((s) => !s.heading.trim() || !s.body.trim())) { setErr(t('para.outcomes.story.sections_incomplete')); return; }
    setBusy(true); setErr(null);
    try {
      if (story?.id) {
        await api.patch(`/para-sport-sponsorship-outcomes/stories/${story.id}`, { sections, expires_on: expiresOn || undefined });
      } else {
        await api.post('/para-sport-sponsorship-outcomes/stories', { programme_id: programmeId, title, sections, expires_on: expiresOn || undefined });
      }
      toast(t('para.outcomes.story.saved'));
      onDone();
    } catch (e) {
      setErr(e.message ?? t('common.error'));
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 14 }}>
      <Field
        label={t('para.outcomes.story.title_label')}
        placeholder={t('para.outcomes.story.title_placeholder')}
        value={title}
        onChangeText={setTitle}
        accessibilityLabel={t('para.outcomes.story.title_label')}
      />

      {sections.map((s, idx) => (
        <Card key={idx} color={c.bg} style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T weight="700" size={13}>{t('para.outcomes.story.section_number', { n: idx + 1 })}</T>
            {sections.length > 1 && (
              <Pressable onPress={() => removeSection(idx)} accessibilityRole="button" accessibilityLabel={t('para.outcomes.story.remove_section')}>
                <T size={12} color={c.red}>{t('common.remove')}</T>
              </Pressable>
            )}
          </View>
          <MenuField
            label={t('para.outcomes.story.section_key_label')}
            value={s.section_key}
            onChange={(v) => updateSection(idx, 'section_key', v)}
            options={SECTION_KEY_OPTIONS}
          />
          <Field
            label={t('para.outcomes.story.heading_label')}
            value={s.heading}
            onChangeText={(v) => updateSection(idx, 'heading', v)}
            accessibilityLabel={t('para.outcomes.story.heading_label')}
          />
          <Field
            label={t('para.outcomes.story.body_label')}
            value={s.body}
            onChangeText={(v) => updateSection(idx, 'body', v)}
            multiline
            numberOfLines={4}
            maxLength={2000}
            accessibilityLabel={t('para.outcomes.story.body_label')}
          />
          <Pressable
            onPress={() => updateSection(idx, 'approved', !s.approved)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: s.approved }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}
          >
            <View style={{ width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: s.approved ? c.pink : c.line, backgroundColor: s.approved ? c.pink : 'transparent', justifyContent: 'center', alignItems: 'center' }}>
              {s.approved && <T size={12} color="#fff" weight="700">✓</T>}
            </View>
            <T size={13} color={s.approved ? c.pink : c.mute}>{t('para.outcomes.story.approve_toggle')}</T>
          </Pressable>
        </Card>
      ))}

      {sections.length < 10 && (
        <Btn label={t('para.outcomes.story.add_section')} color={c.bg} onPress={addSection} />
      )}

      <Field
        label={t('para.outcomes.story.expires_label')}
        placeholder="YYYY-MM-DD"
        value={expiresOn}
        onChangeText={setExpiresOn}
        accessibilityLabel={t('para.outcomes.story.expires_label')}
      />

      {err && <ErrorBox error={err} />}

      <Card color={c.bg} style={{ borderWidth: 1, borderColor: c.line }}>
        <T size={11} color={c.mute}>{t('para.outcomes.story.privacy_guide')}</T>
      </Card>

      <Btn
        label={story?.id ? t('para.outcomes.story.update') : t('para.outcomes.story.save')}
        onPress={submit}
        disabled={busy}
      />
    </View>
  );
}

// ------------------------------------------------------------------ ParaAthleteStoryConsent

export function ParaAthleteStoryConsent({ programmeId, athleteId }) {
  const { user } = useSession();
  const [formOpen, setFormOpen] = useState(false);
  const [editStory, setEditStory] = useState(null);
  const [withdrawTarget, setWithdrawTarget] = useState(null);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const { toast } = useSession();

  const targetAthleteId = athleteId ?? user?.id;
  const stories = useLoad(
    () => api.get('/para-sport-sponsorship-outcomes/stories', { programme_id: programmeId, athlete_id: targetAthleteId }),
    [programmeId, targetAthleteId],
  );

  const activeStories = (stories.data?.stories ?? []).filter((s) => s.status === 'active');
  const withdrawnStories = (stories.data?.stories ?? []).filter((s) => s.status === 'withdrawn');

  const doWithdraw = async () => {
    if (!withdrawTarget) return;
    setWithdrawBusy(true);
    try {
      await api.post(`/para-sport-sponsorship-outcomes/stories/${withdrawTarget.id}/withdraw`, { reason: withdrawReason || undefined });
      toast(t('para.outcomes.story.withdrawn_toast'));
      setWithdrawTarget(null);
      stories.reload();
    } catch (e) {
      toast(e.message ?? t('common.error'));
      setWithdrawBusy(false);
    }
  };

  if (stories.loading && !stories.data) return <Screen><Loading /></Screen>;
  if (stories.error) return <Screen><ErrorBox error={stories.error} onRetry={stories.reload} /></Screen>;

  return (
    <Screen
      title={t('para.outcomes.athlete.story_title')}
      onRefresh={stories.reload}
      refreshing={stories.loading}
    >
      <MetricStrip
        tiles={[
          { label: t('para.outcomes.athlete.active_stories'), value: activeStories.length, tone: c.pink },
          { label: t('para.outcomes.athlete.withdrawn_stories'), value: withdrawnStories.length, tone: c.mute },
          { label: t('para.outcomes.athlete.sections_approved'), value: activeStories.reduce((acc, s) => acc + (s.sections?.filter((sec) => sec.approved)?.length ?? 0), 0), tone: c.lime },
        ]}
      />

      {activeStories.length === 0 && !formOpen && (
        <Empty
          emoji="📖"
          title={t('para.outcomes.athlete.no_stories')}
          sub={t('para.outcomes.athlete.no_stories_sub')}
        >
          <Btn label={t('para.outcomes.athlete.create_story')} onPress={() => { setEditStory(null); setFormOpen(true); }} style={{ marginTop: 12 }} />
        </Empty>
      )}

      {activeStories.map((s) => (
        <Card key={s.id} color={c.paper} style={{ marginBottom: 10 }}>
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <T weight="700" style={{ flex: 1 }}>{s.title}</T>
              <Chip label={t('para.outcomes.story.version', { v: s.version })} color={c.violetSoft} />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Chip label={`${s.sections?.filter((sec) => sec.approved)?.length ?? 0} ${t('para.outcomes.story.sections_approved_label')}`} color={c.limeSoft} />
              {s.expires_on
                ? <Chip label={t('para.outcomes.story.expires', { date: fmtDate(s.expires_on) })} color={c.sunSoft} />
                : <Chip label={t('para.outcomes.story.never_expires')} color={c.bg} />}
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              <Btn
                label={t('common.edit')}
                color={c.paper}
                small
                onPress={() => { setEditStory(s); setFormOpen(true); }}
                accessibilityLabel={t('para.outcomes.story.edit_label', { title: s.title })}
              />
              <Btn
                label={t('para.outcomes.story.withdraw_cta')}
                color={c.redSoft}
                small
                onPress={() => { setWithdrawTarget(s); setWithdrawReason(''); }}
                accessibilityLabel={t('para.outcomes.story.withdraw_label', { title: s.title })}
              />
            </View>
          </View>
        </Card>
      ))}

      {activeStories.length > 0 && (
        <Btn
          label={t('para.outcomes.athlete.create_story')}
          color={c.paper}
          onPress={() => { setEditStory(null); setFormOpen(true); }}
          style={{ marginBottom: 12 }}
        />
      )}

      <PrivacyNotice style={{ marginBottom: 24 }} />

      {/* Create / Edit sheet */}
      <Sheet
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditStory(null); }}
        title={editStory ? t('para.outcomes.story.form_title_edit') : t('para.outcomes.story.form_title')}
      >
        <StoryForm
          story={editStory}
          programmeId={programmeId}
          onDone={() => { setFormOpen(false); setEditStory(null); stories.reload(); }}
        />
      </Sheet>

      {/* Withdraw confirmation sheet */}
      <Sheet
        open={!!withdrawTarget}
        onClose={() => setWithdrawTarget(null)}
        title={t('para.outcomes.story.withdraw_sheet_title')}
      >
        <T style={{ marginBottom: 12 }}>{t('para.outcomes.story.withdraw_confirm')}</T>
        {withdrawTarget && (
          <Card color={c.sunSoft} style={{ marginBottom: 12 }}>
            <T weight="700">{withdrawTarget.title}</T>
          </Card>
        )}
        <Field
          label={t('para.outcomes.story.withdraw_reason_label')}
          placeholder={t('para.outcomes.story.withdraw_reason_placeholder')}
          value={withdrawReason}
          onChangeText={setWithdrawReason}
          multiline
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Btn label={t('common.cancel')} color={c.paper} onPress={() => setWithdrawTarget(null)} style={{ flex: 1 }} />
          <Btn
            label={t('para.outcomes.story.withdraw_cta')}
            color={c.red}
            onPress={doWithdraw}
            disabled={withdrawBusy}
            style={{ flex: 1 }}
            accessibilityLabel={t('para.outcomes.story.withdraw_cta')}
          />
        </View>
      </Sheet>
    </Screen>
  );
}

// ------------------------------------------------------------------ ExclusionManifest

function ExclusionManifest({ manifest }) {
  if (!manifest?.length) return null;
  return (
    <Card color={c.bg} style={{ borderWidth: 1, borderColor: c.line, marginBottom: 12 }} accessibilityRole="region" accessibilityLabel={t('para.outcomes.report.exclusion_manifest_title')}>
      <H2 style={{ marginBottom: 8 }}>{t('para.outcomes.report.exclusion_manifest_title')}</H2>
      {manifest.map((e) => (
        <View key={e.category} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: c.line }}>
          <T size={12} color={c.mute} style={{ flex: 1 }}>{t(`para.outcomes.report.exclusion.${e.category}`, { defaultValue: word(e.category) })}</T>
          <T size={12} weight="700" color={c.ink}>{e.screened_count ?? 0}</T>
        </View>
      ))}
      <T size={11} color={c.mute} style={{ marginTop: 8 }}>{t('para.outcomes.report.exclusion_note')}</T>
    </Card>
  );
}

// ------------------------------------------------------------------ IssueReportSheet

function IssueReportSheet({ programmeId, onDone }) {
  const [form, setForm] = useState({ from: '', to: '', valuation_note: '', narratives: {} });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { toast } = useSession();
  const sponsorships = useLoad(() => api.get('/sponsorships', { programme_id: programmeId, limit: 50 }), [programmeId]);

  const submit = async (vals) => {
    setBusy(true); setErr(null);
    try {
      await api.post('/para-sport-sponsorship-outcomes/impact-reports', {
        programme_id: programmeId,
        sponsorship_ids: vals.sponsorship_ids,
        from: vals.from,
        to: vals.to,
        valuation_note: vals.valuation_note || undefined,
        narrative: {
          delivery_evidence: vals.narrative_delivery || undefined,
          athletic_outcomes: vals.narrative_outcomes || undefined,
          development_milestones: vals.narrative_milestones || undefined,
          valuation_estimates: vals.narrative_valuation || undefined,
        },
      });
      toast(t('para.outcomes.report.issued_toast'));
      onDone();
    } catch (e) {
      setErr(e.message ?? t('common.error'));
      setBusy(false);
    }
  };

  return (
    <FormSheet
      title={t('para.outcomes.report.issue_title')}
      fields={[
        { key: 'sponsorship_ids', type: 'multi', label: t('para.outcomes.report.sponsorships_label'), options: (sponsorships.data?.sponsorships ?? []).map((s) => ({ value: s.id, label: s.name ?? s.id.slice(0, 8) })) },
        { key: 'from', type: 'date', label: t('para.outcomes.report.from_label') },
        { key: 'to', type: 'date', label: t('para.outcomes.report.to_label') },
        { key: 'narrative_delivery', type: 'multiline', label: t('para.outcomes.report.narrative.delivery'), required: false },
        { key: 'narrative_outcomes', type: 'multiline', label: t('para.outcomes.report.narrative.outcomes'), required: false },
        { key: 'narrative_milestones', type: 'multiline', label: t('para.outcomes.report.narrative.milestones'), required: false },
        { key: 'narrative_valuation', type: 'multiline', label: t('para.outcomes.report.narrative.valuation'), required: false },
        { key: 'valuation_note', type: 'multiline', label: t('para.outcomes.report.narrative.valuation_note'), required: false },
      ]}
      onSubmit={submit}
    />
  );
}

// ------------------------------------------------------------------ ParaImpactReport

export function ParaImpactReport({ programmeId, reportId: initialReportId }) {
  const { user } = useSession();
  const [reportId, setReportId] = useState(initialReportId ?? null);
  const [issueOpen, setIssueOpen] = useState(false);
  const { wide } = useLayout();
  const { toast } = useSession();

  const reports = useLoad(() => api.get('/para-sport-sponsorship-outcomes/impact-reports', { programme_id: programmeId }), [programmeId, reportId]);
  const report = useLoad(() => reportId ? api.get(`/para-sport-sponsorship-outcomes/impact-reports/${reportId}`) : null, [reportId]);

  const exportReport = async (format) => {
    try {
      const r = await api.get(`/para-sport-sponsorship-outcomes/impact-reports/${reportId}/export`, { format });
      if (typeof document !== 'undefined') {
        const bytes = r.encoding === 'base64' ? Uint8Array.from(atob(r.content), (ch) => ch.charCodeAt(0)) : r.content;
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: r.content_type })); a.download = r.filename; a.click();
      } else {
        toast(t('para.outcomes.report.export_native_note'));
      }
    } catch (e) {
      toast(e.message ?? t('common.error'));
    }
  };

  if (reportId && report.loading && !report.data) return <Screen><Loading /></Screen>;
  if (reportId && report.error) return <Screen><ErrorBox error={report.error} onRetry={report.reload} /></Screen>;

  // ---- Report detail view ----
  if (reportId && report.data) {
    const r = report.data;
    const snap = r.snapshot ?? {};
    return (
      <Screen
        title={t('para.outcomes.report.title')}
        onRefresh={report.reload}
        refreshing={report.loading}
      >
        {/* Verification badge */}
        <Card color={r.verified ? c.limeSoft : c.redSoft} style={{ marginBottom: 12 }} accessibilityRole="alert">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T size={20}>{r.verified ? '✓' : '⚠'}</T>
            <View style={{ flex: 1 }}>
              <T weight="700" color={r.verified ? c.lime : c.red}>{r.verified ? t('para.outcomes.report.verified') : t('para.outcomes.report.hash_mismatch')}</T>
              <T size={11} color={c.mute}>{t('para.outcomes.report.issued_at', { date: fmtDate(r.issued_at) })}</T>
              <T size={11} color={c.mute}>{t('para.outcomes.report.period', { from: r.period_from, to: r.period_to })}</T>
            </View>
          </View>
        </Card>

        {/* Four evidence sections */}
        {Object.entries(snap.sections ?? {}).map(([sectionKey, sectionData]) => (
          <Section key={sectionKey} title={t(`para.outcomes.report.section.${sectionKey}`, { defaultValue: word(sectionKey) })}>
            <Card color={c.paper}>
              {Object.entries(sectionData).filter(([k]) => !['narrative', 'source', 'warning'].includes(k)).map(([metric, value]) => (
                <View key={metric} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
                  <T size={12} color={c.mute} style={{ flex: 1 }}>{word(metric)}</T>
                  <T size={13} weight="700">{value == null ? t('para.outcomes.report.suppressed_cell', { k: snap.cohort_k_min ?? 5 }) : String(value)}</T>
                </View>
              ))}
              {sectionData.narrative && (
                <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.line }}>
                  <T size={12} color={c.mute} style={{ marginBottom: 4 }}>{t('para.outcomes.report.narrative_label')}</T>
                  <T size={13}>{sectionData.narrative}</T>
                </View>
              )}
              {sectionData.source && (
                <T size={11} color={c.mute} style={{ marginTop: 6 }}>{sectionData.source}</T>
              )}
              {sectionData.warning && (
                <View style={{ backgroundColor: c.sunSoft, borderRadius: 8, padding: 8, marginTop: 8 }}>
                  <T size={11} color={c.ink}>{sectionData.warning}</T>
                </View>
              )}
            </Card>
          </Section>
        ))}

        {/* Exclusion manifest */}
        <ExclusionManifest manifest={snap.exclusion_manifest} />

        {/* Causal claim notice */}
        <Card color={c.bg} style={{ borderWidth: 1, borderColor: c.line, marginBottom: 12 }}>
          <T size={11} color={c.mute}>{snap.causal_claim_policy ?? t('para.outcomes.report.causal_claim_notice')}</T>
        </Card>

        <PrivacyNotice style={{ marginBottom: 12 }} />

        {/* Export buttons */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 24 }}>
          <Btn label={t('para.outcomes.report.export_csv')} color={c.paper} onPress={() => exportReport('csv')} style={{ flex: 1 }} />
          <Btn label={t('para.outcomes.report.export_pdf')} color={c.paper} onPress={() => exportReport('pdf')} style={{ flex: 1 }} />
        </View>

        {/* SHA footer */}
        <T size={10} color={c.mute} style={{ marginBottom: 24 }}>SHA-256: {r.content_sha256}</T>
      </Screen>
    );
  }

  // ---- Report list view ----
  const isAdmin = user?.roles?.some((r) => ['admin', 'platform_admin'].includes(r));

  return (
    <Screen
      title={t('para.outcomes.report.title')}
      onRefresh={reports.reload}
      refreshing={reports.loading}
    >
      {isAdmin && (
        <Btn
          label={t('para.outcomes.report.issue_cta')}
          onPress={() => setIssueOpen(true)}
          style={{ marginBottom: 16 }}
        />
      )}

      {reports.loading && !reports.data && <Loading />}
      {reports.error && <ErrorBox error={reports.error} onRetry={reports.reload} />}

      {(reports.data?.reports ?? []).length === 0 && !reports.loading && (
        <Empty emoji="📊" title={t('para.outcomes.report.empty')} sub={t('para.outcomes.report.empty_sub')} />
      )}

      {(reports.data?.reports ?? []).map((r) => (
        <Card key={r.id} color={c.paper} style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1, gap: 4 }}>
              <T weight="700">{t('para.outcomes.report.period', { from: r.period_from, to: r.period_to })}</T>
              <T size={12} color={c.mute}>{t('para.outcomes.report.issued_at', { date: fmtDate(r.issued_at) })}</T>
            </View>
            <Chip
              label={r.verified ? t('para.outcomes.report.verified') : t('para.outcomes.report.hash_mismatch')}
              color={r.verified ? c.limeSoft : c.redSoft}
            />
          </View>
          <Btn
            label={t('common.open')}
            color={c.paper}
            small
            onPress={() => setReportId(r.id)}
            style={{ marginTop: 8 }}
            accessibilityLabel={t('para.outcomes.report.open_label', { period: `${r.period_from} to ${r.period_to}` })}
          />
        </Card>
      ))}

      <PrivacyNotice style={{ marginTop: 8, marginBottom: 24 }} />

      <Sheet open={issueOpen} onClose={() => setIssueOpen(false)} title={t('para.outcomes.report.issue_title')}>
        <IssueReportSheet programmeId={programmeId} onDone={() => { setIssueOpen(false); reports.reload(); }} />
      </Sheet>
    </Screen>
  );
}
