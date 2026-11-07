// Supplier workspace (#458): one place for a freelancer or company to advertise services, answer RFQs, quote, confirm orders, schedule and deliver work,
// invoice and see their numbers. Every action is an API capability (REST + OpenAPI + MCP); this screen only calls them.
import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { Counter, DateRangeField } from '../pickers';
import { api } from '../api';
import { useLoad } from '../hooks';
import { c } from '../theme';
import { FormSheet } from '../FormSheet';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Section, Sheet, T } from '../ui';
import { localToIso } from '../vtime';
import { useDo } from './console-utils';
import { ChainTrace, DocButton, ExportsPanel, Kpi, Kv, Note, PerformanceRecord, Status, Tabs, Wrap, catLabel, collectScope, day, label, money, scopeFields, useCatalogue, when } from './svc-common';
import { SportsMulti } from '../sportpicker';
import { SupplierAssetCatalogue } from './adaptive-equipment';

const TABS = [['overview', 'Overview'], ['offerings', 'Offerings'], ['quotes', 'Opportunities & quotes'], ['orders', 'Orders & jobs'], ['calendar', 'Calendar'], ['customers', 'Customers'], ['finance', 'Finance'], ['reports', 'Reports & documents'], ['team', 'Team & credentials'], ['specialist_assets', 'Specialist assets']];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'KWD', 'BHD', 'OMR'];

export function SupplierWorkspace() {
  const profiles = useLoad(() => api.get('/me/supplier-profiles'), []);
  const cat = useCatalogue();
  const [sel, setSel] = useState(null), [tab, setTab] = useState('overview'), [create, setCreate] = useState(false);
  if (profiles.loading || !cat) return <Screen><Loading /></Screen>;
  if (profiles.error) return <Screen><ErrorBox error={profiles.error} onRetry={profiles.reload} /></Screen>;
  const list = profiles.data ?? [];
  const p = list.find((x) => x.id === sel) ?? list[0];
  return (
    <Screen wide>
      <H1>Supplier workspace</H1>
      {!list.length ? (
        <Card><T weight="800">Open your supplier profile</T><Note>Freelancers, sole traders and companies can offer services, goods or both. Add your legal and tax details once; they appear on your quotes and invoices.</Note>
          <Btn title="Create supplier profile" onPress={() => setCreate(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }} /></Card>
      ) : (
        <>
          <Wrap>{list.map((x) => <Chip key={x.id} label={x.trading_name ?? x.legal_name} active={x.id === p.id} onPress={() => setSel(x.id)} />)}<Chip label="+ Another entity" onPress={() => setCreate(true)} /></Wrap>
          {p.status !== 'active' ? <Card color={c.redSoft}><T weight="800">This supplier is {p.status}</T><Note>{p.suspended_reason ?? 'New invitations and awards are paused. Existing orders and history are unaffected.'}</Note></Card> : null}
          <Tabs tabs={TABS} value={tab} onChange={setTab} />
          {tab === 'overview' ? <Overview p={p} cat={cat} go={setTab} /> : null}
          {tab === 'offerings' ? <Offerings p={p} cat={cat} /> : null}
          {tab === 'quotes' ? <Quotes p={p} cat={cat} /> : null}
          {tab === 'orders' ? <Orders p={p} cat={cat} /> : null}
          {tab === 'calendar' ? <Calendar p={p} /> : null}
          {tab === 'customers' ? <Customers p={p} /> : null}
          {tab === 'finance' ? <Finance p={p} cat={cat} /> : null}
          {tab === 'reports' ? <Reports p={p} /> : null}
          {tab === 'team' ? <Team p={p} cat={cat} reload={profiles.reload} /> : null}
          {tab === 'specialist_assets' ? <SupplierAssetCatalogue supplierId={p.id} /> : null}
        </>
      )}
      <ProfileForm cat={cat} visible={create} onClose={() => setCreate(false)} onDone={() => { profiles.reload(); setCreate(false); }} />
    </Screen>
  );
}

const PROFILE_STEPS = ['Identity & Services', 'Capacity & Operations', 'Tax & Launch'];
const SUPPLIER_TYPES = [
  { value: 'individual', label: 'Individual / freelancer', sub: 'You personally deliver the service' },
  { value: 'sole_trader', label: 'Sole trader', sub: 'Registered self-employed, trading under your own name' },
  { value: 'company', label: 'Company / organisation', sub: 'Ltd, LLP, charity, school or club' },
];

