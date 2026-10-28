// Commercial console (#504) — platform admin only. The single home for the product catalogue, price versions, entitlements, offers,
// per-account plans / overrides / usage, pricing simulation and the audit trail. Everything here is the same REST API agents use over MCP;
// the server refuses anyone who is not the platform admin, and the entry point is hidden for every other role.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Section, Seg, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';

const label = (s) => String(s ?? '').replace(/[_.]/g, ' ');
const d10 = (d) => (d ? String(d).slice(0, 10) : '');
const money = (minor, cur = 'INR') => moneyIn(Number(minor ?? 0), cur);
const INTERVALS = ['monthly', 'annual', 'one_time', 'per_event', 'usage'];
const SUBJECTS = [['user', 'Person'], ['organisation', 'Organisation'], ['team', 'Team'], ['venue', 'Venue'], ['event', 'Event']];
const TONE = { published: c.lime, active: c.lime, trial: c.cyanSoft, draft: c.violetSoft, retired: c.mute, pending_payment: c.sunSoft, cancelled: c.orangeSoft, ended: c.mute };
const St = ({ s }) => <Tag label={label(s)} color={TONE[s] ?? c.violetSoft} />;
const wrap = { flexDirection: 'row', flexWrap: 'wrap', gap: 8 };

function useAct(reload) {
  const { toast } = useSession();
  return async (fn, ok) => { try { const r = await fn(); toast(ok ?? 'Done'); reload?.(); return r; } catch (e) { toast(e.message); return null; } };
}
const Block = ({ state, children }) => (state.loading && !state.data ? <Loading /> : state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : children);

