// Earnings: what a coach, physio/doctor or shop seller has earned from paid sales, what is held or on its way, and what has been paid out.
// "The customer paid" is shown as a status on each line; only a payout means the money reached the seller.
import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { saveExport } from '../open-file';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Seg, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateRangeField } from '../pickers';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { openPdf } from '../open-file';
import { t } from '../i18n';
import { locale } from '../locale';

const cash = (cents, cur) => moneyIn(Number(cents ?? 0), cur);
const when = (d) => (d ? new Date(d).toLocaleDateString(locale) : '');
const TONE = { processing: c.sunSoft, paid: c.lime, failed: c.pinkSoft, pending: c.sunSoft, verified: c.lime, rejected: c.pinkSoft };
const PAGE = 25;

const download = (name, text) => saveExport({ filename: name, content_type: 'text/csv', encoding: 'utf8', content: text });

const Line = ({ t, v, strong, sub }) => (
  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
    <View style={{ flex: 1 }}><T size={13} weight={strong ? '800' : '500'}>{t}</T>{sub ? <T size={11} color={c.mute}>{sub}</T> : null}</View>
    <T size={13} weight={strong ? '800' : '500'}>{v}</T>
  </View>
);

function CurrencyCard({ e, onAccount }) {
  const blockers = e.payout_blockers.filter((b) => b.code !== 'held');
  const needsAccount = blockers.some((b) => b.code === 'no_account');
  return (
    <Card color={c.limeSoft}>
      <T size={12} weight="700" color={c.mute}>{e.currency} · AVAILABLE TO PAY OUT</T>
      <T size={32} weight="800">{cash(e.available_cents, e.currency)}</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginVertical: 8 }}>
        <StatPill value={cash(e.net_earned_cents, e.currency)} label="Net earned" />
        <StatPill value={cash(e.payout_in_progress_cents, e.currency)} label="On its way" />
        <StatPill value={cash(e.paid_out_cents, e.currency)} label="Paid to you" />
      </View>
      {e.held_cents > 0 ? <T size={13} color={c.orange} weight="700">⏸ {cash(e.held_cents, e.currency)} is on hold while a payment is reviewed.</T> : null}
      {e.in_hold_period_cents > 0 ? <T size={13} color={c.mute}>{cash(e.in_hold_period_cents, e.currency)} becomes payable {e.next_release_at ? `from ${when(e.next_release_at)}` : 'after the hold period'}.</T> : null}
      <View style={{ gap: 4, marginTop: 8 }}>
        <Line t="Sales" v={cash(e.gross_cents, e.currency)} sub="what customers paid" />
        <Line t="Platform fee" v={`− ${cash(e.commission_cents, e.currency)}`} />
        <Line t="Refunds and lost disputes" v={`− ${cash(e.refunds_cents + e.chargebacks_cents, e.currency)}`} />
        <Line t="Net earned" v={cash(e.net_earned_cents, e.currency)} strong />
        {e.tax_included_cents ? <T size={11} color={c.mute}>Of your sales, {cash(e.tax_included_cents, e.currency)} is tax you collected for your own filing — it is not deducted here.</T> : null}
      </View>
      {blockers.length ? (
        <View style={{ marginTop: 10, gap: 4 }}>
          {blockers.map((b) => <T key={b.code} size={13} color={c.mute}>• {b.message}</T>)}
          {needsAccount || blockers.some((b) => b.code === 'account_pending') ? <Btn small title={needsAccount ? `Add my ${e.currency} bank account` : 'Review my bank account'} onPress={() => onAccount(e.currency)} style={{ alignSelf: 'flex-start', marginTop: 4 }} /> : null}
        </View>
      ) : <T size={13} color={c.lime} weight="700" style={{ marginTop: 8 }}>✓ Your bank account is verified. The platform team sends payouts.</T>}
      {!e.reconciles ? <T size={12} color={c.red} weight="700" style={{ marginTop: 6 }}>These totals do not add up — contact support before relying on them.</T> : null}
    </Card>
  );
}

