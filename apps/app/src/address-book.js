import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { Btn, Empty, Row, Section, T, Tag } from './ui';
import { FormSheet } from './FormSheet';
import { countryName } from './country-picker';
import { c } from './theme';

const KINDS = [{ value: 'home', label: 'Home' }, { value: 'training', label: 'Where I play' }, { value: 'billing', label: 'Billing' }, { value: 'venue', label: 'Venue' }, { value: 'other', label: 'Other' }];
const line = (a) => [a.line1, a.line2, a.area, a.locality, a.region, a.postal_code, a.country ? countryName(a.country) : ''].filter(Boolean).join(', ');

/** City or area is a lookup (type to search, or add your own); the full street address is optional. */
const fields = (first) => [
  { key: 'kind', label: 'What is it', type: 'chips', options: KINDS },
  { key: 'locality', label: 'City or town', type: 'region', optional: true },
  { key: 'area', label: 'Area or district', optional: true },
  { key: 'line1', label: 'Street address', optional: true },
  { key: 'line2', label: 'Apartment, building, landmark', optional: true },
  { key: 'region', label: 'State or province', optional: true },
  { key: 'postal_code', label: 'Postal code', optional: true },
  { key: 'country', label: 'Country', type: 'country', optional: true },
  { key: 'label', label: 'Name for this address', optional: true, hint: 'e.g. “Home court” — only you and the people you share it with see it.' },
  ...(first ? [] : [{ key: 'is_default', label: 'Use as my default', type: 'switch' }]),
];

/** All the addresses of one owner (you, an organisation or a team): add, edit, pick the default, remove. */
export function AddressBook({ ownerKind = 'user', ownerId, title = 'My addresses', canEdit = true, toast }) {
  const q = { owner_kind: ownerKind, owner_id: ownerId };
  const { data, reload } = useLoad(() => api.get('/addresses', q), [ownerKind, ownerId]);
  const [edit, setEdit] = useState(null); // {} = new, address = editing
  const list = data ?? [];
  const say = (m) => toast?.(m);
  const act = (fn, msg) => async () => { try { await fn(); await reload(); say(msg); } catch (e) { say(e.message ?? 'Something went wrong'); } };
  const clean = (v) => Object.fromEntries(Object.entries(v).filter(([k, x]) => !k.endsWith('__pick') && x !== undefined));
  return (
    <Section title={title} action={canEdit ? 'Add' : undefined} onAction={() => setEdit({})}>
      {list.length ? list.map((a) => (
        <Row key={a.id} title={a.label || KINDS.find((k) => k.value === a.kind)?.label} sub={line(a)}
          right={<View style={{ gap: 6, alignItems: 'flex-end' }}>
            {a.is_default ? <Tag label="Default" /> : canEdit ? <Btn small title="Make default" color={c.paper} ink={c.ink} onPress={act(() => api.post(`/addresses/${a.id}/default`, {}), 'Default address updated')} /> : null}
          </View>}
          onPress={canEdit ? () => setEdit(a) : undefined} />
      )) : <Empty emoji="📍" title="No address yet" sub="Add a city or area, and a full address if you want to." />}
      {edit ? (
        <FormSheet visible onClose={() => setEdit(null)} title={edit.id ? 'Edit address' : 'New address'} submitLabel={edit.id ? 'Save' : 'Add address'}
          initial={{ kind: 'other', ...Object.fromEntries(Object.entries(edit).map(([k, x]) => [k, x ?? ''])) }}
          fields={fields(!!edit.id || !list.length)}
          onSubmit={async (v) => {
            const body = clean(v);
            if (edit.id) await api.patch(`/addresses/${edit.id}`, body);
            else await api.post('/addresses', { ...Object.fromEntries(Object.entries(body).filter(([, x]) => x !== '')), ...q });
            await reload();
            return edit.id ? 'Address saved' : 'Address added';
          }} />
      ) : null}
    </Section>
  );
}
