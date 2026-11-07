// PS-20 / PS-21: Para-sport Learn & Study content catalogue + Para qualifications (staff tracks).
// PS-20: governed, versioned learning paths for athletes/general learners (auto-badges on completion).
// PS-21: "Para qualifications" inner tab showing role-specific staff tracks; taps through to ParaStaffCred.
// Governed, versioned, beginner-to-advanced learning paths published by the platform or approved
// institutions. Extends the Learn & Study hub (pathways.js) — adds the "Adaptive sport" tab.
// No new LMS, no duplicate of institution discovery. Credentials reuse the Badges tab (pathways.js).
import React, { useState, useCallback } from 'react';
import { AccessibilityInfo, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, GradCard, H1, Loading, Row, Screen, Seg, Section, StatPill, T, Tag } from '../ui';
import { SportSelect } from '../sportpicker';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { t } from '../i18n';

const LEVELS = ['beginner', 'intermediate', 'advanced'];
const LEVEL_COLORS = { beginner: c.pinkSoft, intermediate: c.pink, advanced: c.ink };
const LEVEL_INK = { beginner: c.pink, intermediate: '#fff', advanced: '#fff' };
const STATUS_COLORS = { draft: c.pinkSoft, submitted: c.sunSoft, approved: c.cyanSoft, published: c.limeSoft, retired: c.violetSoft };
const STATUS_INK = { draft: c.mute, submitted: c.sun, approved: c.cyan, published: c.lime, retired: c.mute };
const fail = (toast) => (e) => toast('' + e.message);

// ── Shared helpers ────────────────────────────────────────────────────────────

