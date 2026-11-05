// PS-13 (#843): Para-sport coaching adaptations — three components integrated into the existing coaching studio:
//   ParaAdaptationEditor  — block-level adaptation alternatives (coach, inside BlockSheet)
//   AccessibleTrainingView — athlete-facing accessible session card view
//   SessionGuidePanel     — coach guide/assistant assignments per session
// All use existing theme tokens, ui.js primitives and api.js. No new palette introduced.
import React, { useState } from 'react';
import { View, AccessibilityInfo } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Screen, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { HScroll } from '../pickers';
import { MenuField } from '../menu-field';
import { useLayout } from '../layout';
import { c } from '../theme';
import { t, tEnum } from '../i18n';

const COMMUNICATION_MODES = ['spoken', 'written', 'sign_supported', 'visual_cue', 'tactile'];
const DIFFICULTY_LEVELS = ['maintained', 'reduced', 'progressed'];
const GUIDE_ROLES = ['support_person', 'sighted_guide', 'tapper', 'personal_assistant'];

const label = (s) => tEnum(s);

// ==================================================================================
// ParaAdaptationEditor
// Shown inside the existing BlockSheet when session.sport.is_para is true.
// Lets a coach add up to 8 adaptation alternatives per block.
// ==================================================================================
export function ParaAdaptationEditor({ block: blk, onChange, wide }) {
  const [adding, setAdding] = useState(false);
  const [catalogue, setCatalogue] = useState(null);
  const adaptations = blk?.para_adaptations ?? [];

  const loadCatalogue = async () => {
    if (!catalogue) {
      try { const d = await api.get('/academy/inclusion/catalogue'); setCatalogue(d); } catch { /* non-fatal */ }
    }
    setAdding(true);
  };

  const remove = (idx) => onChange({ ...blk, para_adaptations: adaptations.filter((_, i) => i !== idx) });

  const needOptions = catalogue
    ? Object.entries(catalogue.need_types).flatMap(([type, keys]) => keys.map((k) => ({ value: k, label: label(k), group: label(type) })))
    : [];

  return (
    <View>
      <T weight="700" size={13} style={{ marginTop: 12, marginBottom: 4 }}>
        {t('copar.para_adaptations')}
      </T>
      {!adaptations.length
        ? <T size={12} color={c.mute}>{t('copar.no_adaptations_yet')}</T>
        : adaptations.map((ad, idx) => (
          <Card key={idx} pad={10} style={{ marginBottom: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, marginInlineEnd: 8 }}>
                <T size={12} weight="700">{ad.need_keys.map(label).join(' · ')}</T>
                {ad.instruction ? <T size={12} color={c.mute} style={{ marginTop: 2 }}>{ad.instruction}</T> : null}
                {ad.communication ? <Tag label={label(ad.communication)} color={c.cyanSoft} style={{ marginTop: 4 }} /> : null}
              </View>
              <Chip label={t('access.remove')} onPress={() => remove(idx)} accessibilityLabel={t('copar.remove_adaptation')} />
            </View>
          </Card>
        ))
      }
      {adaptations.length < 8 && (
        <Btn small title={t('copar.add_adaptation')} color={c.paper} ink={c.ink} onPress={loadCatalogue}
          accessibilityLabel={t('copar.add_adaptation')} style={{ marginTop: 6 }} />
      )}

      <FormSheet visible={adding} onClose={() => setAdding(false)} title={t('copar.add_adaptation')} submitLabel={t('access.add')}
        fields={[
          { key: 'need_keys', label: t('copar.need_keys'), type: 'chips', multiSelect: true, options: needOptions, optional: false },
          { key: 'instruction', label: t('copar.alt_instruction'), type: 'multiline', optional: true, placeholder: t('copar.alt_instruction_ph') },
          { key: 'equipment', label: t('copar.equipment'), optional: true, placeholder: t('copar.equipment_ph') },
          { key: 'cues', label: t('copar.cues'), optional: true, placeholder: t('copar.cues_ph') },
          { key: 'communication', label: t('copar.communication_mode'), type: 'chips', optional: true, options: COMMUNICATION_MODES.map((v) => ({ value: v, label: label(v) })) },
        ]}
        onSubmit={async (v) => {
          const ad = {
            need_keys: Array.isArray(v.need_keys) ? v.need_keys : [v.need_keys].filter(Boolean),
            instruction: v.instruction || undefined,
            equipment: v.equipment ? v.equipment.split(',').map((s) => s.trim()).filter(Boolean) : [],
            cues: v.cues ? v.cues.split('\n').map((s) => s.trim()).filter(Boolean) : [],
            communication: v.communication || undefined,
          };
          onChange({ ...blk, para_adaptations: [...adaptations, ad] });
          setAdding(false);
        }} />
    </View>
  );
}

