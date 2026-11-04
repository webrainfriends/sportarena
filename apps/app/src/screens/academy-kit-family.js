// Academy kit (#798) for the athlete (an adult) or a verified guardian: what is to collect and where, what is held and when it is due back, sizes, and (with the
// guardian's pay scope) what is owed. The API checks the guardian link live; a 404 simply means there is nothing to show this person.
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, T, Tag } from '../ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { Block } from './academy-ui';
import { ReceiptSheet, StatusTag, day } from './academy-kit-desk';

export function FamilyKit({ athleteId }) {
  const q = useLoad(() => api.get('/me/academy/kit', { athlete_id: athleteId }), [athleteId]);
  const [rcpt, setRcpt] = useState(null);
  if (!q.data || !q.data.organisations.length) return null;
  const orgs = q.data.organisations.filter((o) => o.to_collect.length || o.items.length || o.sizes.length);
  if (!orgs.length) return null;
  return (
    <View style={{ padding: 16, borderRadius: 20, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, gap: 8 }}>
      <Block title={t('kit.family_title')}>
        {orgs.map((o) => (
          <View key={o.organisation.id} style={{ gap: 8 }}>
            {orgs.length > 1 ? <T weight="800" size={13} color={c.mute}>{o.organisation.name}</T> : null}
            {o.to_collect.map((x, i) => (
              <View key={i} style={{ padding: 12, borderRadius: 16, backgroundColor: c.sunSoft, gap: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <T weight="800" style={{ flexShrink: 1 }}>{x.entitlement}</T>
                  <Tag label={x.needs_fitting ? t('kit.needs_fitting') : t('kit.ready_to_collect')} color={x.needs_fitting ? c.paper : c.mint} />
                </View>
                <T size={13} color={c.mute}>{t('kit.qty_n', { n: x.qty })}{x.size ? ` · ${t('kit.size_n', { size: x.size })}` : ''} · {t('kit.due_on', { date: day(x.due_on) })}</T>
                {x.collect_at ? <T size={13}>{t('kit.collect_at', { venue: x.collect_at })}</T> : null}
                {x.collection_note ? <T size={13}>{x.collection_note}</T> : null}
                {x.pay_first ? <T size={12} color={c.mute}>{t('kit.pay_first_family')}</T> : null}
              </View>
            ))}
            {o.items.map((it) => (
              <View key={it.id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800" style={{ flexShrink: 1 }}>{it.item}{it.size_label ? ` · ${it.size_label}` : ''}</T><StatusTag s={it.status} /></View>
                <T size={12} color={c.mute}>{[it.issued_at ? t('kit.issued_on', { date: day(it.issued_at) }) : null, it.due_back_at ? t('kit.back_by', { date: day(it.due_back_at) }) : null].filter(Boolean).join(' · ')}</T>
                {it.overdue ? <Tag label={t('kit.return_overdue')} color={c.red} /> : null}
                {it.charge ? <T size={12}>{t('kit.fee_line', { amount: moneyIn(it.charge.amount_minor, it.charge.currency), status: it.charge.status === 'paid' ? t('kit.paid') : t('kit.to_pay') })}</T> : null}
                {it.deposit ? <T size={12}>{t('kit.deposit_line', { amount: moneyIn(it.deposit.amount_minor, it.deposit.currency), status: it.deposit.status === 'paid' ? t('kit.paid') : it.deposit.status === 'refunded' ? t('kit.refunded') : t('kit.to_pay') })}</T> : null}
                {['issued', 'returned', 'reserved'].includes(it.status) ? <Btn small title={t('kit.receipt')} color={c.paper} ink={c.ink} onPress={() => setRcpt(it.id)} accessibilityLabel={t('kit.receipt_a11y', { name: it.item })} style={{ alignSelf: 'flex-start' }} /> : null}
              </View>
            ))}
            {o.sizes.length ? <T size={12} color={c.mute}>{t('kit.sizes_on_file', { sizes: o.sizes.map((s) => `${s.slot.replace(/_/g, ' ')} ${s.size_label}`).join(' · ') })}</T> : null}
            {!o.to_collect.length && !o.items.length ? <Empty emoji="🎽" title={t('kit.family_empty_title')} sub={t('kit.family_empty_sub')} /> : null}
          </View>
        ))}
      </Block>
      <ReceiptSheet issueId={rcpt} onClose={() => setRcpt(null)} />
    </View>
  );
}