function LevelChip({ level }) {
  return (
    <View style={{ backgroundColor: LEVEL_COLORS[level] ?? c.pinkSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
      <T size={11} weight="700" color={LEVEL_INK[level] ?? c.pink}>{t('pl.level.' + level)}</T>
    </View>
  );
}

function StatusChip({ status }) {
  return (
    <View style={{ backgroundColor: STATUS_COLORS[status] ?? c.pinkSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
      <T size={11} weight="700" color={STATUS_INK[status] ?? c.mute}>{t('pl.manage.' + status)}</T>
    </View>
  );
}

function ProgressBar({ pct, accessibilityLabel }) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      accessibilityLabel={accessibilityLabel ?? t('pl.progress.pct', { pct })}
      style={{ height: 6, backgroundColor: c.line, borderRadius: 3, overflow: 'hidden', marginTop: 6 }}
    >
      <View style={{ width: `${pct}%`, height: '100%', backgroundColor: c.pink, borderRadius: 3 }} />
    </View>
  );
}

// ── AdaptiveLearn — rendered inside the "adaptive" tab of Pathways ────────────

export function AdaptiveLearn({ push }) {
  const { user } = useSession();
  const isAdmin = user?.roles?.includes('admin') || user?.roles?.includes('platform_admin');
  const [sport, setSport] = useState(null);
  const [levelFilter, setLevelFilter] = useState(null);
  const [innerTab, setInnerTab] = useState('browse');

  const recs = useLoad(() => api.get('/para/learn/recommendations'), []);

  const innerTabs = [
    { value: 'browse', label: t('pl.browse.title') },
    { value: 'my_progress', label: t('pl.progress.title') },
    { value: 'para_quals', label: t('paraStaffCred.title') },
    ...(isAdmin ? [{ value: 'manage', label: t('pl.manage.title') }] : []),
  ];

  return (
    <View>
      <Section title={t('pl.recommend.title')} color={c.violet}>
        {recs.data?.length ? (
          <LearnPathSuggestion recommendations={recs.data} push={push} />
        ) : !recs.data ? (
          <Loading />
        ) : null}
      </Section>

      <View style={{ marginTop: 4 }}>
        <Seg value={innerTab} onChange={setInnerTab} color={c.pink} options={innerTabs} />
      </View>

      {innerTab === 'browse' && (
        <BrowsePaths sport={sport} setSport={setSport} levelFilter={levelFilter} setLevelFilter={setLevelFilter} push={push} />
      )}
      {innerTab === 'my_progress' && <MyProgress push={push} />}
      {innerTab === 'para_quals' && <ParaStaffQuals push={push} />}
      {innerTab === 'manage' && isAdmin && <PublishingQueue push={push} />}
    </View>
  );
}

// ── BrowsePaths ───────────────────────────────────────────────────────────────

function BrowsePaths({ sport, setSport, levelFilter, setLevelFilter, push }) {
  const params = {};
  if (sport) params.sport = sport;
  if (levelFilter) params.level_key = levelFilter;
  const paths = useLoad(() => api.get('/para/learn/paths', params), [sport, levelFilter]);

  return (
    <>
      <View style={{ marginTop: 12 }}>
        <SportSelect label={t('pl.browse.sport_label')} value={sport} onChange={setSport} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {[null, ...LEVELS].map((lv) => (
          <Pressable
            key={lv ?? 'all'}
            onPress={() => setLevelFilter(lv)}
            accessibilityRole="button"
            accessibilityLabel={lv ? t('pl.level.' + lv) : t('pl.browse.all_levels')}
            accessibilityState={{ selected: levelFilter === lv }}
            style={{ minHeight: 36, minWidth: 44, backgroundColor: levelFilter === lv ? c.pink : c.pinkSoft, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6, justifyContent: 'center' }}
          >
            <T size={13} weight="700" color={levelFilter === lv ? '#fff' : c.pink}>{lv ? t('pl.level.' + lv) : t('pl.browse.all_levels')}</T>
          </Pressable>
        ))}
      </View>

      {paths.error ? <ErrorBox error={paths.error} onRetry={paths.reload} /> : !paths.data ? <Loading /> : paths.data.length === 0 ? (
        <Empty emoji="📚" title={t('pl.browse.empty')} sub={sport ? t('pl.browse.empty_sport') : t('pl.browse.empty_pick')} />
      ) : (
        <Section>
          {paths.data.map((p) => (
            <PathCard key={p.id} path={p} onPress={() => push('ParaLearnPath', { id: p.id })} />
          ))}
        </Section>
      )}
    </>
  );
}

function PathCard({ path, onPress, progress }) {
  const pct = progress?.completion_pct ?? null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('pl.path.open_a11y', { title: path.title })}
      style={{ minHeight: 44 }}
    >
      <Card pad={14}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <T size={26}>{path.sport_emoji}</T>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <T weight="700" size={15} style={{ flex: 1 }}>{path.title}</T>
              <LevelChip level={path.level_key} />
            </View>
            <T size={12} color={c.mute} style={{ marginTop: 3 }}>{path.sport_name}</T>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
              {path.module_count > 0 && <T size={12} color={c.mute}>{t('pl.path.modules', { n: path.module_count })}</T>}
              {path.estimated_minutes > 0 && <T size={12} color={c.mute}>{t('pl.path.minutes', { n: path.estimated_minutes })}</T>}
              <T size={12} color={c.mute}>{path.publisher_name && path.publisher_name !== 'Sportarena' ? t('pl.path.publisher', { name: path.publisher_name }) : t('pl.path.platform')}</T>
            </View>
            {pct !== null && <ProgressBar pct={pct} />}
            {progress?.credential_issued && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                <T size={12} color={c.lime} weight="700">🎖️ {t('pl.progress.credential')}</T>
              </View>
            )}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

// ── MyProgress ────────────────────────────────────────────────────────────────

function MyProgress({ push }) {
  const progress = useLoad(() => api.get('/para/learn/progress'), []);
  if (progress.error) return <ErrorBox error={progress.error} onRetry={progress.reload} />;
  if (!progress.data) return <Loading />;
  if (!progress.data.length) return <Empty emoji="🏅" title={t('pl.progress.empty')} sub={t('pl.progress.empty_sub')} />;
  return (
    <Section>
      {progress.data.map((p) => (
        <PathCard key={p.path_id} path={{ ...p, id: p.path_id, module_count: null }} progress={p} onPress={() => push('ParaLearnPath', { id: p.path_id })} />
      ))}
    </Section>
  );
}

// ── PublishingQueue (admin only) ──────────────────────────────────────────────

function PublishingQueue({ push }) {
  const { toast } = useSession();
  const [createVisible, setCreateVisible] = useState(false);
  const paths = useLoad(() => api.get('/para/learn/admin/paths'), []);

  const review = useCallback(async (versionId, action) => {
    try {
      await api.post(`/para/learn/path-versions/${versionId}/review`, { action });
      paths.reload();
      toast(t('pl.manage.action_done'));
    } catch (e) { fail(toast)(e); }
  }, [paths, toast]);

  if (paths.error) return <ErrorBox error={paths.error} onRetry={paths.reload} />;
  if (!paths.data) return <Loading />;

  return (
    <>
      <Btn small title={t('pl.manage.create_path')} color={c.pink} style={{ alignSelf: 'flex-start', marginTop: 12 }} onPress={() => setCreateVisible(true)} />
      {paths.data.length === 0 && <Empty emoji="📋" title={t('pl.manage.empty')} />}
      {paths.data.map((p) => (
        <Card key={p.id} pad={14} style={{ marginTop: 8 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <T size={22}>{p.sport_emoji}</T>
            <View style={{ flex: 1 }}>
              <T weight="700">{p.title}</T>
              <T size={12} color={c.mute}>{p.sport_name} · {t('pl.level.' + p.level_key)}</T>
            </View>
            <StatusChip status={p.status ?? 'draft'} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn small title="Open" color={c.paper} ink={c.ink} onPress={() => push('ParaLearnPath', { id: p.id, manage: true })} />
            {p.version_id && p.status === 'draft' && <Btn small title={t('pl.manage.submit_path')} color={c.sun} onPress={() => api.post(`/para/learn/path-versions/${p.version_id}/submit`).then(paths.reload).catch(fail(toast))} />}
            {p.version_id && p.status === 'submitted' && <Btn small title={t('pl.manage.approve_path')} color={c.cyan} onPress={() => review(p.version_id, 'approve')} />}
            {p.version_id && p.status === 'approved' && <Btn small title={t('pl.manage.publish_path')} color={c.lime} onPress={() => review(p.version_id, 'publish')} />}
            {p.version_id && p.status === 'published' && <Btn small title={t('pl.manage.retire_path')} color={c.paper} ink={c.red} onPress={() => review(p.version_id, 'retire')} />}
          </View>
        </Card>
      ))}
      <CreatePathSheet visible={createVisible} onClose={() => setCreateVisible(false)} onDone={() => { setCreateVisible(false); paths.reload(); }} />
    </>
  );
}

function CreatePathSheet({ visible, onClose, onDone }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('pl.manage.create_path')} submitLabel={t('pl.manage.create_path')}
      fields={[
        { key: 'sport', label: t('pl.path.sport'), type: 'sport' },
        { key: 'level_key', label: t('pl.browse.filter_level'), type: 'chips', options: LEVELS.map((l) => ({ value: l, label: t('pl.level.' + l) })) },
        { key: 'title', label: t('pl.path.title_label') },
        { key: 'summary', label: t('pl.path.summary_label'), type: 'multiline', optional: true },
      ]}
      onSubmit={async (v) => { await api.post('/para/learn/paths', v); onDone(); return t('pl.manage.path_created'); }} />
  );
}

// ── PathDetail — pushed screen ParaLearnPath ──────────────────────────────────

export function PathDetail({ id: pathId, manage }) {
  const { push } = useNav();
  const { user, toast } = useSession();
  const isAdmin = user?.roles?.includes('admin') || user?.roles?.includes('platform_admin');
  const path = useLoad(() => api.get(`/para/learn/paths/${pathId}`), [pathId]);
  const progress = useLoad(() => api.get('/para/learn/progress', { path_id: pathId }), [pathId]);

  if (path.error) return <Screen><ErrorBox error={path.error} onRetry={path.reload} /></Screen>;
  if (!path.data) return <Screen><Loading /></Screen>;

  const { path: p, sport, publisher, version, modules } = path.data;
  const prog = progress.data?.[0];
  const pct = prog?.completion_pct ?? 0;
  const started = pct > 0;
  const done = pct === 100;

  return (
    <Screen title={p.title}>
      <GradCard colors={[c.violet, c.ink]}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <T size={36}>{sport.emoji}</T>
          <View style={{ flex: 1 }}>
            <LevelChip level={p.level_key} />
            <H1 color="#fff" style={{ fontSize: 22, marginTop: 6 }}>{p.title}</H1>
            <T color="#fff" size={13} style={{ marginTop: 2 }}>{sport.name}</T>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {version.estimated_minutes > 0 && <StatPill value={`${version.estimated_minutes}m`} label={t('pl.path.duration')} />}
          <StatPill value={modules.length} label={t('pl.path.module_count')} />
          {done && <StatPill value="✓" label={t('pl.path.complete')} />}
        </View>
      </GradCard>

      {version.objectives?.length > 0 && (
        <Section title={t('pl.path.objectives')} color={c.pink}>
          {version.objectives.map((o, i) => (
            <Card key={i} pad={12}><T>• {o.text}</T></Card>
          ))}
        </Section>
      )}

      {version.source_attribution?.owner && (
        <Card pad={12} style={{ marginTop: 4 }}>
          <T size={12} color={c.mute} weight="700">{t('pl.path.source')}</T>
          <T size={13}>{version.source_attribution.owner}{version.source_attribution.licence ? ` · ${version.source_attribution.licence}` : ''}</T>
          {version.source_attribution.source_url && (
            <T size={12} color={c.pink}>{version.source_attribution.source_url}</T>
          )}
          {version.copyright_note && <T size={12} color={c.mute}>{version.copyright_note}</T>}
        </Card>
      )}

      {started && !done && (
        <View style={{ marginTop: 8 }}>
          <T size={13} color={c.mute} style={{ marginHorizontal: 12, marginBottom: 4 }}>{t('pl.progress.pct', { pct })}</T>
          <ProgressBar pct={pct} accessibilityLabel={t('pl.progress.pct', { pct })} />
        </View>
      )}

      <Section title={t('pl.path.modules_title')} color={c.violet}>
        {modules.map((m) => {
          const modDone = prog?.module_completions?.includes(m.id);
          return (
            <Pressable
              key={m.id}
              onPress={() => push('ParaLearnModule', { id: m.id, path_id: pathId, version_id: version.id })}
              accessibilityRole="button"
              accessibilityLabel={t('pl.module.open_a11y', { title: m.title })}
              style={{ minHeight: 44 }}
            >
              <Card pad={14}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  <T size={18}>{modDone ? '✅' : '⬜'}</T>
                  <View style={{ flex: 1 }}>
                    <T weight="700">{m.title}</T>
                    {m.estimated_minutes > 0 && <T size={12} color={c.mute}>{t('pl.path.minutes', { n: m.estimated_minutes })}</T>}
                    <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                      {m.caption_url && <Chip label={t('pl.module.caption')} color={c.cyanSoft} />}
                      {m.transcript_url && <Chip label={t('pl.module.transcript')} color={c.cyanSoft} />}
                      {m.audio_description && <Chip label={t('pl.module.audio_desc')} color={c.cyanSoft} />}
                      {m.assessment_count > 0 && <Chip label={t('pl.module.has_assessment')} color={c.pinkSoft} />}
                    </View>
                  </View>
                  <T size={18} color={c.mute}>›</T>
                </View>
              </Card>
            </Pressable>
          );
        })}
      </Section>

      {!done && (
        <Btn title={started ? t('pl.path.resume') : t('pl.path.start')} onPress={() => { const first = modules.find((m) => !prog?.module_completions?.includes(m.id)); if (first) push('ParaLearnModule', { id: first.id, path_id: pathId, version_id: version.id }); }} style={{ marginTop: 16, marginBottom: 8 }} />
      )}
      {done && prog?.credential_issued && (
        <Card pad={14} style={{ marginTop: 8, borderLeftWidth: 3, borderLeftColor: c.lime }}>
          <T weight="700" color={c.lime}>🎖️ {t('pl.progress.credential')}</T>
          <T size={13} color={c.mute}>{t('pl.progress.credential_sub')}</T>
        </Card>
      )}
    </Screen>
  );
}

// ── ModuleView — pushed screen ParaLearnModule ────────────────────────────────

export function ModuleView({ id: moduleId, path_id: pathId, version_id: versionId }) {
  const { push } = useNav();
  const { toast } = useSession();
  const mod = useLoad(() => api.get(`/para/learn/modules/${moduleId}`), [moduleId]);
  const assessments = useLoad(() => api.get(`/para/learn/modules/${moduleId}/assessments`), [moduleId]);
  const [done, setDone] = useState(false);
  const [credentialIssued, setCredentialIssued] = useState(false);

  if (mod.error) return <Screen><ErrorBox error={mod.error} onRetry={mod.reload} /></Screen>;
  if (!mod.data) return <Screen><Loading /></Screen>;

  const m = mod.data;

  const markComplete = async (assessmentId, answerIndex, attemptNumber) => {
    try {
      const res = await api.post('/para/learn/progress', { path_id: pathId, version_id: versionId, module_id: moduleId, assessment_id: assessmentId, answer_index: answerIndex, attempt_number: attemptNumber });
      setDone(true);
      if (res.credential_issued) setCredentialIssued(true);
    } catch (e) { fail(toast)(e); }
  };

  return (
    <Screen title={m.title}>
      <View style={{ padding: 16 }}>
        {/* Body blocks */}
        {m.body_blocks?.map((block, i) => <BodyBlock key={i} block={block} />)}

        {/* Accessible media section */}
        {(m.caption_url || m.transcript_url || m.audio_description || m.alt_text) && (
          <Section title={t('pl.module.accessible_media')} color={c.cyan}>
            {m.alt_text && <Card pad={12}><T size={12} weight="700" color={c.mute}>{t('pl.module.alt_text_label')}</T><T size={13}>{m.alt_text}</T></Card>}
            {m.caption_url && (
              <Card pad={12}>
                <T size={12} weight="700" color={c.mute}>{t('pl.module.caption')}</T>
                <T size={13} color={c.pink}>{m.caption_url}</T>
              </Card>
            )}
            {m.transcript_url && (
              <Card pad={12}>
                <T size={12} weight="700" color={c.mute}>{t('pl.module.transcript')}</T>
                <T size={13} color={c.pink}>{m.transcript_url}</T>
              </Card>
            )}
            {m.audio_description && (
              <Card pad={12}>
                <T size={12} weight="700" color={c.mute}>{t('pl.module.audio_desc')}</T>
                <T size={13}>{m.audio_description}</T>
              </Card>
            )}
          </Section>
        )}

        {/* Assessment */}
        {!done && assessments.data?.length > 0 && (
          <AssessmentView assessments={assessments.data} onPass={(asmtId, idx, attempt) => markComplete(asmtId, idx, attempt)} />
        )}

        {/* No assessment — mark complete button */}
        {!done && (!assessments.data || assessments.data.length === 0) && (
          <Btn title={t('pl.module.mark_complete')} onPress={() => markComplete(undefined, undefined, 1)} style={{ marginTop: 20 }} />
        )}

        {done && (
          <Card pad={14} style={{ marginTop: 16, borderLeftWidth: 3, borderLeftColor: c.lime }}>
            <T weight="700" color={c.lime}>✅ {t('pl.module.done')}</T>
            {credentialIssued && <T size={13} color={c.mute} style={{ marginTop: 4 }}>🎖️ {t('pl.progress.credential_just_issued')}</T>}
          </Card>
        )}
      </View>
    </Screen>
  );
}

function BodyBlock({ block }) {
  if (block.type === 'heading') return <T weight="800" size={18} style={{ marginBottom: 6, marginTop: 14 }}>{block.text}</T>;
  if (block.type === 'checklist') return (
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
      <T>□</T>
      <T style={{ flex: 1 }}>{block.text}</T>
    </View>
  );
  if (block.type === 'tip') return (
    <Card pad={12} style={{ backgroundColor: c.cyanSoft, marginBottom: 8 }}>
      <T size={12} weight="700" color={c.cyan}>💡 {t('pl.module.tip')}</T>
      <T size={14}>{block.text}</T>
    </Card>
  );
  // text (default)
  return <T style={{ marginBottom: 10, lineHeight: 22 }}>{block.text}</T>;
}

// ── AssessmentView ────────────────────────────────────────────────────────────

export function AssessmentView({ assessments, onPass }) {
  const [aIdx, setAIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [attempt, setAttempt] = useState(1);
  const { toast } = useSession();

  const asmnt = assessments[aIdx];
  if (!asmnt) return null;

  const correct = asmnt.options[selected]?.is_correct === true;
  const retakesLeft = asmnt.max_retakes === 0 ? null : asmnt.max_retakes - attempt + 1;

  const submit = () => {
    if (selected === null) return;
    setSubmitted(true);
    if (correct) {
      onPass(asmnt.id, selected, attempt);
    }
  };

  const retry = () => {
    setSelected(null);
    setSubmitted(false);
    setAttempt((a) => a + 1);
  };

  return (
    <Section title={t('pl.assessment.question')} color={c.pink}>
      <Card pad={16}>
        <T weight="700" size={16} style={{ marginBottom: 8 }}>{asmnt.question}</T>
        {asmnt.plain_language_hint && (
          <T size={13} color={c.mute} style={{ fontStyle: 'italic', marginBottom: 10 }}>{t('pl.assessment.hint', { hint: asmnt.plain_language_hint })}</T>
        )}
        {asmnt.options.map((opt, i) => {
          const isSelected = selected === i;
          const showResult = submitted;
          const bgColor = !showResult ? (isSelected ? c.pinkSoft : c.bg) : (opt.is_correct ? c.limeSoft : isSelected ? c.redSoft : c.bg);
          return (
            <Pressable
              key={i}
              onPress={() => !submitted && setSelected(i)}
              accessibilityRole="radio"
              accessibilityLabel={opt.label}
              accessibilityState={{ checked: isSelected, disabled: submitted }}
              style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, backgroundColor: bgColor, marginBottom: 6 }}
            >
              <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: isSelected ? c.pink : c.line, backgroundColor: isSelected ? c.pink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                {isSelected && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />}
              </View>
              <T style={{ flex: 1 }}>{opt.label}</T>
              {showResult && opt.is_correct && <T color={c.lime}>✓</T>}
              {showResult && !opt.is_correct && isSelected && <T color={c.red}>✗</T>}
            </Pressable>
          );
        })}
        {!submitted ? (
          <Btn title={t('pl.assessment.submit')} disabled={selected === null} onPress={submit} style={{ marginTop: 10 }} />
        ) : correct ? (
          <T weight="700" color={c.lime} style={{ marginTop: 10 }}>✅ {t('pl.assessment.correct')}</T>
        ) : (
          <View style={{ marginTop: 10 }}>
            <T weight="700" color={c.red}>{t('pl.assessment.incorrect')}</T>
            {retakesLeft !== null && retakesLeft > 0 && (
              <>
                <T size={13} color={c.mute}>{t('pl.assessment.retakes_left', { n: retakesLeft })}</T>
                <Btn small title={t('pl.assessment.retry')} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={retry} />
              </>
            )}
            {retakesLeft !== null && retakesLeft <= 0 && (
              <T size={13} color={c.red}>{t('pl.assessment.no_retakes')}</T>
            )}
          </View>
        )}
      </Card>
    </Section>
  );
}