// Accessible media section inside block editor — captions and screen-reader description.
export function AccessibleMediaEditor({ block: blk, onChange }) {
  const m = blk?.accessible_media ?? {};
  return (
    <View style={{ marginTop: 12 }}>
      <T weight="700" size={13} style={{ marginBottom: 4 }}>{t('copar.accessible_media')}</T>
      <Field label={t('copar.caption_text')} value={m.caption_text ?? ''} onChangeText={(v) => onChange({ ...blk, accessible_media: { ...m, caption_text: v || undefined } })}
        multiline placeholder={t('copar.caption_text_ph')} accessibilityLabel={t('copar.caption_text')} />
      <Field label={t('copar.sr_description')} value={m.screen_reader_description ?? ''} onChangeText={(v) => onChange({ ...blk, accessible_media: { ...m, screen_reader_description: v || undefined } })}
        placeholder={t('copar.sr_description_ph')} accessibilityLabel={t('copar.sr_description')} style={{ marginTop: 8 }} />
    </View>
  );
}

// ==================================================================================
// SessionGuidePanel
// Coach-facing panel rendered in the session roster when sport.is_para.
// Reads consented support needs and allows assigning/removing guides per athlete.
// ==================================================================================
export function SessionGuidePanel({ sessionId, wide }) {
  const { toast } = useSession();
  const needs = useLoad(() => api.get(`/coaching/sessions/${sessionId}/para-needs`), [sessionId]);
  const guides = useLoad(() => api.get(`/coaching/sessions/${sessionId}/guides`), [sessionId]);
  const [adding, setAdding] = useState(null); // athlete object being assigned a guide

  const athletes = needs.data?.athletes ?? [];
  const supported = athletes.filter((a) => a.support_needs.length > 0);
  if (!supported.length && !needs.loading) return null;

  const guidesFor = (athleteId) => (guides.data?.guides ?? []).filter((g) => g.athlete_id === athleteId);

  const removeGuide = async (guideId) => {
    try {
      await api.del(`/coaching/sessions/${sessionId}/guides/${guideId}`);
      toast(t('copar.guide_removed'));
      guides.reload();
    } catch (e) { toast(e.message); }
  };

  return (
    <Section title={t('copar.session_guides')}>
      {needs.loading ? <Loading /> : needs.error ? <ErrorBox error={needs.error} onRetry={needs.reload} /> : (
        supported.map((a) => (
          <Card key={a.athlete_id} pad={12} style={{ marginBottom: 8 }}
            accessible accessibilityLabel={`${a.display_name} — ${a.support_needs.map(label).join(', ')}`}>
            <T weight="700">{a.display_name}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {a.support_needs.map((k) => <Tag key={k} label={label(k)} color={c.cyanSoft} />)}
            </View>
            {guidesFor(a.athlete_id).map((g) => (
              <Row key={g.id} title={g.guide_name ?? t('copar.unnamed_guide')} sub={label(g.guide_role)}
                right={<Chip label={t('access.remove')} onPress={() => removeGuide(g.id)} accessibilityLabel={t('copar.remove_guide')} />} />
            ))}
            <Btn small title={t('copar.assign_guide')} color={c.paper} ink={c.ink} style={{ marginTop: 6 }}
              accessibilityLabel={t('copar.assign_guide_for', { name: a.display_name })}
              onPress={() => setAdding(a)} />
          </Card>
        ))
      )}
      {adding && (
        <FormSheet visible onClose={() => setAdding(null)} title={t('copar.assign_guide')} submitLabel={t('common.save')}
          fields={[
            { key: 'guide_role', label: t('copar.guide_role'), type: 'chips', options: GUIDE_ROLES.map((v) => ({ value: v, label: label(v) })) },
            { key: 'note', label: t('copar.guide_note'), type: 'multiline', optional: true, placeholder: t('copar.guide_note_ph') },
          ]}
          onSubmit={async (v) => {
            await api.post(`/coaching/sessions/${sessionId}/guides`, { athlete_id: adding.athlete_id, guide_role: v.guide_role, note: v.note || undefined });
            toast(t('copar.guide_assigned'));
            setAdding(null);
            guides.reload();
          }} />
      )}
    </Section>
  );
}

