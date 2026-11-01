// India GST billing profile of a venue (#694 / #503), shown inside the venue's "Money, tax & invoices" section. One place for it: the server
// checks the GSTIN, takes the state from it and shows CGST+SGST or IGST on invoices, credit notes and front-desk receipts.
import React, { useState } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { t } from '../i18n';
import { c } from '../theme';

export function GstProfileCard({ venueId, currency }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const gst = useLoad(() => api.get(`/gst-profiles/venue/${venueId}`), [venueId]);
  if (currency !== 'INR') return null;   // GST applies to rupee invoices only
  const p = gst.data?.profile;
  return (
    <Card>
      <T weight="700">{t('gst.title')}</T>
      <T size={13} color={c.mute}>{p ? t('gst.summary', { gstin: p.gstin, state: p.state_code, rate: p.rate_bp / 100 }) : t('gst.none')}</T>
      <Btn small title={p ? t('gst.edit') : t('gst.add')} color={c.violet} onPress={() => setOpen(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }} accessibilityLabel={t('gst.title')} />
      <FormSheet visible={open} onClose={() => setOpen(false)} title={t('gst.title')}
        initial={{ gstin: p?.gstin ?? '', default_sac: p?.default_sac ?? '', rate_pct: p ? p.rate_bp / 100 : 18, tax_inclusive: p?.tax_inclusive ?? true }}
        fields={[
          { key: 'gstin', label: t('gst.gstin'), hint: t('gst.gstin_hint') },
          { key: 'default_sac', label: t('gst.sac'), optional: true, hint: t('gst.sac_hint') },
          { key: 'rate_pct', label: t('gst.rate'), type: 'stepper', min: 0, max: 40, step: 0.5, suffix: '%' },
          { key: 'tax_inclusive', label: t('gst.inclusive'), type: 'switch' },
        ]}
        onSubmit={async ({ rate_pct, gstin, default_sac, ...f }) => {
          await api.post(`/gst-profiles/venue/${venueId}`, { ...f, gstin: String(gstin).trim().toUpperCase(), ...(default_sac ? { default_sac } : {}), rate_bp: Math.round((rate_pct ?? 18) * 100) });
          await gst.reload(); toast(t('gst.saved')); return t('gst.saved');
        }} />
    </Card>
  );
}
