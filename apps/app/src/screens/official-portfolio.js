// Official Career Portfolio screen (#1009): career resume built from accepted engagements.
// Sections: hero strip, career-by-sport accordion, grades & credentials, milestones timeline,
// activity sparkline, federation licences, references, visibility settings and PDF export.
import React, { useState, useCallback } from 'react';
import { View, Pressable, ScrollView, Platform } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Empty, Loading, Screen, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateField, TextField, SwitchField, MenuField } from '../fields';
import { c, r } from '../theme';
import { t } from '../i18n';

const VER_CHIP = {
  verified:      { label: '✅ Verified',        bg: c.mintSoft  },
  self_declared: { label: '📋 Self-declared',   bg: c.card      },
  pending:       { label: '⏳ Pending',          bg: c.sunSoft   },
  rejected:      { label: '✗ Rejected',          bg: c.card      },
};
const REL_LABEL = { worked_with: 'Worked with', supervised: 'Supervised', assessed: 'Assessed', appointed: 'Appointed' };
const verChip = (s) => <Tag label={(VER_CHIP[s] ?? VER_CHIP.self_declared).label} color={(VER_CHIP[s] ?? VER_CHIP.self_declared).bg} />;

function ActivitySparkline({ months }) {
  if (!months?.length) return null;
  const groups = {};
  for (const m of months) { if (!groups[m.month]) groups[m.month] = 0; groups[m.month] += m.matches; }
  const sorted = Object.keys(groups).sort().slice(-12);
  const max = Math.max(...sorted.map((mo) => groups[mo]), 1);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 48, gap: 2 }}>
      {sorted.map((month) => {
        const h = Math.max(4, Math.round((groups[month] / max) * 44));
        return (
          <View key={month} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
            <View style={{ width: '80%', height: h, borderRadius: 3, backgroundColor: c.pink }} />
          </View>
        );
      })}
    </View>
  );
}

function MetricStrip({ summary }) {
  const items = [
    { label: t('portfolio.metric.matches'), value: summary?.total_matches ?? 0 },
    { label: t('portfolio.metric.sports'),  value: summary?.sports_count ?? 0 },
    { label: t('portfolio.metric.years'),   value: summary?.years_active ?? 0 },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      {items.map((item) => (
        <Card key={item.label} style={{ flex: 1, alignItems: 'center', paddingVertical: 14 }}>
          <T weight="900" size={28} color={c.pink}>{item.value}</T>
          <T size={11} color={c.mute} style={{ marginTop: 2 }}>{item.label}</T>
        </Card>
      ))}
    </View>
  );
}

