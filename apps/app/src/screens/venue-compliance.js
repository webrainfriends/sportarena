// Compliance register of a venue: licences, certificates and permits with expiry dates (fire, safety, pool, food, accessibility, tax,
// event permits), together with the insurance and contracts the venue already holds. It lives in the venue's Documents tab (one
// place for venue paperwork); the venue home warns before anything lapses. Items are archived, never deleted.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';
import { useSession } from '../session';

const KINDS = ['licence', 'fire', 'safety', 'pool', 'food', 'accessibility', 'tax', 'permit', 'other'];
const TONE = { expired: c.orange, soon: c.sun, ok: c.mint };

export function VenueComplianceRegister({ venueId }) {
  const { toast } = useSession();
  const reg = useLoad(() => api.get(`/venues/${venueId}/compliance`), [venueId]);
  const [form, setForm] = useState(null); // null | {} (new) | item (renew)
  const run = async (fn, msg) => { try { await fn(); toast?.(msg); reg.reload(); } catch (e) { toast?.(explain(e)); } };
  if (reg.error) return <ErrorBox error={reg.error} onRetry={reg.reload} />;
  if (!reg.data) return <Loading />;
  return (
    <View style={{ gap: 10, marginBottom: 16 }}>
      <T size={17} weight="800">{t('vcr.title')}</T>
      <T size={13} color={c.mute}>{t('vcr.sub')}</T>
      {reg.data.items.length ? reg.data.items.map((i) => (
        <Card key={`${i.source}${i.id}`} pad={12} accessibilityLabel={`${i.title ?? t(`vh.ck.${i.kind}`)}. ${t(`vh.cs.${i.status}`)}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <View style={{ flex: 1, minWidth: 160 }}>
              <T weight="700">{i.title ?? t(`vh.ck.${i.kind}`)}</T>
              <T size={12} color={c.mute}>{t(`vcr.src.${i.source}`)}{i.expires_on ? ` · ${i.expires_on}` : ''}</T>
            </View>
            <Tag label={i.days_left == null ? t('vh.cs.ok') : i.days_left < 0 ? t('vh.cs.expired') : (i.days_left === 1 ? t('vh.cs.days_one') : t('vh.cs.days', { n: i.days_left }))} color={TONE[i.status]} />
            {i.source === 'compliance' ? <>
              <Btn small title={t('vcr.renew')} color={c.paper} onPress={() => setForm(i)} />
              <Btn small title={t('vcr.archive')} color={c.paper} onPress={() => run(() => api.patch(`/venues/${venueId}/compliance/${i.id}`, { archived: true }), t('vcr.archived'))} />
            </> : null}
          </View>
        </Card>
      )) : <Empty emoji="📜" title={t('vh.co.none')} sub={t('vh.co.none_sub')} />}
      <Btn small title={t('vcr.add')} onPress={() => setForm({})} />
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.id ? t('vcr.renew') : t('vcr.add')} submitLabel={t('common.save')}
        initial={form?.id ? { expires_on: '' } : { kind: 'licence' }}
        fields={form?.id
          ? [{ key: 'expires_on', label: t('vcr.expires'), type: 'date' }]
          : [{ key: 'kind', label: t('vcr.kind'), type: 'chips', options: KINDS.map((value) => ({ value, label: t(`vh.ck.${value}`) })) },
            { key: 'title', label: t('vcr.name') }, { key: 'reference', label: t('vcr.reference'), optional: true },
            { key: 'issued_on', label: t('vcr.issued'), type: 'date', optional: true }, { key: 'expires_on', label: t('vcr.expires'), type: 'date', optional: true }]}
        onSubmit={async (v) => {
          if (form?.id) await api.patch(`/venues/${venueId}/compliance/${form.id}`, { expires_on: v.expires_on });
          else await api.post(`/venues/${venueId}/compliance`, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null)));
          reg.reload();
          return t('vcr.saved');
        }} />
    </View>
  );
}