/** Every price point (a sellable slot, identified by its code) with its current published price, from the catalogue. */
const pricePointsOf = (cat) => {
  const out = new Map();
  for (const p of cat.data?.products ?? []) for (const pl of p.plans) for (const v of pl.versions) {
    if (v.status !== 'published' && out.has(v.price_point_code)) continue;
    if (v.status === 'retired' && out.has(v.price_point_code)) continue;
    out.set(v.price_point_code, { code: v.price_point_code, plan: pl.name, plan_key: pl.key, interval: v.billing_interval, currency: v.currency, amount: v.amount_minor, product: p.name });
  }
  for (const b of cat.data?.bundles ?? []) {
    const live = b.versions.find((v) => v.status === 'published');
    out.set(b.price_point_code, { code: b.price_point_code, plan: `${b.name} (bundle)`, plan_key: b.key, interval: b.billing_interval, currency: b.currency, amount: live?.price_minor ?? null, bundle: true });
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
};
const ppOption = (x) => ({ value: x.code, label: `${x.code} · ${x.amount == null ? 'needs a price' : money(x.amount, x.currency)}` });
const CodeTag = ({ code }) => <Tag label={code} color={c.cyanSoft} style={{ alignSelf: 'flex-start' }} />;

/** Offers that can apply to the chosen plan (and interval): attached to one of its price points, or to all. */
const offersFor = (cat, planKey, interval, bundleKey) => {
  const codes = bundleKey ? (cat.data?.bundles ?? []).filter((b) => b.key === bundleKey).map((b) => b.price_point_code) : pricePointsOf(cat).filter((x) => !x.bundle && x.plan_key === planKey && (!interval || x.interval === interval)).map((x) => x.code);
  return (cat.data?.promotions ?? []).filter((p) => p.status === 'active' && (!p.price_points.length || p.price_points.some((x) => codes.includes(x))));
};

const priceText = (v) => `${money(v.amount_minor, v.currency)} / ${label(v.billing_interval)}`;
const versionLine = (v) => `v${v.version} · ${priceText(v)} · from ${d10(v.effective_from)}${v.effective_to ? ` to ${d10(v.effective_to)}` : ''}`;

// ------------------------------------------------------------------ version sheet (details + draft editing)
function VersionSheet({ version, plan, keys, onClose, reload }) {
  const act = useAct(reload);
  const [addEnt, setAddEnt] = useState(false);
  const [addCmp, setAddCmp] = useState(false);
  if (!version) return null;
  const draft = version.status === 'draft';
  const base = () => ({
    region: version.region, currency: version.currency, billing_interval: version.billing_interval, amount_minor: Number(version.amount_minor), components: version.components,
    tax_bp: version.tax_bp, tax_ref: version.tax_ref ?? undefined, trial_days: version.trial_days, proration_policy: version.proration_policy,
    effective_from: d10(version.effective_from), effective_to: version.effective_to ? d10(version.effective_to) : undefined, entitlements: version.entitlements,
  });
  const save = (patch, ok) => act(() => api.patch(`/admin/commercial/versions/${version.id}`, { ...base(), ...patch }), ok).then((r) => r && onClose());
  return (
    <Sheet visible onClose={onClose} title={`${plan.name} · v${version.version}`}>
      <View style={wrap}><St s={version.status} /><Tag label={`${version.region} · ${version.currency}`} /><CodeTag code={version.price_point_code} /></View>
      <T weight="800">{priceText(version)}</T>
      <T size={13} color={c.mute}>Effective {d10(version.effective_from)}{version.effective_to ? ` – ${d10(version.effective_to)}` : ' onwards'} · tax {version.tax_bp / 100}%{version.trial_days ? ` · ${version.trial_days}-day trial` : ''} · proration {label(version.proration_policy)}</T>
      <Section title="Priced components" color={c.cyan}>
        {version.components.length === 0 ? <T size={13} color={c.mute}>Just the base price.</T> : null}
        {version.components.map((x, n) => (
          <Row key={n} title={x.label} sub={x.kind === 'percent_fee' ? `${x.bp / 100}% of ${label(x.applies_to)}${x.cap_minor != null ? `, capped at ${money(x.cap_minor, version.currency)}` : ''}` : x.kind === 'band' ? x.bands.map((b) => `${b.up_to == null ? 'more' : `≤${b.up_to}`}: ${money(b.amount_minor, version.currency)}`).join(' · ') : x.kind === 'per_unit' ? `${money(x.unit_amount_minor, version.currency)} per ${x.unit}${x.included ? `, ${x.included} included` : ''}` : x.kind === 'usage' ? `${money(x.unit_amount_minor, version.currency)} per ${x.meter}${x.included ? `, ${x.included} included` : ''}` : money(x.amount_minor, version.currency)}
            right={draft ? <Btn small title="Remove" color={c.paper} ink={c.ink} accessibilityLabel={`Remove ${x.label}`} onPress={() => save({ components: version.components.filter((_, i) => i !== n) }, 'Removed')} /> : null} />
        ))}
        {draft ? <Btn small title="Add a component" color={c.cyan} ink={c.ink} onPress={() => setAddCmp(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>
      <Section title="Entitlements this plan grants" color={c.lime}>
        {version.entitlements.length === 0 ? <T size={13} color={c.mute}>None yet.</T> : null}
        {version.entitlements.map((e) => (
          <Row key={e.key} title={label(e.key)} sub={e.limit_value == null ? 'included, no limit' : `limit ${e.limit_value} · ${e.limit_behaviour === 'hard' ? 'blocks at the limit' : e.limit_behaviour === 'soft' ? 'flags past the limit' : 'warns only'}`}
            right={draft ? <Btn small title="Remove" color={c.paper} ink={c.ink} accessibilityLabel={`Remove ${label(e.key)}`} onPress={() => save({ entitlements: version.entitlements.filter((x) => x.key !== e.key) }, 'Removed')} /> : null} />
        ))}
        {draft ? <Btn small title="Add an entitlement" color={c.lime} ink={c.ink} onPress={() => setAddEnt(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>
      {draft ? <Btn title="Publish this version" onPress={() => act(() => api.post(`/admin/commercial/versions/${version.id}/publish`), 'Published — it is now frozen').then((r) => r && onClose())} accessibilityLabel="Publish version" /> : null}
      {version.status === 'published' ? <Btn title="Stop selling this version" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/admin/commercial/versions/${version.id}/retire`), 'Retired').then((r) => r && onClose())} /> : null}
      {!draft ? <T size={12} color={c.mute}>Published versions are frozen. Customers keep the version they bought; to change a price, publish a new version with a later start date.</T> : null}

      <FormSheet visible={addEnt} onClose={() => setAddEnt(false)} title="Add an entitlement" submitLabel="Add"
        initial={{ limit_behaviour: 'hard', unlimited: true, limit_value: 0 }}
        fields={[
          { key: 'key', label: 'What it covers', type: 'chips', options: keys.map((k) => ({ value: k, label: label(k) })) },
          { key: 'unlimited', label: 'Included without a limit', type: 'switch' },
          { key: 'limit_value', label: 'Limit', type: 'stepper', min: 0, max: 1000000, step: 1, show: (v) => !v.unlimited },
          { key: 'limit_behaviour', label: 'At the limit', type: 'choice', options: [{ value: 'hard', label: 'Block' }, { value: 'soft', label: 'Flag only' }, { value: 'warn', label: 'Warn' }], show: (v) => !v.unlimited },
        ]}
        onSubmit={async (v) => { await api.patch(`/admin/commercial/versions/${version.id}`, { ...base(), entitlements: [...version.entitlements.filter((e) => e.key !== v.key), { key: v.key, limit_value: v.unlimited ? null : v.limit_value, limit_behaviour: v.limit_behaviour ?? 'hard', warn_at_pct: 80 }] }); reload(); onClose(); return 'Entitlement added'; }} />
      <FormSheet visible={addCmp} onClose={() => setAddCmp(false)} title="Add a priced component" submitLabel="Add"
        initial={{ kind: 'fixed', unit: 'seat', applies_to: 'booking', up_to: 30 }}
        fields={[
          { key: 'kind', label: 'Type', type: 'chips', options: [{ value: 'fixed', label: 'Fixed fee' }, { value: 'per_unit', label: 'Per seat / team / location' }, { value: 'band', label: 'Band step (e.g. athletes)' }, { value: 'usage', label: 'Usage' }, { value: 'percent_fee', label: 'Percentage / commission' }] },
          { key: 'label', label: 'Name on the invoice' },
          { key: 'unit', label: 'Per', type: 'chips', options: [{ value: 'seat', label: 'Seat' }, { value: 'team', label: 'Team' }, { value: 'location', label: 'Location' }, { value: 'athlete', label: 'Athlete' }, { value: 'event', label: 'Event' }], show: (v) => v.kind === 'per_unit' || v.kind === 'band' },
          { key: 'up_to', label: 'Up to this many (0 = no upper limit)', type: 'stepper', min: 0, max: 1000000, step: 10, show: (v) => v.kind === 'band' },
          { key: 'meter', label: 'Meter', type: 'chips', options: keys.map((k) => ({ value: k, label: label(k) })), show: (v) => v.kind === 'usage' },
          { key: 'amount', label: 'Amount', type: 'money', currency: version.currency, show: (v) => v.kind !== 'percent_fee' },
          { key: 'included', label: 'Included free', type: 'stepper', min: 0, max: 1000000, step: 1, show: (v) => v.kind === 'per_unit' || v.kind === 'usage' },
          { key: 'applies_to', label: 'Charged on', type: 'chips', options: [{ value: 'booking', label: 'Bookings' }, { value: 'transaction', label: 'Transactions' }, { value: 'sale', label: 'Sales' }, { value: 'commission', label: 'Commission' }], show: (v) => v.kind === 'percent_fee' },
          { key: 'pct', label: 'Rate (0% is allowed)', type: 'stepper', min: 0, max: 100, step: 1, suffix: '%', show: (v) => v.kind === 'percent_fee' },
          { key: 'cap', label: 'Cap per transaction', type: 'money', currency: version.currency, optional: true, show: (v) => v.kind === 'percent_fee' },
        ]}
        onSubmit={async (v) => {
          const comps = [...version.components];
          if (v.kind === 'fixed') comps.push({ kind: 'fixed', label: v.label, amount_minor: v.amount });
          else if (v.kind === 'per_unit') comps.push({ kind: 'per_unit', label: v.label, unit: v.unit, unit_amount_minor: v.amount, included: v.included ?? 0 });
          else if (v.kind === 'usage') comps.push({ kind: 'usage', label: v.label, meter: v.meter, unit_amount_minor: v.amount, included: v.included ?? 0 });
          else if (v.kind === 'percent_fee') comps.push({ kind: 'percent_fee', label: v.label, applies_to: v.applies_to, bp: Math.round((v.pct ?? 0) * 100), ...(v.cap ? { cap_minor: v.cap } : {}) });
          else {
            const step = { up_to: v.up_to > 0 ? v.up_to : null, amount_minor: v.amount };
            const i = comps.findIndex((x) => x.kind === 'band' && x.unit === v.unit);
            if (i >= 0) comps[i] = { ...comps[i], bands: [...comps[i].bands.filter((b) => b.up_to != null), step].sort((a, b) => (a.up_to ?? 1e12) - (b.up_to ?? 1e12)) };
            else comps.push({ kind: 'band', label: v.label, unit: v.unit, bands: [step] });
          }
          await api.patch(`/admin/commercial/versions/${version.id}`, { ...base(), components: comps }); reload(); onClose(); return 'Component added';
        }} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ catalogue tab
function Catalogue({ cat, keys }) {
  const act = useAct(cat.reload);
  const [open, setOpen] = useState(null);
  const [newProduct, setNewProduct] = useState(false);
  const [newPlan, setNewPlan] = useState(false);
  const [newVersion, setNewVersion] = useState(null);
  const data = cat.data;
  const plans = (data?.products ?? []).flatMap((p) => p.plans);
  const needsPrice = plans.filter((p) => p.status === 'active' && !p.versions.some((v) => v.status === 'published'));
  return (
    <Block state={cat}>
      <View style={wrap}>
        <StatPill value={String(data?.products.length ?? 0)} label="products" />
        <StatPill value={String(plans.length)} label="plans" color={c.cyanSoft} />
        <StatPill value={String(needsPrice.length)} label="need a price" color={c.sunSoft} />
        <StatPill value={String(plans.flatMap((p) => p.versions).filter((v) => v.status === 'draft').length)} label="drafts" color={c.violetSoft} />
      </View>
      <View style={wrap}>
        <Btn small title="Load India launch catalogue" onPress={() => act(async () => { const r = await api.post('/admin/commercial/import', { source: 'india_launch' }); return r; }, 'Catalogue loaded — nothing existing was changed')} accessibilityLabel="Load India launch catalogue" />
        <Btn small title="New product" color={c.cyan} ink={c.ink} onPress={() => setNewProduct(true)} />
        <Btn small title="New plan" color={c.lime} ink={c.ink} onPress={() => setNewPlan(true)} />
      </View>
      {data?.products.length === 0 ? <Empty emoji="🏷️" title="No catalogue yet" sub="Load the India launch baseline or add a product. Prices and limits are data you publish, never screen constants." /> : null}
      <View style={wrap}>
        {(data?.products ?? []).map((p) => (
          <Card key={p.id} style={{ flexGrow: 1, flexBasis: 320, minWidth: 280 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{p.name}</T><Tag label={label(p.family)} /></View>
            {p.plans.length === 0 ? <T size={13} color={c.mute}>No plans yet.</T> : null}
            {p.plans.map((pl) => {
              const live = pl.versions.filter((v) => v.status === 'published');
              return (
                <View key={pl.id} style={{ gap: 6, marginTop: 10 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <T weight="700">{pl.name}</T>
                    {pl.kind === 'addon' ? <Tag label="add-on" /> : null}
                    {pl.is_default ? <Tag label="default" color={c.lime} /> : null}
                    {!live.length ? <Tag label="needs a price" color={c.sunSoft} /> : null}
                  </View>
                  <T size={12} color={c.mute}>For {pl.eligible_actors.join(', ')}</T>
                  {pl.versions.map((v) => <Row key={v.id} title={versionLine(v)} sub={`${v.price_point_code} · ${v.entitlements.length} entitlement${v.entitlements.length === 1 ? '' : 's'}`} right={<St s={v.status} />} onPress={() => setOpen({ version: v, plan: pl })} />)}
                  <Btn small title="New price version" color={c.paper} ink={c.ink} accessibilityLabel={`New price version for ${pl.name}`} onPress={() => setNewVersion(pl)} style={{ alignSelf: 'flex-start' }} />
                </View>
              );
            })}
          </Card>
        ))}
      </View>

      {open ? <VersionSheet version={open.version} plan={open.plan} keys={keys} onClose={() => setOpen(null)} reload={cat.reload} /> : null}

      <FormSheet visible={newProduct} onClose={() => setNewProduct(false)} title="New product" submitLabel="Create"
        initial={{ family: 'other' }}
        fields={[{ key: 'name', label: 'Name' }, { key: 'key', label: 'Short code (a–z, 0–9, _)', hint: 'Used in the API, never shown to customers' },
          { key: 'family', label: 'Family', type: 'chips', options: ['athlete', 'professional', 'team', 'club', 'academy', 'venue', 'event', 'supplier', 'sponsor', 'education', 'enterprise', 'usage', 'other'].map((v) => ({ value: v, label: label(v) })) },
          { key: 'description', label: 'Description', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post('/admin/commercial/products', v); cat.reload(); return 'Product created'; }} />
      <FormSheet visible={newPlan} onClose={() => setNewPlan(false)} title="New plan or add-on" submitLabel="Create"
        initial={{ kind: 'base', eligible_actors: ['user'] }}
        fields={[{ key: 'product_key', label: 'Product', type: 'chips', options: (data?.products ?? []).map((p) => ({ value: p.key, label: p.name })) },
          { key: 'name', label: 'Name' }, { key: 'key', label: 'Short code (a–z, 0–9, _)' },
          { key: 'kind', label: 'Kind', type: 'choice', options: [{ value: 'base', label: 'Plan' }, { value: 'addon', label: 'Add-on' }] },
          { key: 'eligible_actors', label: 'Who can hold it', type: 'multi', options: SUBJECTS.map(([value, l]) => ({ value, label: l })) },
          { key: 'requires', label: 'Add-on needs one of these plans', type: 'multi', optional: true, options: plans.filter((p) => p.kind === 'base').map((p) => ({ value: p.key, label: p.name })), show: (v) => v.kind === 'addon' },
          { key: 'is_default', label: 'The free plan everyone of this kind starts on', type: 'switch', show: (v) => v.kind === 'base' }]}
        onSubmit={async (v) => { await api.post('/admin/commercial/plans', { ...v, is_default: !!v.is_default, requires: v.requires ?? [] }); cat.reload(); return 'Plan created'; }} />
      <FormSheet visible={!!newVersion} onClose={() => setNewVersion(null)} title={`New price version · ${newVersion?.name ?? ''}`} submitLabel="Save as draft" notice="A draft is not live. Add components and entitlements, then publish — after that it is frozen."
        initial={{ region: 'IN', currency: 'INR', billing_interval: 'monthly', proration_policy: 'none', trial_days: 0, tax: 0, amount: 0, effective_from: new Date().toISOString().slice(0, 10) }}
        fields={[
          { key: 'billing_interval', label: 'Billed', type: 'chips', options: INTERVALS.map((v) => ({ value: v, label: label(v) })) },
          { key: 'currency', label: 'Currency', type: 'currency' },
          { key: 'region', label: 'Region', type: 'country' },
          { key: 'amount', label: 'Base price', type: 'money', currency: (v) => v.currency ?? 'INR' },
          { key: 'tax', label: 'Tax added on top', type: 'stepper', min: 0, max: 100, step: 1, suffix: '%' },
          { key: 'trial_days', label: 'Free trial', type: 'stepper', min: 0, max: 365, step: 7, suffix: ' days' },
          { key: 'proration_policy', label: 'When the plan changes mid-period', type: 'chips', options: [{ value: 'none', label: 'No proration' }, { value: 'prorate', label: 'Prorate' }, { value: 'credit', label: 'Credit unused' }, { value: 'at_period_end', label: 'Switch at period end' }] },
          { key: 'effective_from', label: 'Starts', type: 'date' },
          { key: 'effective_to', label: 'Ends (optional)', type: 'date', optional: true },
        ]}
        onSubmit={async (v) => {
          await api.post(`/admin/commercial/plans/${newVersion.key}/versions`, { region: v.region, currency: v.currency, billing_interval: v.billing_interval, amount_minor: v.amount, tax_bp: Math.round((v.tax ?? 0) * 100), trial_days: v.trial_days ?? 0, proration_policy: v.proration_policy, effective_from: v.effective_from, ...(v.effective_to ? { effective_to: v.effective_to } : {}), components: [], entitlements: [] });
          cat.reload(); return 'Draft saved — open it to add components and entitlements';
        }} />
    </Block>
  );
}

// ------------------------------------------------------------------ simulate tab
function Simulate({ cat }) {
  const [res, setRes] = useState(null);
  const plans = (cat.data?.products ?? []).flatMap((p) => p.plans).filter((p) => p.versions.some((v) => v.status === 'published'));
  const bundles = (cat.data?.bundles ?? []).filter((b) => b.versions.some((v) => v.status === 'published'));
  return (
    <Block state={cat}>
      {plans.length === 0 ? <Empty emoji="🧮" title="Nothing to simulate yet" sub="Publish a price version first." /> : (
        <FormSheet inline onClose={() => {}} title="Simulate" submitLabel="Simulate pricing" initial={{ seat: 0, team: 0, location: 0, athlete: 0, event: 0, gmv: 0 }}
          fields={[
            { key: 'plan_key', label: 'Plan', type: 'chips', optional: true, options: plans.map((p) => ({ value: p.key, label: p.name })) },
            ...(bundles.length ? [{ key: 'bundle_key', label: 'Or a bundle (several profiles of one person)', type: 'chips', optional: true, options: bundles.map((b) => ({ value: b.key, label: b.name })) }] : []),
            { key: 'billing_interval', label: 'Billed', type: 'chips', optional: true, options: INTERVALS.map((v) => ({ value: v, label: label(v) })) },
            ...['seat', 'team', 'location', 'athlete', 'event'].map((u) => ({ key: u, label: `${label(u)}s`, type: 'stepper', min: 0, max: 100000, step: u === 'athlete' ? 10 : 1 })),
            { key: 'gmv', label: 'Expected sales (to see a percentage fee in money)', type: 'money', currency: 'INR', optional: true },
            { key: 'at', label: 'On this date', type: 'date', optional: true },
            { key: 'promotion_key', label: 'Offer (only those attached to this price point are listed)', type: 'chips', optional: true, options: (v) => offersFor(cat, v.plan_key, v.billing_interval, v.bundle_key).map((p) => ({ value: p.key, label: p.name })) },
          ]}
          onSubmit={async (v) => { if (!v.plan_key && !v.bundle_key) throw new Error('Pick a plan or a bundle'); setRes(await api.post('/admin/commercial/simulate', { ...(v.bundle_key ? { bundle_key: v.bundle_key } : { plan_key: v.plan_key }), ...(v.billing_interval ? { billing_interval: v.billing_interval } : {}), quantities: { seat: v.seat, team: v.team, location: v.location, athlete: v.athlete, event: v.event }, ...(v.gmv ? { gmv_minor: v.gmv } : {}), ...(v.at ? { at: v.at } : {}), ...(v.promotion_key ? { promotion_key: v.promotion_key } : {}) })); return null; }} />
      )}
      {res ? (
        <Card color={c.paper}>
          <T weight="800">{res.plan_key} · v{res.version} · {label(res.billing_interval)}</T>
          <CodeTag code={res.price_point_code} />
          {res.bundle ? <T size={12} color={c.mute}>Bundle: {money(res.bundle.list_minor, res.currency)} apart → saves {money(res.bundle.saving_minor, res.currency)}</T> : null}
          {res.lines.length === 0 ? <T color={c.mute}>No charge.</T> : res.lines.map((l, n) => <View key={n} style={{ flexDirection: 'row', gap: 8 }}><T style={{ flex: 1 }} size={13}>{l.label}{l.quantity > 1 ? ` × ${l.quantity}` : ''}{l.list_minor != null ? ` (list ${money(l.list_minor, res.currency)})` : ''}</T><T size={13} weight="700">{money(l.amount_minor, res.currency)}</T></View>)}
          {res.terms.map((t, n) => <T key={n} size={12} color={c.mute}>{t.label}: {t.bp / 100}%{t.cap_minor != null ? ` (cap ${money(t.cap_minor, res.currency)})` : ''}{t.example_on_minor ? ` → ${money(t.example_fee_minor, res.currency)} on ${money(t.example_on_minor, res.currency)}` : ''}</T>)}
          {res.discount_minor ? <T size={13}>Offer −{money(res.discount_minor, res.currency)} in the first term</T> : null}
          {res.offer_schedule?.length ? <View style={{ gap: 2 }}><T size={12} weight="800">With the offer</T>{res.offer_schedule.map((t) => <T key={t.term} size={12} color={c.mute}>Term {t.term}: {money(t.total_minor, res.currency)}{t.discount_minor ? ` (offer −${money(t.discount_minor, res.currency)})` : ''}</T>)}<T size={12} color={c.mute}>Then {money(res.regular_total_minor, res.currency)} per term</T></View> : null}
          {res.extra_free_months ? <T size={12} color={c.mute}>The first period lasts {res.extra_free_months} month{res.extra_free_months > 1 ? 's' : ''} longer at no extra cost</T> : null}
          <T size={13} color={c.mute}>Tax {money(res.tax_minor, res.currency)}</T>
          <T weight="800" size={18}>Total {money(res.total_minor, res.currency)}</T>
        </Card>
      ) : null}
    </Block>
  );
}

// ------------------------------------------------------------------ accounts tab
function SubjectPicker({ type, onPick }) {
  const [q, setQ] = useState('');
  const res = useLoad(() => api.get('/admin/commercial/subjects', { subject_type: type, q: q || undefined, limit: 15 }), [type, q]);
  return (
    <View style={{ gap: 8 }}>
      <Field value={q} onChangeText={setQ} placeholder={`Search ${type === 'user' ? 'people' : `${type}s`} by name…`} accessibilityLabel="Search accounts" />
      {(res.data ?? []).map((s) => <Row key={s.id} title={s.name} sub={s.sub} onPress={() => onPick(s)} />)}
      {res.data?.length === 0 ? <T size={13} color={c.mute}>Nobody matches.</T> : null}
    </View>
  );
}

function Account({ cat, keys }) {
  const [type, setType] = useState('user');
  const [subject, setSubject] = useState(null);
  const [assign, setAssign] = useState(false);
  const [ovr, setOvr] = useState(false);
  const [link, setLink] = useState(false);
  const plans = (cat.data?.products ?? []).flatMap((p) => p.plans).filter((p) => p.eligible_actors.includes(type) && p.versions.some((v) => v.status === 'published'));
  const bundlesFor = (cat.data?.bundles ?? []).filter((b) => b.eligible_actors.includes(type) && b.versions.some((v) => v.status === 'published'));
  const prev = useLoad(() => (subject ? api.post('/admin/commercial/preview', { subject_type: type, subject_id: subject.id }) : Promise.resolve(null)), [subject?.id, type]);
  const subs = useLoad(() => (subject ? api.get('/admin/commercial/subscriptions', { subject_type: type, subject_id: subject.id, limit: 50 }) : Promise.resolve([])), [subject?.id, type]);
  const ovs = useLoad(() => (subject ? api.get('/admin/commercial/overrides', { subject_type: type, subject_id: subject.id, limit: 50 }) : Promise.resolve([])), [subject?.id, type]);
  const reload = () => { prev.reload(); subs.reload(); ovs.reload(); };
  const act = useAct(reload);
  const e = prev.data?.entitlements ?? {};
  return (
    <View style={{ gap: 12 }}>
      <Seg options={SUBJECTS.map(([value, l]) => ({ value, label: l }))} value={type} onChange={(t) => { setType(t); setSubject(null); }} />
      {!subject ? <SubjectPicker type={type} onPick={setSubject} /> : (
        <>
          <Card><View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ flex: 1 }}><T weight="800">{subject.name}</T><T size={12} color={c.mute}>{subject.sub}</T></View><Btn small title="Change" color={c.paper} ink={c.ink} onPress={() => setSubject(null)} /></View></Card>
          <View style={wrap}>
            <Btn small title="Assign a plan" onPress={() => setAssign(true)} />
            <Btn small title="Add an override" color={c.cyan} ink={c.ink} onPress={() => setOvr(true)} />
            <Btn small title="Link to a parent" color={c.lime} ink={c.ink} onPress={() => setLink(true)} />
          </View>
          <Section title="What they can do now" color={c.lime}>
            <Block state={prev}>
              {Object.keys(e).length === 0 ? <T size={13} color={c.mute}>No entitlements: no plan and no default plan for this kind of account.</T> : Object.entries(e).map(([k, x]) => (
                <Row key={k} title={label(k)} sub={`${x.enabled ? (x.limit == null ? 'included, no limit' : `limit ${x.limit}`) : 'switched off'} · ${x.sources.join(' → ')}`} right={x.limit == null ? null : <Tag label={x.behaviour} />} />
              ))}
            </Block>
          </Section>
          <Section title="Usage" color={c.cyan}>
            {(prev.data?.usage ?? []).length === 0 ? <T size={13} color={c.mute}>No metered usage.</T> : prev.data.usage.map((u) => (
              <Row key={u.key} title={`${u.name}${u.period !== 'lifetime' && u.mode === 'counter' ? ` · this ${u.period}` : ''}`} sub={`${u.used ?? '—'}${u.limit != null ? ` of ${u.limit}` : ''} ${u.unit}${u.over_limit ? ' · over the limit' : u.warning ? ' · nearing the limit' : ''}`} right={u.over_limit ? <Tag label="over" color={c.orangeSoft} /> : u.warning ? <Tag label="near" color={c.sunSoft} /> : null} />
            ))}
          </Section>
          <Section title="Subscriptions" color={c.pink}>
            <Block state={subs}>
              {(subs.data ?? []).length === 0 ? <T size={13} color={c.mute}>None. They are on the default plan, if there is one.</T> : subs.data.map((s) => (
                <Row key={s.id} title={`${s.plan_name} · v${s.version}`} sub={`${s.plan_key}:${s.billing_interval}:${s.currency}:${s.region} · ${money(s.amount_minor, s.currency)} · ${s.current_period_end ? `until ${d10(s.current_period_end)}` : 'not started'}${s.cancel_at_period_end ? ' · ending' : ''}`}
                  right={<View style={{ gap: 6, alignItems: 'flex-end' }}><St s={s.status} />{s.bundle_group ? <Tag label="bundle" color={c.lime} /> : null}
                    {s.status === 'pending_payment' ? <Btn small title="Mark paid" accessibilityLabel="Mark subscription paid" onPress={() => act(() => api.post(`/admin/commercial/subscriptions/${s.id}/activate`), 'Activated')} /> : null}
                    {['trial', 'active', 'pending_payment'].includes(s.status) && !s.cancel_at_period_end ? <Btn small title="Stop renewal" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/admin/commercial/subscriptions/${s.id}/cancel`), 'Renewal stopped — nothing was deleted')} /> : null}</View>} />
              ))}
            </Block>
          </Section>
          <Section title="Overrides" color={c.orange}>
            {(ovs.data ?? []).length === 0 ? <T size={13} color={c.mute}>None.</T> : ovs.data.map((o) => (
              <Row key={o.id} title={`${label(o.key)} · ${o.scope}`} sub={`${o.mode} ${o.enabled ? (o.limit_value == null ? 'unlimited' : o.limit_value) : 'off'} · ${o.reason} · from ${d10(o.starts_on)}${o.ends_on ? ` to ${d10(o.ends_on)}` : ''}`}
                right={o.status === 'active' ? <Btn small title="Revoke" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/admin/commercial/overrides/${o.id}/revoke`), 'Revoked')} /> : <St s={o.status} />} />
            ))}
          </Section>
        </>
      )}

      <FormSheet visible={assign} onClose={() => setAssign(false)} title="Assign a plan" submitLabel="Assign" initial={{ billing_interval: 'monthly', mark_paid: false }}
        fields={[{ key: 'plan_key', label: 'Plan', type: 'chips', optional: true, options: plans.map((p) => ({ value: p.key, label: p.name })) },
          ...(bundlesFor.length ? [{ key: 'bundle_key', label: 'Or a bundle (all of this person\'s profiles at the bundle price)', type: 'chips', optional: true, options: bundlesFor.map((b) => ({ value: b.key, label: `${b.name} · ${money(b.versions.find((x) => x.status === 'published').price_minor ?? 0, b.currency)}/${b.billing_interval === 'monthly' ? 'mo' : 'yr'}` })) }] : []),
          { key: 'billing_interval', label: 'Billed (plans only)', type: 'chips', optional: true, options: INTERVALS.map((v) => ({ value: v, label: label(v) })) },
          { key: 'promotion_key', label: 'Offer (only those attached to this price point are listed)', type: 'chips', optional: true, options: (v) => offersFor(cat, v.plan_key, v.billing_interval, v.bundle_key).map((p) => ({ value: p.key, label: p.name })) },
          { key: 'mark_paid', label: 'Already paid', type: 'switch' }]}
        onSubmit={async (v) => { if (!v.plan_key && !v.bundle_key) throw new Error('Pick a plan or a bundle'); await api.post('/admin/commercial/subscriptions', { subject_type: type, subject_id: subject.id, ...v, ...(v.bundle_key ? { plan_key: undefined, billing_interval: undefined } : {}) }); reload(); return v.bundle_key ? 'Bundle assigned' : 'Plan assigned'; }} />
      <FormSheet visible={ovr} onClose={() => setOvr(false)} title="Add an override" submitLabel="Add" notice="Contract overrides apply to this account; enterprise overrides apply to every account linked below it and win over everything else."
        initial={{ scope: 'contract', mode: 'set', enabled: true, unlimited: false, limit_value: 0, starts_on: new Date().toISOString().slice(0, 10) }}
        fields={[{ key: 'scope', label: 'Applies to', type: 'choice', options: [{ value: 'contract', label: 'This account' }, { value: 'enterprise', label: 'Everything linked below it' }] },
          { key: 'key', label: 'What it changes', type: 'chips', options: keys.map((k) => ({ value: k, label: label(k) })) },
          { key: 'mode', label: 'How', type: 'choice', options: [{ value: 'set', label: 'Set the value' }, { value: 'add', label: 'Add to it' }] },
          { key: 'enabled', label: 'Switched on', type: 'switch' },
          { key: 'unlimited', label: 'No limit', type: 'switch' },
          { key: 'limit_value', label: 'Limit', type: 'stepper', min: 0, max: 1000000, step: 1, show: (v) => !v.unlimited },
          { key: 'starts_on', label: 'From', type: 'date' }, { key: 'ends_on', label: 'Until (optional)', type: 'date', optional: true },
          { key: 'reason', label: 'Reason (kept in the audit trail)', type: 'multiline' }]}
        onSubmit={async (v) => { const { unlimited, ...rest } = v; await api.post('/admin/commercial/overrides', { subject_type: type, subject_id: subject.id, ...rest, limit_value: unlimited ? null : v.limit_value }); reload(); return 'Override added'; }} />
      <Sheet visible={link} onClose={() => setLink(false)} title="Link under an organisation">
        <T size={13} color={c.mute}>The account inherits what the parent organisation resolves to. Ending a link keeps its history.</T>
        <SubjectPicker type="organisation" onPick={async (p) => { setLink(false); await act(() => api.post('/admin/commercial/links', { child_type: type, child_id: subject.id, parent_type: 'organisation', parent_id: p.id }), `Linked under ${p.name}`); }} />
        <Btn small title="End the current link" color={c.paper} ink={c.ink} onPress={async () => { setLink(false); await act(() => api.post('/admin/commercial/links', { child_type: type, child_id: subject.id, end: true }), 'Link ended'); }} />
      </Sheet>
    </View>
  );
}

// ------------------------------------------------------------------ offers + audit
const benefitText = (p) => (p.benefit === 'free_months' ? `${p.free_months} month${p.free_months > 1 ? 's' : ''} free` : p.benefit === 'percent_off' ? `${p.discount_bp / 100}% off for ${p.duration_months} month${p.duration_months > 1 ? 's' : ''}` : p.benefit === 'flat_off' ? `${money(p.flat_off_minor, p.flat_currency)} off for ${p.duration_months} month${p.duration_months > 1 ? 's' : ''}` : label(p.kind));

function Offers({ cat }) {
  const [form, setForm] = useState(false);
  const [edit, setEdit] = useState(null);
  const act = useAct(cat.reload);
  const points = pricePointsOf(cat);
  const list = cat.data?.promotions ?? [];
  const appliesFields = [
    { key: 'all_price_points', label: 'Applies to all price points', type: 'switch', hint: 'Off = choose the price points (codes) below' },
    { key: 'price_points', label: 'Price points (pick one or more)', type: 'multi', options: points.map(ppOption), show: (v) => !v.all_price_points },
  ];
  return (
    <Block state={cat}>
      <Btn small title="New offer" onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {list.length === 0 ? <Empty emoji="🎁" title="No offers" sub="Free months, percentage or flat discounts for a duration, trials and coupon references live here — attached to one or more price points, or all of them." /> : list.map((p) => (
        <Card key={p.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{p.name}</T><St s={p.status} /></View>
          <T size={13} color={c.mute}>{benefitText(p)}{p.trial_days ? ` · ${p.trial_days}-day trial` : ''} · {d10(p.starts_on)}{p.ends_on ? ` → ${d10(p.ends_on)}` : ' onwards'}</T>
          <View style={wrap}>{p.price_points.length ? p.price_points.map((code) => <CodeTag key={code} code={code} />) : <Tag label="All price points" color={c.lime} />}</View>
          <Btn small title="Edit price points" color={c.paper} ink={c.ink} accessibilityLabel={`Edit price points for ${p.name}`} onPress={() => setEdit(p)} style={{ alignSelf: 'flex-start' }} />
        </Card>
      ))}
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={`Price points · ${edit?.name ?? ''}`} submitLabel="Save"
        initial={{ all_price_points: !edit?.price_points?.length, price_points: edit?.price_points ?? [] }} fields={appliesFields}
        onSubmit={async (v) => { await api.patch(`/admin/commercial/promotions/${edit.id}/price-points`, { all_price_points: !!v.all_price_points, price_points: v.all_price_points ? [] : v.price_points }); cat.reload(); return 'Price points updated'; }} />
      <FormSheet visible={form} onClose={() => setForm(false)} title="New offer" submitLabel="Create"
        initial={{ kind: 'launch_offer', benefit: 'free_months', free_months: 1, discount: 10, duration_months: 3, flat: 0, flat_currency: 'INR', trial_days: 0, all_price_points: true, price_points: [], starts_on: new Date().toISOString().slice(0, 10) }}
        fields={[{ key: 'name', label: 'Name' }, { key: 'key', label: 'Short code (a–z, 0–9, _)' },
          { key: 'kind', label: 'Shown as', type: 'chips', options: [{ value: 'launch_offer', label: 'Launch offer' }, { value: 'first_term_discount', label: 'First-term discount' }, { value: 'coupon', label: 'Coupon' }, { value: 'trial', label: 'Trial' }] },
          ...appliesFields,
          { key: 'benefit', label: 'What the customer gets', type: 'chips', options: [{ value: 'free_months', label: 'Free months' }, { value: 'percent_off', label: '% off' }, { value: 'flat_off', label: 'Flat amount off' }, { value: 'none', label: 'Trial / extras only' }] },
          { key: 'free_months', label: 'Free months (1 = first month free)', type: 'stepper', min: 1, max: 24, step: 1, suffix: ' mo', show: (v) => v.benefit === 'free_months' },
          { key: 'discount', label: 'Discount', type: 'stepper', min: 1, max: 100, step: 5, suffix: '%', show: (v) => v.benefit === 'percent_off' },
          { key: 'flat_currency', label: 'Currency', type: 'currency', show: (v) => v.benefit === 'flat_off' },
          { key: 'flat', label: 'Amount off each billing term', type: 'money', currency: (v) => v.flat_currency ?? 'INR', show: (v) => v.benefit === 'flat_off' },
          { key: 'duration_months', label: 'For how long', type: 'stepper', min: 1, max: 60, step: 1, suffix: ' mo', show: (v) => v.benefit === 'percent_off' || v.benefit === 'flat_off' },
          { key: 'trial_days', label: 'Free trial before billing', type: 'stepper', min: 0, max: 365, step: 7, suffix: ' days' },
          { key: 'coupon_ref', label: 'Coupon reference', optional: true, show: (v) => v.kind === 'coupon' },
          { key: 'starts_on', label: 'Starts', type: 'date' }, { key: 'ends_on', label: 'Ends (optional)', type: 'date', optional: true },
          { key: 'max_redemptions', label: 'Maximum uses', type: 'stepper', min: 1, max: 1000000, step: 10, optional: true, blank: true }]}
        onSubmit={async (v) => {
          const { discount, flat, flat_currency, free_months, duration_months, price_points, all_price_points, ...rest } = v;
          const body = { ...rest, all_price_points: !!all_price_points, price_points: all_price_points ? [] : price_points, benefit: v.benefit, ...(v.benefit === 'free_months' ? { free_months } : {}), ...(v.benefit === 'percent_off' ? { discount_bp: Math.round(discount * 100), duration_months } : {}), ...(v.benefit === 'flat_off' ? { flat_off_minor: flat, flat_currency, duration_months } : {}) };
          await api.post('/admin/commercial/promotions', body); cat.reload(); return 'Offer created';
        }} />
    </Block>
  );
}

// ------------------------------------------------------------------ bundles tab
function Bundles({ cat }) {
  const act = useAct(cat.reload);
  const [form, setForm] = useState(false);
  const [priceFor, setPriceFor] = useState(null);
  const all = pricePointsOf(cat).filter((x) => !x.bundle);
  const bundles = cat.data?.bundles ?? [];
  return (
    <Block state={cat}>
      <T size={13} color={c.mute}>A person with more than one profile (athlete, coach, organiser…) takes their plans together at one bundle price. A bundle names the price points it sells; offers can attach to a bundle by its code.</T>
      <Btn small title="New bundle" onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {bundles.length === 0 ? <Empty emoji="🧩" title="No bundles yet" sub="Combine price points of different profiles into one cheaper price." /> : null}
      <View style={wrap}>
        {bundles.map((b) => {
          const live = b.versions.find((v) => v.status === 'published');
          return (
            <Card key={b.id} style={{ flexGrow: 1, flexBasis: 320, minWidth: 280 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{b.name}</T>{!live ? <Tag label="needs a price" color={c.sunSoft} /> : <St s="published" />}</View>
              <CodeTag code={b.price_point_code} />
              <T size={12} color={c.mute}>For {b.eligible_actors.join(', ')} · {label(b.billing_interval)} · {b.currency}</T>
              <View style={wrap}>{b.price_points.map((code) => <CodeTag key={code} code={code} />)}</View>
              {live ? <T weight="800">{money(live.price_minor, b.currency)} / {label(b.billing_interval)} <T size={12} color={c.mute} weight="600">· apart {money(live.list_minor, b.currency)} · saves {money(live.saving_minor, b.currency)}</T></T> : null}
              {b.versions.map((v) => (
                <Row key={v.id} title={`v${v.version} · ${v.price_mode === 'fixed' ? money(v.amount_minor, b.currency) : v.price_mode === 'percent_off' ? `${v.discount_bp / 100}% off the list` : `${money(v.amount_minor, b.currency)} off the list`} · from ${d10(v.effective_from)}${v.effective_to ? ` to ${d10(v.effective_to)}` : ''}`}
                  right={<View style={{ gap: 6, alignItems: 'flex-end' }}><St s={v.status} />
                    {v.status === 'draft' ? <Btn small title="Publish" accessibilityLabel={`Publish bundle price v${v.version}`} onPress={() => act(() => api.post(`/admin/commercial/bundle-versions/${v.id}/publish`), 'Published — it is now frozen')} /> : null}
                    {v.status === 'published' ? <Btn small title="Stop selling" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/admin/commercial/bundle-versions/${v.id}/retire`), 'Retired')} /> : null}</View>} />
              ))}
              <Btn small title="New bundle price" color={c.paper} ink={c.ink} accessibilityLabel={`New price for ${b.name}`} onPress={() => setPriceFor(b)} style={{ alignSelf: 'flex-start' }} />
            </Card>
          );
        })}
      </View>

      <FormSheet visible={form} onClose={() => setForm(false)} title="New bundle" submitLabel="Create" notice="Pick two or more price points of different profile families. They must share the bundle's interval, currency and region."
        initial={{ billing_interval: 'monthly', currency: 'INR', region: 'IN', eligible_actors: ['user'], price_points: [] }}
        fields={[{ key: 'name', label: 'Name' }, { key: 'key', label: 'Short code (a–z, 0–9, _)' },
          { key: 'description', label: 'Description', type: 'multiline', optional: true },
          { key: 'billing_interval', label: 'Billed', type: 'choice', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }] },
          { key: 'currency', label: 'Currency', type: 'currency' }, { key: 'region', label: 'Region', type: 'country' },
          { key: 'eligible_actors', label: 'Who can take it', type: 'multi', options: SUBJECTS.map(([value, l]) => ({ value, label: l })) },
          { key: 'price_points', label: 'Price points in the bundle (pick two or more)', type: 'multi', options: (v) => all.filter((x) => x.interval === v.billing_interval && x.currency === (v.currency ?? 'INR')).map(ppOption) }]}
        onSubmit={async (v) => { await api.post('/admin/commercial/bundles', v); cat.reload(); return 'Bundle created — now give it a price'; }} />
      <FormSheet visible={!!priceFor} onClose={() => setPriceFor(null)} title={`Bundle price · ${priceFor?.name ?? ''}`} submitLabel="Save as draft" notice="A draft is not live. Publish it to freeze it; customers keep the price they bought."
        initial={{ price_mode: 'fixed', amount: 0, discount: 10, tax: 0, effective_from: new Date().toISOString().slice(0, 10) }}
        fields={[{ key: 'price_mode', label: 'Price', type: 'chips', options: [{ value: 'fixed', label: 'Fixed bundle price' }, { value: 'percent_off', label: '% off the list prices' }, { value: 'flat_off', label: 'Amount off the list prices' }] },
          { key: 'amount', label: (priceFor ? 'Amount' : 'Amount'), type: 'money', currency: priceFor?.currency ?? 'INR', show: (v) => v.price_mode !== 'percent_off' },
          { key: 'discount', label: 'Discount', type: 'stepper', min: 1, max: 100, step: 5, suffix: '%', show: (v) => v.price_mode === 'percent_off' },
          { key: 'tax', label: 'Tax added on top', type: 'stepper', min: 0, max: 100, step: 1, suffix: '%' },
          { key: 'effective_from', label: 'Starts', type: 'date' }, { key: 'effective_to', label: 'Ends (optional)', type: 'date', optional: true }]}
        onSubmit={async (v) => { await api.post(`/admin/commercial/bundles/${priceFor.key}/versions`, { price_mode: v.price_mode, ...(v.price_mode === 'percent_off' ? { discount_bp: Math.round(v.discount * 100) } : { amount_minor: v.amount }), tax_bp: Math.round((v.tax ?? 0) * 100), effective_from: v.effective_from, ...(v.effective_to ? { effective_to: v.effective_to } : {}) }); cat.reload(); return 'Draft saved — publish it to make it live'; }} />
    </Block>
  );
}

