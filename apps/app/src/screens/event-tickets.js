// Spectator ticketing (#480), one file for its three audiences. Everyone: TicketShop (buy) and MyTickets (QR, transfer, refund). The organiser: TicketsTab
// inside the event console (products, capacity and rules, complimentary allocations, find, report). Gate staff scan with the existing GateScan, which now
// understands ticket QR codes as well as badges. All rules live in the API (src/capabilities/ticketing.js); this only calls it.
import React, { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Share, TextInput, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useDo } from './console-utils';
import { A, ABar, ABtn, ACard, AEmpty, ARow, ASection, AStat, AT, ATabs, ATag, ReasonSheet } from '../arena';
import { FormSheet } from '../FormSheet';
import { PaySheet } from '../PaySheet';
import { AccessPoints } from '../access-ui';
import { Btn, Card, Chip, Empty, ErrorBox, GradCard, Loading, Screen, Sheet, T } from '../ui';
import { Counter } from '../pickers';
import { c } from '../theme';
import { locale } from '../locale';
import { moneyIn } from '../vtime';
import { t } from '../i18n';
import { QrCode } from './passport';
import { CameraScan, hasCamera } from '../camera-scan';
import { makeStore } from '../offline-store';

const stamp = (d) => (d ? new Date(d).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const key = () => `tix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const CLASSES = ['adult', 'youth', 'concession', 'vip', 'complimentary', 'other'];
const className = (cls, label) => (cls === 'other' && label ? label : t(`tix.class.${cls}`));
const AVAIL_TONE = { available: A.green, low: A.sun, sold_out: A.red, not_started: A.cyan, ended: A.mute, paused: A.orange };

// ---- buy ------------------------------------------------------------------------------------------------------------------------------------------

/** A seat grid for reserved seating: rows by seats, 44pt touch targets, taken seats disabled, exactly `need` to choose. */
function SeatSheet({ product, need, value, onClose, onChange }) {
  const map = useLoad(() => (product ? api.get(`/ticket-products/${product.id}/seats`) : Promise.resolve(null)), [product?.id]);
  const s = map.data?.section;
  const taken = new Set(map.data?.taken ?? []);
  const rows = s ? Array.from({ length: s.rows_count }, (_, r) => String.fromCharCode(65 + (r % 26)).repeat(1 + Math.floor(r / 26))) : [];
  const toggle = (lbl) => onChange(value.includes(lbl) ? value.filter((x) => x !== lbl) : value.length < need ? [...value, lbl] : [...value.slice(1), lbl]);
  return (
    <Sheet visible={!!product} onClose={onClose} title={t('tix.choose_seats', { n: need })}
      footer={<Btn title={t('common.done')} onPress={onClose} disabled={value.length !== need} />}>
      {!map.data ? <Loading /> : (
        <View style={{ gap: 6 }}>
          <T size={13} color={c.mute}>{s.name} · {t('tix.seats_taken_grey')}</T>
          {rows.map((row) => (
            <View key={row} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <T size={13} weight="800" style={{ width: 24 }}>{row}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, flex: 1 }}>
                {Array.from({ length: s.seats_per_row }, (_, n) => `${row}${n + 1}`).map((lbl) => {
                  const on = value.includes(lbl), off = taken.has(lbl);
                  return (
                    <Pressable key={lbl} disabled={off} onPress={() => toggle(lbl)} accessibilityRole="button" accessibilityState={{ selected: on, disabled: off }} accessibilityLabel={`${t('tix.seat')} ${lbl}${off ? `, ${t('tix.taken')}` : ''}`}
                      style={{ width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.violet : off ? c.line : c.paper, borderWidth: 1, borderColor: on ? c.violet : c.line, opacity: off ? 0.5 : 1 }}>
                      <T size={11} weight="800" color={on ? '#fff' : c.ink}>{lbl}</T>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      )}
    </Sheet>
  );
}

export function TicketShop({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const page = useLoad(() => api.get(`/public/events/${id}`), [id]);
  const offer = useLoad(() => api.get(`/public/events/${id}/tickets`), [id]);
  const [qty, setQty] = useState({}), [seats, setSeats] = useState({}), [seatFor, setSeatFor] = useState(null), [pay, setPay] = useState(null), [busy, setBusy] = useState(false);
  const idem = useRef(key());
  const products = offer.data?.products ?? [];
  const chosen = products.filter((p) => (qty[p.id] ?? 0) > 0);
  const cur = chosen[0]?.currency;
  const total = chosen.reduce((n, p) => n + p.price_minor * qty[p.id], 0);
  const seatsOk = chosen.every((p) => p.seating !== 'reserved' || (seats[p.id] ?? []).length === qty[p.id]);
  const set = (p, n) => { idem.current = key(); setQty((q) => ({ ...q, [p.id]: n })); setSeats((s) => ({ ...s, [p.id]: (s[p.id] ?? []).slice(0, n) })); };
  const reserve = async () => {
    setBusy(true);
    try {
      const o = await api.post(`/events/${id}/ticket-orders`, { idempotency_key: idem.current, lines: chosen.map((p) => ({ product_id: p.id, quantity: qty[p.id], seats: p.seating === 'reserved' ? seats[p.id] : undefined })) });
      if (o.pay) setPay({ id: o.id, type: 'ticket_order', label: `${page.data?.event?.name ?? ''} · ${t('tix.tickets')}`, amount: o.total_minor, currency: o.currency });
      else { toast(t('tix.ready')); push('MyTickets', {}); }
    } catch (x) { toast('' + x.message); offer.reload(); } finally { setBusy(false); }
  };
  if (offer.error) return <Screen><ErrorBox error={offer.error} onRetry={offer.reload} /></Screen>;
  if (!offer.data) return <Screen><Loading /></Screen>;
  return (
    <Screen>
      <T size={13} color={c.mute}>{page.data?.event?.name}</T>
      <T size={26} weight="800">{t('tix.get_tickets')}</T>
      {!products.length ? <Empty emoji="🎟️" title={t('tix.none_on_sale')} sub={t('tix.none_on_sale_sub')} /> : products.map((p) => {
        const sellable = ['available', 'low'].includes(p.availability);
        const clash = cur && p.currency !== cur && !(qty[p.id] > 0);
        const max = Math.min(p.per_order_limit, p.remaining ?? p.per_order_limit);
        return (
          <Card key={p.id} style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <T size={17} weight="800">{p.name}</T>
                <T size={13} color={c.mute}>{className(p.class, p.class_label)}{p.kind === 'pass' ? ` · ${t('tix.pass')}` : ''}{p.seating === 'reserved' ? ` · ${t('tix.reserved_seat')}` : ''}</T>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <T size={20} weight="800">{p.price_minor ? moneyIn(p.price_minor, p.currency) : t('tix.free')}</T>
                <T size={12} color={AVAIL_TONE[p.availability]} weight="800">{t(`tix.avail.${p.availability}`)}{p.remaining != null ? ` · ${t('tix.left', { n: p.remaining })}` : ''}</T>
              </View>
            </View>
            {p.fixtures.length ? <T size={13} color={c.mute}>{p.fixtures.slice(0, 3).map((f) => `${f.label} · ${stamp(f.scheduled_at)}`).join('\n')}{p.fixtures.length > 3 ? `\n${t('tix.and_more', { n: p.fixtures.length - 3 })}` : ''}</T> : <T size={13} color={c.mute}>{t('tix.whole_event')}</T>}
            {p.sale_ends_at && sellable ? <T size={12} color={c.mute}>{t('tix.sale_ends', { when: stamp(p.sale_ends_at) })}</T> : null}
            {p.availability === 'not_started' && p.sale_starts_at ? <T size={12} color={c.mute}>{t('tix.sale_starts', { when: stamp(p.sale_starts_at) })}</T> : null}
            {sellable ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <View style={{ minWidth: 190, flexShrink: 1 }}><Counter value={qty[p.id] ?? 0} onChange={(n) => set(p, n)} min={0} max={max} label={t('tix.tickets')} /></View>
                {clash ? <T size={12} color={c.mute}>{t('tix.one_currency')}</T> : null}
                {p.seating === 'reserved' && (qty[p.id] ?? 0) > 0 ? <Btn small title={(seats[p.id] ?? []).length === qty[p.id] ? (seats[p.id] ?? []).join(', ') : t('tix.choose_seats', { n: qty[p.id] })} color={c.paper} ink={c.ink} onPress={() => setSeatFor(p)} /> : null}
              </View>
            ) : null}
          </Card>
        );
      })}
      {chosen.length ? (
        <Card style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={15} weight="800">{t('tix.total')}</T><T size={20} weight="800">{total ? moneyIn(total, cur) : t('tix.free')}</T></View>
          <T size={12} color={c.mute}>{t('tix.hold_note')}</T>
          <Btn title={total ? t('tix.reserve_pay') : t('tix.get_free')} onPress={reserve} loading={busy} disabled={!seatsOk} accessibilityLabel={t('tix.reserve_pay')} />
        </Card>
      ) : null}
      <SeatSheet product={seatFor} need={seatFor ? qty[seatFor.id] ?? 0 : 0} value={seatFor ? seats[seatFor.id] ?? [] : []} onClose={() => setSeatFor(null)} onChange={(v) => { idem.current = key(); setSeats((s) => ({ ...s, [seatFor.id]: v })); }} />
      {pay ? <PaySheet target={pay} onClose={() => { setPay(null); offer.reload(); }} onDone={() => { setQty({}); push('MyTickets', {}); }} /> : null}
    </Screen>
  );
}

// ---- my tickets -------------------------------------------------------------------------------------------------------------------------------------

const STATE_TONE = { valid: c.green, reserved: c.sun, refund_due: c.sun, refunded: c.mute, void: c.red, transferred: c.mute };

function TicketCard({ k, onChanged }) {
  const { toast } = useSession();
  const [transfer, setTransfer] = useState(false), [refund, setRefund] = useState(false), [share, setShare] = useState(null);
  const live = k.state === 'valid' && k.token;
  const act = async (fn, msg) => { try { await fn(); toast(msg); onChanged(); } catch (x) { toast('' + x.message); } };
  const send = async (code) => {
    const text = t('tix.claim_message', { code });
    if (Platform.OS === 'web') { try { await navigator.clipboard.writeText(text); toast(t('tix.copied')); } catch { toast(text); } } else await Share.share({ message: text });
  };
  return (
    <GradCard colors={[k.class === 'vip' ? '#B8860B' : c.violet, '#2A2D3A']} pad={18} style={{ gap: 10 }}>
      <T size={11} weight="800" color="rgba(255,255,255,0.85)" style={{ letterSpacing: 1.4 }}>{String(k.event.name).toUpperCase()}</T>
      <T size={24} weight="800" color="#fff">{k.product.name}</T>
      <T size={14} color="#fff">{className(k.class, k.class_label)}{k.section ? ` · ${k.section}` : ''}{k.seat ? ` · ${t('tix.seat')} ${k.seat}` : ''}</T>
      {k.fixtures.slice(0, 2).map((f) => <T key={f.id} size={13} color="rgba(255,255,255,0.9)">{f.label} · {stamp(f.scheduled_at)}</T>)}
      {k.fixtures.length > 2 ? <T size={12} color="rgba(255,255,255,0.8)">{t('tix.and_more', { n: k.fixtures.length - 2 })}</T> : null}
      {live ? (
        <View style={{ alignItems: 'center', gap: 6, marginVertical: 4 }}>
          <QrCode value={k.token} size={Platform.OS === 'web' ? 210 : 230} label={t('tix.qr_label', { name: k.product.name })} />
          <T size={14} weight="800" color="#fff" style={{ letterSpacing: 2 }} accessibilityLabel={t('tix.code_label')}>{k.short_code}</T>
          {k.used ? <T size={13} weight="800" color="#FBBF24">{k.inside ? t('tix.inside') : t('tix.used')}</T> : null}
        </View>
      ) : <View style={{ alignSelf: 'flex-start', borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 12, paddingVertical: 6 }}><T size={13} weight="800" color="#fff">{t(`tix.state.${k.state}`)}</T></View>}
      {live ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Btn small title={t('tix.transfer')} color="rgba(255,255,255,0.18)" ink="#fff" onPress={() => (k.can_transfer ? setTransfer(true) : toast(k.transfer_blocked))} accessibilityLabel={t('tix.transfer')} />
          <Btn small title={t('tix.new_qr')} color="rgba(255,255,255,0.18)" ink="#fff" onPress={() => act(() => api.post(`/tickets/${k.id}/reissue`, { token_version: undefined }), t('tix.new_qr_done'))} accessibilityLabel={t('tix.new_qr')} />
          <Btn small title={t('tix.refund')} color="rgba(255,255,255,0.18)" ink="#fff" onPress={() => (k.can_refund ? setRefund(true) : toast(k.refund_blocked))} accessibilityLabel={t('tix.refund')} />
        </View>
      ) : null}
      {live && (k.transfer_blocked || k.refund_blocked) ? <T size={12} color="rgba(255,255,255,0.75)">{[k.transfer_blocked, k.refund_blocked].filter(Boolean).join(' · ')}</T> : null}
      {k.state === 'refund_due' ? <T size={12} color="rgba(255,255,255,0.85)">{t('tix.refund_pending')}</T> : null}
      <FormSheet visible={transfer} onClose={() => setTransfer(false)} title={t('tix.transfer_title')} submitLabel={t('tix.transfer')} initial={{ mode: 'account' }}
        fields={[
          { key: 'mode', label: t('tix.give_to'), type: 'chips', options: [{ value: 'account', label: t('tix.someone_on_app') }, { value: 'guest', label: t('tix.a_guest') }] },
          { key: 'to', label: t('tix.recipient'), type: 'entity', entityKind: 'person', noun: t('tix.recipient'), show: (v) => v.mode === 'account' },
          { key: 'guest_name', label: t('tix.guest_name'), show: (v) => v.mode === 'guest' },
          { key: 'guest_email', label: t('tix.guest_email'), type: 'email', optional: true, show: (v) => v.mode === 'guest', hint: t('tix.guest_private') },
        ]}
        onSubmit={async (v) => {
          const r = await api.post(`/tickets/${k.id}/transfer`, v.mode === 'account' ? { to_user_id: v.to } : { guest: { name: v.guest_name, email: v.guest_email || undefined } });
          onChanged(); if (r.claim_code) setShare(r.claim_code); else toast(t('tix.transferred'));
          return null;
        }} />
      <Sheet visible={refund} onClose={() => setRefund(false)} title={t('tix.refund_title')}
        footer={<Btn title={t('tix.refund_confirm')} onPress={() => { setRefund(false); act(() => api.post(`/tickets/${k.id}/refund`, {}), t('tix.refund_started')); }} />}>
        <T>{t('tix.refund_body', { amount: moneyIn(k.price_minor, k.currency) })}</T>
      </Sheet>
      <Sheet visible={!!share} onClose={() => setShare(null)} title={t('tix.claim_title')} footer={<Btn title={t('tix.share_code')} onPress={() => send(share)} />}>
        <T>{t('tix.claim_body')}</T>
        <T size={26} weight="800" style={{ letterSpacing: 3, textAlign: 'center', marginTop: 10 }} selectable>{share}</T>
      </Sheet>
    </GradCard>
  );
}

export function MyTickets() {
  const mine = useLoad(() => api.get('/me/tickets', { scope: 'all', limit: 100 }), []);
  const [claim, setClaim] = useState(false);
  const items = mine.data?.items ?? [];
  return (
    <Screen refreshing={false} onRefresh={mine.reload}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <T size={26} weight="800">{t('tix.my_tickets')}</T>
        <Btn small title={t('tix.have_code')} color={c.paper} ink={c.ink} onPress={() => setClaim(true)} accessibilityLabel={t('tix.have_code')} />
      </View>
      {mine.error ? <ErrorBox error={mine.error} onRetry={mine.reload} /> : !mine.data ? <Loading /> : items.length
        ? items.map((k) => <TicketCard key={k.id} k={k} onChanged={mine.reload} />)
        : <Empty emoji="🎟️" title={t('tix.no_tickets')} sub={t('tix.no_tickets_sub')} />}
      <FormSheet visible={claim} onClose={() => setClaim(false)} title={t('tix.have_code')} submitLabel={t('tix.claim')} fields={[{ key: 'code', label: t('tix.claim_code'), hint: t('tix.claim_hint') }]}
        onSubmit={async (v) => { await api.post('/tickets/claim', { code: v.code }); mine.reload(); return null; }} />
    </Screen>
  );
}

// ---- organiser: the Tickets tab ---------------------------------------------------------------------------------------------------------------

const SUBS = ['overview', 'products', 'rules', 'comps', 'find'];

function ProductForm({ visible, onClose, p, id, e, fixtures, sections, onDone }) {
  const edit = !!p?.id;
  const initial = edit
    ? { ...p, tax_pct: p.tax_bp / 100, sale_starts_at: p.sale_starts_at ?? undefined, sale_ends_at: p.sale_ends_at ?? undefined, access_point_ids: p.access_point_ids ?? [], fixture_ids: p.fixture_ids ?? [] }
    : { kind: 'single', class: 'adult', seating: 'general', currency: 'GBP', tax_pct: 0, tax_inclusive: true, per_order_limit: 10, per_account_limit: 10, channels: ['online'], transferable: true, reentry: 'single', access_point_ids: [], fixture_ids: [] };
  const points = useLoad(() => (visible ? api.get('/access/points', { event_id: id }).catch(() => []) : Promise.resolve([])), [visible, id]);
  return (
    <FormSheet visible={visible} onClose={onClose} title={edit ? t('tix.edit_product') : t('tix.new_product')} submitLabel={edit ? t('common.save') : t('tix.create')} initial={initial}
      fields={[
        { key: 'name', label: t('tix.product_name') },
        { key: 'kind', label: t('tix.kind'), type: 'chips', options: [{ value: 'single', label: t('tix.kind_single') }, { value: 'pass', label: t('tix.pass') }] },
        { key: 'class', label: t('tix.class_label'), type: 'chips', options: CLASSES.map((x) => ({ value: x, label: t(`tix.class.${x}`) })) },
        { key: 'class_label', label: t('tix.custom_class'), optional: true, show: (v) => v.class === 'other' },
        { key: 's1', type: 'section', label: t('tix.what_it_admits') },
        { key: 'fixture_ids', label: t('tix.fixtures'), type: 'multi', optional: true, options: fixtures, hint: t('tix.fixtures_hint') },
        { key: 'seating', label: t('tix.seating'), type: 'chips', options: [{ value: 'general', label: t('tix.general') }, { value: 'reserved', label: t('tix.reserved_seat') }] },
        { key: 'section_id', label: t('tix.section'), type: 'chips', options: sections, show: (v) => v.seating === 'reserved', hint: sections.length ? undefined : t('tix.add_section_first') },
        { key: 's2', type: 'section', label: t('tix.price') },
        { key: 'currency', label: t('tix.currency'), type: 'currency', default: 'GBP' },
        { key: 'price_minor', label: t('tix.price_each'), type: 'money', currency: (v) => v.currency || 'GBP', optional: true },
        { key: 'tax_pct', label: t('tix.tax'), type: 'stepper', min: 0, max: 100, suffix: '%' },
        { key: 'tax_inclusive', label: t('tix.tax_inclusive'), type: 'switch' },
        { key: 's3', type: 'section', label: t('tix.selling') },
        { key: 'sale_starts_at', label: t('tix.sale_opens'), type: 'datetime', optional: true },
        { key: 'sale_ends_at', label: t('tix.sale_closes'), type: 'datetime', optional: true },
        { key: 'allocation', label: t('tix.allocation'), type: 'number', optional: true, hint: t('tix.allocation_hint') },
        { key: 'per_order_limit', label: t('tix.per_order'), type: 'stepper', min: 1, max: 100 },
        { key: 'per_account_limit', label: t('tix.per_account'), type: 'stepper', min: 1, max: 1000 },
        { key: 'channels', label: t('tix.channels'), type: 'multi', options: ['online', 'box_office', 'partner', 'complimentary'].map((x) => ({ value: x, label: t(`tix.channel.${x}`) })) },
        { key: 's4', type: 'section', label: t('tix.at_the_gate') },
        { key: 'transferable', label: t('tix.transferable'), type: 'switch' },
        { key: 'reentry', label: t('tix.reentry'), type: 'choice', options: [{ value: 'single', label: t('tix.one_entry') }, { value: 'reentry', label: t('tix.reentry_allowed') }] },
        { key: 'access_point_ids', label: t('tix.gates'), type: 'multi', optional: true, options: (points.data ?? []).map((g) => ({ value: g.id, label: g.name })), hint: t('tix.gates_hint') },
      ]}
      onSubmit={async (v) => {
        const body = {
          name: v.name, kind: v.kind, class: v.class, class_label: v.class === 'other' ? v.class_label || null : null, fixture_ids: v.fixture_ids ?? [], seating: v.seating, section_id: v.seating === 'reserved' ? v.section_id || null : null,
          currency: v.currency, price_minor: Number(v.price_minor) || 0, tax_bp: Math.round(Number(v.tax_pct) * 100), tax_inclusive: !!v.tax_inclusive, sale_starts_at: v.sale_starts_at || null, sale_ends_at: v.sale_ends_at || null,
          allocation: v.allocation === '' || v.allocation == null ? null : Number(v.allocation), per_order_limit: v.per_order_limit, per_account_limit: v.per_account_limit, channels: v.channels, transferable: !!v.transferable,
          reentry: v.reentry, access_point_ids: v.access_point_ids ?? [],
        };
        if (edit) { delete body.kind; await api.patch(`/ticket-products/${p.id}`, body); } else await api.post(`/events/${id}/ticket-products`, body);
        onDone(); return null;
      }} />
  );
}

export function TicketsTab({ id, e, isOrg }) {
  const { push } = useNav();
  const [sub, setSub] = useState('overview');
  const report = useLoad(() => (isOrg ? api.get(`/events/${id}/tickets/report`) : Promise.resolve(null)), [id, isOrg]);
  const products = useLoad(() => (isOrg ? api.get(`/events/${id}/ticket-products`) : Promise.resolve([])), [id, isOrg]);
  const settings = useLoad(() => (isOrg ? api.get(`/events/${id}/tickets/settings`) : Promise.resolve(null)), [id, isOrg]);
  const sections = useLoad(() => (isOrg ? api.get(`/events/${id}/ticket-sections`) : Promise.resolve([])), [id, isOrg]);
  const allocs = useLoad(() => (isOrg ? api.get(`/events/${id}/ticket-allocations`) : Promise.resolve([])), [id, isOrg]);
  const fx = useLoad(() => api.get('/fixtures', { event_id: id, limit: 100 }), [id]);
  const [q, setQ] = useState(''), [status, setStatus] = useState('');
  const found = useLoad(() => (isOrg && sub === 'find' ? api.get(`/events/${id}/tickets`, { q: q || undefined, status: status || undefined, limit: 50 }) : Promise.resolve(null)), [id, isOrg, sub, q, status]);
  const [form, setForm] = useState(null), [rules, setRules] = useState(false), [secForm, setSecForm] = useState(false), [allocForm, setAllocForm] = useState(false), [issue, setIssue] = useState(null), [open, setOpen] = useState(null), [voiding, setVoiding] = useState(null);
  const reload = () => { report.reload(); products.reload(); settings.reload(); sections.reload(); allocs.reload(); found.reload(); };
  const act = useDo(reload);
  const fixtureOpts = useMemo(() => (fx.data ?? []).map((f) => ({ value: f.id, label: `${f.home_name ?? t('tix.tbc')} v ${f.away_name ?? t('tix.tbc')} · ${stamp(f.scheduled_at)}` })), [fx.data]);
  const sectionOpts = (sections.data ?? []).map((s) => ({ value: s.id, label: `${s.name} (${s.seats})` }));
  if (!isOrg) {
    return <ACard><AT size={15} weight="800">{t('tix.organiser_only')}</AT><Btn title={t('tix.get_tickets')} onPress={() => push('Tickets', { id })} style={{ marginTop: 10 }} /></ACard>;
  }
  const S = settings.data, R = report.data;
  return (
    <>
      <ATabs value={sub} onChange={setSub} tabs={SUBS.map((k) => ({ key: k, label: t(`tix.sub.${k}`) }))} />

      {sub === 'overview' ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <AStat icon="🎟️" value={R?.counts.sold ?? 0} label={t('tix.stat_sold')} /><AStat icon="✅" value={R?.counts.issued ?? 0} label={t('tix.stat_issued')} tone={A.green} />
            <AStat icon="🚪" value={R?.counts.scanned_in ?? 0} label={t('tix.stat_scanned')} tone={A.cyan} /><AStat icon="↩️" value={R?.counts.refunded ?? 0} label={t('tix.stat_refunded')} tone={R?.counts.refunded ? A.sun : undefined} />
          </View>
          <AT size={12} color={A.mute}>{t('tix.sold_vs_scanned')}</AT>
          {(R?.money ?? []).map((m) => <ARow key={m.currency} title={`${t('tix.revenue')} · ${m.currency}`} sub={t('tix.revenue_sub', { gross: moneyIn(m.gross_minor, m.currency), refunded: moneyIn(m.refunded_minor, m.currency), tax: moneyIn(m.tax_minor, m.currency) })} right={<AT size={20} weight="900" num>{moneyIn(m.net_minor, m.currency)}</AT>} />)}
          <ASection title={t('tix.by_fixture')} sub={t('tix.by_fixture_sub')} />
          {(R?.fixtures ?? []).length ? R.fixtures.map((f) => (
            <ACard key={f.fixture_id} pad={14} style={{ gap: 6 }}>
              <AT size={14} weight="800">{f.home ?? t('tix.tbc')} v {f.away ?? t('tix.tbc')}</AT>
              <AT size={12} color={A.mute}>{stamp(f.scheduled_at)}</AT>
              <ABar pct={f.capacity ? Math.min(100, (f.issued / f.capacity) * 100) : 0} color={A.violet} />
              <AT size={12} color={A.mute}>{t('tix.fixture_line', { issued: f.issued, cap: f.capacity ?? '∞', attended: f.attended })}{f.no_show != null ? ` · ${t('tix.no_show', { n: f.no_show })}` : ''}</AT>
            </ACard>
          )) : <AEmpty emoji="🏟️" title={t('tix.no_fixtures')} />}
          <ASection title={t('tix.gates_title')} sub={t('tix.gates_sub')} />
          {(R?.gates ?? []).map((g) => <ARow key={g.gate} title={g.gate} sub={t('tix.gate_line', { dup: g.duplicates, refused: g.refused })} right={<AT size={20} weight="900" num color={A.green}>{g.admitted}</AT>} />)}
          <ABtn title={t('tix.open_gate')} tone="lime" small onPress={() => push('GateScan', { id })} />
        </>
      ) : null}

      {sub === 'products' ? (
        <>
          <ASection title={t('tix.sub.products')} action={t('tix.new_product')} onAction={() => setForm({})} />
          {(products.data ?? []).length ? products.data.map((p) => (
            <ACard key={p.id} pad={14} style={{ gap: 6 }} onPress={() => setForm(p)}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><AT size={15} weight="800" style={{ flex: 1 }}>{p.name}</AT><ATag label={t(`tix.status.${p.status}`)} tone={p.status === 'active' ? A.green : undefined} /></View>
              <AT size={12} color={A.mute}>{className(p.class, p.class_label)} · {p.price_minor ? moneyIn(p.price_minor, p.currency) : t('tix.free')}{p.kind === 'pass' ? ` · ${t('tix.pass')}` : ''}</AT>
              <AT size={12} color={A.mute}>{t('tix.product_line', { issued: p.issued, held: p.held, left: p.remaining ?? '∞' })}</AT>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {p.status !== 'active' ? <ABtn small title={t('tix.put_on_sale')} onPress={() => act(() => api.patch(`/ticket-products/${p.id}`, { status: 'active' }), t('tix.on_sale'))} /> : <ABtn small tone="ghost" title={t('tix.pause')} onPress={() => act(() => api.patch(`/ticket-products/${p.id}`, { status: 'paused' }), t('tix.paused'))} />}
                {p.status !== 'archived' ? <ABtn small tone="ghost" title={t('tix.archive')} onPress={() => act(() => api.patch(`/ticket-products/${p.id}`, { status: 'archived' }), t('tix.archived'))} /> : null}
              </View>
            </ACard>
          )) : <AEmpty emoji="🎟️" title={t('tix.no_products')} sub={t('tix.no_products_sub')} action={t('tix.new_product')} onAction={() => setForm({})} />}
        </>
      ) : null}

      {sub === 'rules' && S ? (
        <>
          <ASection title={t('tix.capacity')} action={t('tix.edit_rules')} onAction={() => setRules(true)} />
          <ARow title={t('tix.spectator_capacity')} sub={t('tix.spectator_capacity_sub')} right={<AT size={18} weight="900" num>{S.spectator_capacity ?? '∞'}</AT>} />
          <ARow title={t('tix.safety_capacity')} sub={[S.count_participants ? t('tix.counts_participants') : null, S.count_accreditations ? t('tix.counts_accreditations') : null].filter(Boolean).join(' · ') || t('tix.safety_capacity_sub')} right={<AT size={18} weight="900" num>{S.safety_capacity ?? '∞'}</AT>} />
          <ARow title={t('tix.sales')} sub={S.sales_open ? t('tix.sales_open') : t('tix.sales_paused')} right={<ABtn small tone={S.sales_open ? 'ghost' : 'hero'} title={S.sales_open ? t('tix.pause') : t('tix.reopen')} onPress={() => act(() => api.patch(`/events/${id}/tickets/settings`, { sales_open: !S.sales_open }), S.sales_open ? t('tix.paused') : t('tix.on_sale'))} />} />
          <ARow title={t('tix.refund_policy')} sub={t(`tix.policy.${S.refund_policy}`, { h: S.refund_cutoff_hours })} />
          <ARow title={t('tix.transfers')} sub={S.transfer_allowed ? t('tix.transfer_until', { h: S.transfer_cutoff_hours }) : t('tix.transfer_off')} />
          <ASection title={t('tix.sections')} sub={t('tix.sections_sub')} action={t('tix.add_section')} onAction={() => setSecForm(true)} />
          {(sections.data ?? []).map((s) => <ARow key={s.id} title={s.name} sub={t('tix.section_line', { rows: s.rows_count, per: s.seats_per_row })} right={<AT size={16} weight="900" num>{s.seats}</AT>} />)}
          <ASection title={t('tix.gates_readers')} sub={t('tix.gates_readers_sub')} />
          <AccessPoints eventId={id} zones={[]} />
        </>
      ) : null}

      {sub === 'comps' ? (
        <>
          <ASection title={t('tix.comps_title')} sub={t('tix.comps_sub')} action={t('tix.new_allocation')} onAction={() => setAllocForm(true)} />
          {(allocs.data ?? []).length ? allocs.data.map((a) => (
            <ACard key={a.id} pad={14} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><AT size={15} weight="800" style={{ flex: 1 }}>{a.label}</AT><ATag label={t(`tix.alloc_kind.${a.kind}`)} /></View>
              <AT size={12} color={A.mute}>{a.product} · {a.reason}</AT>
              <ABar pct={(a.issued / a.quota) * 100} color={A.cyan} />
              <AT size={12} color={A.mute}>{t('tix.alloc_line', { issued: a.issued, quota: a.quota })}</AT>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {a.status === 'active' ? <ABtn small title={t('tix.issue')} onPress={() => setIssue(a)} /> : null}
                <ABtn small tone="ghost" title={a.status === 'active' ? t('tix.close') : t('tix.reopen')} onPress={() => act(() => api.patch(`/ticket-allocations/${a.id}`, { status: a.status === 'active' ? 'closed' : 'active' }), t('common.done'))} />
              </View>
            </ACard>
          )) : <AEmpty emoji="🎁" title={t('tix.no_allocations')} sub={t('tix.no_allocations_sub')} />}
        </>
      ) : null}

      {sub === 'find' ? (
        <>
          <TextInput value={q} onChangeText={setQ} placeholder={t('tix.find_placeholder')} placeholderTextColor={A.mute} autoCapitalize="characters" accessibilityLabel={t('tix.find_placeholder')}
            style={{ minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: A.line, backgroundColor: A.panel, color: A.ink, paddingHorizontal: 14, fontSize: 16 }} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {['', 'issued', 'reserved', 'refund_due', 'refunded', 'void', 'transferred'].map((s) => <Pressable key={s} onPress={() => setStatus(s)} accessibilityRole="button" accessibilityState={{ selected: status === s }} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 999, backgroundColor: status === s ? A.violet : A.panel, borderWidth: 1, borderColor: A.line }}><AT size={13} weight="800" color={status === s ? '#fff' : A.mute}>{s ? t(`tix.state.${s === 'issued' ? 'valid' : s}`) : t('tix.all')}</AT></Pressable>)}
          </View>
          {(found.data?.items ?? []).map((k) => <ARow key={k.id} title={`${k.serial} · ${k.product}`} sub={`${className(k.class)}${k.seat_label ? ` · ${k.seat_label}` : ''} · ${t(`tix.state.${k.status === 'issued' ? 'valid' : k.status}`)}${k.used ? ` · ${t('tix.used')}` : ''}`} onPress={() => setOpen(k)} right={<AT size={12} color={A.mute}>{k.short_code}</AT>} />)}
          {found.data && !found.data.items.length ? <AEmpty emoji="🔎" title={t('tix.nothing_found')} /> : null}
        </>
      ) : null}

      <ProductForm visible={!!form} onClose={() => setForm(null)} p={form} id={id} e={e} fixtures={fixtureOpts} sections={sectionOpts} onDone={reload} />
      <FormSheet visible={rules} onClose={() => setRules(false)} title={t('tix.edit_rules')} initial={S ?? {}} submitLabel={t('common.save')}
        fields={[
          { key: 'spectator_capacity', label: t('tix.spectator_capacity'), type: 'number', optional: true, hint: t('tix.spectator_capacity_sub') },
          { key: 'safety_capacity', label: t('tix.safety_capacity'), type: 'number', optional: true, hint: t('tix.safety_capacity_sub') },
          { key: 'count_participants', label: t('tix.counts_participants'), type: 'switch' }, { key: 'count_accreditations', label: t('tix.counts_accreditations'), type: 'switch' },
          { key: 'hold_minutes', label: t('tix.hold_minutes'), type: 'stepper', min: 5, max: 120, step: 5, suffix: ' min' },
          { key: 'refund_policy', label: t('tix.refund_policy'), type: 'choice', options: ['anytime', 'until_cutoff', 'never'].map((x) => ({ value: x, label: t(`tix.policy_short.${x}`) })) },
          { key: 'refund_cutoff_hours', label: t('tix.refund_cutoff'), type: 'stepper', min: 0, max: 720, step: 1, suffix: ' h', show: (v) => v.refund_policy === 'until_cutoff' },
          { key: 'transfer_allowed', label: t('tix.transfers'), type: 'switch' },
          { key: 'transfer_cutoff_hours', label: t('tix.transfer_cutoff'), type: 'stepper', min: 0, max: 720, step: 1, suffix: ' h', show: (v) => v.transfer_allowed },
        ]}
        onSubmit={async (v) => { await api.patch(`/events/${id}/tickets/settings`, { spectator_capacity: v.spectator_capacity === '' || v.spectator_capacity == null ? null : Number(v.spectator_capacity), safety_capacity: v.safety_capacity === '' || v.safety_capacity == null ? null : Number(v.safety_capacity), count_participants: !!v.count_participants, count_accreditations: !!v.count_accreditations, hold_minutes: v.hold_minutes, refund_policy: v.refund_policy, refund_cutoff_hours: v.refund_cutoff_hours, transfer_allowed: !!v.transfer_allowed, transfer_cutoff_hours: v.transfer_cutoff_hours }); reload(); return null; }} />
      <FormSheet visible={secForm} onClose={() => setSecForm(false)} title={t('tix.add_section')} submitLabel={t('tix.create')} initial={{ rows_count: 10, seats_per_row: 20 }}
        fields={[{ key: 'name', label: t('tix.section_name') }, { key: 'rows_count', label: t('tix.rows'), type: 'stepper', min: 1, max: 100 }, { key: 'seats_per_row', label: t('tix.seats_per_row'), type: 'stepper', min: 1, max: 200 }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/ticket-sections`, v); reload(); return null; }} />
      <FormSheet visible={allocForm} onClose={() => setAllocForm(false)} title={t('tix.new_allocation')} submitLabel={t('tix.create')} initial={{ kind: 'sponsor', quota: 10 }}
        fields={[
          { key: 'product_id', label: t('tix.product'), type: 'chips', options: (products.data ?? []).filter((p) => p.channels.includes('complimentary') && Number(p.price_minor) === 0).map((p) => ({ value: p.id, label: p.name })), hint: t('tix.alloc_product_hint') },
          { key: 'kind', label: t('tix.alloc_for'), type: 'chips', options: ['sponsor', 'team', 'vip', 'partner', 'media', 'other'].map((x) => ({ value: x, label: t(`tix.alloc_kind.${x}`) })) },
          { key: 'label', label: t('tix.alloc_name') }, { key: 'quota', label: t('tix.quota'), type: 'stepper', min: 1, max: 1000 },
          { key: 'reason', label: t('tix.reason'), type: 'multiline' },
        ]}
        onSubmit={async (v) => { await api.post(`/events/${id}/ticket-allocations`, v); reload(); return null; }} />
      <FormSheet visible={!!issue} onClose={() => setIssue(null)} title={t('tix.issue_to', { name: issue?.label ?? '' })} submitLabel={t('tix.issue')} initial={{ mode: 'account' }}
        fields={[
          { key: 'mode', label: t('tix.give_to'), type: 'chips', options: [{ value: 'account', label: t('tix.someone_on_app') }, { value: 'guest', label: t('tix.a_guest') }] },
          { key: 'to', label: t('tix.recipient'), type: 'entity', entityKind: 'person', noun: t('tix.recipient'), show: (v) => v.mode === 'account' },
          { key: 'guest_name', label: t('tix.guest_name'), show: (v) => v.mode === 'guest' },
          { key: 'guest_email', label: t('tix.guest_email'), type: 'email', optional: true, show: (v) => v.mode === 'guest' },
        ]}
        onSubmit={async (v) => { const r = await api.post(`/ticket-allocations/${issue.id}/issue`, { idempotency_key: key(), recipients: [v.mode === 'account' ? { user_id: v.to } : { guest: { name: v.guest_name, email: v.guest_email || undefined } }] }); reload(); return r.tickets[0]?.claim_code ? t('tix.claim_issued', { code: r.tickets[0].claim_code }) : null; }} />
      <Sheet visible={!!open} onClose={() => setOpen(null)} title={open?.serial ?? ''}>
        {open ? <TicketDetail k={open} onVoid={() => { setVoiding(open); setOpen(null); }} /> : null}
      </Sheet>
      <ReasonSheet visible={!!voiding} onClose={() => setVoiding(null)} title={t('tix.void_title')} sub={t('tix.void_sub')} confirmLabel={t('tix.void_refund')} requireReason
        presets={[t('tix.reason_fraud'), t('tix.reason_goodwill'), t('tix.reason_error')]}
        onConfirm={async (reason) => { await act(() => api.post(`/tickets/${voiding.id}/refund`, { reason }), t('tix.refund_started')); setVoiding(null); }} />
    </>
  );
}