function ProfileForm({ cat, visible, onClose, onDone, initial, id }) {
  const mine = useLoad(() => api.get('/organisations').catch(() => []), []);
  const orgs = (mine.data ?? []).filter((o) => ['owner', 'admin'].includes(o.role));
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    supplier_type: initial?.supplier_type ?? 'individual',
    organisation_id: initial?.organisation_id ?? undefined,
    legal_name: initial?.legal_name ?? '',
    trading_name: initial?.trading_name ?? '',
    description: initial?.description ?? '',
    categories: initial?.categories ?? [],
    currencies: initial?.currencies ?? [],
    daily_capacity: initial?.daily_capacity ?? 0,
    lead_time_days: initial?.lead_time_days ?? 0,
    min_booking_days: initial?.min_booking_days ?? 0,
    accepts_rush: initial?.accepts_rush ?? false,
    insured: initial?.insured ?? false,
    tax_registration: initial?.tax_registration ?? '',
    billing_address: initial?.billing_address ?? '',
    timezone: initial?.timezone ?? '',
    website: initial?.website ?? '',
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const can = [
    () => f.supplier_type && f.legal_name.trim().length >= 2,
    () => true,
    () => true,
  ][step]();

  const submit = async () => {
    setBusy(true);
    try {
      const body = {
        supplier_type: f.supplier_type,
        legal_name: f.legal_name.trim(),
        ...(f.trading_name.trim() ? { trading_name: f.trading_name.trim() } : {}),
        ...(f.description.trim() ? { description: f.description.trim() } : {}),
        ...(f.categories.length ? { categories: f.categories } : {}),
        ...(f.currencies.length ? { currencies: f.currencies } : {}),
        ...(f.daily_capacity > 0 ? { daily_capacity: f.daily_capacity } : {}),
        lead_time_days: f.lead_time_days,
        ...(f.min_booking_days > 0 ? { min_booking_days: f.min_booking_days } : {}),
        accepts_rush: f.accepts_rush,
        insured: f.insured,
        ...(f.tax_registration.trim() ? { tax_registration: f.tax_registration.trim() } : {}),
        ...(f.billing_address.trim() ? { billing_address: f.billing_address.trim() } : {}),
        ...(f.timezone ? { timezone: f.timezone } : {}),
        ...(f.website.trim() ? { website: f.website.trim() } : {}),
        ...(f.supplier_type === 'company' && f.organisation_id ? { organisation_id: f.organisation_id } : {}),
      };
      if (id) await api.patch(`/supplier-profiles/${id}`, { ...body, row_version: initial.row_version });
      else await api.post('/supplier-profiles', body);
      onDone();
    } catch (e) { /* surface via toast in parent */ throw e; }
    setBusy(false);
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={id ? 'Edit Supplier Profile' : 'Create Supplier Profile'}>
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 4 }}>
        {PROFILE_STEPS.map((s, i) => (
          <View key={s} style={{ flex: 1, gap: 3 }}>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: i <= step ? c.pink : c.line }} />
            <T size={10} weight={i === step ? '800' : '500'} color={i === step ? c.ink : c.mute}>{s}</T>
          </View>
        ))}
      </View>

      {step === 0 ? (
        <View style={{ gap: 14 }}>
          <View style={{ gap: 8 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>WHO IS SUPPLYING?</T>
            {SUPPLIER_TYPES.map(o => (
              <View key={o.value} onTouchEnd={() => set('supplier_type', o.value)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderWidth: 1.5, borderColor: f.supplier_type === o.value ? c.pink : c.line, borderRadius: 14, backgroundColor: c.paper }}>
                <View style={{ flex: 1 }}>
                  <T weight="800" size={14}>{o.label}</T>
                  <T size={12} color={c.mute}>{o.sub}</T>
                </View>
                <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: f.supplier_type === o.value ? c.pink : c.line, backgroundColor: f.supplier_type === o.value ? c.pink : 'transparent' }} />
              </View>
            ))}
          </View>
          {f.supplier_type === 'company' && orgs.length ? (
            <View style={{ gap: 6 }}>
              <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>LINKED ORGANISATION</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {orgs.map(o => <Chip key={o.id} label={o.name} active={f.organisation_id === o.id} onPress={() => set('organisation_id', f.organisation_id === o.id ? undefined : o.id)} />)}
              </View>
            </View>
          ) : null}
          <Field label="Legal name" value={f.legal_name} onChangeText={x => set('legal_name', x)} placeholder="As it appears on official documents" />
          <Field label="Trading name (optional)" value={f.trading_name} onChangeText={x => set('trading_name', x)} placeholder="Brand or trading name if different" />
          <Field label="About your services (optional)" value={f.description} onChangeText={x => set('description', x)} multiline placeholder="What you offer, your specialisms, years of experience, notable clients…" />
          <Field label="Website (optional)" value={f.website} onChangeText={x => set('website', x)} placeholder="https://" keyboardType="url" autoCapitalize="none" />
          <View style={{ gap: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>SERVICE CATEGORIES</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {cat.categories.map(k => <Chip key={k.slug} label={k.label} active={f.categories.includes(k.slug)} onPress={() => set('categories', f.categories.includes(k.slug) ? f.categories.filter(x => x !== k.slug) : [...f.categories, k.slug])} />)}
            </View>
          </View>
        </View>
      ) : null}

      {step === 1 ? (
        <View style={{ gap: 14 }}>
          <View style={{ gap: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>CURRENCIES YOU ACCEPT</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {CURRENCIES.map(cur => <Chip key={cur} label={cur} active={f.currencies.includes(cur)} onPress={() => set('currencies', f.currencies.includes(cur) ? f.currencies.filter(x => x !== cur) : [...f.currencies, cur])} />)}
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800" size={13}>Daily capacity (jobs / units)</T>
              <T size={11} color={c.mute}>Maximum bookings per day — 0 means unlimited</T>
            </View>
            <Counter value={f.daily_capacity} onChange={x => set('daily_capacity', x)} min={0} max={10000} step={1} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800" size={13}>Lead time (days)</T>
              <T size={11} color={c.mute}>Minimum notice required before a booking</T>
            </View>
            <Counter value={f.lead_time_days} onChange={x => set('lead_time_days', x)} min={0} max={365} step={1} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800" size={13}>Minimum booking (days)</T>
              <T size={11} color={c.mute}>Shortest engagement you will take — 0 means no minimum</T>
            </View>
            <Counter value={f.min_booking_days} onChange={x => set('min_booking_days', x)} min={0} max={365} step={1} />
          </View>
          <View style={{ gap: 8 }}>
            {[
              ['accepts_rush', 'Accepts rush bookings', 'Available at shorter notice for an uplift in rate'],
              ['insured', 'Public liability insurance held', 'Clients may require proof before confirming an order'],
            ].map(([key, title, sub]) => (
              <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1, borderColor: c.line, borderRadius: 12 }}>
                <View style={{ flex: 1 }}>
                  <T weight="800" size={13}>{title}</T>
                  <T size={11} color={c.mute}>{sub}</T>
                </View>
                <Switch value={f[key]} onValueChange={v => set(key, v)} trackColor={{ true: c.pink }} />
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {step === 2 ? (
        <View style={{ gap: 14 }}>
          <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 14, backgroundColor: c.paper, gap: 3 }}>
            <T weight="800">{f.trading_name || f.legal_name || '—'}</T>
            <T size={12} color={c.mute}>{SUPPLIER_TYPES.find(x => x.value === f.supplier_type)?.label}</T>
            {f.categories.length ? <T size={12} color={c.mute}>{f.categories.length} service categor{f.categories.length > 1 ? 'ies' : 'y'}</T> : null}
            {f.currencies.length ? <T size={12} color={c.mute}>Accepts: {f.currencies.join(', ')}</T> : null}
          </View>
          <Field label="Tax registration number (optional)" value={f.tax_registration} onChangeText={x => set('tax_registration', x)} placeholder="GSTIN, VAT ID, ABN, EIN…" autoCapitalize="characters" />
          <Field label="Billing address (optional)" value={f.billing_address} onChangeText={x => set('billing_address', x)} multiline placeholder="Address that appears on your invoices" />
          <Field label="Time zone (optional)" value={f.timezone} onChangeText={x => set('timezone', x)} placeholder="e.g. Europe/London" autoCapitalize="none" />
          <Card pad={12} color={c.sunSoft}>
            <T size={12} weight="800">What happens next</T>
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>Your profile is active immediately. Add offerings from the Offerings tab so buyers can find and book you. All quotes and invoices carry your legal name and tax number.</T>
          </Card>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
        {step > 0 ? <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} style={{ flex: 1 }} /> : null}
        {step < 2
          ? <Btn title="Next" disabled={!can} onPress={() => setStep(step + 1)} style={{ flex: 2 }} />
          : <Btn title={id ? 'Save profile' : 'Create profile'} loading={busy} onPress={submit} style={{ flex: 2 }} />}
      </View>
    </Sheet>
  );
}

function Overview({ p, go }) {
  const { push } = useNav();
  const d = useLoad(() => api.get(`/supplier-profiles/${p.id}/dashboard`), [p.id]);
  const inbox = useLoad(() => api.get('/me/rfq-invitations', { profile_id: p.id, limit: 5 }), [p.id]);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  const x = d.data, cur = x.finance.by_currency[0];
  return (
    <>
      <Wrap>
        <Kpi title="Open RFQs" value={String(inbox.data?.filter((i) => ['invited', 'accepted'].includes(i.status)).length ?? 0)} sub="awaiting your quote" />
        <Kpi title="Quote conversion" value={x.quotes.conversion == null ? '—' : `${Math.round(x.quotes.conversion * 100)}%`} sub={`${x.quotes.awarded}/${x.quotes.submitted} awarded`} />
        <Kpi title="Billed" value={cur ? money(cur.billed_minor, cur.currency) : '—'} sub={cur ? `${money(cur.collected_minor, cur.currency)} collected` : 'no invoices yet'} />
        <Kpi title="Outstanding" value={cur ? money(cur.outstanding_minor, cur.currency) : '—'} />
      </Wrap>
      <Section title="Opportunities">
        {inbox.data?.length ? inbox.data.map((i) => <Row key={i.id} title={i.title} sub={`${i.buyer_name}${i.quote_deadline ? ` · quote by ${day(i.quote_deadline)}` : ''}`} right={<Status s={i.status} />} onPress={() => go('quotes')} />) : <Empty emoji="📨" title="No requests yet" sub="Publish offerings so buyers can find and invite you." />}
      </Section>
      <Section title="Your performance record"><PerformanceRecord profileId={p.id} /></Section>
      <Section title="Goods & stock"><Note>Selling goods works as before: products, stock and shipping stay in the shop.</Note><Wrap><Btn small color={c.paper} ink={c.ink} title="My shop" onPress={() => push('Shop')} /><Btn small color={c.paper} ink={c.ink} title="Stock & reorders" onPress={() => push('Supply')} /></Wrap></Section>
      <Note>Dates and times are shown in UTC. Figures are per currency and are never combined.</Note>
    </>
  );
}

const OFFERING_STEPS = ['Offering Identity', 'Pricing & Delivery', 'Availability & Launch'];
const OFFERING_TYPES = ['Coaching session', 'Training camp', 'Kit & equipment supply', 'Nutrition consultation', 'Sports psychology', 'Video analysis', 'Fitness assessment', 'Group workshop', 'Online course', 'Venue hire', 'Medical consultation', 'Other'];
const DELIVERY_MODES = ['In-person', 'Remote / online', 'Hybrid', "At buyer's venue", 'At our facility'];
const LEAD_TIMES = ['Book same day', '24 hours', '48 hours', '1 week', '2 weeks', '1 month'];
const DURATIONS = ['Under 1 hour', '1–2 hours', 'Half day', 'Full day', 'Multi-day', 'Ongoing'];
const toLines = (s) => (s ? String(s).split('\n').map((x) => x.trim()).filter(Boolean) : []);

function NewOfferingWizard({ visible, onClose, profileId, p, cat, onDone }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ title: '', offering_type: '', category: '', mode: 'service', description: '', pricing_model: 'Fixed price', currency: p.currencies?.[0] ?? 'INR', rate: 0, unit: '', min_quantity: 1, delivery_modes: [], duration: '', min_attendees: 1, max_attendees: 20, avail_from: null, avail_until: null, lead_time: '48 hours', sports: [], inclusions: '', exclusions: '', available: true, featured: false });
  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));
  const toggle = (k, val) => setF((prev) => ({ ...prev, [k]: prev[k].includes(val) ? prev[k].filter((x) => x !== val) : [...prev[k], val] }));
  const can = [
    () => f.title.trim().length >= 2 && !!f.category,
    () => !!f.pricing_model && !!f.currency,
    () => true,
  ][step]();
  const unitsForCat = cat.categories.find((k) => k.slug === f.category)?.units ?? [];

  const submit = async () => {
    setBusy(true);
    try {
      const pmMap = { 'Fixed price': 'fixed', 'Custom quote': 'quote_only', 'Per person': 'fixed', 'Per session': 'fixed', 'Per hour': 'fixed', 'Free / included': 'fixed' };
      await api.post(`/supplier-profiles/${profileId}/offerings`, {
        category: f.category, title: f.title.trim(), description: f.description.trim() || undefined, mode: f.mode,
        pricing_model: pmMap[f.pricing_model] ?? 'quote_only', unit: f.unit || undefined, currency: f.currency,
        ...(f.pricing_model !== 'Custom quote' && f.rate > 0 ? { rate_minor: f.rate } : {}),
        min_quantity: f.min_quantity,
        inclusions: toLines(f.inclusions), exclusions: toLines(f.exclusions),
        specs: collectScope(cat, f.category, f, p.timezone),
        delivery_modes: f.delivery_modes.length ? f.delivery_modes : undefined,
        duration_label: f.duration || undefined,
        min_attendees: f.min_attendees > 1 ? f.min_attendees : undefined,
        max_attendees: f.max_attendees < 500 ? f.max_attendees : undefined,
        lead_time_label: f.lead_time || undefined,
        available_from: f.avail_from || undefined, available_until: f.avail_until || undefined, featured: f.featured,
      });
      onDone();
    } catch (e) { setBusy(false); throw e; }
    setBusy(false);
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="New offering">
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 4 }}>
        {OFFERING_STEPS.map((s, i) => (
          <View key={s} style={{ flex: 1, gap: 3 }}>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: i < step ? c.violet : i === step ? c.pink : c.line }} />
            <T size={10} weight={i === step ? '800' : '500'} color={i === step ? c.ink : c.mute}>{s}</T>
          </View>
        ))}
      </View>

      {step === 0 ? (
        <View style={{ gap: 14 }}>
          <Field label="Offering title" value={f.title} onChangeText={(x) => set('title', x)} placeholder="e.g. Elite speed & agility camp, Custom kit supply" />
          <View style={{ gap: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>OFFERING TYPE</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {OFFERING_TYPES.map((t) => <Chip key={t} label={t} active={f.offering_type === t} onPress={() => set('offering_type', t)} />)}
            </View>
          </View>
          <View style={{ gap: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>SERVICE CATEGORY</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {cat.categories.map((k) => <Chip key={k.slug} label={k.label} active={f.category === k.slug} onPress={() => set('category', k.slug)} />)}
            </View>
          </View>
          <View style={{ gap: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>WHAT YOU SUPPLY</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {[{ value: 'service', label: 'Service' }, { value: 'goods', label: 'Goods' }, { value: 'mixed', label: 'Mixed' }].map((o) => <Chip key={o.value} label={o.label} active={f.mode === o.value} onPress={() => set('mode', o.value)} />)}
            </View>
          </View>
          <Field label="Description (optional)" value={f.description} onChangeText={(x) => set('description', x)} multiline placeholder="What's included, format, skill level, what to bring…" />
        </View>
      ) : null}

      {step === 1 ? (
        <View style={{ gap: 14 }}>
          <View style={{ gap: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>PRICING MODEL</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {['Fixed price', 'Per person', 'Per session', 'Per hour', 'Custom quote', 'Free / included'].map((m) => <Chip key={m} label={m} active={f.pricing_model === m} onPress={() => set('pricing_model', m)} />)}
            </View>
          </View>
          <View style={{ gap: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>CURRENCY</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {CURRENCIES.map((cur) => <Chip key={cur} label={cur} active={f.currency === cur} onPress={() => set('currency', cur)} />)}
            </View>
          </View>
          {f.pricing_model !== 'Custom quote' && f.pricing_model !== 'Free / included' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1 }}><T weight="800" size={13}>Price ({f.currency})</T><T size={11} color={c.mute}>Exact amount in {f.currency}</T></View>
              <Counter value={f.rate} onChange={(x) => set('rate', x)} min={0} max={9999999} step={1} />
            </View>
          ) : null}
          {unitsForCat.length ? (
            <View style={{ gap: 6 }}>
              <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>PRICED PER (UNIT)</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {unitsForCat.map((u) => <Chip key={u} label={label(u)} active={f.unit === u} onPress={() => set('unit', u)} />)}
              </View>
            </View>
          ) : null}
          <View style={{ gap: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>DELIVERY MODE</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {DELIVERY_MODES.map((m) => <Chip key={m} label={m} active={f.delivery_modes.includes(m)} onPress={() => toggle('delivery_modes', m)} />)}
            </View>
          </View>
          <View style={{ gap: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>DURATION</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {DURATIONS.map((d) => <Chip key={d} label={d} active={f.duration === d} onPress={() => set('duration', d)} />)}
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800" size={13}>Min attendees</T></View>
            <Counter value={f.min_attendees} onChange={(x) => set('min_attendees', x)} min={1} max={100} step={1} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800" size={13}>Max attendees</T></View>
            <Counter value={f.max_attendees} onChange={(x) => set('max_attendees', x)} min={1} max={500} step={1} />
          </View>
        </View>
      ) : null}

      {step === 2 ? (
        <View style={{ gap: 14 }}>
          <DateRangeField label="Available from / until (optional — leave blank for ongoing)" value={{ start: f.avail_from, end: f.avail_until }} onChange={({ start, end }) => { set('avail_from', start); set('avail_until', end); }} />
          <View style={{ gap: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5 }}>LEAD TIME REQUIRED</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {LEAD_TIMES.map((lt) => <Chip key={lt} label={lt} active={f.lead_time === lt} onPress={() => set('lead_time', lt)} />)}
            </View>
          </View>
          <SportsMulti value={f.sports} onChange={(x) => set('sports', x)} label="Sports this applies to (optional)" />
          <Field label="What's included (one per line, optional)" value={f.inclusions} onChangeText={(x) => set('inclusions', x)} multiline placeholder="e.g. Full kit, Coaching notes, Video analysis…" />
          <Field label="What's not included (one per line, optional)" value={f.exclusions} onChangeText={(x) => set('exclusions', x)} multiline placeholder="e.g. Travel, Accommodation…" />
          <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 14, backgroundColor: c.paper, gap: 4 }}>
            <T weight="800" size={14}>{f.title || 'Untitled offering'}</T>
            <T size={12} color={c.mute}>{f.offering_type || f.mode} · {f.pricing_model}{f.rate > 0 ? ` · ${f.currency} ${f.rate}` : ''}</T>
            {f.delivery_modes.length ? <T size={12} color={c.mute}>{f.delivery_modes.join(', ')}</T> : null}
          </View>
          {[['available', 'Available for booking', 'Buyers can find and request this offering'], ['featured', 'Feature this offering', 'Shown prominently in search results']].map(([key, title, sub]) => (
            <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1, borderColor: c.line, borderRadius: 12 }}>
              <View style={{ flex: 1 }}><T weight="800" size={13}>{title}</T><T size={11} color={c.mute}>{sub}</T></View>
              <Switch value={f[key]} onValueChange={(v) => set(key, v)} trackColor={{ true: c.pink }} />
            </View>
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
        {step > 0 ? <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} style={{ flex: 1 }} /> : null}
        {step < 2
          ? <Btn title="Next" disabled={!can} onPress={() => setStep(step + 1)} style={{ flex: 2 }} />
          : <Btn title="Publish offering" loading={busy} onPress={submit} style={{ flex: 2 }} />}
      </View>
    </Sheet>
  );
}

function Offerings({ p, cat }) {
  const list = useLoad(() => api.get(`/supplier-profiles/${p.id}/offerings`, { limit: 100 }), [p.id]);
  const act = useDo(list.reload);
  const [form, setForm] = useState(null);
  return (
    <>
      <Btn small title="Add an offering" onPress={() => setForm({})} style={{ alignSelf: 'flex-start' }} />
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data?.length ? list.data.map((o) => (
        <Row key={o.id} title={o.title} sub={`${catLabel(cat, o.category)} · ${o.mode} · ${o.pricing_model === 'fixed' ? `${money(o.rate_minor, o.currency)} / ${label(o.unit)}` : `quote per ${label(o.unit)}`}`}
          right={<><Status s={o.status} />{o.status !== 'archived' ? <Btn small color={c.paper} ink={c.ink} title="Archive" onPress={() => act(() => api.patch(`/service-offerings/${o.id}`, { row_version: o.row_version, status: 'archived' }), 'Archived')} /> : null}</>} />
      )) : <Empty emoji="🧰" title="No offerings yet" sub="Services never need stock or shipping. Mixed offerings can link a shop product whose stock stays in the shop." />}
      <NewOfferingWizard visible={!!form} onClose={() => setForm(null)} profileId={p.id} p={p} cat={cat} onDone={() => { list.reload(); setForm(null); }} />
    </>
  );
}

function Quotes({ p, cat }) {
  const inbox = useLoad(() => api.get('/me/rfq-invitations', { profile_id: p.id, limit: 50 }), [p.id]);
  const open = useLoad(() => api.get('/rfq-opportunities', { profile_id: p.id, limit: 20 }), [p.id]);
  const act = useDo(() => { inbox.reload(); open.reload(); });
  const [rfq, setRfq] = useState(null);
  return (
    <>
      <Section title="Invitations">
        {inbox.loading ? <Loading /> : inbox.data?.length ? inbox.data.map((i) => <Row key={i.id} title={i.title} sub={`${i.buyer_name} · ${catLabel(cat, i.category)}${i.quote_deadline ? ` · quote by ${day(i.quote_deadline)}` : ''}`} right={<Status s={i.status} />} onPress={() => setRfq(i)} />) : <Empty emoji="📨" title="No invitations" />}
      </Section>
      {open.data?.length ? (
        <Section title="Open to quote">
          {open.data.map((r) => <Row key={r.id} title={r.title} sub={`${catLabel(cat, r.category)}${r.quote_deadline ? ` · quote by ${day(r.quote_deadline)}` : ''}`} right={<Btn small title="Join" onPress={() => act(() => api.post(`/rfqs/${r.id}/join`, { profile_id: p.id }), 'Joined — you can quote now')} />} />)}
        </Section>
      ) : null}
      {rfq ? <RfqSheet inv={rfq} p={p} cat={cat} onClose={() => { setRfq(null); inbox.reload(); }} /> : null}
    </>
  );
}

function RfqSheet({ inv, p, cat, onClose }) {
  const r = useLoad(() => api.get(`/rfqs/${inv.rfq_id}`), [inv.rfq_id]);
  const act = useDo(r.reload);
  const [form, setForm] = useState(null), [lines, setLines] = useState([]);
  const rules = useLoad(() => api.get(`/supplier-profiles/${p.id}/tax-rules`, { limit: 50 }).catch(() => []), [p.id]);
  const x = r.data;
  const units = cat.categories.find((k) => k.slug === x?.scope?.category)?.units ?? [];
  const codes = [...new Set((rules.data ?? []).map((t) => t.code))];
  return (
    <Sheet visible onClose={onClose} title={inv.title}>
      {r.loading ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <>
          <Wrap><Status s={x.status} /><T size={12} color={c.mute}>scope v{x.scope_version} · {x.currency}</T></Wrap>
          <Kv k="category" v={catLabel(cat, x.scope.category)} /><Kv k="quantity" v={`${x.scope.quantity} ${label(x.scope.unit)}`} /><Kv k="starts" v={when(x.scope.starts_at)} /><Kv k="ends" v={when(x.scope.ends_at)} />
          {Object.entries(x.scope.scope ?? {}).map(([k, v]) => <Kv key={k} k={k} v={v} />)}
          {x.scope.acceptance_criteria?.length ? <Kv k="acceptance" v={x.scope.acceptance_criteria} /> : null}
          <Kv k="quote deadline" v={when(x.quote_deadline)} />
          <DocButton type="rfq" id={x.id} title="RFQ PDF" />
          <Section title="Your response">
            <Wrap>
              {['invited'].includes(x.invite.status) ? <Btn small title="Accept" onPress={() => act(() => api.post(`/rfq-invites/${x.invite.id}/respond`, { action: 'accept' }), 'Accepted')} /> : null}
              {['invited', 'accepted'].includes(x.invite.status) ? <Btn small color={c.paper} ink={c.ink} title="Request site visit" onPress={() => setForm('visit')} /> : null}
              {!['declined', 'closed'].includes(x.invite.status) ? <Btn small color={c.paper} ink={c.red} title="Decline" onPress={() => setForm('decline')} /> : null}
            </Wrap>
          </Section>
          <Section title="Clarifications">
            {x.clarifications.length ? x.clarifications.map((q) => <Card key={q.id} pad={10}><T size={11} color={c.mute}>{q.author_side}{q.mine ? ' (you)' : ''}</T><T size={13}>{q.body}</T></Card>) : <Note>None yet.</Note>}
            <Btn small color={c.paper} ink={c.ink} title="Ask a question" onPress={() => setForm('ask')} style={{ alignSelf: 'flex-start' }} />
          </Section>
          <Section title="Your quotes">
            {x.quotes.map((q) => <Row key={q.id} title={`Version ${q.version}`} sub={`${money(q.gross_minor, q.currency)} gross · valid until ${day(q.valid_until)}`} right={<><Status s={q.status} />{['submitted', 'shortlisted'].includes(q.status) ? <Btn small color={c.paper} ink={c.ink} title="Withdraw" onPress={() => act(() => api.post(`/quotes/${q.id}/withdraw`, {}), 'Withdrawn')} /> : null}<DocButton type="quote" id={q.id} title="PDF" /></>} />)}
            {['accepted', 'quoted', 'invited', 'site_visit_requested'].includes(x.invite.status) && ['issued', 'quoting', 'evaluation'].includes(x.status) ? (
              <>
                {lines.map((l, n) => <Row key={n} title={l.description} sub={`${l.quantity} ${label(l.unit)} × ${money(l.rate_minor, x.currency)}${l.tax_code ? ` · ${l.tax_code}` : ''}`} right={<Btn small color={c.paper} ink={c.red} title="Remove" onPress={() => setLines(lines.filter((_, i) => i !== n))} />} />)}
                <Wrap><Btn small color={c.paper} ink={c.ink} title="Add a quote line" onPress={() => setForm('line')} />{lines.length ? <Btn small title={`Submit quote (${lines.length} line${lines.length > 1 ? 's' : ''})`} onPress={() => setForm('submit')} /> : null}</Wrap>
              </>
            ) : null}
          </Section>
          <FormSheet visible={form === 'line'} onClose={() => setForm(null)} title="Quote line" submitLabel="Add line" initial={{ line_type: 'service', charge_kind: 'labour' }}
            fields={[{ key: 'line_type', label: 'Type', type: 'choice', options: [{ value: 'service', label: 'Service' }, { value: 'goods', label: 'Goods' }] }, { key: 'charge_kind', label: 'Charge', type: 'chips', options: ['labour', 'material', 'travel', 'equipment', 'other'].map((v) => ({ value: v, label: label(v) })) },
              { key: 'description', label: 'Description' }, { key: 'quantity', label: 'Quantity', type: 'number' }, { key: 'unit', label: 'Unit', type: 'chips', options: units.map((u) => ({ value: u, label: label(u) })) },
              { key: 'rate', label: 'Rate per unit', type: 'money', currency: x.currency }, { key: 'discount', label: 'Discount (whole line)', type: 'money', currency: x.currency, optional: true },
              ...(codes.length ? [{ key: 'tax_code', label: 'Tax', type: 'chips', options: codes.map((k) => ({ value: k, label: k })), optional: true }] : []), { key: 'milestone', label: 'Milestone (for staged billing)', optional: true }]}
            onSubmit={async (v) => { setLines([...lines, { line_type: v.line_type, charge_kind: v.charge_kind, description: v.description, quantity: v.quantity, unit: v.unit, rate_minor: v.rate, discount_minor: v.discount || 0, tax_code: v.tax_code, milestone: v.milestone }]); }} />
          <FormSheet visible={form === 'submit'} onClose={() => setForm(null)} title="Submit quote"
            fields={[{ key: 'valid_until', label: 'Valid until', type: 'date' }, { key: 'prices_include_tax', label: 'Prices include tax', type: 'switch', default: false }, { key: 'deposit_bp', label: 'Deposit (% of order)', type: 'stepper', min: 0, max: 100, default: 0, step: 5, optional: true },
              { key: 'cancellation', label: 'Cancellation terms', type: 'multiline', optional: true }, { key: 'warranty', label: 'Warranty', type: 'multiline', optional: true }, { key: 'sla', label: 'Service level (SLA)', type: 'multiline', optional: true }, { key: 'payment_terms', label: 'Payment terms', optional: true }, { key: 'staffing', label: 'Staffing & capacity', optional: true }]}
            onSubmit={async (v) => { await api.post(`/rfq-invites/${x.invite.id}/quote`, { lines, valid_until: localToIso(v.valid_until, '23:59', p.timezone || 'UTC'), prices_include_tax: v.prices_include_tax, terms: { ...(v.deposit_bp ? { deposit_bp: v.deposit_bp * 100 } : {}), cancellation: v.cancellation, warranty: v.warranty, sla: v.sla, payment_terms: v.payment_terms, staffing: v.staffing } }); setLines([]); r.reload(); return 'Quote submitted'; }} />
          <FormSheet visible={form === 'ask'} onClose={() => setForm(null)} title="Ask a question" fields={[{ key: 'body', label: 'Your question', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/rfqs/${x.id}/clarifications`, { body: v.body, invite_id: x.invite.id }); r.reload(); return 'Sent to the buyer'; }} />
          <FormSheet visible={form === 'decline'} onClose={() => setForm(null)} title="Decline this RFQ" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/rfq-invites/${x.invite.id}/respond`, { action: 'decline', reason: v.reason }); r.reload(); return 'Declined'; }} />
          <FormSheet visible={form === 'visit'} onClose={() => setForm(null)} title="Request a site visit" fields={[{ key: 'd', label: 'Preferred day', type: 'date' }, { key: 't', label: 'Time', type: 'time' }]} onSubmit={async (v) => { await api.post(`/rfq-invites/${x.invite.id}/respond`, { action: 'request_site_visit', site_visit_at: localToIso(v.d, v.t, p.timezone || 'UTC') }); r.reload(); return 'Requested'; }} />
        </>
      )}
    </Sheet>
  );
}

function Orders({ p, cat }) {
  const list = useLoad(() => api.get('/service-orders', { side: 'supplier', profile_id: p.id, limit: 50 }), [p.id]);
  const [open, setOpen] = useState(null);
  return (
    <>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data?.length ? list.data.map((o) => (
        <Row key={o.id} title={`${o.number} · ${o.title ?? catLabel(cat, o.category)}`} sub={`${o.buyer_name} · ${money(o.gross_minor, o.currency)} · fulfilment ${label(o.fulfilment)} · billing ${label(o.billing)} · ${label(o.settlement)}`} right={<Status s={o.status} />} onPress={() => setOpen(o)} />
      )) : <Empty emoji="📋" title="No orders yet" sub="Awarded quotes appear here for you to confirm." />}
      {open ? <OrderSheet id={open.id} p={p} cat={cat} onClose={() => { setOpen(null); list.reload(); }} /> : null}
    </>
  );
}

function OrderSheet({ id, p, onClose }) {
  const r = useLoad(() => api.get(`/service-orders/${id}`), [id]);
  const vis = useLoad(() => api.get(`/service-orders/${id}/visits`, { limit: 100 }), [id]);
  const act = useDo(() => { r.reload(); vis.reload(); });
  const [form, setForm] = useState(null);
  const o = r.data;
  if (!o) return <Sheet visible onClose={onClose} title="Order">{r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : <Loading />}</Sheet>;
  const tz = p.timezone || 'UTC';
  return (
    <Sheet visible onClose={onClose} title={o.number}>
      <Wrap><Status s={o.status} /><Status s={o.fulfilment} /><Tag2 k="billing" v={o.billing} /><Tag2 k="settlement" v={o.settlement} /></Wrap>
      <Kv k="buyer" v={o.buyer?.name} /><Kv k="total" v={money(o.gross_minor, o.currency)} /><Kv k="agreement" v={label(o.agreement_status)} />
      {o.travel_confirmation ? <Kv k="booking" v={`${label(o.travel_confirmation)}${o.third_party_ref ? ` · ref ${o.third_party_ref}` : ''} — a supplier confirmation, not a live airline/hotel reservation`} /> : null}
      <Wrap>
        <DocButton type="service_order" id={o.id} title="Order PDF" /><DocButton type="agreement" id={o.id} title="Agreement / SOW" /><DocButton type="completion_report" id={o.id} title="Completion report" />
      </Wrap>
      {['pending_supplier', 'changes_proposed'].includes(o.status) ? <Wrap><Btn small title="Confirm order" onPress={() => act(() => api.post(`/service-orders/${o.id}/respond`, { action: 'confirm' }), 'Confirmed — capacity reserved')} /><Btn small color={c.paper} ink={c.red} title="Reject" onPress={() => setForm('reject')} /></Wrap> : null}
      {['not_required', 'fully_signed', 'signed_by_supplier'].includes(o.agreement_status) ? null : <Btn small color={c.paper} ink={c.ink} title="Acknowledge agreement" onPress={() => setForm('sign')} style={{ alignSelf: 'flex-start' }} />}
      <Section title="Commercial chain"><ChainTrace path={`/service-orders/${o.id}/chain`} /></Section>
      <Section title="Lines">
        {o.lines.map((l) => <Row key={l.id} title={`${l.line_no}. ${l.description}`} sub={`${Number(l.qty_ordered)} ${label(l.unit)} · accepted ${Number(l.qty_accepted)} · invoiced ${Number(l.qty_invoiced)} · ${money(l.rate_minor, o.currency)}`} />)}
      </Section>
      {['confirmed', 'in_progress'].includes(o.status) ? <Btn small title="Schedule visits / shifts" onPress={() => setForm('visits')} style={{ alignSelf: 'flex-start' }} /> : null}
      <Section title="Visits">
        {vis.data?.length ? vis.data.map((v) => (
          <Row key={v.id} title={`${when(v.starts_at)}${v.site_label ? ` · ${v.site_label}` : ''}`} sub={`planned ${Number(v.planned_qty)}${v.actual_qty ? ` · actual ${Number(v.actual_qty)}` : ''}`}
            right={<><Status s={v.status} />
              {v.status === 'scheduled' ? <Btn small title="Start" onPress={() => act(() => api.post(`/service-visits/${v.id}/status`, { row_version: v.row_version, status: 'in_progress' }))} /> : null}
              {v.status === 'in_progress' || v.status === 'rework' ? <Btn small title="Submit work" onPress={() => setForm({ submit: v })} /> : null}
              <DocButton type="job_sheet" id={v.id} title="Job sheet" /></>} />
        )) : <Note>No visits scheduled.</Note>}
      </Section>
      <Section title="Billing">
        <Wrap><Btn small color={c.paper} ink={c.ink} title="New invoice" onPress={() => setForm('invoice')} /><Btn small color={c.paper} ink={c.ink} title="Propose a change" onPress={() => setForm('variation')} /></Wrap>
      </Section>
      <FormSheet visible={form === 'reject'} onClose={() => setForm(null)} title="Reject order" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/service-orders/${o.id}/respond`, { action: 'reject', reason: v.reason }); r.reload(); return 'Rejected'; }} />
      <FormSheet visible={form === 'sign'} onClose={() => setForm(null)} title="Acknowledge agreement" fields={[{ key: 'typed_name', label: 'Type your full name to acknowledge' }]} onSubmit={async (v) => { await api.post(`/service-orders/${o.id}/agreement`, v); r.reload(); return 'Recorded (this is an acknowledgement, not a qualified e-signature)'; }} />
      <FormSheet visible={form === 'visits'} onClose={() => setForm(null)} title="Schedule visits"
        fields={[{ key: 'line_no', label: 'Order line', type: 'chips', options: o.lines.filter((l) => l.status === 'active').map((l) => ({ value: l.line_no, label: `${l.line_no}. ${l.description.slice(0, 24)}` })) },
          { key: 'd', label: 'First day', type: 'date' }, { key: 't', label: 'Start time', type: 'time' }, { key: 'duration_minutes', label: 'Duration (minutes)', type: 'stepper', min: 15, max: 1440, step: 15, default: 60 }, { key: 'planned_qty', label: 'Quantity per visit', type: 'number' },
          { key: 'freq', label: 'Repeats', type: 'chips', options: [{ value: 'none', label: 'Once' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }], default: 'none' },
          { key: 'until', label: 'Until', type: 'date', show: (v) => v.freq && v.freq !== 'none' }, { key: 'resource_key', label: 'Site / pitch reference (for clash checks)', optional: true }, { key: 'site_label', label: 'Site name', optional: true }]}
        onSubmit={async (v) => { const s = await api.post(`/service-orders/${o.id}/visits`, { line_no: Number(v.line_no), starts_at: localToIso(v.d, v.t, tz), duration_minutes: v.duration_minutes, planned_qty: Number(v.planned_qty), ...(v.freq !== 'none' ? { recurrence: { freq: v.freq, until: v.until } } : {}), resource_key: v.resource_key, site_label: v.site_label }); act(async () => null); return `${s.created} visit${s.created === 1 ? '' : 's'} scheduled${s.skipped_existing ? ` (${s.skipped_existing} already existed)` : ''}`; }} />
      <FormSheet visible={!!form?.submit} onClose={() => setForm(null)} title="Submit work for acceptance" fields={[{ key: 'actual_qty', label: 'Quantity actually done', type: 'number' }, { key: 'notes', label: 'Notes', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/service-visits/${form.submit.id}/status`, { row_version: form.submit.row_version, status: 'submitted_for_acceptance', actual_qty: Number(v.actual_qty), notes: v.notes }); r.reload(); vis.reload(); return 'Submitted to the buyer'; }} />
      <FormSheet visible={form === 'invoice'} onClose={() => setForm(null)} title="New invoice"
        fields={[{ key: 'doc_type', label: 'Document', type: 'choice', options: [{ value: 'invoice', label: 'Invoice' }, { value: 'proforma', label: 'Pro forma' }] }, { key: 'kind', label: 'Billing for', type: 'chips', options: ['progress', 'final', 'milestone', 'deposit', 'visit'].map((k) => ({ value: k, label: label(k) })) },
          { key: 'line_no', label: 'Order line', type: 'chips', options: o.lines.map((l) => ({ value: l.line_no, label: `${l.line_no}. ${l.description.slice(0, 24)} (billable ${Number(l.qty_accepted) - Number(l.qty_invoiced)})` })), show: (v) => v.kind !== 'deposit' }, { key: 'quantity', label: 'Quantity to bill', type: 'number', show: (v) => v.kind !== 'deposit' },
          { key: 'milestone', label: 'Milestone', show: (v) => v.kind === 'milestone', optional: true }, { key: 'due_on', label: 'Due date', type: 'date', optional: true }]}
        onSubmit={async (v) => { const d = await api.post(`/service-orders/${o.id}/invoices`, { doc_type: v.doc_type, kind: v.kind, ...(v.kind === 'deposit' ? {} : { lines: [{ line_no: Number(v.line_no), quantity: Number(v.quantity) }] }), milestone: v.milestone, due_on: v.due_on }); r.reload(); return `Draft saved (${money(d.gross_minor, o.currency)}) — issue it from Finance`; }} />
      <FormSheet visible={form === 'variation'} onClose={() => setForm(null)} title="Propose a change"
        fields={[{ key: 'kind', label: 'What changes', type: 'chips', options: ['scope', 'cost', 'date', 'headcount', 'pause', 'resume', 'reschedule', 'partial_cancellation'].map((k) => ({ value: k, label: label(k) })) }, { key: 'reason', label: 'Reason', type: 'multiline' },
          { key: 'effective_on', label: 'Effective from', type: 'date', optional: true }, { key: 'line_no', label: 'Order line', type: 'chips', options: o.lines.map((l) => ({ value: l.line_no, label: `${l.line_no}. ${l.description.slice(0, 24)}` })), show: (v) => ['scope', 'cost', 'partial_cancellation', 'headcount'].includes(v.kind), optional: true },
          { key: 'qty', label: 'New quantity', type: 'number', show: (v) => ['scope', 'partial_cancellation', 'headcount'].includes(v.kind), optional: true }, { key: 'rate', label: 'New rate', type: 'money', currency: o.currency, show: (v) => v.kind === 'cost', optional: true }, { key: 'shift_days', label: 'Move by (days)', type: 'stepper', min: -365, max: 365, default: 0, show: (v) => ['date', 'reschedule'].includes(v.kind), optional: true }]}
        onSubmit={async (v) => { await api.post(`/service-orders/${o.id}/variations`, { kind: v.kind, reason: v.reason, effective_on: v.effective_on, changes: { ...(v.line_no ? { lines: [{ line_no: Number(v.line_no), ...(v.qty ? { qty_ordered: Number(v.qty) } : {}), ...(v.rate ? { rate_minor: v.rate } : {}) }] } : {}), ...(v.shift_days ? { shift_days: v.shift_days } : {}) } }); r.reload(); return 'Sent for the buyer to accept'; }} />
    </Sheet>
  );
}
const Tag2 = ({ k, v }) => <T size={12} color={c.mute}>{k} {label(v)}</T>;

function Calendar({ p }) {
  const from = new Date().toISOString().slice(0, 10), to = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const cal = useLoad(() => api.get(`/supplier-profiles/${p.id}/calendar`, { from, to }), [p.id]);
  const act = useDo(cal.reload);
  const [form, setForm] = useState(false);
  if (cal.loading) return <Loading />;
  if (cal.error) return <ErrorBox error={cal.error} onRetry={cal.reload} />;
  const days = {};
  for (const v of cal.data.visits) (days[v.starts_at.slice(0, 10)] ??= []).push(v);
  for (const b of cal.data.blackouts) (days[b.day.slice(0, 10)] ??= []).push({ blackout: true, ...b });
  return (
    <>
      <Wrap><Btn small color={c.paper} ink={c.ink} title="Mark a day unavailable" onPress={() => setForm(true)} /></Wrap>
      {Object.keys(days).sort().map((d) => (
        <Card key={d} pad={12}><T weight="800">{day(d)}</T>{days[d].map((v, n) => v.blackout ? <T key={n} size={13} color={c.red}>Unavailable{v.reason ? ` — ${v.reason}` : ''}</T> : <T key={n} size={13}>{when(v.starts_at).split(',').slice(-1)[0]} · {v.number}{v.site_label ? ` · ${v.site_label}` : ''} · {label(v.status)}{v.crew ? ` · crew ${v.crew}` : ''}</T>)}</Card>
      )) || null}
      {!Object.keys(days).length ? <Empty emoji="🗓️" title="Nothing scheduled in the next 30 days" /> : null}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Unavailable day" fields={[{ key: 'day', label: 'Day', type: 'date' }, { key: 'reason', label: 'Reason', optional: true }]} onSubmit={async (v) => { await api.post(`/supplier-profiles/${p.id}/blackouts`, v); cal.reload(); return 'Saved'; }} />
    </>
  );
}

function Customers({ p }) {
  const d = useLoad(() => api.get(`/supplier-profiles/${p.id}/dashboard`), [p.id]);
  if (d.loading) return <Loading />;
  const rows = d.data?.orders.by_customer ?? [];
  return rows.length ? rows.map((r) => <Row key={`${r.buyer_id}${r.currency}`} title={r.name} sub={`${r.orders} order${r.orders === 1 ? '' : 's'}`} right={<T weight="800">{money(r.gross_minor, r.currency)}</T>} />) : <Empty emoji="🤝" title="No customers yet" />;
}

function Finance({ p, cat }) {
  const inv = useLoad(() => api.get('/service-invoices', { side: 'supplier', profile_id: p.id, limit: 50 }), [p.id]);
  const rules = useLoad(() => api.get(`/supplier-profiles/${p.id}/tax-rules`, { limit: 50 }), [p.id]);
  const act = useDo(() => { inv.reload(); rules.reload(); });
  const [form, setForm] = useState(null);
  return (
    <>
      <Section title="Tax configuration">
        <Note>You decide the tax treatment that applies to your supply. GotMyGame prints and totals what you configure; it does not assert any jurisdiction’s rules or file e-invoices.</Note>
        {rules.data?.map((t) => <Row key={t.id} title={`${t.code} · ${t.name}`} sub={`${t.jurisdiction} · ${label(t.treatment)} ${(t.rate_bp / 100).toFixed(2)}%${t.withholding_bp ? ` · withholding ${(t.withholding_bp / 100).toFixed(2)}%` : ''} · from ${day(t.effective_from)}`} />)}
        <Btn small color={c.paper} ink={c.ink} title="Add a tax rule" onPress={() => setForm('tax')} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Invoices">
        {inv.loading ? <Loading /> : inv.data?.length ? inv.data.map((i) => (
          <Row key={i.id} title={`${i.status === 'draft' ? 'Draft' : i.supplier_number} · ${label(i.doc_type)}`} sub={`${i.order_number} · ${money(i.gross_minor, i.currency)}${Number(i.paid_minor) ? ` · paid ${money(i.paid_minor, i.currency)}` : ''} · match ${label(i.match_status)}`}
            right={<><Status s={i.status === 'issued' ? i.pay_status : i.status} />
              {i.status === 'draft' ? <Btn small title="Issue" onPress={() => act(() => api.post(`/service-invoices/${i.id}/issue`, {}), 'Issued')} /> : null}
              {i.status === 'issued' && i.doc_type === 'invoice' && i.pay_status !== 'paid' ? <Btn small color={c.paper} ink={c.ink} title="Record payment" onPress={() => setForm({ pay: i })} /> : null}
              {i.status === 'issued' && i.doc_type === 'invoice' ? <Btn small color={c.paper} ink={c.ink} title="Credit note" onPress={() => setForm({ credit: i })} /> : null}
              <DocButton type="invoice" id={i.id} title="PDF" /></>} />
        )) : <Empty emoji="🧾" title="No invoices yet" sub="Create an invoice from an order once work is accepted." />}
      </Section>
      <FormSheet visible={form === 'tax'} onClose={() => setForm(null)} title="Tax rule"
        fields={[{ key: 'code', label: 'Code (e.g. GST18)' }, { key: 'name', label: 'Name' }, { key: 'jurisdiction', label: 'Jurisdiction' }, { key: 'treatment', label: 'Treatment', type: 'chips', options: ['standard', 'zero_rated', 'exempt', 'reverse_charge'].map((k) => ({ value: k, label: label(k) })) },
          { key: 'rate', label: 'Rate (%)', type: 'stepper', min: 0, max: 100, default: 0, show: (v) => v.treatment === 'standard' }, { key: 'withholding', label: 'Buyer withholding (%)', type: 'stepper', min: 0, max: 100, default: 0, optional: true },
          { key: 'prices_include_tax', label: 'Prices include tax', type: 'switch', default: false }, { key: 'rounding', label: 'Rounding', type: 'choice', options: [{ value: 'per_line', label: 'Per line' }, { value: 'per_document', label: 'Per document' }] }, { key: 'effective_from', label: 'Applies from', type: 'date' }]}
        onSubmit={async (v) => { await api.post(`/supplier-profiles/${p.id}/tax-rules`, { code: v.code, name: v.name, jurisdiction: v.jurisdiction, treatment: v.treatment, rate_bp: v.treatment === 'standard' ? Math.round(v.rate * 100) : 0, withholding_bp: Math.round((v.withholding || 0) * 100), prices_include_tax: v.prices_include_tax, rounding: v.rounding, effective_from: v.effective_from }); rules.reload(); return 'Saved'; }} />
      <FormSheet visible={!!form?.pay} onClose={() => setForm(null)} title="Record money received"
        fields={[{ key: 'source', label: 'How', type: 'choice', options: [{ value: 'manual_bank', label: 'Bank' }, { value: 'manual_cash', label: 'Cash' }, { value: 'manual_other', label: 'Other' }] }, { key: 'amount', label: 'Amount', type: 'money', currency: form?.pay?.currency }, { key: 'paid_on', label: 'Received on', type: 'date' }, { key: 'reference', label: 'Bank / receipt reference' }, { key: 'evidence', label: 'Evidence (what you saw)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/service-invoices/${form.pay.id}/payments`, { source: v.source, amount_minor: v.amount, paid_on: v.paid_on, reference: v.reference, evidence: v.evidence }); inv.reload(); return 'Recorded — this is a ledger entry; no money moved'; }} />
      <FormSheet visible={!!form?.credit} onClose={() => setForm(null)} title="Credit note" fields={[{ key: 'amount', label: 'Amount to credit', type: 'money', currency: form?.credit?.currency }, { key: 'reason', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { const r = await api.post(`/service-invoices/${form.credit.id}/credit-note`, { amount_minor: v.amount, reason: v.reason }); inv.reload(); return r.refund_note ?? 'Credit note issued'; }} />
    </>
  );
}

function Reports({ p }) {
  const d = useLoad(() => api.get(`/supplier-profiles/${p.id}/dashboard`), [p.id]);
  const [csv, setCsv] = useState(null);
  const { push } = useNav();
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  const x = d.data;
  return (
    <>
      <Wrap>
        <Kpi title="Response rate" value={x.enquiries.response_rate == null ? '—' : `${Math.round(x.enquiries.response_rate * 100)}%`} sub={x.enquiries.avg_response_hours ? `${x.enquiries.avg_response_hours}h avg` : ''} />
        <Kpi title="On-time visits" value={x.delivery.on_time_rate == null ? '—' : `${Math.round(x.delivery.on_time_rate * 100)}%`} />
        <Kpi title="Rework" value={x.delivery.rework_rate == null ? '—' : `${Math.round(x.delivery.rework_rate * 100)}%`} sub={`${x.delivery.no_show} no-show · ${x.delivery.cancelled} cancelled`} />
        <Kpi title="Utilisation" value={x.delivery.utilisation == null ? '—' : `${Math.round(x.delivery.utilisation * 100)}%`} />
      </Wrap>
      <Section title="Money (per currency)">{x.finance.by_currency.map((m) => <Row key={m.currency} title={m.currency} sub={`billed ${money(m.billed_minor, m.currency)} · collected ${money(m.collected_minor, m.currency)}`} right={<T weight="800">{money(m.outstanding_minor, m.currency)} due</T>} />)}</Section>
      <Section title="Ageing">{x.finance.ageing.length ? x.finance.ageing.map((a) => <Row key={a.currency} title={a.currency} sub={`not due ${money(a.not_due, a.currency)} · 1–30 ${money(a.d1_30, a.currency)} · 31–60 ${money(a.d31_60, a.currency)} · 61–90 ${money(a.d61_90, a.currency)} · 90+ ${money(a.d90_plus, a.currency)}`} />) : <Note>Nothing outstanding.</Note>}</Section>
      <Section title="Tax summary">{x.finance.tax.length ? x.finance.tax.map((t) => <Row key={t.currency + t.tax_code} title={`${t.currency} · ${t.tax_code}`} sub={`net ${money(t.net_minor, t.currency)}`} right={<T weight="800">{money(t.tax_minor, t.currency)}</T>} />) : <Note>No invoices in this period.</Note>}</Section>
      <Wrap>
        {['orders', 'invoices', 'payments', 'tax'].map((k) => <Btn key={k} small color={c.paper} ink={c.ink} title={`CSV: ${k}`} onPress={async () => setCsv(await api.get('/service-reports/export', { side: 'supplier', scope_id: p.id, report: k }))} />)}
        <DocButton type="statement" id={p.id} title="Statement PDF" /><DocButton type="supplier_report" id={p.id} title="Dashboard PDF" small={false} />
      </Wrap>
      <ExportsPanel side="supplier" scopeId={p.id} />
      <Sheet visible={!!csv} onClose={() => setCsv(null)} title={csv?.filename ?? ''}><Note>{csv?.rows} rows{csv?.truncated ? ' (truncated — narrow the dates)' : ''}. Copy the text into a spreadsheet.</Note><T size={11} selectable>{csv?.csv}</T></Sheet>
      <Note>{Object.values(x.definitions).slice(0, 3).join(' · ')}</Note>
    </>
  );
}

function Team({ p, cat, reload }) {
  const full = useLoad(() => api.get(`/supplier-profiles/${p.id}`), [p.id]);
  const act = useDo(() => { full.reload(); reload(); });
  const [form, setForm] = useState(null);
  const x = full.data;
  if (!x) return <Loading />;
  return (
    <>
      <Section title="Staff roles">
        {x.staff?.map((s) => <Row key={s.id} title={s.display_name} sub={`@${s.handle}`} right={<><Status s={s.role} />{s.role !== 'owner' ? <Btn small color={c.paper} ink={c.red} title="Remove" onPress={() => act(() => api.del(`/supplier-staff/${s.id}`), 'Access ended')} /> : null}</>} />)}
        <Btn small color={c.paper} ink={c.ink} title="Add a person" onPress={() => setForm('staff')} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Certificates & insurance">
        {x.credentials?.length ? x.credentials.map((k) => <Row key={k.id} title={k.title} sub={`${label(k.kind)} · ${k.valid_to ? `valid to ${day(k.valid_to)}` : 'no expiry'} · ${k.badge}`} right={<Status s={k.state} />} />) : <Note>None recorded. Badges say exactly what was checked.</Note>}
        <Btn small color={c.paper} ink={c.ink} title="Add a certificate" onPress={() => setForm('cred')} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Btn small color={c.paper} ink={c.ink} title="Edit profile" onPress={() => setForm('edit')} style={{ alignSelf: 'flex-start' }} />
      <FormSheet visible={form === 'staff'} onClose={() => setForm(null)} title="Add a person" fields={[{ key: 'user_id', label: 'Person', type: 'entity', entityKind: 'person', noun: 'person' }, { key: 'role', label: 'Role', type: 'chips', options: ['sales', 'scheduler', 'supervisor', 'finance', 'crew'].map((k) => ({ value: k, label: label(k) })) }]} onSubmit={async (v) => { await api.post(`/supplier-profiles/${p.id}/staff`, { user_id: v.user_id, role: v.role }); full.reload(); return 'Added'; }} />
      <FormSheet visible={form === 'cred'} onClose={() => setForm(null)} title="Certificate or insurance"
        fields={[{ key: 'kind', label: 'Kind', type: 'chips', options: ['insurance', 'electrical', 'pool_operator', 'first_aid', 'safeguarding', 'vehicle', 'food_safety', 'business_registration', 'other'].map((k) => ({ value: k, label: label(k) })) }, { key: 'title', label: 'Title' }, { key: 'reference', label: 'Reference', optional: true }, { key: 'valid_to', label: 'Valid until', type: 'date', optional: true }, { key: 'required_for_award', label: 'Buyers must see this valid before awarding', type: 'switch', default: false }]}
        onSubmit={async (v) => { await api.post(`/supplier-profiles/${p.id}/credentials`, v); full.reload(); return 'Saved (self-declared until checked)'; }} />
      <ProfileForm cat={cat} visible={form === 'edit'} onClose={() => setForm(null)} id={p.id} initial={x} onDone={() => { act(async () => null); setForm(null); }} />
    </>
  );
}