// ── LearnPathSuggestion — compact widget for para-pathway.js ──────────────────

export function LearnPathSuggestion({ recommendations, push }) {
  if (!recommendations?.length) return null;
  const shown = recommendations.slice(0, 3);
  return (
    <View>
      {shown.map((p) => (
        <Pressable
          key={p.id}
          onPress={() => push('ParaLearnPath', { id: p.id })}
          accessibilityRole="button"
          accessibilityLabel={t('pl.path.open_a11y', { title: p.title })}
          style={{ minHeight: 44 }}
        >
          <Card pad={12} style={{ marginBottom: 6 }}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <T size={22}>{p.sport_emoji}</T>
              <View style={{ flex: 1 }}>
                <T weight="700" size={14}>{p.title}</T>
                <T size={12} color={c.mute}>{p.sport_name}</T>
              </View>
              <LevelChip level={p.level_key} />
            </View>
          </Card>
        </Pressable>
      ))}
      {recommendations.length > 3 && (
        <Btn small title={t('pl.recommend.see_all')} color={c.paper} ink={c.pink} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => push('Pathways')} />
      )}
    </View>
  );
}

// ── PS-21: Para qualifications tab ──────────────────────────────────────────
// Shows staff professional development tracks inline in the Adaptive sport hub.
// Tapping a track pushes to the full ParaStaffCred wallet (para-staff-cred.js).
const STAFF_ROLES = ['adaptive_coach', 'para_referee', 'technical_official', 'guide_support', 'classifier_candidate'];
const ROLE_COLORS = { adaptive_coach: c.pink, para_referee: c.cyan, technical_official: c.lime, guide_support: c.sun, classifier_candidate: c.orange };