function TicketDetail({ k, onVoid }) {
  const hist = useLoad(() => api.get(`/tickets/${k.id}/history`), [k.id]);
  return (
    <View style={{ gap: 8 }}>
      <T size={14}>{k.product} · {className(k.class)}{k.seat_label ? ` · ${k.seat_label}` : ''}</T>
      <T size={13} color={c.mute}>{t(`tix.state.${k.status === 'issued' ? 'valid' : k.status}`)} · {k.price_minor ? moneyIn(k.price_minor, k.currency) : t('tix.free')}</T>
      {k.status === 'issued' ? <Btn small title={t('tix.void_refund')} onPress={onVoid} accessibilityLabel={t('tix.void_refund')} /> : null}
      <T size={13} weight="800" style={{ marginTop: 6 }}>{t('tix.history')}</T>
      {(hist.data ?? []).map((h) => <T key={h.id} size={12} color={c.mute}>{stamp(h.at)} · {h.kind.replace(/_/g, ' ')}{h.to_status ? ` → ${h.to_status}` : ''}</T>)}
    </View>
  );
}

// ---- the gate: spectator tickets (shown inside the existing Gate scanner, next to badges) --------------------------------------------------

const VERDICT_TONE = { valid: 'ok', re_entry: 'ok', exit: 'ok', duplicate: 'warn', replaced: 'warn', wrong_date: 'warn', wrong_gate: 'warn', wrong_fixture: 'warn', not_issued: 'warn', no_reentry: 'warn', not_inside: 'warn', transferred: 'warn' };
const toneColor = (r) => ({ ok: A.green, warn: A.sun }[VERDICT_TONE[r]] ?? A.red);
const gateStore = makeStore({ db: 'sa_gate', prefix: 'sa_gt' });
const OFFLINE_KEY = (id) => `tm_${id}`, QUEUE_KEY = (id) => `tq_${id}`;
const offlineVerdict = (manifest, seen, token) => {
  const m = /^GT1\.(TKT-[A-Z0-9]{10})\.(\d{1,6})\./.exec(String(token).trim());
  const tk = m && manifest?.get(m[1]);
  if (!m) return { result: 'invalid' };
  if (!tk) return { result: 'invalid' };
  if (tk.token_version !== Number(m[2])) return { result: 'replaced' };
  if (seen.has(m[1])) return { result: 'duplicate' };
  return { result: 'valid', admitted: true, class: tk.class, section: tk.section, seat: tk.seat_label, ticket_id: m[1] };
};

