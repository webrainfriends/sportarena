import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Row, T, Tag } from '../ui';
import { c } from '../theme';
import { FormSheet } from '../FormSheet';

const LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'ta', label: 'Tamil' },
  { value: 'te', label: 'Telugu' },
  { value: 'ml', label: 'Malayalam' },
  { value: 'mr', label: 'Marathi' },
  { value: 'kn', label: 'Kannada' },
  { value: 'bn', label: 'Bengali' },
  { value: 'or', label: 'Odia' },
  { value: 'hi', label: 'Hindi' },
  { value: 'si', label: 'Sinhala' },
  { value: 'ur', label: 'Urdu (RTL)' },
  { value: 'id', label: 'Bahasa Indonesia' },
];

export function StudioLocalisations({ pageId }) {
  const [locale, setLocale] = useState('en');
  const locs = useLoad(() => api.get('/admin/landing/pages/' + pageId + '/localisations', { locale }), [pageId, locale]);
  const [editing, setEditing] = useState(null);

  if (locs.loading && !locs.data) return <Loading />;
  if (locs.error) return <ErrorBox error={locs.error} onRetry={locs.reload} />;

  const strings = locs.data ? locs.data.strings : [];

  return (
    <View style={{ gap: 10 }}>
      <T weight="800" size={18}>Localisations</T>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        {LOCALES.map((l) => (
          <Btn key={l.value} small title={l.label} color={locale === l.value ? c.pink : c.paper} ink={locale === l.value ? '#fff' : c.mute} onPress={() => setLocale(l.value)} />
        ))}
      </View>

      {strings.length === 0
        ? <Empty emoji="🌐" title="No strings" sub={'No localised strings for ' + locale + '.'} />
        : strings.map((s) => (
          <Card key={s.string_key}>
            <View style={{ gap: 4 }}>
              <T size={11} color={c.mute} weight="700">{s.string_key}</T>
              <T size={14}>{s.value || <T size={14} color={c.red}>Missing</T>}</T>
              {!s.reviewed && <Tag label="Machine draft — needs review" color={c.sun} />}
            </View>
            <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setEditing(s)} style={{ marginTop: 8 }} />
          </Card>
        ))}

      <FormSheet visible={!!editing} onClose={() => setEditing(null)} title="Edit string"
        submitLabel="Save"
        initial={editing ? { value: editing.value || '', reviewed: editing.reviewed ? 'yes' : 'no' } : {}}
        fields={[
          { key: 'value', label: 'Translated value', type: 'multiline' },
          { key: 'reviewed', label: 'Mark as reviewed by native speaker', type: 'chips', options: [{ value: 'yes', label: 'Reviewed' }, { value: 'no', label: 'Machine draft' }] },
        ]}
        onSubmit={async (v) => {
          await api.patch('/admin/landing/localisations/' + editing.id, { value: v.value, reviewed: v.reviewed === 'yes' });
          locs.reload();
          setEditing(null);
          return 'String updated';
        }}
      />
    </View>
  );
}
