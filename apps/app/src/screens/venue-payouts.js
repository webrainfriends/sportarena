// Venue payouts (benchmark gap 10): the one place a venue owner or manager sees how booking money turns into a payout — collected, refunds,
// platform commission and costs, paid out, on its way and the expected next payout. It only calls GET /me/venue-payouts (REST, OpenAPI and
// MCP share it) and opens the existing settlement statement; scope, masking and the draft rule are enforced on the server.
import React, { useEffect, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Seg, T, Tag } from '../ui';
import { MultiMenuField } from '../menu-field';
import { DateRangeField } from '../pickers';
import { SettlementView } from './partners';
import { c } from '../theme';
import { moneyIn, addDays } from '../vtime';

const label = (s) => String(s ?? '').replace(/_/g, ' ');
const PRESETS = [['30 days', 30], ['90 days', 90], ['12 months', 365]];
const today = () => new Date().toISOString().slice(0, 10);
const TONE = { paid: c.lime, approved: c.cyanSoft, open: c.sunSoft, void: c.violetSoft, done: c.lime, pending: c.sunSoft, manual: c.orangeSoft, failed: c.orangeSoft };

/** CSV leaves the device the way each platform expects: a download on the web, the share sheet on iOS, iPadOS and Android. */
async function sendCsv(name, text, toast) {
  if (Platform.OS === 'web') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click();
  } else await Share.share({ title: name, message: text });
  toast('Payout lines exported');
}

const Tile = ({ title, value, sub, tone }) => (
  <View accessible accessibilityLabel={`${title}: ${value}`} style={{ flexGrow: 1, flexBasis: 150, minHeight: 88, padding: 12, borderRadius: 16, backgroundColor: tone ?? c.paper, borderWidth: 1, borderColor: c.line, gap: 2 }}>
    <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{title.toUpperCase()}</T>
    <T size={22} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
    {sub ? <T size={12} color={c.mute}>{sub}</T> : null}
  </View>
);