export function Earnings({ navigation }) {
  const { toast } = useSession();
  const e = useLoad(() => api.get('/me/earnings'), []);
  const accounts = useLoad(() => api.get('/me/payout-accounts'), []);
  const payouts = useLoad(() => api.get('/me/payouts', { limit: 10 }), []);
  const items = useLoad(() => api.get('/me/payout-items', { limit: 20 }), []);
  const sellerStatus = useLoad(() => api.get('/me/seller-status'), []);
  const trend = useLoad(() => api.get('/me/earnings/trend', { weeks: 12 }), []);
  const [cur, setCur] = useState(null);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState([]);
  const entries = useLoad(() => api.get('/me/earnings/entries', { limit: PAGE, ...(cur ? { currency: cur } : {}) }), [cur]);
  const [form, setForm] = useState(null);
  const [range, setRange] = useState(false);
  const [taxRange, setTaxRange] = useState({ from: null, to: null });
  const [taxDownloading, setTaxDownloading] = useState(false);
  const [taxRangeOpen, setTaxRangeOpen] = useState(false);

  const reload = () => { e.reload(); accounts.reload(); payouts.reload(); entries.reload(); sellerStatus.reload(); trend.reload(); setMore([]); setOffset(0); };

  const handleInstantPay = async (currency) => {
    try {
      const key = `instant-${currency}-${Date.now()}`;
      await api.post('/me/instant-payout', { currency, idempotency_key: key });
      toast(t('earnings.instant_requested'));
      reload();
    } catch (x) { toast(x.message); }
  };

  const handleTaxDownload = async (format) => {
    if (!taxRange.from || !taxRange.to) { toast(t('earnings.tax_select_range')); return; }
    setTaxDownloading(true);
    try {
      const r = await api.get('/me/tax-summary/download', { from: taxRange.from, to: taxRange.to, currency: cur ?? (e.data?.currencies?.[0]?.currency ?? 'USD'), format });
      if (format === 'csv') await download(r.filename, r.csv);
      else await openPdf(`/me/tax-summary/download?from=${taxRange.from}&to=${taxRange.to}&currency=${cur ?? ''}&format=pdf`, r.filename).catch((x) => toast(x.message));
    } catch (x) { toast(x.message); }
    finally { setTaxDownloading(false); }
  };
  const loadMore = async () => {
    try { const next = offset + PAGE; const rows = await api.get('/me/earnings/entries', { limit: PAGE, offset: next, ...(cur ? { currency: cur } : {}) }); setMore((m) => [...m, ...rows]); setOffset(next); } catch (x) { toast(x.message); }
  };

  if (e.loading && !e.data) return <Screen><Loading /></Screen>;
  if (e.error) return <Screen><ErrorBox error={e.error} onRetry={e.reload} /></Screen>;
  const d = e.data;
  const supported = d.supported_currencies;
  const rows = [...(entries.data ?? []), ...more];
  const nothing = !d.currencies.length && !d.venues.length;
  const trendData = trend.data?.trend ?? {};

  return (
    <Screen onRefresh={reload}>
      <H1 style={{ marginTop: 8 }}>{t('earnings.title')}</H1>
      <T color={c.mute} weight="600">{t('earnings.subtitle')}</T>

      {sellerStatus.data?.any_pending && (
        <Card style={{ backgroundColor: c.sunSoft, padding: 16, borderRadius: 14, marginTop: 10, gap: 8 }}>
          <T weight="800" size={14}>{t('earnings.gate_title')}</T>
          <T size={13} color={c.mute}>{t('earnings.gate_body')}</T>
          <Btn small title={t('earnings.gate_cta')} onPress={() => navigation?.navigate?.('SellerOnboarding')} style={{ alignSelf: 'flex-start', marginTop: 4 }} accessibilityLabel={t('earnings.gate_cta')} />
        </Card>
      )}

      {d.attention.map((a) => (
        <Card key={a.payout_id} color={c.pinkSoft} style={{ marginTop: 10 }}>
          <T weight="800">⚠️ A payout of {cash(a.amount_cents, a.currency)} could not be completed</T>
          <T size={13}>{a.title}.</T>
          <T size={13} color={c.mute}>{a.next_step}</T>
          <Btn small title="Update my bank account" onPress={() => setForm(a.currency)} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        </Card>
      ))}
      <View style={{ gap: 12, marginTop: 12 }}>
        {d.currencies.map((x) => {
          const weeks = trendData[x.currency] ?? [];
          const maxVal = weeks.reduce((m, w) => Math.max(m, w.net_cents), 1);
          const statusRow = sellerStatus.data?.currencies?.find((s) => s.currency === x.currency);
          return (
            <Card key={x.currency} color={c.limeSoft}>
              <T size={12} weight="700" color={c.mute}>{x.currency} · AVAILABLE TO PAY OUT</T>
              <T size={32} weight="800">{cash(x.available_cents, x.currency)}</T>
              {weeks.length > 0 && (
                <View style={{ flexDirection: 'row', height: 32, gap: 2, alignItems: 'flex-end', marginVertical: 6 }} accessibilityLabel={t('earnings.trend_label')}>
                  {weeks.map((w, i) => {
                    const h = Math.max(2, (Math.max(w.net_cents, 0) / maxVal) * 32);
                    return <View key={i} style={{ flex: 1, height: h, borderRadius: 2, backgroundColor: w.net_cents >= 0 ? c.lime : c.pinkSoft }} />;
                  })}
                </View>
              )}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginVertical: 8 }}>
                <StatPill value={cash(x.net_earned_cents, x.currency)} label="Net earned" />
                <StatPill value={cash(x.payout_in_progress_cents, x.currency)} label="On its way" />
                <StatPill value={cash(x.paid_out_cents, x.currency)} label="Paid to you" />
              </View>
              {x.held_cents > 0 ? <T size={13} color={c.orange} weight="700">⏸ {cash(x.held_cents, x.currency)} is on hold while a payment is reviewed.</T> : null}
              {x.in_hold_period_cents > 0 ? <T size={13} color={c.mute}>{cash(x.in_hold_period_cents, x.currency)} becomes payable {x.next_release_at ? `from ${when(x.next_release_at)}` : 'after the hold period'}.</T> : null}
              <View style={{ gap: 4, marginTop: 8 }}>
                <Line t="Sales" v={cash(x.gross_cents, x.currency)} sub="what customers paid" />
                <Line t="Platform fee" v={`− ${cash(x.commission_cents, x.currency)}`} />
                <Line t="Refunds and lost disputes" v={`− ${cash(x.refunds_cents + x.chargebacks_cents, x.currency)}`} />
                <Line t="Net earned" v={cash(x.net_earned_cents, x.currency)} strong />
                {x.tax_included_cents ? <T size={11} color={c.mute}>Of your sales, {cash(x.tax_included_cents, x.currency)} is tax you collected for your own filing — it is not deducted here.</T> : null}
              </View>
              {(() => {
                const blockers = x.payout_blockers?.filter((b) => b.code !== 'held') ?? [];
                const needsAccount = blockers.some((b) => b.code === 'no_account');
                return blockers.length ? (
                  <View style={{ marginTop: 10, gap: 4 }}>
                    {blockers.map((b) => <T key={b.code} size={13} color={c.mute}>• {b.message}</T>)}
                    {needsAccount || blockers.some((b) => b.code === 'account_pending') ? <Btn small title={needsAccount ? `Add my ${x.currency} bank account` : 'Review my bank account'} onPress={() => setForm(x.currency)} style={{ alignSelf: 'flex-start', marginTop: 4 }} /> : null}
                    {blockers.some((b) => b.code === 'terms_pending') ? <Btn small title={t('earnings.gate_cta')} onPress={() => navigation?.navigate?.('SellerOnboarding')} style={{ alignSelf: 'flex-start', marginTop: 4 }} /> : null}
                  </View>
                ) : (
                  <View style={{ marginTop: 8, gap: 6 }}>
                    <T size={13} color={c.lime} weight="700">✓ Your bank account is verified. The platform team sends payouts.</T>
                    {statusRow?.instant_eligible && (
                      <Btn small title={t('earnings.instant_pay')} color={c.lime} onPress={() => handleInstantPay(x.currency)} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t('earnings.instant_pay')} />
                    )}
                  </View>
                );
              })()}
              {!x.reconciles ? <T size={12} color={c.red} weight="700" style={{ marginTop: 6 }}>These totals do not add up — contact support before relying on them.</T> : null}
            </Card>
          );
        })}
      </View>
      {nothing ? <Empty emoji="💰" title="No earnings yet" sub="When a customer pays for your coaching, appointments or shop items, the sale shows up here with its fee and payout status." /> : null}
      {d.platform_fee_percent ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Platform fee on sales: {d.platform_fee_percent}%{d.hold_days ? ` · sales become payable after ${d.hold_days} days` : ''}.</T> : null}

      {d.venues.length ? (
        <Section title="Venue settlements" color={c.cyan}>
          <T size={12} color={c.mute}>Venue money is settled through your partner contract.</T>
          {d.venues.map((v) => <Row key={`${v.venue_id}${v.currency}`} title={v.venue} sub={`Sales ${cash(v.sales_cents, v.currency)} · commission ${cash(v.commission_cents, v.currency)}`} right={<View style={{ alignItems: 'flex-end' }}><T weight="800" size={13}>Paid {cash(v.paid_cents, v.currency)}</T><T size={11} color={c.mute}>Due {cash(v.due_cents, v.currency)}</T></View>} />)}
        </Section>
      ) : null}

      <Section title="Bank accounts" color={c.violet} action={d.currencies.length || nothing ? 'Add or replace' : undefined} onAction={() => setForm(supported[0])}>
        {accounts.data?.length ? accounts.data.filter((a) => a.status !== 'superseded').map((a) => (
          <Row key={a.id} title={`${a.currency} account ending ${a.last4}`} sub={a.status === 'rejected' && a.decision_reason ? a.decision_reason : a.status === 'pending' ? 'Waiting for the platform team to verify it' : 'Used for payouts'}
            right={<Tag label={a.status} color={TONE[a.status]} />} />
        )) : <T size={13} color={c.mute}>No bank account yet. Add one so the platform team can pay you.</T>}
      </Section>

      <Section title="Payouts" color={c.lime}>
        {payouts.data?.length ? payouts.data.map((p) => (
          <Row key={p.id} title={cash(p.amount_cents, p.currency)} sub={p.status === 'paid' ? `Sent ${when(p.decided_at)} · ref ${p.reference}` : p.status === 'failed' ? `${p.explanation.title}. ${p.explanation.next_step}` : `Started ${when(p.created_at)} · on its way`}
            right={<Tag label={p.status} color={TONE[p.status]} />} />
        )) : <T size={13} color={c.mute}>No payouts yet.</T>}
      </Section>

      {(items.data ?? []).filter((i) => i.source_type !== 'provider_balance').length ? (
        <Section title={t('payout.to_you')} color={c.mint}>
          {(items.data ?? []).filter((i) => i.source_type !== 'provider_balance').map((i) => (
            <Row key={i.id} title={cash(i.net_minor, i.currency)} sub={`${t(`payout.source_${i.source_type}`)} · ${t('payout.gross')} ${cash(i.gross_minor, i.currency)}${Number(i.tax_minor) ? ` · ${t('payout.withheld')} ${cash(i.tax_minor, i.currency)}` : ''}${i.reference ? ` · ${i.reference}` : ''}`}
              right={i.status === 'paid' ? <Btn small title={t('payout.statement')} color={c.violet} accessibilityLabel={t('payout.statement')} onPress={() => openPdf(`/payout-items/${i.id}/statement.pdf`, 'payout-statement').catch((x) => toast(x.message))} /> : <Tag label={t(`payout.status_${i.status}`)} color={TONE[i.status]} />} />
          ))}
        </Section>
      ) : null}

      <Section title="Statement" color={c.sun} action="Export CSV" onAction={() => setRange(true)}>
        {d.currencies.length > 1 ? <Seg options={[{ value: null, label: 'All' }, ...d.currencies.map((x) => ({ value: x.currency, label: x.currency }))]} value={cur} onChange={(v) => { setCur(v); setMore([]); setOffset(0); }} /> : null}
        {entries.loading && !entries.data ? <Loading /> : entries.error ? <ErrorBox error={entries.error} onRetry={entries.reload} /> : rows.length ? rows.map((l) => (
          <Row key={l.id} title={l.label} sub={`${new Date(l.created_at).toLocaleString(locale)}${l.payment_status ? ` · customer payment ${l.payment_status}` : ''}${l.available_at && new Date(l.available_at) > new Date() ? ` · payable from ${when(l.available_at)}` : ''}`}
            right={<T weight="800" color={Number(l.amount_cents) < 0 ? c.ink : c.lime}>{Number(l.amount_cents) < 0 ? '−' : '+'}{cash(Math.abs(Number(l.amount_cents)), l.currency)}</T>} />
        )) : <T size={13} color={c.mute}>No lines yet.</T>}
        {rows.length >= PAGE && rows.length % PAGE === 0 ? <Btn small title="Load more" color={c.paper} ink={c.ink} onPress={loadMore} style={{ alignSelf: 'center' }} /> : null}
      </Section>

      <Section title={t('earnings.tax_title')} color={c.violet}>
        <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('earnings.tax_subtitle')}</T>
        <DateRangeField value={taxRange} onChange={setTaxRange} />
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <Btn small title={t('earnings.tax_csv')} onPress={() => handleTaxDownload('csv')} style={{ flex: 1 }} disabled={taxDownloading} accessibilityLabel={t('earnings.tax_csv')} />
          <Btn small title={t('earnings.tax_pdf')} onPress={() => handleTaxDownload('pdf')} style={{ flex: 1 }} disabled={taxDownloading} accessibilityLabel={t('earnings.tax_pdf')} />
        </View>
      </Section>

      <FormSheet visible={!!form} onClose={() => setForm(null)} title="Bank account for payouts" submitLabel="Save for verification"
        initial={{ currency: typeof form === 'string' ? form : supported[0] }}
        fields={[
          { key: 'currency', label: 'Currency', type: 'chips', options: supported },
          { key: 'holder_name', label: 'Account holder name', hint: 'Use the name on your profile or registered business — a different name delays verification.' },
          { key: 'account_number', label: 'Account number or IBAN', type: 'secret' },
          { key: 'bank_code', label: 'Bank code (IFSC, sort code, SWIFT/BIC or routing number)' },
        ]}
        onSubmit={async (v) => { await api.post('/me/payout-accounts', v); reload(); return 'Saved. The platform team will verify it before sending a payout.'; }} />
      <FormSheet visible={range} onClose={() => setRange(false)} title="Export statement" submitLabel="Export CSV"
        fields={[{ key: 'from', toKey: 'to', label: 'Period', type: 'daterange', optional: true }]}
        onSubmit={async (v) => {
          const r = await api.get('/me/earnings/export', { ...(v.from ? { from: v.from } : {}), ...(v.to ? { to: v.to } : {}), ...(cur ? { currency: cur } : {}) });
          await download(r.filename, r.csv); return `${r.rows} lines exported`;
        }} />
    </Screen>
  );
}