function SportRow({ sport }) {
  const [open, setOpen] = useState(false);
  return (
    <Card style={{ marginBottom: 8 }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityLabel={`${sport.sport_name}, ${sport.total_matches} ${t('portfolio.metric.matches')}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
          <T size={20}>{sport.sport_emoji ?? '🏅'}</T>
        </View>
        <View style={{ flex: 1 }}>
          <T weight="800" size={15}>{sport.sport_name}</T>
          <T size={12} color={c.mute}>{(sport.roles ?? []).join(' · ')}</T>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <T weight="800" size={18} color={c.pink}>{sport.total_matches}</T>
          <T size={10} color={c.mute}>{t('portfolio.metric.matches')}</T>
        </View>
        <T size={16} color={c.mute}>{open ? '▲' : '▼'}</T>
      </Pressable>
      {open && (
        <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 0.5, borderTopColor: c.line }}>
          <T size={11} color={c.mute}>{t('portfolio.verified_matches')}</T>
          <T weight="700">{sport.verified_matches ?? 0} / {sport.total_matches}</T>
        </View>
      )}
    </Card>
  );
}

function GradeItem({ grade }) {
  return (
    <Card style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <T weight="800" size={14}>{grade.level_code} — {grade.level_name}</T>
          <T size={12} color={c.mute}>{grade.scheme_name}</T>
          <T size={11} color={c.mute}>{grade.governing_body_abbr ?? grade.governing_body}{grade.sport_name ? ' · ' + grade.sport_name : ''}{grade.effective_from ? ' · ' + t('portfolio.grade.from') + ' ' + grade.effective_from : ''}</T>
        </View>
        {verChip(grade.verification_status)}
      </View>
    </Card>
  );
}

function MilestoneRow({ m, onEdit, onDelete }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: m.is_championship ? c.orange : c.pink, marginTop: 5, flexShrink: 0 }} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 2 }}>
          {m.is_championship ? <Tag label="🏆 Championship" color={c.sunSoft} /> : null}
          {verChip(m.verification_status)}
        </View>
        <T weight="800" size={14}>{m.title}</T>
        <T size={12} color={c.mute}>{m.milestone_date}{m.competition_name ? ' · ' + m.competition_name : ''}{m.role ? ' · ' + m.role : ''}{m.sport_name ? ' · ' + m.sport_name : ''}</T>
        {m.verification_status === 'self_declared' && onEdit ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            <Pressable onPress={() => onEdit(m)} accessibilityLabel={t('common.edit')} style={{ minHeight: 44, justifyContent: 'center', paddingEnd: 8 }}>
              <T size={12} color={c.pink}>{t('common.edit')}</T>
            </Pressable>
            <Pressable onPress={() => onDelete(m.id)} accessibilityLabel={t('common.delete')} style={{ minHeight: 44, justifyContent: 'center' }}>
              <T size={12} color={c.mute}>{t('common.delete')}</T>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ReferenceCard({ item }) {
  return (
    <Card style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <T weight="800" size={14}>{item.org_name ?? item.body_name ?? '—'}</T>
          {item.sport_name ? <T size={12} color={c.mute}>{item.sport_name}</T> : null}
          <Tag label={REL_LABEL[item.relationship] ?? item.relationship} color={c.cyanSoft} style={{ marginTop: 4 }} />
          {item.public_summary ? <T size={12} style={{ marginTop: 6, fontStyle: 'italic' }}>{item.public_summary}</T> : null}
        </View>
        <Tag
          label={item.response_status === 'approved' ? '✅ Approved' : item.response_status === 'declined' ? 'Declined' : '⏳ Pending'}
          color={item.response_status === 'approved' ? c.mintSoft : c.card}
        />
      </View>
    </Card>
  );
}

function AddMilestoneSheet({ visible, onClose, onSaved, sports }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [sportId, setSportId] = useState(null);
  const [competition, setCompetition] = useState('');
  const [role, setRole] = useState('');
  const [isChamp, setIsChamp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const reset = () => { setTitle(''); setDate(''); setSportId(null); setCompetition(''); setRole(''); setIsChamp(false); setError(null); };

  const submit = async () => {
    if (!title.trim()) { setError(t('portfolio.milestone.title_required')); return; }
    if (!date) { setError(t('portfolio.milestone.date_required')); return; }
    setSaving(true); setError(null);
    try {
      await api.post('/me/officials/portfolio/milestones', {
        title: title.trim(), milestone_date: date, sport_id: sportId,
        competition_name: competition.trim() || undefined, role: role.trim() || undefined, is_championship: isChamp,
      });
      reset(); onSaved(); onClose();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  return (
    <FormSheet visible={visible} onClose={onClose} title={t('portfolio.milestone.add_title')}>
      <TextField label={t('portfolio.milestone.title')} value={title} onChangeText={setTitle} maxLength={200} />
      <DateField label={t('portfolio.milestone.date')} value={date} onChange={setDate} />
      <MenuField label={t('portfolio.milestone.sport')} options={(sports ?? []).map((s) => ({ value: s.id, label: s.name }))} value={sportId} onChange={setSportId} nullable />
      <TextField label={t('portfolio.milestone.competition')} value={competition} onChangeText={setCompetition} maxLength={200} placeholder={t('portfolio.milestone.competition_hint')} />
      <TextField label={t('portfolio.milestone.role')} value={role} onChangeText={setRole} maxLength={60} placeholder={t('portfolio.milestone.role_hint')} />
      <SwitchField label={t('portfolio.milestone.championship')} value={isChamp} onChange={setIsChamp} />
      {error ? <T size={12} color={c.red} style={{ marginTop: 4 }}>{error}</T> : null}
      <Btn label={saving ? t('common.saving') : t('portfolio.milestone.save')} onPress={submit} disabled={saving} style={{ marginTop: 12 }} />
    </FormSheet>
  );
}

function VisibilitySheet({ visible, settings, onClose, onSaved }) {
  const [vis, setVis] = useState(settings?.visibility ?? 'private');
  const [showGrades, setShowGrades] = useState(settings?.show_grades ?? true);
  const [showMilestones, setShowMilestones] = useState(settings?.show_milestones ?? true);
  const [showRefs, setShowRefs] = useState(settings?.show_references ?? true);
  const [showChart, setShowChart] = useState(settings?.show_activity_chart ?? true);
  const [showMatchCount, setShowMatchCount] = useState(settings?.show_match_count ?? true);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await api.put('/me/officials/portfolio/settings', {
        visibility: vis, show_grades: showGrades, show_milestones: showMilestones,
        show_references: showRefs, show_activity_chart: showChart, show_match_count: showMatchCount,
      });
      onSaved(); onClose();
    } catch (_) { } finally { setSaving(false); }
  };

  const VIS_OPTIONS = [
    { value: 'public',    label: t('portfolio.vis.public') },
    { value: 'link_only', label: t('portfolio.vis.link_only') },
    { value: 'private',   label: t('portfolio.vis.private') },
  ];

  return (
    <FormSheet visible={visible} onClose={onClose} title={t('portfolio.vis.title')}>
      <MenuField label={t('portfolio.vis.label')} options={VIS_OPTIONS} value={vis} onChange={setVis} />
      <SwitchField label={t('portfolio.vis.show_grades')} value={showGrades} onChange={setShowGrades} />
      <SwitchField label={t('portfolio.vis.show_milestones')} value={showMilestones} onChange={setShowMilestones} />
      <SwitchField label={t('portfolio.vis.show_references')} value={showRefs} onChange={setShowRefs} />
      <SwitchField label={t('portfolio.vis.show_chart')} value={showChart} onChange={setShowChart} />
      <SwitchField label={t('portfolio.vis.show_match_count')} value={showMatchCount} onChange={setShowMatchCount} />
      <Btn label={saving ? t('common.saving') : t('common.save')} onPress={submit} disabled={saving} style={{ marginTop: 12 }} />
    </FormSheet>
  );
}

export function OfficialPortfolio() {
  useSession(); // ensure auth
  const { push: go } = useNav();
  const [tab, setTab] = useState('career');
  const [showAddMilestone, setShowAddMilestone] = useState(false);
  const [showVisibility, setShowVisibility] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  const [data, loadErr, loading] = useLoad(() => api.get('/me/officials/portfolio'), [reload]);
  const [sports] = useLoad(() => api.get('/sports'));
  const [settings, , settingsLoading] = useLoad(() => api.get('/me/officials/portfolio/settings'), [reload]);

  const handleExport = async () => {
    setExporting(true);
    try {
      await api.post('/me/officials/portfolio/exports', { client_key: `export-${Date.now()}` });
    } catch (_) { } finally { setExporting(false); }
  };

  const handleDelete = async (milestoneId) => {
    await api.delete(`/me/officials/portfolio/milestones/${milestoneId}`);
    refresh();
  };

  if (loading || settingsLoading) return <Loading />;
  if (loadErr) return <Screen><Empty title={t('error.generic')} /></Screen>;

  const { summary, by_sport, grades, licences, verifications, activity_months, milestones, references } = data ?? {};

  const TABS = [
    { key: 'career',     label: t('portfolio.tab.career')     },
    { key: 'grades',     label: t('portfolio.tab.grades')      },
    { key: 'milestones', label: t('portfolio.tab.milestones')  },
    { key: 'references', label: t('portfolio.tab.references')  },
  ];

  return (
    <Screen title={t('nav.title.OfficialPortfolio')}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {/* Verification badge */}
        {verifications?.[0] ? (
          <Tag
            label={verifications[0].status === 'verified' ? '✅ ' + t('portfolio.verified_official') : '📋 ' + t('portfolio.unverified_official')}
            color={verifications[0].status === 'verified' ? c.mintSoft : c.card}
          />
        ) : null}

        {/* Metric strip */}
        <MetricStrip summary={summary} />

        {/* Action row */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn label={exporting ? t('common.loading') : t('portfolio.export_pdf')} onPress={handleExport} disabled={exporting} style={{ flex: 1 }} />
          <Btn label={t('portfolio.vis.settings')} onPress={() => setShowVisibility(true)} variant="secondary" style={{ flex: 1 }} />
        </View>

        {/* Tab selector */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {TABS.map((tb) => (
            <Pressable
              key={tb.key}
              onPress={() => setTab(tb.key)}
              style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: r.pill, backgroundColor: tab === tb.key ? c.pink : c.card, minHeight: 44, justifyContent: 'center' }}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === tb.key }}>
              <T size={13} weight="700" color={tab === tb.key ? '#fff' : c.ink}>{tb.label}</T>
            </Pressable>
          ))}
        </View>

        {/* Career tab */}
        {tab === 'career' && (
          <View style={{ gap: 8 }}>
            {by_sport?.length
              ? by_sport.map((s) => <SportRow key={s.sport_id} sport={s} />)
              : <Empty title={t('portfolio.empty.career')} body={t('portfolio.empty.career_body')} />}
            {activity_months?.length > 0 && (
              <Card>
                <T weight="700" size={13} style={{ marginBottom: 8 }}>{t('portfolio.activity_chart')}</T>
                <ActivitySparkline months={activity_months} />
              </Card>
            )}
          </View>
        )}

        {/* Grades tab */}
        {tab === 'grades' && (
          <View style={{ gap: 8 }}>
            {grades?.length ? (
              <View>
                <T weight="700" size={13} style={{ marginBottom: 8 }}>{t('portfolio.grades_title')}</T>
                {grades.map((g) => <GradeItem key={g.id} grade={g} />)}
              </View>
            ) : null}
            {licences?.length ? (
              <View>
                <T weight="700" size={13} style={{ marginVertical: 8 }}>{t('portfolio.licences_title')}</T>
                {licences.map((l) => (
                  <Card key={l.id} style={{ marginBottom: 8 }}>
                    <T weight="800" size={14}>{l.licence_type_name}</T>
                    <T size={12} color={c.mute}>{l.body_name}{l.sport_name ? ' · ' + l.sport_name : ''}</T>
                    <T size={12} color={c.mute}>{l.issued_on} → {l.expires_on ?? t('portfolio.no_expiry')}</T>
                    <Tag label={l.status} color={l.status === 'active' ? c.mintSoft : c.card} style={{ marginTop: 4 }} />
                  </Card>
                ))}
              </View>
            ) : null}
            {!grades?.length && !licences?.length && (
              <Empty title={t('portfolio.empty.grades')} body={t('portfolio.empty.grades_body')} />
            )}
          </View>
        )}

        {/* Milestones tab */}
        {tab === 'milestones' && (
          <View style={{ gap: 8 }}>
            <Btn label={t('portfolio.milestone.add')} onPress={() => setShowAddMilestone(true)} variant="secondary" />
            {milestones?.length
              ? milestones.map((m) => (
                  <MilestoneRow key={m.id} m={m} onEdit={() => setShowAddMilestone(true)} onDelete={handleDelete} />
                ))
              : <Empty title={t('portfolio.empty.milestones')} body={t('portfolio.empty.milestones_body')} />}
          </View>
        )}

        {/* References tab */}
        {tab === 'references' && (
          <View style={{ gap: 8 }}>
            {references?.length
              ? references.map((ref) => <ReferenceCard key={ref.id} item={ref} />)
              : <Empty title={t('portfolio.empty.references')} body={t('portfolio.empty.references_body')} />}
          </View>
        )}
      </ScrollView>

      <AddMilestoneSheet visible={showAddMilestone} sports={sports} onClose={() => setShowAddMilestone(false)} onSaved={refresh} />
      <VisibilitySheet visible={showVisibility} settings={settings} onClose={() => setShowVisibility(false)} onSaved={refresh} />
    </Screen>
  );
}
