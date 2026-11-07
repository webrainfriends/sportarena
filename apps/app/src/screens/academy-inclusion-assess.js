// Adapted, coach-led assessment (#808): on an existing academy assessment the coach picks the pathway alternative and describes each dimension with a
// descriptor level (emerging, developing, secure, exceeding). There is no number and no universal score. A second assessor signs it off; the athlete and
// guardian keep the appeal route on the canonical assessment. Rules are on the server (save_adapted_assessment, sign_off_adapted_assessment).
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Field, Loading, T } from '../ui';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { t } from '../i18n';
import { Block } from './academy-ui';

const LEVELS = ['emerging', 'developing', 'secure', 'exceeding'];
const VARIANTS = ['standard', 'adapted', 'age_flexible'];
const blank = () => ({ label: '', level: 'developing' });
const slug = (s, i) => (s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'dimension') + `_${i + 1}`;

export function AdaptedAssessments({ o, toast }) {
  const [aid, setAid] = useState(null), [variant, setVariant] = useState('adapted'), [rows, setRows] = useState([blank()]), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/assessments`, { limit: 100 }), [o.id]);
  if (list.error) return <LoadError error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const items = Array.isArray(list.data) ? list.data : list.data.items ?? [];
  const set = (i, patch) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = async () => {
    const descriptors = rows.filter((r) => r.label.trim()).map((r, i) => ({ dimension_key: slug(r.label, i), label: r.label.trim(), level: r.level }));
    if (!descriptors.length) { toast(t('inc.a_need_one')); return; }
    setBusy(true);
    try { await api.post(`/academy/assessments/${aid}/adaptation`, { pathway_variant: variant, descriptors, ...(note ? { note } : {}) }); toast(t('inc.a_saved')); } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const sign = async () => { try { await api.post(`/academy/assessments/${aid}/adaptation/sign-off`, {}); toast(t('inc.a_signed')); } catch (e) { toast(explain(e)); } };
  return (
    <View style={{ gap: 12 }}>
      <MenuField label={t('inc.a_pick')} value={aid} onChange={setAid} options={items.map((a) => ({ value: a.id, label: `${a.athlete_name} · ${a.pathway} · ${a.level_key}` }))} placeholder={t('inc.a_pick_ph')} />
      {!items.length ? <Card><Empty emoji="📝" title={t('inc.a_none_title')} sub={t('inc.a_none_sub')} /></Card> : null}
      {aid ? (
        <Card>
          <Block title={t('inc.a_title')}>
            <T size={12} color={c.mute}>{t('inc.a_note')}</T>
            <T weight="700" size={13}>{t('inc.a_variant')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{VARIANTS.map((k) => <Chip key={k} label={t(`inc.variant_${k}`)} active={variant === k} onPress={() => setVariant(k)} />)}</View>
            {rows.map((r, i) => (
              <View key={i} style={{ gap: 6 }}>
                <Field label={t('inc.a_dimension', { n: i + 1 })} value={r.label} onChangeText={(x) => set(i, { label: x })} maxLength={120} />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup">{LEVELS.map((k) => <Chip key={k} label={t(`inc.lvl_${k}`)} active={r.level === k} onPress={() => set(i, { level: k })} />)}</View>
              </View>
            ))}
            {rows.length < 12 ? <Btn small title={t('inc.a_add')} color={c.cyan} onPress={() => setRows((r) => [...r, blank()])} /> : null}
            <Field label={t('inc.a_note_label')} value={note} onChangeText={setNote} multiline maxLength={500} hint={t('inc.f_note_hint')} />
            <Btn title={t('inc.a_save')} onPress={save} loading={busy} />
            <Btn title={t('inc.a_sign')} color={c.violet} onPress={sign} accessibilityLabel={t('inc.a_sign_a11y')} />
          </Block>
        </Card>
      ) : null}
    </View>
  );
}