function ParaStaffQuals({ push }) {
  const [role, setRole] = useState(null);
  const [sport, setSport] = useState(null);
  const tracks = useLoad(() => api.get('/para/staff/tracks', { role_category: role, sport: sport ?? undefined, limit: 50 }), [role, sport]);

  return (
    <View style={{ marginTop: 8 }}>
      <T size={12} color={c.mute} style={{ marginHorizontal: 16, marginBottom: 10 }}>{t('paraStaffCred.classifierNote')}</T>

      <View style={{ marginHorizontal: 16, marginBottom: 10 }}>
        <SportSelect label={t('pl.browse.sport_label')} value={sport} onChange={setSport} />
      </View>

      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginHorizontal: 16, marginBottom: 10 }}>
        {[null, ...STAFF_ROLES].map((r) => (
          <Pressable
            key={r ?? 'all'}
            onPress={() => setRole(r)}
            accessibilityRole="button"
            accessibilityState={{ selected: role === r }}
            style={{ minHeight: 36, minWidth: 44, backgroundColor: role === r ? (ROLE_COLORS[r] ?? c.pink) : c.pinkSoft, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, justifyContent: 'center' }}
          >
            <T size={12} weight={role === r ? '700' : '400'} color={role === r ? '#fff' : c.pink}>
              {r ? t(`paraStaffCred.roleCategory.${r}`) : t('pl.browse.all_levels')}
            </T>
          </Pressable>
        ))}
      </View>

      {tracks.loading
        ? <Loading />
        : !tracks.data?.length
          ? <Empty label={t('paraStaffCred.emptyBrowse')} />
          : tracks.data.map((tr) => (
            <Pressable
              key={tr.id}
              onPress={() => push('ParaStaffCred', { trackId: tr.id })}
              accessibilityRole="button"
              accessibilityLabel={`${tr.title} - ${t(`paraStaffCred.roleCategory.${tr.role_category}`)}`}
            >
              <Card pad={12} style={{ marginHorizontal: 16, marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                  <T size={22}>{tr.sport_emoji ?? '♿'}</T>
                  <View style={{ flex: 1 }}>
                    <T weight="700" size={14}>{tr.title}</T>
                    <T size={12} color={c.mute}>{tr.body_name ?? tr.publisher_org_name ?? ''}</T>
                  </View>
                  {tr.level_key && <LevelChip level={tr.level_key} />}
                </View>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  <View style={{ backgroundColor: c.violetSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
                    <T size={11} color={c.violet}>{t(`paraStaffCred.roleCategory.${tr.role_category}`)}</T>
                  </View>
                  {tr.renewal_months && (
                    <View style={{ backgroundColor: c.sunSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
                      <T size={11} color={c.sun}>{t('paraStaffCred.renewalPeriod', { n: tr.renewal_months })}</T>
                    </View>
                  )}
                  {tr.role_category === 'classifier_candidate' && (
                    <View style={{ backgroundColor: c.orangeSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
                      <T size={10} color={c.orange}>Learning only</T>
                    </View>
                  )}
                </View>
              </Card>
            </Pressable>
          ))}

      <Btn
        small
        title={t('paraStaffCred.myCredentials')}
        color={c.pinkSoft}
        ink={c.pink}
        style={{ alignSelf: 'flex-start', marginHorizontal: 16, marginTop: 8 }}
        onPress={() => push('ParaStaffCred')}
        accessibilityLabel={t('paraStaffCred.myCredentials')}
      />
    </View>
  );
}
