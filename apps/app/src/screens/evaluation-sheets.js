// Evaluation sheets: the coach's own assessment framework for an athlete or a class, built as a rubric with the detail a professional needs.
// Each criterion belongs to a pillar (technical, tactical, physical, mental, behaviour, lifestyle), has a weight, its own scale, a short name and a
// description of the behaviour at every level (so two coaches score the same thing the same way), a target and a note on what evidence to collect.
// Saving makes a new version: evaluations already shared keep the version they were scored on. The standard sheets for the sports the coach coaches
// arrive on their own and can be changed or copied. This replaces the old three-field rubric form: one place for sheets.
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Section, T, Tag } from '../ui';
import { MenuField, MultiMenuField } from '../menu-field';
import { SportsMulti } from '../sportpicker';
import { Counter } from '../pickers';
import { t } from '../i18n';
import { c } from '../theme';
import { explain } from '../access';
import { STANDARD_PILLARS, pillarName, pillarKey, orderOf, isNumeric } from '../eval-pillars';

const DIRS = [['higher_is_better', 'cs.dir_higher'], ['lower_is_better', 'cs.dir_lower'], ['target_range', 'cs.dir_target']];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
const labelsOf = (cr) => Object.fromEntries(cr.filter((c) => c.pillar_label).map((c) => [c.pillar, c.pillar_label]));
const blank = (n) => ({ key: '', name: '', pillar: 'technical', weight: 1, scale_min: 1, scale_max: 5, direction: 'higher_is_better', labels: {}, anchors: {}, _open: true, _n: n });