/** Scan, look up or type a spectator ticket. Online it asks the server; offline it checks the downloaded list and queues the scan for replay. */
export function TicketGatePanel({ id }) {
  const { toast } = useSession();
  const points = useLoad(() => api.get('/access/points', { event_id: id }).catch(() => []), [id]);
  const fixtures = useLoad(() => api.get('/fixtures', { event_id: id, limit: 100 }).catch(() => []), [id]);
  const [gate, setGate] = useState(''), [fixture, setFixture] = useState(''), [dir, setDir] = useState('in'), [code, setCode] = useState(''), [res, setRes] = useState(null), [busy, setBusy] = useState(false), [cam, setCam] = useState(false), [recent, setRecent] = useState([]);
  const [manifest, setManifest] = useState(null), [queue, setQueue] = useState([]), [offline, setOffline] = useState(false);
  const seen = useRef(new Set());
  const input = useRef(null);
  React.useEffect(() => {
    (async () => {
      const all = await gateStore.readAll().catch(() => []);
      const m = all.find((d) => d.id === OFFLINE_KEY(id)), q = all.find((d) => d.id === QUEUE_KEY(id));
      if (m) setManifest({ at: m.at, map: new Map(m.tickets.map((x) => [x.serial, x])) });
      if (q) { setQueue(q.scans ?? []); (q.scans ?? []).forEach((s) => { const mm = /^GT1\.(TKT-[A-Z0-9]{10})/.exec(s.token ?? ''); if (mm) seen.current.add(mm[1]); }); }
    })();
  }, [id]);
  const saveQueue = (q) => { setQueue(q); gateStore.write({ id: QUEUE_KEY(id), scans: q }).catch(() => {}); };
  const download = async () => {
    setBusy(true);
    try {
      let all = [], offset = 0, total = 0;
      do { const page = await api.get(`/events/${id}/tickets/gate-manifest`, { limit: 2000, offset }); all = all.concat(page.tickets); total = page.total; offset += 2000; } while (all.length < total);
      const at = new Date().toISOString();
      await gateStore.write({ id: OFFLINE_KEY(id), at, tickets: all.map((x) => ({ serial: x.serial, token_version: x.token_version, class: x.class, section: x.section, seat_label: x.seat_label })) });
      setManifest({ at, map: new Map(all.map((x) => [x.serial, x])) });
      toast(t('tix.gate_downloaded', { n: all.length }));
    } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  const sync = async () => {
    if (!queue.length) return;
    setBusy(true);
    try {
      const r = await api.post(`/events/${id}/tickets/scan-batch`, { scans: queue.slice(0, 200) });
      saveQueue(queue.slice(200)); setOffline(false);
      toast(t('tix.gate_synced', { n: r.results.length, dup: r.duplicates }));
    } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  const submit = async (raw) => {
    const v = String(raw ?? code).trim();
    if (!v || busy) return;
    setBusy(true);
    const ref = key();
    const body = { ...(v.startsWith('GT1.') ? { token: v } : { code: v }), fixture_id: fixture || undefined, access_point_id: gate || undefined, direction: dir, method: v.startsWith('GT1.') ? 'camera' : 'manual', client_ref: ref };
    try {
      let r;
      try { r = await api.post(`/events/${id}/tickets/scan`, body); setOffline(false); }
      catch (x) {
        if (x.status) throw x;
        // no connection: judge against the downloaded list and queue the scan, if there is a list and the code is a QR token
        if (!manifest || !v.startsWith('GT1.')) { toast(manifest ? t('tix.gate_offline_code') : t('tix.gate_offline_no_list')); return; }
        setOffline(true);
        r = offlineVerdict(manifest.map, seen.current, v);
        if (r.result === 'valid') { seen.current.add(r.ticket_id); saveQueue([...queue, { token: v, client_ref: ref, scanned_at: new Date().toISOString(), fixture_id: fixture || undefined, access_point_id: gate || undefined, direction: dir }]); }
        r = { ...r, offline: true };
      }
      setRes(r); setRecent((p) => [{ ...r, at: new Date().toISOString() }, ...p].slice(0, 8)); setCode('');
    } catch (x) { toast('' + x.message); } finally { setBusy(false); setTimeout(() => input.current?.focus?.(), 50); }
  };
  const lookup = async () => {
    const v = code.trim(); if (!v) return;
    try { const r = await api.get(`/events/${id}/tickets/lookup`, { code: v, fixture_id: fixture || undefined, access_point_id: gate || undefined }); setRes({ ...r, lookup: true }); } catch (x) { toast('' + x.message); }
  };
  const gates = (points.data ?? []).filter((p) => ['gate', 'turnstile'].includes(p.kind));
  const live = (fixtures.data ?? []).filter((f) => !['completed', 'cancelled'].includes(f.status));
  return (
    <View style={{ gap: 12 }}>
      <T size={15} weight="800">{t('tix.gate_where')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip label={t('tix.any_gate')} active={!gate} onPress={() => setGate('')} />
        {gates.map((g) => <Chip key={g.id} label={g.name} active={gate === g.id} onPress={() => setGate(g.id)} />)}
      </View>
      <T size={13} weight="800" color={c.mute}>{t('tix.gate_match')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip label={t('tix.auto_match')} active={!fixture} onPress={() => setFixture('')} />
        {live.slice(0, 12).map((f) => <Chip key={f.id} label={`${f.home_name ?? t('tix.tbc')} v ${f.away_name ?? t('tix.tbc')} · ${new Date(f.scheduled_at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}`} active={fixture === f.id} onPress={() => setFixture(f.id)} />)}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}><Chip label={`➡️ ${t('tix.entering')}`} active={dir === 'in'} onPress={() => setDir('in')} /><Chip label={`⬅️ ${t('tix.leaving')}`} active={dir === 'out'} onPress={() => setDir('out')} /></View>
      {cam && hasCamera ? <CameraScan onCode={submit} onClose={() => setCam(false)} /> : hasCamera ? <Btn title={`📷 ${t('tix.scan_camera')}`} onPress={() => setCam(true)} accessibilityLabel={t('tix.scan_camera')} /> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput ref={input} value={code} onChangeText={setCode} onSubmitEditing={() => submit()} autoCapitalize="characters" autoCorrect={false} returnKeyType="go" placeholder={t('tix.gate_placeholder')} placeholderTextColor={c.mute}
          accessibilityLabel={t('tix.gate_input_label')} style={{ flex: 1, minWidth: 0, minHeight: 52, borderRadius: 16, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.paper, color: c.ink, paddingHorizontal: 14, fontSize: 16 }} />
        <Btn title={t('tix.admit')} onPress={() => submit()} loading={busy} disabled={!code.trim()} accessibilityLabel={t('tix.admit')} />
      </View>
      <Btn small title={t('tix.check_only')} color={c.paper} ink={c.ink} onPress={lookup} disabled={!code.trim()} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t('tix.check_only')} />

      {res ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ borderRadius: 28, backgroundColor: toneColor(res.result), padding: 22, gap: 8 }}>
          <T size={32} weight="800" color="#fff" style={{ letterSpacing: 1 }}>{res.admitted ? '✓ ' : '✕ '}{t(`tix.v.${res.result}`)}</T>
          <T size={15} weight="700" color="#fff">{t(`tix.vh.${res.result}`)}{res.lookup ? ` · ${t('tix.not_recorded')}` : ''}{res.offline ? ` · ${t('tix.queued')}` : ''}</T>
          {res.class ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <View style={chipStyle}><T size={14} weight="800" color="#fff">{className(res.class, res.class_label)}</T></View>
            {res.section ? <View style={chipStyle}><T size={14} weight="800" color="#fff">{res.section}</T></View> : null}
            {res.seat ? <View style={chipStyle}><T size={14} weight="800" color="#fff">{t('tix.seat')} {res.seat}</T></View> : null}
          </View> : null}
          {res.previous ? <T size={13} color="#fff">{t('tix.previous', { when: stamp(res.previous.at), gate: res.previous.gate ?? t('tix.any_gate'), n: res.previous.entries })}</T> : null}
          {res.ticket_id ? <T size={12} color="rgba(255,255,255,0.8)">{res.ticket_id}{res.replay ? ` · ${t('tix.repeat')}` : ''}</T> : null}
        </View>
      ) : null}

      <Card style={{ gap: 8 }}>
        <T size={13} weight="800">{t('tix.offline_title')}</T>
        <T size={12} color={c.mute}>{manifest ? t('tix.offline_ready', { when: stamp(manifest.at), n: manifest.map.size }) : t('tix.offline_none')}</T>
        <T size={12} color={c.mute}>{t('tix.offline_limits')}</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title={manifest ? t('tix.offline_refresh') : t('tix.offline_download')} color={c.paper} ink={c.ink} onPress={download} loading={busy} accessibilityLabel={t('tix.offline_download')} />
          {queue.length ? <Btn small title={t('tix.offline_sync', { n: queue.length })} onPress={sync} loading={busy} accessibilityLabel={t('tix.offline_sync', { n: queue.length })} /> : null}
        </View>
        {offline ? <T size={12} weight="800" color={A.sun}>{t('tix.offline_now')}</T> : null}
      </Card>

      {recent.length ? <>
        <T size={13} weight="800">{t('tix.recent')}</T>
        {recent.map((r, i) => <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: toneColor(r.result) }} /><T size={14} weight="700" style={{ flex: 1 }}>{r.ticket_id ?? t('tix.unknown_code')} · {t(`tix.v.${r.result}`)}</T><T size={12} color={c.mute}>{stamp(r.at)}</T>
        </View>)}
      </> : null}
    </View>
  );
}
const chipStyle = { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: 'rgba(255,255,255,0.25)' };