function Audit() {
  const a = useLoad(() => api.get('/admin/commercial/audit', { limit: 60 }), []);
  return (
    <Block state={a}>
      {(a.data ?? []).length === 0 ? <Empty emoji="📜" title="Nothing yet" sub="Every catalogue, subscription and override change is recorded here." /> : a.data.map((x) => (
        <Row key={x.id} title={label(x.action)} sub={`${label(x.entity)} · ${x.actor_handle ? `@${x.actor_handle}` : 'system'} · ${new Date(x.at).toLocaleString()}`} />
      ))}
    </Block>
  );
}

const TABS = [['catalogue', 'Catalogue'], ['bundles', 'Bundles'], ['simulate', 'Simulate'], ['accounts', 'Accounts'], ['offers', 'Offers'], ['audit', 'Audit']];


export function CommercialConsole() {
  const { user } = useSession();
  const [tab, setTab] = useState('catalogue');
  const allowed = user.roles.includes('platform_admin');
  const cat = useLoad(() => (allowed ? api.get('/admin/commercial/catalogue') : Promise.resolve(null)), [allowed]);
  if (!allowed) return <Screen><H1>Commercial</H1><Empty emoji="🔒" title="Platform admin only" sub="This console is only available to the Gotmygame platform admin." /></Screen>;
  const keys = [...new Set([...(cat.data?.meters ?? []).map((m) => m.key), ...(cat.data?.products ?? []).flatMap((p) => p.plans.flatMap((pl) => pl.versions.flatMap((v) => v.entitlements.map((e) => e.key))))])].sort();
  return (
    <Screen wide>
      <H1>Commercial</H1>
      <T color={c.mute} weight="700">Catalogue, prices, plans, entitlements and usage — one place, versioned, never hard-coded.</T>
      <View style={{ marginVertical: 8 }}><Seg options={TABS.map(([value, l]) => ({ value, label: l }))} value={tab} onChange={setTab} /></View>
      {tab === 'catalogue' ? <Catalogue cat={cat} keys={keys} /> : tab === 'bundles' ? <Bundles cat={cat} /> : tab === 'simulate' ? <Simulate cat={cat} /> : tab === 'accounts' ? <Account cat={cat} keys={keys} /> : tab === 'offers' ? <Offers cat={cat} /> : <Audit />}
    </Screen>
  );
}