export function VenuePayouts() {
  const { toast } = useSession();
  const [preset, setPreset] = useState(0);
  const [range, setRange] = useState(null); // custom { from, to }
  const [venueIds, setVenueIds] = useState([]);
  const [all, setAll] = useState([]);
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState(false);
  const from = range?.from ?? addDays(today(), -PRESETS[preset][1]);
  const to = range?.to ?? today();
  const r = useLoad(() => api.get('/me/venue-payouts', { from, to, detail: detail ? 'true' : undefined, venue_ids: venueIds.length ? venueIds.join(',') : undefined }), [from, to, venueIds.join(','), detail]);
  useEffect(() => { if (!venueIds.length && r.data?.venues) setAll(r.data.venues.map((v) => ({ value: v.id, label: `${v.emoji ?? ''} ${v.name}`.trim(), sub: v.currency }))); }, [r.data, venueIds.length]);
  const exportCsv = async () => { try { const x = await api.get('/me/venue-payouts', { from, to, format: 'csv', venue_ids: venueIds.length ? venueIds.join(',') : undefined }); await sendCsv(`payouts-${from}-${to}.csv`, x.csv, toast); } catch (e) { toast('' + e.message); } };
  const d = r.data;
  return (
    <Screen wide onRefresh={r.reload}>
      <H1 style={{ marginTop: 8 }}>Venue payouts</H1>
      <T color={c.mute} weight="700">From a booking to your bank: what was collected, what the platform keeps, what is refunded and when you are paid.</T>
      <Seg options={[...PRESETS.map(([l], value) => ({ value, label: l })), { value: -1, label: 'Pick dates' }]} value={range ? -1 : preset} onChange={(v) => { if (v === -1) setRange({ from, to }); else { setRange(null); setPreset(v); } }} color={c.cyan} />
      {range ? <DateRangeField label="Between" from={range.from} to={range.to} onChange={setRange} /> : null}
      {all.length > 1 ? <MultiMenuField label="Venues" title="Choose venues" value={venueIds} onChange={setVenueIds} options={all} placeholder="All my venues" /> : null}
      {r.loading && !d ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !d.venues.length ? (
        <Empty emoji="🏟️" title="No payouts to show" sub="Payouts appear for venues you own or manage. Once bookings are collected and settled, they show up here." />
      ) : <>
        {d.by_currency.map((t) => {
          const m = (n) => moneyIn(Number(n), t.currency);
          return (
            <Card key={t.currency}>
              <T weight="800" size={17}>{t.currency} · {t.venues} venue{t.venues === 1 ? '' : 's'} · {t.bookings} bookings</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
                <Tile title="Paid out" value={m(t.paid_cents)} tone={c.limeSoft} />
                <Tile title="On its way" value={m(t.on_its_way_cents)} sub="approved, not yet paid" tone={c.cyanSoft} />
                <Tile title="Collected" value={m(t.collected_cents)} sub={`${m(t.outstanding_cents)} still to collect`} />
                <Tile title="Platform commission" value={m(t.commission_cents)} sub={`payment costs ${m(t.payment_costs_cents)}`} />
                <Tile title="Refunds" value={m(t.refunds_owed_cents)} sub={`owed · ${m(t.refunds_done_cents)} handed back`} tone={Number(t.refunds_owed_cents) ? c.sunSoft : undefined} />
              </View>
            </Card>
          );
        })}
        <Section title="By venue" color={c.violet}>
          {d.venues.map((v) => (
            <Row key={v.id} title={`${v.emoji ?? ''} ${v.name}`.trim()} sub={[v.partner && `Partner ${v.partner}`, v.payout_account && `Bank ${v.payout_account}`, v.next_payout_on && `Next payout about ${v.next_payout_on}`].filter(Boolean).join(' · ') || `${v.bookings} bookings`}
              right={<T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{moneyIn(Number(v.collected_cents), v.currency)}</T>} />
          ))}
        </Section>
        <Section title="Settlements" color={c.mint}>
          {d.settlements.length ? d.settlements.map((s) => (
            <Row key={s.id} onPress={() => setOpen(s.id)} accessibilityLabel={`Open settlement ${s.settlement_no}`} title={`${s.settlement_no} · ${s.venue}`} sub={`Period to ${String(s.period_end).slice(0, 10)}${s.paid_at ? ` · paid ${String(s.paid_at).slice(0, 10)}` : ''}${s.payout_ref ? ` · ref ${s.payout_ref}` : ''}`}
              right={<View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{moneyIn(Number(s.net_payable_cents), s.currency)}</T><Tag label={label(s.status)} color={TONE[s.status]} /></View>} />
          )) : <Empty emoji="🧾" title="No settlements in this period" sub="A settlement appears here once the platform approves it. Drafts are never shown." />}
        </Section>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title={detail ? 'Hide invoice lines' : 'Show invoice lines'} color={c.paper} ink={c.ink} onPress={() => setDetail(!detail)} accessibilityLabel="Toggle invoice and credit note lines" />
          <Btn small title="Export CSV" color={c.cyan} ink={c.ink} onPress={exportCsv} accessibilityLabel="Export payout lines as CSV" />
        </View>
        {detail ? <Section title="Invoices and credit notes" color={c.pink}>
          {d.lines.length ? d.lines.map((l) => (
            <Row key={l.number} title={`${l.number} · ${l.venue}`} sub={`${l.issued_on} · ${l.settlement_no ? `paid out in ${l.settlement_no}` : l.kind === 'credit_note' ? 'credit note' : 'not settled yet'}`}
              right={<View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{l.kind === 'credit_note' ? '−' : ''}{moneyIn(Number(l.total_cents), l.currency)}</T><Tag label={label(l.refund_status ?? l.status)} color={TONE[l.refund_status ?? l.status]} /></View>} />
          )) : <Empty emoji="📄" title="No invoices in this period" />}
        </Section> : null}
      </>}
      <SettlementView id={open} onClose={() => setOpen(null)} onChanged={r.reload} />
    </Screen>
  );
}
