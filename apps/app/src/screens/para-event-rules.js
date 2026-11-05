// PS-01 (#831): the para-sport block of an event discipline. Context chips, and for sanctioned competition the governed rule version (approved and in
// force only) with its event categories. recreational / mixed-ability need no classification and no version. The pin is frozen server-side as a snapshot.
import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSports } from '../sportpicker';
import { Chip, T } from '../ui';
import { MenuField, MultiMenuField } from '../menu-field';
import { c } from '../theme';
import { t } from '../i18n';

export const PARA_CONTEXTS = ['sanctioned', 'recreational', 'mixed_ability'];

/** FormSheet `custom` renderer: the value is a one-element array [{ context, version, categories }] so FormSheet keeps it. */
export function ParaRules({ v, set, fieldKey = 'para', sportSlug }) {
  const sports = useSports();
  const slug = sportSlug ?? v.sport;
  const sport = (sports.data ?? []).find((s) => s.slug === slug);
  const val = (v[fieldKey] ?? [])[0] ?? {};
  const put = (patch) => set(fieldKey, [{ ...val, ...patch }]);
  const detail = useLoad(() => (sport?.is_para ? api.get(`/para/sports/${slug}`) : Promise.resolve(null)), [slug, sport?.is_para]);
  if (!sport?.is_para) return null;
  const usable = (detail.data?.versions ?? []).filter((x) => x.status === 'published' && x.approval_status === 'approved' && !x.deprecated_at);
  const picked = usable.find((x) => x.id === val.version);
  return (
    <View style={{ gap: 8 }}>
      <T weight="800" size={13}>{t('ps.contexts')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {PARA_CONTEXTS.map((k) => <Chip key={k} label={t(`ps.ctx.${k}`)} active={val.context === k} onPress={() => put({ context: val.context === k ? undefined : k, ...(k !== 'sanctioned' ? { version: undefined, categories: [] } : {}) })} />)}
      </View>
      <T size={12} color={c.mute}>{t('ps.ctx_hint')}</T>
      {val.context === 'sanctioned' ? (
        usable.length ? (
          <>
            <MenuField label={t('ps.rule_version')} value={val.version} onChange={(x) => put({ version: x, categories: [] })} options={usable.map((x) => ({ value: x.id, label: `${x.authority} · ${t('ps.version_n', { n: x.version })}` }))} hint={t('ps.rule_version_hint')} />
            {picked?.event_categories?.length ? <MultiMenuField label={t('ps.categories')} value={val.categories ?? []} onChange={(x) => put({ categories: x })} options={picked.event_categories.map((k) => ({ value: k, label: k }))} placeholder={t('common.all')} /> : null}
          </>
        ) : <T size={12} color={c.red}>{t('ps.no_rules')}</T>
      ) : null}
    </View>
  );
}

/** Map the custom field value to the capability's input. */
export const paraInput = (v, fieldKey = 'para') => {
  const p = (v[fieldKey] ?? [])[0];
  if (!p?.context) return {};
  return { participation_context: p.context, ...(p.version ? { para_version_id: p.version } : {}), ...(p.categories?.length ? { para_categories: p.categories } : {}) };
};