export function CoachRubrics() {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/coaching/rubrics', { limit: 100 }), []);
  const sports = useLoad(() => api.get('/sports'), []);
  const [edit, setEdit] = useState(null);   // null | { id?, name, sports, positions, criteria }
  const slugOf = (sid) => sports.data?.find((x) => x.id === sid)?.slug;
  const sportNames = (r) => (r.sport_ids?.length ? r.sport_ids.map((sid) => sports.data?.find((x) => x.id === sid)?.name).filter(Boolean).join(', ') : t('cs.all_sports_lc'));
  const open = (r, copy = false) => setEdit({ id: copy ? undefined : r.id, name: copy ? '' : r.name, sports: (r.sport_ids ?? []).map(slugOf).filter(Boolean), positions: r.positions ?? [], criteria: r.dimensions.map((d, i) => ({ ...d, labels: d.labels ?? {}, anchors: d.anchors ?? {}, pillar: d.pillar ?? 'other', _n: i })) });
  if (edit) return <SheetEditor edit={edit} setEdit={setEdit} onSaved={() => { setEdit(null); list.reload(); }} toast={toast} />;
  return (
    <Screen onRefresh={list.reload}>
      <H1>{t('es.sheets_title')}</H1>
      <T size={13} color={c.mute}>{t('es.help')}</T>
      <View style={{ marginTop: 10 }}><Btn small title={t('es.new_sheet')} onPress={() => setEdit({ name: '', sports: [], positions: [], criteria: [blank(0)] })} /></View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty emoji="📏" title={t('cs.no_rubrics')} sub={t('cs.no_rubrics_sub')} /> : (
        <View style={{ marginTop: 12, gap: 10 }}>
          {list.data.map((r) => {
            const pillars = [...new Set(r.dimensions.map((d) => d.pillar ?? 'other'))];
            return (
              <View key={r.id} style={{ gap: 8, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper }}>
                <T weight="800" size={16}>{r.name}</T>
                <T size={13} color={c.mute}>{[r.standard_source ? t('cs.std_source', { src: r.standard_source }) : null, `v${r.version}`, sportNames(r), t('es.criteria_n', { n: r.dimensions.length })].filter(Boolean).join(' · ')}</T>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{pillars.map((p) => <Tag key={p} label={pillarName(p, labelsOf(r.dimensions))} />)}</View>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Btn small title={t('es.edit')} onPress={() => open(r)} accessibilityLabel={[t('es.edit'), r.name].join(': ')} />
                  <Btn small title={t('es.copy')} color={c.paper} ink={c.ink} onPress={() => open(r, true)} accessibilityLabel={[t('es.copy'), r.name].join(': ')} />
                </View>
              </View>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

function SheetEditor({ edit, setEdit, onSaved, toast }) {
  const positions = useLoad(() => api.get('/coaching/positions'), []);
  const [busy, setBusy] = useState(false);
  const cr = edit.criteria;
  const setC = (i, p) => setEdit({ ...edit, criteria: cr.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const move = (i, to) => { const n = cr.slice(); const [x] = n.splice(i, 1); n.splice(to, 0, x); setEdit({ ...edit, criteria: n }); };
  const totalW = cr.reduce((s, x) => s + (x.weight ?? 1), 0);
  const byPillar = useMemo(() => orderOf(cr).map((p) => [p, cr.filter((x) => x.pillar === p).reduce((s, x) => s + (x.weight ?? 1), 0)]).filter(([, w]) => w > 0), [cr]);
  const problem = !edit.name.trim() || edit.name.trim().length < 2 ? t('es.need_name') : !cr.length ? t('cs.rubric_need_dim') : cr.some((x) => !x.name.trim()) ? t('es.need_criterion_name') : null;
  const save = async () => {
    setBusy(true);
    try {
      const seen = new Set();
      const dimensions = cr.map((x) => {
        let key = x.key || slug(x.name) || `c${x._n}`; while (seen.has(key)) key = `${key}_2`; seen.add(key);
        const levels = []; for (let v = x.scale_min; v <= x.scale_max && levels.length < 11 && !isNumeric(x); v++) levels.push(String(v));
        const pick = (o) => Object.fromEntries(levels.filter((l) => o?.[l]?.trim()).map((l) => [l, o[l].trim()]));
        return { key: key.length < 2 ? `${key}_x` : key, name: x.name.trim(), ...(x.description?.trim() ? { description: x.description.trim() } : {}), scale_min: x.scale_min, scale_max: x.scale_max, direction: x.direction, pillar: x.pillar, ...(x.pillar_label ? { pillar_label: x.pillar_label } : {}), weight: x.weight ?? 1, ...(x.input ? { input: x.input } : {}), ...(x.step && x.step !== 1 ? { step: x.step } : {}),
          ...(x.unit?.trim() ? { unit: x.unit.trim() } : {}), ...(x.target != null ? { target: x.target } : {}), ...(x.evidence_hint?.trim() ? { evidence_hint: x.evidence_hint.trim() } : {}), labels: pick(x.labels), anchors: pick(x.anchors) };
      });
      await api.post('/coaching/rubrics', { rubric_id: edit.id, name: edit.name.trim(), sports: edit.sports, positions: edit.positions, dimensions });
      toast(edit.id ? t('cs.rubric_saved') : t('cs.rubric_created')); onSaved();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title={t('common.back')} color={c.paper} ink={c.ink} onPress={() => setEdit(null)} />
        <H1 style={{ fontSize: 24, flex: 1 }}>{edit.name.trim() || t('es.new_sheet')}</H1>
      </View>
      <View style={{ gap: 12, marginTop: 12 }}>
        <Field label={t('cs.rubric_name')} value={edit.name} onChangeText={(x) => setEdit({ ...edit, name: x })} maxLength={80} />
        <SportsMulti label={t('cs.rubric_sports')} value={edit.sports} onChange={(x) => setEdit({ ...edit, sports: x })} optional />
        {positions.data?.length ? <MultiMenuField label={t('cs.rubric_positions')} value={edit.positions} onChange={(x) => setEdit({ ...edit, positions: x })} options={positions.data.map((p) => ({ value: p, label: p }))} placeholder={t('common.all')} /> : null}
        <Section title={t('es.balance')} color={c.cyan}>
          {byPillar.length ? byPillar.map(([p, w]) => (
            <View key={p} accessible accessibilityLabel={[pillarName(p, labelsOf(cr)), `${Math.round((w / totalW) * 100)}%`].join(': ')} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 }}>
              <T size={13} weight="700" style={{ width: 96 }}>{pillarName(p, labelsOf(cr))}</T>
              <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ height: 8, width: `${(w / totalW) * 100}%`, backgroundColor: c.cyan }} /></View>
              <T size={12} color={c.mute} style={{ width: 40, textAlign: 'right' }}>{Math.round((w / totalW) * 100)}%</T>
            </View>
          )) : <T size={13} color={c.mute}>{t('es.balance_none')}</T>}
          <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('es.balance_note')}</T>
        </Section>
        {cr.map((x, i) => (
          <CriterionCard key={x._n} x={x} i={i} n={cr.length} allCriteria={cr} share={totalW ? Math.round(((x.weight ?? 1) / totalW) * 100) : 0} onPatch={(p) => setC(i, p)} onMove={(to) => move(i, to)}
            onDuplicate={() => setEdit({ ...edit, criteria: [...cr.slice(0, i + 1), { ...x, key: '', name: `${x.name} 2`, _n: Math.max(...cr.map((y) => y._n)) + 1, _open: true }, ...cr.slice(i + 1)] })}
            onRemove={() => setEdit({ ...edit, criteria: cr.filter((_, j) => j !== i) })} />
        ))}
        <Btn small title={t('es.add_criterion')} color={c.paper} ink={c.ink} onPress={() => setEdit({ ...edit, criteria: [...cr, blank(Math.max(-1, ...cr.map((y) => y._n)) + 1)] })} style={{ alignSelf: 'flex-start' }} />
        {problem ? <T size={13} color={c.sun} weight="700">{problem}</T> : null}
        <Btn title={t('common.save')} loading={busy} disabled={!!problem} onPress={save} />
        <T size={12} color={c.mute}>{t('es.versions_note')}</T>
      </View>
    </Screen>
  );
}

function CriterionCard({ x, i, n, share, allCriteria, onPatch, onMove, onDuplicate, onRemove }) {
  const [newPillar, setNewPillar] = useState('');
  const levels = []; for (let v = x.scale_min; v <= x.scale_max && levels.length < 11; v++) levels.push(String(v));
  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: x._open ? c.ink : c.line, backgroundColor: c.paper, overflow: 'hidden' }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: !!x._open }} accessibilityLabel={x.name || t('es.new_criterion')} onPress={() => onPatch({ _open: !x._open })} style={{ padding: 14, gap: 4, minHeight: 56 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T weight="800" size={16} style={{ flex: 1 }}>{x.name || t('es.new_criterion')}</T>
          <Btn small title={x._open ? '▲' : '▼'} color={c.paper} ink={c.ink} onPress={() => onPatch({ _open: !x._open })} accessibilityLabel={x._open ? t('es.collapse') : t('es.expand')} />
        </View>
        <T size={12} color={c.mute}>{[pillarName(x.pillar, labelsOf(allCriteria)), t('es.weight_share', { n: share }), `${x.scale_min}–${x.scale_max}`, x.target != null ? t('es.target_n', { n: x.target }) : null].filter(Boolean).join(' · ')}</T>
      </Pressable>
      {x._open ? (
        <View style={{ padding: 14, gap: 12, borderTopWidth: 1, borderTopColor: c.line }}>
          <Field label={t('es.criterion_name')} value={x.name} onChangeText={(v) => onPatch({ name: v })} maxLength={80} />
          <Field label={t('es.what_it_measures')} value={x.description} onChangeText={(v) => onPatch({ description: v })} multiline minHeight={60} maxLength={300} />
          <View style={{ gap: 6 }}>
            <T weight="600" size={12} color={c.mute}>{t('es.pillar').toUpperCase()}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[...new Set([...STANDARD_PILLARS, ...orderOf(allCriteria)])].map((p) => <Chip key={p} label={pillarName(p, labelsOf(allCriteria))} active={x.pillar === p} onPress={() => onPatch({ pillar: p, pillar_label: undefined })} />)}</View>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Field value={newPillar} onChangeText={setNewPillar} placeholder={t('es.pillar_new')} maxLength={40} accessibilityLabel={t('es.pillar_new')} /></View><Btn small title={t('es.add')} disabled={pillarKey(newPillar).length < 2} onPress={() => { onPatch({ pillar: pillarKey(newPillar), pillar_label: newPillar.trim() }); setNewPillar(''); }} /></View>
            <T size={12} color={c.mute}>{t('es.pillar_hint')}</T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}><T weight="600">{t('es.weight')}</T><T size={12} color={c.mute}>{t('es.weight_hint')}</T></View><Counter value={x.weight ?? 1} min={0} max={10} onChange={(v) => onPatch({ weight: v })} a11y={t('es.weight')} /></View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><T weight="600" style={{ flex: 1 }}>{t('es.scale_from')}</T><Counter value={x.scale_min} min={0} max={x.scale_max - 1} onChange={(v) => onPatch({ scale_min: v })} a11y={t('es.scale_from')} /></View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><T weight="600" style={{ flex: 1 }}>{t('es.scale_to')}</T><Counter value={x.scale_max} min={x.scale_min + 1} max={Math.min(x.scale_min + 10, 100)} onChange={(v) => onPatch({ scale_max: v })} a11y={t('es.scale_to')} /></View>
          <View style={{ gap: 6 }}>
            <T weight="600" size={12} color={c.mute}>{t('es.score_type').toUpperCase()}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Chip label={t('es.score_levels')} active={!isNumeric(x)} onPress={() => onPatch({ input: 'levels', step: 1 })} /><Chip label={t('es.score_number')} active={isNumeric(x)} onPress={() => onPatch({ input: 'number' })} /></View>
            {isNumeric(x) ? <><T size={12} color={c.mute}>{t('es.step')}</T><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[1, 0.5, 0.1, 0.01].map((v) => <Chip key={v} label={String(v)} active={(x.step ?? 1) === v} onPress={() => onPatch({ step: v })} />)}</View></> : null}
          </View>
          <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>{t('cs.better_when').toUpperCase()}</T><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{DIRS.map(([v, k]) => <Chip key={v} label={t(k)} active={x.direction === v} onPress={() => onPatch({ direction: v })} />)}</View></View>
          <Field label={t('es.unit')} value={x.unit} onChangeText={(v) => onPatch({ unit: v })} maxLength={20} hint={t('es.unit_hint')} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}><T weight="600">{t('es.target')}</T><T size={12} color={c.mute}>{x.target != null ? t('es.target_n', { n: x.target }) : t('es.target_none')}</T></View>
            <Chip label={x.target != null ? t('es.target_clear') : t('es.target_set')} active={x.target != null} onPress={() => onPatch({ target: x.target != null ? undefined : x.scale_max })} />
            {x.target != null ? <Counter value={x.target} min={x.scale_min} max={x.scale_max} onChange={(v) => onPatch({ target: v })} a11y={t('es.target')} /> : null}</View>
          {isNumeric(x) ? <T size={12} color={c.mute}>{t('es.number_hint')}</T> : <View style={{ gap: 8 }}>
            <T weight="700">{t('es.levels')}</T><T size={12} color={c.mute}>{t('es.levels_hint')}</T>
            {levels.map((l) => (
              <View key={l} style={{ gap: 6, padding: 10, borderRadius: 12, backgroundColor: c.violetSoft }}>
                <T weight="800">{t('es.level_n', { n: l })}</T>
                <Field label={t('es.level_name')} value={x.labels?.[l]} onChangeText={(v) => onPatch({ labels: { ...x.labels, [l]: v } })} maxLength={80} />
                <Field label={t('es.level_looks')} value={x.anchors?.[l]} onChangeText={(v) => onPatch({ anchors: { ...x.anchors, [l]: v } })} multiline minHeight={56} maxLength={400} />
              </View>
            ))}
          </View>}
          <Field label={t('es.evidence_hint')} value={x.evidence_hint} onChangeText={(v) => onPatch({ evidence_hint: v })} multiline minHeight={56} maxLength={300} hint={t('es.evidence_hint_note')} />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title="↑" color={c.paper} ink={c.ink} disabled={i === 0} onPress={() => onMove(i - 1)} accessibilityLabel={t('cp.move_up')} />
            <Btn small title="↓" color={c.paper} ink={c.ink} disabled={i === n - 1} onPress={() => onMove(i + 1)} accessibilityLabel={t('cp.move_down')} />
            <Btn small title={t('st.duplicate')} color={c.paper} ink={c.ink} onPress={onDuplicate} />
            <Btn small title={t('cp.remove')} color={c.red} onPress={onRemove} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
