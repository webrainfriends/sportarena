import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { Btn, Empty, Row, Section, T, Tag } from './ui';
import { FormSheet } from './FormSheet';
import { countryName } from './country-picker';
import { c } from './theme';
import { t } from './i18n';

const KINDS = [{ value: 'home', label: t('addr.kind_home') }, { value: 'training', label: t('addr.kind_training') }, { value: 'billing', label: t('addr.kind_billing') }, { value: 'venue', label: t('addr.kind_venue') }, { value: 'other', label: t('addr.kind_other') }];
const line = (a) => [a.line1, a.line2, a.area, a.locality, a.region, a.postal_code, a.country ? countryName(a.country) : ''].filter(Boolean).join(', ');

/** City or area is a lookup (type to search, or add your own); the full street address is optional. */
const fields = (first, contexts) => [
  { key: 'kind', label: t('addr.what'), type: 'chips', options: KINDS },
  { key: 'locality', label: t('addr.city'), type: 'region', optional: true },
  { key: 'area', label: t('addr.area'), optional: true },
  { key: 'line1', label: t('addr.street'), optional: true },
  { key: 'line2', label: t('addr.line2'), optional: true },
  { key: 'region', label: t('addr.state'), optional: true },
  { key: 'postal_code', label: t('addr.postal'), optional: true },
  { key: 'country', label: t('place.country'), type: 'country', optional: true },
  ...(contexts.length ? [{ key: 'context', label: t('addr.where_used'), type: 'chips', optional: true, options: contexts.map((x) => ({ value: x.value, label: x.label })), hint: t('addr.where_hint') }] : []),
  { key: 'label', label: t('addr.name_label'), optional: true, hint: t('addr.name_hint') },
  ...(first ? [] : [{ key: 'is_default', label: t('addr.default_switch'), type: 'switch' }]),
];

/** All the addresses of one owner (you, an organisation or a team): add, edit, pick the default, remove. */
export function AddressBook({ ownerKind = 'user', ownerId, title = t('addr.title'), canEdit = true, toast }) {
  const q = { owner_kind: ownerKind, owner_id: ownerId };
  const { data, reload } = useLoad(() => api.get('/addresses', q), [ownerKind, ownerId]);
  const [edit, setEdit] = useState(null); // {} = new, address = editing
  const mineScopes = useLoad(async () => {
    if (ownerKind !== 'user') return [];
    const [orgs, teams] = await Promise.all([api.get('/organisations').catch(() => []), api.get('/teams', { mine: true }).catch(() => [])]);
    const arr = (x) => (Array.isArray(x) ? x : x?.items ?? []);
    return [...arr(orgs).filter((o) => o.my_status === 'active').map((o) => ({ value: `${o.kind === 'academy' ? 'academy' : 'organisation'}:${o.id}`, label: `${o.kind === 'academy' ? t('addr.scope_academy') : t('addr.scope_org')} · ${o.name}` })), ...arr(teams).map((tm) => ({ value: `team:${tm.id}`, label: `${t('addr.scope_team')} · ${tm.name}` }))];
  }, [ownerKind]);
  const contexts = mineScopes.data ?? [];
  const ctxName = (a) => contexts.find((x) => x.value === `${a.context_kind}:${a.context_id}`)?.label;
  const list = data ?? [];
  const say = (m) => toast?.(m);
  const act = (fn, msg) => async () => { try { await fn(); await reload(); say(msg); } catch (e) { say(e.message ?? t('error.generic')); } };
  const clean = (v) => Object.fromEntries(Object.entries(v).filter(([k, x]) => !k.endsWith('__pick') && x !== undefined));
  return (
    <Section title={title} action={canEdit ? t('addr.add') : undefined} onAction={() => setEdit({})}>
      {list.length ? list.map((a) => (
        <Row key={a.id} title={a.label || KINDS.find((k) => k.value === a.kind)?.label} sub={[ctxName(a), line(a)].filter(Boolean).join(' · ')}
          right={<View style={{ gap: 6, alignItems: 'flex-end' }}>
            {a.is_default ? <Tag label={t('addr.default_tag')} /> : canEdit ? <Btn small title={t('addr.make_default')} color={c.paper} ink={c.ink} onPress={act(() => api.post(`/addresses/${a.id}/default`, {}), t('addr.default_updated'))} /> : null}
          </View>}
          onPress={canEdit ? () => setEdit(a) : undefined} />
      )) : <Empty emoji="📍" title={t('addr.empty_title')} sub={t('addr.empty_sub')} />}
      {edit ? (
        <FormSheet visible onClose={() => setEdit(null)} title={edit.id ? t('addr.edit_title') : t('addr.new_title')} submitLabel={edit.id ? t('common.save') : t('addr.add_submit')}
          initial={{ kind: 'other', ...Object.fromEntries(Object.entries(edit).map(([k, x]) => [k, x ?? ''])), context: edit.context_kind ? `${edit.context_kind}:${edit.context_id}` : undefined }}
          fields={fields(!!edit.id || !list.length, contexts)}
          onSubmit={async (v) => {
            const { context, ...rest } = v;
            const body = { ...clean(rest), ...(context ? { context_kind: context.split(':')[0], context_id: context.split(':')[1] } : edit.id && edit.context_kind ? { context_kind: edit.context_kind, context_id: edit.context_id } : {}) };
            if (edit.id) await api.patch(`/addresses/${edit.id}`, body);
            else await api.post('/addresses', { ...Object.fromEntries(Object.entries(body).filter(([, x]) => x !== '')), ...q });
            await reload();
            return edit.id ? t('addr.saved') : t('addr.added');
          }} />
      ) : null}
    </Section>
  );
}