// ==================================================================================
// AccessibleTrainingView
// Athlete-facing: a large-text, high-contrast, screen-reader-ready session view.
// Shows the adapted block for the athlete's consented needs when available.
// ==================================================================================
export function AccessibleTrainingView({ sessionId }) {
  const { user } = useSession();
  const ws = useLoad(() => api.get(`/coaching/sessions/${sessionId}`), [sessionId]);
  const [difficulty, setDifficulty] = useState({}); // block_id -> chosen level

  if (ws.loading) return <Screen><Loading /></Screen>;
  if (ws.error) return <Screen><ErrorBox error={ws.error} onRetry={ws.reload} /></Screen>;

  const session = ws.data?.session;
  const blocks = ws.data?.plan?.blocks ?? [];

  const setBlockDifficulty = async (blockId, level) => {
    setDifficulty((d) => ({ ...d, [blockId]: level }));
    try { await api.patch(`/coaching/sessions/${sessionId}/blocks/${blockId}/difficulty`, { athlete_difficulty: level }); } catch { /* non-fatal local state */ }
  };

  return (
    <Screen>
      <T size={22} weight="700" accessibilityRole="header">{session?.title}</T>
      {session?.objective ? <T size={15} color={c.mute} style={{ marginTop: 4 }}>{session.objective}</T> : null}

      {!blocks.length
        ? <Empty emoji="🏋️" title={t('copar.no_blocks_accessible')} sub={t('copar.no_blocks_accessible_sub')} />
        : blocks.map((b, idx) => (
          <Card key={b.id ?? idx} pad={16} style={{ marginBottom: 12, minHeight: 44 }}
            accessible accessibilityLabel={`${t('copar.block_n', { n: idx + 1 })}: ${b.title}`}>

            {/* Block header */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <T size={18} weight="700" style={{ flex: 1, marginInlineEnd: 8 }}>{idx + 1}. {b.title}</T>
              {b.duration_min ? <Tag label={`${b.duration_min} min`} color={c.violetSoft} accessibilityLabel={`${b.duration_min} ${t('copar.minutes')}`} /> : null}
            </View>

            <T size={13} color={c.mute} style={{ marginTop: 4 }}>{label(b.kind)}</T>

            {/* Primary instructions */}
            {b.instructions
              ? <T size={15} style={{ marginTop: 8, lineHeight: 22 }}>{b.instructions}</T>
              : null}

            {/* Adaptation for this athlete's needs (shown when present) */}
            {b.para_adaptations?.length ? (
              <View style={{ marginTop: 10, padding: 10, backgroundColor: c.cyanSoft, borderRadius: 10 }}
                accessible accessibilityLabel={t('copar.adapted_instructions')}>
                <T size={13} weight="700" color={c.ink}>{t('copar.adapted_instructions')}</T>
                {b.para_adaptations.map((ad, ai) => (
                  <View key={ai} style={{ marginTop: 6 }}>
                    {ad.instruction ? <T size={14} style={{ lineHeight: 21 }}>{ad.instruction}</T> : null}
                    {ad.cues?.length ? <T size={13} color={c.mute} style={{ marginTop: 4 }}>{ad.cues.join(' · ')}</T> : null}
                  </View>
                ))}
              </View>
            ) : null}

            {/* Accessible media caption */}
            {b.accessible_media?.caption_text
              ? <T size={13} color={c.mute} style={{ marginTop: 8 }} accessibilityLabel={`${t('copar.caption')}: ${b.accessible_media.caption_text}`}>
                  {b.accessible_media.caption_text}
                </T>
              : null}

            {/* Difficulty selector */}
            {b.athlete_difficulty !== undefined || difficulty[b.id] ? (
              <View style={{ marginTop: 10 }}
                accessible accessibilityLabel={t('copar.select_difficulty')}>
                <T size={13} weight="700" style={{ marginBottom: 6 }}>{t('copar.select_difficulty')}</T>
                <HScroll>
                  {DIFFICULTY_LEVELS.map((lv) => (
                    <Chip key={lv} label={label(lv)} active={(difficulty[b.id] ?? b.athlete_difficulty) === lv}
                      accessibilityRole="radio" accessibilityState={{ checked: (difficulty[b.id] ?? b.athlete_difficulty) === lv }}
                      accessibilityHint={t('copar.difficulty_hint', { level: label(lv) })}
                      onPress={() => setBlockDifficulty(b.id, lv)} />
                  ))}
                </HScroll>
              </View>
            ) : null}

            {/* Coaching cues */}
            {b.cues?.length
              ? <T size={13} color={c.mute} style={{ marginTop: 8 }}>{b.cues.join(' · ')}</T>
              : null}
          </Card>
        ))
      }
    </Screen>
  );
}

// ==================================================================================
// ParaTemplateToggle
// A "Para sport" filter chip to add above template lists in coaching-studio.js MoreSheet.
// ==================================================================================
export function ParaTemplateToggle({ value, onChange }) {
  return (
    <Chip label={t('copar.para_templates')} active={!!value} onPress={() => onChange(!value)}
      accessibilityRole="switch" accessibilityState={{ checked: !!value }}
      accessibilityLabel={t('copar.filter_para_sport')} />
  );
}

// ==================================================================================
// AccessibleSession — navigable route wrapper for AccessibleTrainingView.
// Receives props.id (the coaching session record id) from push('AccessibleSession', { id }).
// ==================================================================================
export function AccessibleSession({ id }) {
  return <AccessibleTrainingView sessionId={id} />;
}
