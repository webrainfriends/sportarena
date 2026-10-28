// Sponsorship ROI & portfolio intelligence (#519). One screen for both sides of a sponsorship, read live from the canonical agreements:
// the brand sees its portfolio, measured exposure, deliverable health, comparison, valuation estimates, renewal packs and issued reports; the
// beneficiary (event organiser, team owner, adult athlete) sells inventory, delivers with evidence and records provider figures.
// Nothing here is estimated unless the brand wrote the assumptions itself, and an estimate is always labelled as one.
import React, { useMemo, useState } from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, H1, Loading, Screen, Section, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { EntityPicker } from '../entity-picker';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { useNav } from '../nav';

const fmt = (cents, cur) => { if (cents == null) return '—'; try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
const today = () => new Date().toISOString().slice(0, 10);
const ago = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const word = (k) => String(k).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const STATE_TONE = { accepted: c.lime, awaiting_review: c.sunSoft, rework: c.pinkSoft, overdue: c.pinkSoft, upcoming: c.violetSoft, excepted: c.paper, cancelled: c.paper };
const BASIS = { platform_measured: ['Measured by Sportarena', c.lime], provider_reported: ['Reported by a provider', c.sunSoft] };
const CATEGORIES = ['beverage', 'nutrition', 'apparel', 'footwear', 'equipment', 'banking_finance', 'insurance', 'telecom', 'automotive', 'technology', 'healthcare', 'education', 'travel_hospitality', 'media', 'retail', 'other'].map((v) => ({ value: v, label: word(v) }));
const DELIVERABLES = ['appearance', 'content', 'hospitality', 'challenge_reward', 'activation', 'other'].map((v) => ({ value: v, label: word(v) }));
const PROVIDER_METRICS = ['page_views', 'attendance', 'tickets_scanned', 'hospitality_guests'].map((v) => ({ value: v, label: word(v) }));

const deliver = async (out) => {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const bytes = out.encoding === 'base64' ? Uint8Array.from(atob(out.content), (ch) => ch.charCodeAt(0)) : out.content;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: out.content_type })); a.download = out.filename; a.click();
    return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const file = new File(Paths.cache, out.filename.replace(/[^A-Za-z0-9._-]/g, '_'));
  file.create({ overwrite: true });
  file.write(out.encoding === 'base64' ? Uint8Array.from(atob(out.content), (ch) => ch.charCodeAt(0)) : out.content);
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open the file from here. Download it from the web app.');
  await Sharing.shareAsync(file.uri, { mimeType: out.content_type, dialogTitle: out.filename });
};

/** A link opens in the browser; a file is fetched through the audited endpoint (only the two sides may read it) and handed to the browser or the share sheet. */
const openEvidence = async (e) => {
  if (e.url) { await Linking.openURL(e.url); return; }
  const f = await api.get(`/sponsorship-deliverable-evidence/${e.id}`);
  await deliver({ filename: f.file_name ?? 'evidence', content_type: f.content_type ?? 'application/octet-stream', encoding: 'base64', content: f.data });
};

const Banner = ({ tone = c.sunSoft, children }) => <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 12, padding: 12 }}><T size={13}>{children}</T></View>;
const Stat = ({ label, value, tone }) => <View style={{ minWidth: 104 }}><T size={11} color={c.mute}>{label}</T><T size={15} weight="800" color={tone ?? c.ink}>{value}</T></View>;
const Row = ({ children, gap = 8 }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap, alignItems: 'center' }}>{children}</View>;

/** What is measured and what is not: the definitions travel with the numbers. */
function Metrics({ exposure }) {
  return (
    <View style={{ gap: 10 }}>
      {exposure.metrics.length ? exposure.metrics.map((m) => (
        <Card key={m.key} color={c.paper} accessibilityLabel={`${m.label}: ${num(m.value)} ${m.unit}`}>
          <View style={{ gap: 4 }}>
            <Row><T weight="800" style={{ flex: 1 }}>{m.label}</T><Tag label={BASIS[m.basis][0]} color={BASIS[m.basis][1]} /></Row>
            <T size={22} weight="800">{num(m.value)} <T size={12} color={c.mute}>{m.unit}</T></T>
            <T size={12} color={c.mute}>{m.definition}{m.period_bound ? '' : ' (a point-in-time count, not a figure for the period)'}{m.sources?.length ? ` Source: ${m.sources.join(', ')}.` : ''}{m.days_with_data != null ? ` ${m.days_with_data} day(s) with data.` : ''}</T>
          </View>
        </Card>)) : <Empty emoji="📏" title="Nothing measured yet" sub="Figures appear as placements are served and providers report. Nothing is estimated in their place." />}
      {exposure.missing?.map((m) => <Banner key={`${m.metric}-${m.inventory}`} tone={c.sunSoft}>Missing: {word(m.metric)} for “{m.inventory}” — {m.reason}. It is not shown as zero.</Banner>)}
      <T size={12} color={c.mute}>Not measured by Sportarena: {exposure.not_measured.join(' · ')}</T>
    </View>
  );
}

// ------------------------------------------------------------------ one agreement: exposure, deliverables, estimate, renewal pack, inventory
function Deliverables({ id, role, reload }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get(`/sponsorships/${id}/deliverables`), [id]);
  const [form, setForm] = useState(null);
  const act = async (fn, ok) => { try { await fn(); toast(ok); list.reload(); reload?.(); } catch (e) { toast(explain(e)); if (e.status === 409) list.reload(); } };
  if (list.error) return <LoadError error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      <Btn small title="＋ Add a deliverable" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm({ type: 'new' })} />
      {!list.data.length ? <Empty emoji="📋" title="No deliverables yet" sub="Appearances, content, hospitality and rewards you agree are tracked here. Each is accepted by the other side, with evidence." /> : null}
      {list.data.map((d) => (
        <Card key={d.id} color={c.paper}>
          <View style={{ gap: 6 }}>
            <Row><T weight="800" style={{ flex: 1 }}>{d.title}</T><Tag label={word(d.state)} color={STATE_TONE[d.state] ?? c.paper} /></Row>
            <T size={12} color={c.mute}>{word(d.kind)} · owed by the {d.owed_by} · due {d.due_on} · evidence: {d.evidence_required === 'either' ? 'a link or a file' : `a ${d.evidence_required}`}</T>
            {d.brief ? <T size={13}>{d.brief}</T> : null}
            {d.review_note ? <T size={12} color={c.mute}>Reviewer note: {d.review_note}</T> : null}
            {d.evidence.map((e) => (
              <Pressable key={e.id} accessibilityRole="button" accessibilityLabel={`Open evidence: ${e.label ?? e.file_name ?? 'link'}`} style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => openEvidence(e).catch((x) => toast(explain(x)))}>
                <T size={13} weight="700" color={c.violet}>• {e.label ?? (e.url ? 'Link' : e.file_name)} — {e.url ? 'open link' : `open file${e.size_bytes ? ` (${Math.max(1, Math.round(e.size_bytes / 1024))} KB)` : ''}`}</T>
              </Pressable>))}
            {d.exceptions.filter((x) => x.status === 'requested').map((x) => (
              <Banner key={x.id}>{word(x.kind)} requested{x.new_due_on ? ` to ${x.new_due_on}` : ''}: {x.reason}
                {!d.you_owe ? <Row><Btn small title="Approve" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorship-deliverable-exceptions/${x.id}`, { decision: 'approve' }), 'Approved')} /><Btn small title="Decline…" color={c.paper} ink={c.red} onPress={() => setForm({ type: 'decline', x })} /></Row> : null}
              </Banner>))}
            <Row>
              {d.you_owe && ['planned', 'rework', 'submitted'].includes(d.status) ? <Btn small title="Submit evidence" color={c.mint} ink={c.ink} onPress={() => setForm({ type: 'evidence', d })} /> : null}
              {d.you_owe && ['planned', 'rework', 'submitted'].includes(d.status) && !d.exceptions.some((x) => x.status === 'requested') ? <Btn small title="Ask to postpone or waive…" color={c.paper} ink={c.ink} onPress={() => setForm({ type: 'exception', d })} /> : null}
              {d.you_review && d.status === 'submitted' ? <Btn small title="Accept" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorship-deliverables/${d.id}/review`, { decision: 'accept', expected_rev: d.rev }), 'Accepted')} /> : null}
              {d.you_review && d.status === 'submitted' ? <Btn small title="Send back…" color={c.paper} ink={c.ink} onPress={() => setForm({ type: 'rework', d })} /> : null}
              {d.you_review && ['planned', 'rework', 'submitted'].includes(d.status) ? <Btn small title="Cancel…" color={c.paper} ink={c.red} onPress={() => setForm({ type: 'cancel', d })} /> : null}
            </Row>
          </View>
        </Card>))}
      <FormSheet visible={form?.type === 'new'} onClose={() => setForm(null)} title="Add a deliverable" submitLabel="Add" color={c.pink}
        fields={[{ key: 'title', label: 'What is delivered' }, { key: 'kind', label: 'Kind', type: 'chips', options: DELIVERABLES }, { key: 'owed_by', label: 'Who delivers it', type: 'choice', options: [{ value: 'recipient', label: 'Beneficiary' }, { value: 'sponsor', label: 'Sponsor' }] },
          { key: 'due_on', label: 'Due date', type: 'date' }, { key: 'evidence_required', label: 'Evidence that completes it', type: 'choice', options: [{ value: 'either', label: 'Link or file' }, { value: 'link', label: 'Link' }, { value: 'file', label: 'File' }] }, { key: 'brief', label: 'Brief', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/sponsorships/${id}/deliverables`, v); list.reload(); reload?.(); return 'Deliverable added'; }} />
      <FormSheet visible={form?.type === 'evidence'} onClose={() => setForm(null)} title="Submit evidence" submitLabel="Submit" color={c.mint}
        notice="The other side reviews it. It is not complete until they accept it."
        fields={[{ key: 'url', label: 'Link (https)', type: 'text', optional: true }, { key: 'files', label: 'Or photos / documents', type: 'files', max: 3, optional: true }, { key: 'label', label: 'Label', optional: true }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-deliverables/${form.d.id}/evidence`, { url: v.url, label: v.label, files: (v.files ?? []).map((f) => ({ file_name: f.file_name, data: f.data })), expected_rev: form.d.rev }); list.reload(); reload?.(); return 'Evidence submitted'; }} />
      <FormSheet visible={form?.type === 'rework'} onClose={() => setForm(null)} title="Send back for rework" submitLabel="Send back" fields={[{ key: 'note', label: 'What needs to change', type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-deliverables/${form.d.id}/review`, { decision: 'rework', note: v.note, expected_rev: form.d.rev }); list.reload(); reload?.(); return 'Sent back'; }} />
      <FormSheet visible={form?.type === 'cancel'} onClose={() => setForm(null)} title="Cancel this deliverable" submitLabel="Cancel deliverable" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-deliverables/${form.d.id}/cancel`, { reason: v.reason, expected_rev: form.d.rev }); list.reload(); reload?.(); return 'Cancelled'; }} />
      <FormSheet visible={form?.type === 'decline'} onClose={() => setForm(null)} title="Decline the request" submitLabel="Decline" fields={[{ key: 'note', label: 'Why', type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-deliverable-exceptions/${form.x.id}`, { decision: 'decline', note: v.note }); list.reload(); return 'Declined'; }} />
      <FormSheet visible={form?.type === 'exception'} onClose={() => setForm(null)} title="Ask to postpone or waive" submitLabel="Ask" notice="Nothing changes until the other side agrees; it stays overdue meanwhile."
        fields={[{ key: 'kind', label: 'What do you need', type: 'choice', options: [{ value: 'postpone', label: 'Postpone' }, { value: 'waive', label: 'Waive' }] }, { key: 'new_due_on', label: 'New due date', type: 'date', show: (v) => v.kind === 'postpone' }, { key: 'reason', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-deliverables/${form.d.id}/exception`, v); list.reload(); return 'Request sent'; }} />
    </View>
  );
}

function Estimate({ deal }) {
  const { toast } = useSession();
  const models = useLoad(() => api.get(`/sponsors/${deal.sponsor_id}/valuation-models`).catch(() => ({ models: [] })), [deal.sponsor_id]);
  const [vid, setVid] = useState(null);
  const est = useLoad(() => (vid ? api.get(`/sponsorships/${deal.id}/valuation`, { version_id: vid }) : Promise.resolve(null)), [vid, deal.id]);
  const versions = (models.data?.models ?? []).flatMap((m) => m.versions.map((v) => ({ ...v, name: m.name })));
  const e = est.data?.valuation;
  return (
    <View style={{ gap: 10 }}>
      <Banner tone={c.sunSoft}>No monetary value or ROI is shown unless you choose your own valuation assumptions. Whatever it produces is an estimate from your rates applied to measured figures only.</Banner>
      {versions.length ? <Row>{versions.map((v) => <Chip key={v.id} label={`${v.name} v${v.version}`} active={vid === v.id} onPress={() => setVid(vid === v.id ? null : v.id)} />)}</Row> : <Empty emoji="🧮" title="No valuation model yet" sub="Create one under Valuation to see an estimate here." />}
      {e ? (
        <Card color={c.sunSoft}>
          <View style={{ gap: 6 }}>
            <Tag label="ESTIMATE — assumption-based, not a measured fact" color={c.paper} />
            <T size={24} weight="800">{fmt(e.estimated_value_cents, e.currency)}</T>
            <T size={12} color={c.mute}>Model “{e.model.name}” version {e.model.version}. Why these rates: {e.model.basis_note}</T>
            {e.lines.map((l) => <T key={l.metric} size={13}>• {word(l.metric)}: {num(l.measured_value)} {l.measured_basis === 'platform_measured' ? 'measured by Sportarena' : 'reported by a provider'}, at {fmt(l.rate_cents, e.currency)} per {l.rate_per === 1 ? 'unit' : '1,000 units'} = {fmt(l.value_cents, e.currency)}</T>)}
            {e.excluded.length ? <T size={12} color={c.mute}>Not valued by this model: {e.excluded.map(word).join(', ')}.</T> : null}
            <T size={13} weight="700">{e.return_on_spend.ratio != null ? `Estimated value ÷ confirmed spend: ${e.return_on_spend.ratio} (estimate)` : e.return_on_spend.note}</T>
          </View>
        </Card>) : null}
    </View>
  );
}

function RenewalPack({ id }) {
  const { push } = useNav();
  const pack = useLoad(() => api.get(`/sponsorships/${id}/renewal-pack`), [id]);
  if (pack.error) return <LoadError error={pack.error} onRetry={pack.reload} />;
  if (!pack.data) return <Loading />;
  const p = pack.data;
  return (
    <View style={{ gap: 10 }}>
      <Banner tone={c.lime}>Every line below comes from the agreement’s own records. A summary written from it — by you or by an assistant — cannot add return on investment.</Banner>
      <Card color={c.paper}><View style={{ gap: 6 }}>{p.facts.map((f, i) => <T key={i} size={13}>• {f}</T>)}</View></Card>
      <Card color={c.paper}>
        <Row><Stat label="Open disputes" value={p.unresolved.open_disputes} tone={p.unresolved.open_disputes ? c.pink : c.ink} /><Stat label="Overdue deliverables" value={p.unresolved.overdue_deliverables} tone={p.unresolved.overdue_deliverables ? c.pink : c.ink} /><Stat label="Awaiting review" value={p.unresolved.deliverables_awaiting_review} /></Row>
      </Card>
      <Row><Btn small title="Open the agreement to renew" color={c.violet} onPress={() => push('SponsorDeal', { id })} />{p.renewal.successor ? <Tag label={`Renewal ${p.renewal.successor.status}`} color={c.violetSoft} /> : null}</Row>
    </View>
  );
}

function ProviderFigures({ id, reload }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Btn small title="＋ Record a provider figure" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setOpen(true)} />
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Record a provider figure" submitLabel="Record" color={c.pink}
        notice="One figure per metric per day, with who supplied it. Shown to the sponsor as provider-reported. Broadcast and stream reach is recorded once, in Media & broadcast, and appears here by itself."
        fields={[{ key: 'metric', label: 'Metric', type: 'chips', options: PROVIDER_METRICS }, { key: 'day', label: 'Day', type: 'date' }, { key: 'value', label: 'Figure', type: 'number', hint: 'The number the provider reported for that day' },
          { key: 'source', label: 'Provider' }, { key: 'source_ref', label: 'Where it can be checked (report name, export id or https link)' }]}
        onSubmit={async (v) => { await api.post(`/sponsorships/${id}/exposure-signals`, v); reload(); return 'Figure recorded'; }} />
    </>
  );
}

function AgreementPanel({ deal, role, onClose }) {
  const tabs = role === 'sponsor' ? ['Exposure', 'Deliverables', 'Estimate', 'Renewal pack', 'Inventory'] : ['Exposure', 'Deliverables', 'Renewal pack', 'Inventory'];
  const [tab, setTab] = useState('Exposure');
  const exp = useLoad(() => api.get(`/sponsorships/${deal.id}/exposure`), [deal.id]);
  const inv = useLoad(() => (tab === 'Inventory' ? api.get(`/sponsorships/${deal.id}/inventory`) : Promise.resolve(null)), [deal.id, tab]);
  return (
    <Card color={c.paper}>
      <View style={{ gap: 10 }}>
        <Row><Btn small title="← Back" color={c.paper} ink={c.ink} onPress={onClose} accessibilityLabel="Back to the list" /><T weight="800" size={16} style={{ flex: 1 }}>{deal.beneficiary} · {deal.sponsor}{deal.ref ? ` · ${deal.ref}` : ''}</T></Row>
        <Row>{tabs.map((t) => <Chip key={t} label={t} active={tab === t} onPress={() => setTab(t)} />)}</Row>
        {tab === 'Exposure' ? (exp.error ? <LoadError error={exp.error} onRetry={exp.reload} /> : exp.data ? <View style={{ gap: 10 }}>{role !== 'sponsor' ? <ProviderFigures id={deal.id} reload={exp.reload} /> : null}<Metrics exposure={exp.data} />
          {exp.data.signals.length ? <T size={12} color={c.mute}>Provider figures on file: {exp.data.signals.filter((s) => !s.superseded_at).length} (corrections keep the earlier value in history).</T> : null}</View> : <Loading />) : null}
        {tab === 'Deliverables' ? <Deliverables id={deal.id} role={role} /> : null}
        {tab === 'Estimate' ? <Estimate deal={deal} /> : null}
        {tab === 'Renewal pack' ? <RenewalPack id={deal.id} /> : null}
        {tab === 'Inventory' ? (inv.data ? (inv.data.length ? inv.data.map((b) => (
          <Card key={b.id} color={c.paper}><T weight="800">{b.unit_name}</T><T size={12} color={c.mute}>{b.kind_label} · {word(b.category)} · {b.starts_on} → {b.ends_on} · {b.status}{b.active_placements ? ` · ${b.active_placements} live placement(s)` : ''}</T></Card>)) : <Empty emoji="🎟" title="No inventory booked" sub="Placements, overlays and hospitality appear here once the event or team books them for this agreement." />) : <Loading />) : null}
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------ brand: portfolio, compare, valuation, reports
function Portfolio({ brand, onOpen }) {
  const [range, setRange] = useState({});
  const q = useMemo(() => ({ sponsor_id: brand.id, ...(range.from ? { from: range.from, to: range.to ?? range.from } : {}) }), [brand.id, range]);
  const dash = useLoad(() => api.get('/sponsorship-intelligence', q), [JSON.stringify(q)]);
  const [pick, setPick] = useState(false);
  if (dash.error) return <LoadError error={dash.error} onRetry={dash.reload} />;
  if (!dash.data) return <Loading />;
  const d = dash.data;
  if (!d.total) return <Empty emoji="📈" title="No accepted agreements yet" sub="Once a beneficiary accepts an offer from this brand, its commitments, deliverables and measured exposure appear here." />;
  return (
    <View style={{ gap: 12 }}>
      <Row><Btn small title={range.from ? `${range.from} → ${range.to ?? range.from}` : 'Whole term so far'} color={c.paper} ink={c.ink} onPress={() => setPick(true)} />{range.from ? <Btn small title="Clear" color={c.paper} ink={c.ink} onPress={() => setRange({})} /> : null}</Row>
      <FormSheet visible={pick} onClose={() => setPick(false)} title="Period" submitLabel="Apply" fields={[{ key: 'from', label: 'Dates', type: 'daterange', toKey: 'to' }]} initial={range} onSubmit={async (v) => { setRange(v); }} />
      {d.totals.finance.map((t) => (
        <Card key={t.currency} color={c.paper}>
          <View style={{ gap: 6 }} accessible accessibilityLabel={`${t.currency}: committed ${fmt(t.committed_cents, t.currency)}, confirmed ${fmt(t.confirmed_cents, t.currency)}`}>
            <T weight="800" color={c.mute}>{t.currency} · from the dues and confirmed payments</T>
            <Row gap={18}><Stat label="Committed" value={fmt(t.committed_cents, t.currency)} /><Stat label="Paid (confirmed)" value={fmt(t.confirmed_cents, t.currency)} /><Stat label="Remaining" value={fmt(t.outstanding_cents, t.currency)} tone={t.outstanding_cents > 0 ? c.pink : c.ink} />{t.overdue_cents ? <Stat label="Overdue" value={fmt(t.overdue_cents, t.currency)} tone={c.pink} /> : null}</Row>
          </View>
        </Card>))}
      <Card color={c.paper}>
        <View style={{ gap: 6 }}>
          <T weight="800">Deliverable health</T>
          <Row gap={14}>{['accepted', 'awaiting_review', 'upcoming', 'overdue', 'rework', 'excepted'].map((k) => <Stat key={k} label={word(k)} value={d.totals.deliverables[k] ?? 0} tone={k === 'overdue' && d.totals.deliverables[k] ? c.pink : c.ink} />)}</Row>
        </View>
      </Card>
      {d.totals.exposure_this_page.length ? (
        <Card color={c.paper}><View style={{ gap: 6 }}><T weight="800">Measured exposure (rows shown)</T>
          <Row gap={14}>{d.totals.exposure_this_page.map((m) => <Stat key={m.key} label={`${m.label}${m.basis === 'provider_reported' ? ' · provider' : ''}`} value={num(m.value)} />)}</Row>
          <T size={12} color={c.mute}>{d.totals.exposure_note}</T></View></Card>) : null}
      {d.upcoming.length ? <Section title="Upcoming obligations" color={c.sun}>{d.upcoming.map((u) => <T key={u.id} size={13}>• {u.due_on} · {u.beneficiary} · {word(u.kind)}{u.amount_cents ? ` · ${fmt(u.amount_cents, u.currency)}` : ''}</T>)}</Section> : null}
      <Section title={`Agreements (${d.total})`} color={c.violet}>
        {d.agreements.map((a) => {
          const f = a.finance.totals[0];
          return (
            <Card key={a.agreement.id} color={c.paper} onPress={() => onOpen(a.agreement)} accessibilityLabel={`${a.agreement.beneficiary}, open exposure, deliverables and renewal pack`}>
              <View style={{ gap: 6 }}>
                <Row><T weight="800" style={{ flex: 1 }}>{a.agreement.beneficiary}{a.agreement.ref ? ` · ${a.agreement.ref}` : ''}</T><Tag label={word(a.agreement.status)} color={c.violetSoft} />{a.agreement.days_left != null && a.agreement.days_left <= 90 && a.agreement.days_left >= 0 ? <Tag label={`${a.agreement.days_left} days left`} color={c.sunSoft} /> : null}</Row>
                <T size={12} color={c.mute}>{a.agreement.starts_on ?? '?'} → {a.agreement.ends_on ?? 'open-ended'} · {a.agreement.sponsor}</T>
                <Row gap={16}>{f ? <Stat label="Paid / committed" value={`${fmt(f.confirmed_cents, f.currency)} / ${fmt(f.committed_cents, f.currency)}`} /> : <Stat label="Money terms" value="none" />}
                  <Stat label="Deliverables accepted" value={`${a.deliverables.accepted}/${a.deliverables.due_to_date}`} tone={a.deliverables.missed ? c.pink : c.ink} />
                  {a.exposure.metrics.filter((m) => m.additive).slice(0, 2).map((m) => <Stat key={m.key} label={m.label} value={num(m.value)} />)}
                  {a.disputes.open ? <Stat label="Open disputes" value={a.disputes.open} tone={c.pink} /> : null}</Row>
                {a.exposure.missing.length ? <T size={12} color={c.mute}>{a.exposure.missing.length} expected figure(s) missing</T> : null}
              </View>
            </Card>);
        })}
      </Section>
      <T size={12} color={c.mute}>Not measured by Sportarena: {d.not_measured.join(' · ')}</T>
    </View>
  );
}

function Compare({ brand }) {
  const list = useLoad(() => api.get('/sponsorship-intelligence', { sponsor_id: brand.id, limit: 50 }), [brand.id]);
  const [sel, setSel] = useState([]);
  const [range, setRange] = useState({ from: ago(30), to: today() });
  const [res, setRes] = useState(null);
  const [form, setForm] = useState(false);
  const { toast } = useSession();
  const options = (list.data?.agreements ?? []).map((a) => ({ id: a.agreement.id, label: `${a.agreement.beneficiary}${a.agreement.ref ? ` · ${a.agreement.ref}` : ''}`, sub: `${a.agreement.starts_on ?? ''} → ${a.agreement.ends_on ?? ''}` }));
  const run = async () => { try { setRes(await api.post('/sponsorship-intelligence/compare', { sponsorship_ids: sel.map((s) => s.id), ...range })); } catch (e) { toast(explain(e)); } };
  return (
    <View style={{ gap: 10 }}>
      <Banner tone={c.lime}>Only metrics measured for every agreement over the same dates are compared. Nothing is ranked, and exposure never becomes an athlete score.</Banner>
      <EntityPicker label="Agreements to compare" multi noun="agreement" value={sel} onChange={setSel} options={options} />
      <Row><Btn small title={`${range.from} → ${range.to}`} color={c.paper} ink={c.ink} onPress={() => setForm(true)} /><Btn small title="Compare" color={c.pink} disabled={sel.length < 2} onPress={run} /></Row>
      {sel.length < 2 ? <T size={12} color={c.mute}>Pick at least two agreements.</T> : null}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Period" submitLabel="Apply" fields={[{ key: 'from', label: 'Dates', type: 'daterange', toKey: 'to' }]} initial={range} onSubmit={async (v) => { setRange({ from: v.from, to: v.to }); }} />
      {res ? (
        <View style={{ gap: 10 }}>
          {res.agreements.some((a) => a.partial_window) ? <Banner>Some agreements were active for only part of this period; values are also given per active day.</Banner> : null}
          {res.comparable_metrics.map((m) => (
            <Card key={m.key} color={c.paper}><View style={{ gap: 4 }}><Row><T weight="800" style={{ flex: 1 }}>{m.label}</T><Tag label={BASIS[m.basis][0]} color={BASIS[m.basis][1]} /></Row>
              {m.values.map((v) => <T key={v.sponsorship_id} size={13}>{res.agreements.find((a) => a.sponsorship_id === v.sponsorship_id).beneficiary}: {num(v.value)} {m.unit} · {v.per_active_day ?? '—'} per active day</T>)}</View></Card>))}
          {!res.comparable_metrics.length ? <Empty emoji="🔍" title="No metric is measured for all of them" sub="Add provider figures or placements so the same metric exists for each agreement." /> : null}
          {res.not_comparable.map((m) => <Banner key={m.key} tone={c.paper}>{word(m.key)} not compared: {m.reason}.</Banner>)}
          <T size={12} color={c.mute}>{res.spend.comparable ? `Confirmed spend (${res.spend.currency}): ${res.spend.values.map((v) => fmt(v.confirmed_cents, res.spend.currency)).join(' · ')}` : `Spend not compared: ${res.spend.reason}.`}</T>
        </View>) : null}
    </View>
  );
}

function Valuation({ brand }) {
  const { toast } = useSession();
  const models = useLoad(() => api.get(`/sponsors/${brand.id}/valuation-models`), [brand.id]);
  const [form, setForm] = useState(null);
  if (models.error) return <LoadError error={models.error} onRetry={models.reload} />;
  if (!models.data) return <Loading />;
  const metrics = models.data.metrics;
  const fields = (withName) => [...(withName ? [{ key: 'name', label: 'Model name' }] : []), { key: 'currency', label: 'Currency', type: 'currency' },
    { key: 'valued', label: 'Metrics you value', type: 'multi', options: metrics.map((m) => ({ value: m.key, label: m.label })) },
    { key: 'per', label: 'Rate is per', type: 'choice', options: [{ value: 1000, label: '1,000 units' }, { value: 1, label: 'one unit' }] },
    { key: 'rate', label: 'Value of that many units', type: 'money', currency: (v) => v.currency, hint: 'The same rate is used for every metric you tick; add a version for different rates' },
    { key: 'basis_note', label: 'Why these rates (shown beside every estimate)', type: 'multiline' }];
  const build = (v) => ({ currency: v.currency, basis_note: v.basis_note, assumptions: Object.fromEntries(v.valued.map((k) => [k, { per: v.per, value_cents: v.rate }])) });
  return (
    <View style={{ gap: 10 }}>
      <Banner>These are your own assumptions. They never leave your brand, are versioned (old versions never change), and estimates made from them are always labelled estimates.</Banner>
      <Btn small title="＋ New valuation model" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm({ type: 'new' })} />
      {models.data.models.map((m) => (
        <Card key={m.id} color={c.paper}><View style={{ gap: 4 }}>
          <Row><T weight="800" style={{ flex: 1 }}>{m.name}</T><Btn small title="New version" color={c.violet} onPress={() => setForm({ type: 'version', m })} /></Row>
          {m.versions.map((v) => <T key={v.id} size={12} color={c.mute}>v{v.version} · {v.currency} · {Object.entries(v.assumptions).map(([k, a]) => `${word(k)} ${a.value_cents} per ${a.per}`).join('; ')} — {v.basis_note}</T>)}
        </View></Card>))}
      {!models.data.models.length ? <Empty emoji="🧮" title="No valuation model" sub="Without one, Sportarena shows no monetary value or ROI at all." /> : null}
      <FormSheet visible={form?.type === 'new'} onClose={() => setForm(null)} title="New valuation model" submitLabel="Save" fields={fields(true)} onSubmit={async (v) => { await api.post(`/sponsors/${brand.id}/valuation-models`, { name: v.name, ...build(v) }); models.reload(); return 'Model saved'; }} />
      <FormSheet visible={form?.type === 'version'} onClose={() => setForm(null)} title="New version" submitLabel="Save version" fields={fields(false)}
        onSubmit={async (v) => { await api.post(`/sponsor-valuation-models/${form.m.id}/versions`, { expected_version: form.m.versions[0].version, ...build(v) }); models.reload(); return 'Version saved'; }} />
    </View>
  );
}

function Reports({ role, brand }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/sponsorship-roi-reports', { view: role === 'sponsor' ? 'sponsor' : 'recipient', ...(brand ? { sponsor_id: brand.id } : {}) }), [role, brand?.id]);
  const deals = useLoad(() => (role === 'sponsor' && brand ? api.get('/sponsorship-intelligence', { sponsor_id: brand.id, limit: 50 }) : api.get('/sponsorships', { limit: 50 }).catch(() => [])), [role, brand?.id]);
  const models = useLoad(() => (role === 'sponsor' && brand ? api.get(`/sponsors/${brand.id}/valuation-models`).catch(() => ({ models: [] })) : Promise.resolve({ models: [] })), [role, brand?.id]);
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState(null);
  const [sel, setSel] = useState([]);
  const options = role === 'sponsor' ? (deals.data?.agreements ?? []).map((a) => ({ id: a.agreement.id, label: `${a.agreement.beneficiary}${a.agreement.ref ? ` · ${a.agreement.ref}` : ''}`, sub: `${a.agreement.starts_on ?? ''} → ${a.agreement.ends_on ?? ''}` })) : (deals.data ?? []).filter((d) => d.status === 'active' && !d.i_am_sponsor).map((d) => ({ id: d.id, label: d.sponsor_name, sub: d.target_type }));
  const versions = (models.data?.models ?? []).flatMap((m) => m.versions.map((v) => ({ value: v.id, label: `${m.name} v${v.version}` })));
  const view = async (id) => { try { setOpen(await api.get(`/sponsorship-roi-reports/${id}`)); } catch (e) { toast(explain(e)); list.reload(); } };
  const exportAs = async (id, format) => { try { await deliver(await api.get(`/sponsorship-roi-reports/${id}/export`, { format })); toast(`${format.toUpperCase()} ready`); } catch (e) { toast(explain(e)); } };
  if (list.error) return <LoadError error={list.error} onRetry={list.reload} />;
  return (
    <View style={{ gap: 10 }}>
      <Banner tone={c.lime}>An issued report is a frozen copy of the facts on the day you issue it, with its definitions and a fingerprint. It can never be edited or deleted; issue a new one to show newer data.</Banner>
      <EntityPicker label={role === 'sponsor' ? 'Agreements to report on' : 'Agreement to report on'} multi={role === 'sponsor'} noun="agreement" value={sel} onChange={setSel} options={options} />
      <Btn small title="＋ Issue a report" color={c.pink} style={{ alignSelf: 'flex-start' }} disabled={!sel.length} onPress={() => setForm(true)} />
      {(list.data ?? []).map((r) => (
        <Card key={r.id} color={c.paper} onPress={() => view(r.id)} accessibilityLabel={`Report ${r.period_from} to ${r.period_to}`}>
          <Row><T weight="800" style={{ flex: 1 }}>{r.period_from} → {r.period_to}</T><Tag label={r.kind === 'end_of_agreement' ? 'End of agreement' : 'Period'} color={c.violetSoft} />{r.has_estimate ? <Tag label="Includes estimate" color={c.sunSoft} /> : null}</Row>
          <T size={12} color={c.mute}>{r.sponsor_name} · {r.sponsorship_ids.length} agreement(s) · issued {String(r.issued_at).slice(0, 10)} · fingerprint {r.content_sha256.slice(0, 12)}…</T>
        </Card>))}
      {list.data && !list.data.length ? <Empty emoji="🧾" title="No reports issued" sub="Issue one for a period or at the end of an agreement." /> : null}
      {open ? (
        <Card color={c.sunSoft}>
          <View style={{ gap: 6 }}>
            <Row><T weight="800" style={{ flex: 1 }}>Report {open.period.from} → {open.period.to}</T><Tag label={open.verified ? 'Fingerprint verified' : 'DOES NOT MATCH'} color={open.verified ? c.lime : c.pinkSoft} /></Row>
            {open.snapshot.table.rows.map((r, i) => <T key={i} size={13}>• {r.recipient}: confirmed {fmt(r.confirmed_cents, r.currency)} of {fmt(r.committed_cents, r.currency)} · accepted deliverables {r.deliverables_accepted} · impressions {num(r.placement_impressions)}{r.provider_reported ? ` · ${r.provider_reported}` : ''}{r.estimated_value_cents != null ? ` · estimate ${fmt(r.estimated_value_cents, r.currency)}` : ''}</T>)}
            <T size={12} color={c.mute}>{open.snapshot.valuation_note}</T>
            <Row>{['csv', 'xlsx', 'pdf'].map((f) => <Btn key={f} small title={f.toUpperCase()} color={c.violet} onPress={() => exportAs(open.id, f)} />)}<Btn small title="Close" color={c.paper} ink={c.ink} onPress={() => setOpen(null)} /></Row>
          </View>
        </Card>) : null}
      <IssueForm visible={form} onClose={() => setForm(false)} role={role} sel={sel} versions={versions} onDone={() => list.reload()} />
    </View>
  );
}

function IssueForm({ visible, onClose, role, sel, versions, onDone }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title="Issue a report" submitLabel="Issue (cannot be changed)" color={c.pink} initial={{ from: ago(30), to: today() }}
      notice={role === 'sponsor' ? `Covers ${sel.map((x) => x.label).join(', ')}, as they stand today.` : `Covers ${sel[0]?.label ?? 'one agreement'} only. It carries no valuation and no other agreements.`}
      fields={[{ key: 'kind', label: 'Report', type: 'choice', options: [{ value: 'period', label: 'For a period' }, { value: 'end_of_agreement', label: 'End of agreement' }] },
        { key: 'from', label: 'Dates', type: 'daterange', toKey: 'to' },
        ...(role === 'sponsor' && versions.length ? [{ key: 'valuation_version_id', label: 'Add a labelled estimate from', type: 'chips', options: versions, optional: true }] : [])]}
      onSubmit={async (v) => {
        await api.post('/sponsorship-roi-reports', { view: role === 'sponsor' ? 'sponsor' : 'recipient', kind: v.kind, sponsorship_ids: sel.map((x) => x.id), from: v.from, to: v.to, ...(v.valuation_version_id ? { valuation_version_id: v.valuation_version_id } : {}) });
        onDone(); return 'Report issued';
      }} />
  );
}

// ------------------------------------------------------------------ beneficiary: inventory
export function Inventory({ target }) {
  const { toast } = useSession();
  const inv = useLoad(() => api.get('/sponsor-inventory', { target_type: target.type, target_id: target.id, include_archived: false }), [target.type, target.id]);
  const deals = useLoad(() => api.get('/sponsorships', { limit: 50 }).catch(() => []), []);
  const [form, setForm] = useState(null);
  if (inv.error) return <LoadError error={inv.error} onRetry={inv.reload} />;
  if (!inv.data) return <Loading />;
  const mine = (deals.data ?? []).filter((d) => d.status === 'active' && d.target_type === target.type && d.target_id === target.id).map((d) => ({ value: d.id, label: d.sponsor_name }));
  const KINDS = [['title_partner', 'Title partner'], ['associate_partner', 'Associate partner'], ['team_association', 'Team association'], ['athlete_association', 'Athlete association'], ['kit_placement', 'Kit / logo placement'], ['event_page', 'Public event page'], ['leaderboard', 'Leaderboard'], ['scorecard', 'Scorecard'], ['livestream_overlay', 'Livestream overlay'], ['replay', 'Replay'], ['social_content', 'Social / content'], ['hospitality', 'Hospitality / tickets'], ['sponsored_challenge', 'Sponsored challenge or reward'], ['appearance', 'Agreed appearance'], ['content_deliverable', 'Agreed content']].map(([value, label]) => ({ value, label }));
  return (
    <View style={{ gap: 10 }}>
      <Btn small title="＋ Offer inventory" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm({ type: 'unit' })} />
      {!inv.data.units.length ? <Empty emoji="🎟" title="No inventory yet" sub="Offer what sponsors can have: a title slot, a leaderboard, an overlay, hospitality, appearances. Each unit has a capacity and can be category-exclusive." /> : null}
      {inv.data.units.map((u) => (
        <Card key={u.id} color={c.paper}><View style={{ gap: 6 }}>
          <Row><T weight="800" style={{ flex: 1 }}>{u.name}</T><Tag label={u.kind_label} color={c.violetSoft} />{u.exclusive_category ? <Tag label="Category-exclusive" color={c.sunSoft} /> : null}</Row>
          <T size={12} color={c.mute}>{u.window.free} of {u.capacity} free {u.window.from} → {u.window.to}{u.blocked_categories.length ? ` · blocked: ${u.blocked_categories.map(word).join(', ')}` : ''}{u.placement_slot ? ` · backs the “${word(u.placement_slot)}” public slot` : ''}</T>
          {(u.bookings ?? []).filter((b) => b.status === 'confirmed').map((b) => (
            <Row key={b.id}><T size={13} style={{ flex: 1 }}>• {b.sponsor_name} · {word(b.category)} · {b.starts_on} → {b.ends_on}</T><Btn small title="Release…" color={c.paper} ink={c.red} onPress={() => setForm({ type: 'release', b })} /></Row>))}
          <Btn small title="Book for a sponsor" color={c.mint} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm({ type: 'book', u })} disabled={!mine.length} />
          {!mine.length ? <T size={12} color={c.mute}>Booking needs an accepted sponsorship with {target.label}.</T> : null}
        </View></Card>))}
      <FormSheet visible={form?.type === 'unit'} onClose={() => setForm(null)} title="Offer inventory" submitLabel="Offer" color={c.pink}
        fields={[{ key: 'kind', label: 'What', type: 'chips', options: KINDS }, { key: 'name', label: 'Name' }, { key: 'capacity', label: 'Sponsors at once', type: 'stepper', min: 1, max: 100, default: 1 },
          { key: 'exclusive_category', label: 'Only one sponsor per category in a period', type: 'switch' }, { key: 'avail', label: 'Available', type: 'daterange', toKey: 'avail_to', optional: true }]}
        onSubmit={async (v) => { await api.post('/sponsor-inventory', { target_type: target.type, target_id: target.id, kind: v.kind, name: v.name, capacity: v.capacity, exclusive_category: v.exclusive_category, ...(v.avail ? { available_from: v.avail, available_to: v.avail_to } : {}) }); inv.reload(); return 'Inventory offered'; }} />
      <FormSheet visible={form?.type === 'book'} onClose={() => setForm(null)} title={`Book “${form?.u?.name}”`} submitLabel="Book" color={c.mint}
        notice="Refused if the unit is full or another sponsor of the same category holds it in that period."
        fields={[{ key: 'sponsorship_id', label: 'Sponsor', type: 'chips', options: mine }, { key: 'category', label: 'Sponsor category', type: 'chips', options: CATEGORIES }, { key: 'starts_on', label: 'Dates', type: 'daterange', toKey: 'ends_on' }]}
        onSubmit={async (v) => { await api.post(`/sponsor-inventory/${form.u.id}/bookings`, v); inv.reload(); return 'Booked'; }} />
      <FormSheet visible={form?.type === 'release'} onClose={() => setForm(null)} title="Release this booking" submitLabel="Release" fields={[{ key: 'reason', label: 'Reason (shown to the sponsor)', type: 'multiline' }]}
        onSubmit={async (v) => { const r = await api.post(`/sponsor-inventory-bookings/${form.b.id}/release`, v); inv.reload(); return r.placements_ended ? `Released; ${r.placements_ended} public placement ended` : 'Released'; }} />
    </View>
  );
}

function BeneficiaryDeals({ target, onOpen }) {
  const deals = useLoad(() => api.get('/sponsorships', { limit: 50 }).catch(() => []), []);
  const rows = (deals.data ?? []).filter((d) => ['active', 'paused', 'ended', 'term_expired', 'completed'].includes(d.status) && (!target || (d.target_type === target.type && d.target_id === target.id)) && !d.i_am_sponsor);
  if (!deals.data) return <Loading />;
  if (!rows.length) return <Empty emoji="🤝" title="No accepted sponsorships" sub="When you accept a sponsor’s offer it appears here with its deliverables and figures." />;
  return rows.map((d) => (
    <Card key={d.id} color={c.paper} onPress={() => onOpen({ id: d.id, beneficiary: d.target_name ?? target?.label ?? '', sponsor: d.sponsor_name, sponsor_id: d.sponsor_id })} accessibilityLabel={`${d.sponsor_name}, open deliverables and figures`}>
      <Row><T weight="800" style={{ flex: 1 }}>{d.sponsor_name}</T><Tag label={word(d.status)} color={c.violetSoft} /></Row>
      <T size={12} color={c.mute}>{word(d.target_type)} · tap for deliverables, figures and the renewal pack</T>
    </Card>));
}

// ------------------------------------------------------------------ the screen
export function SponsorRoi() {
  const { user } = useSession();
  const { push } = useNav();
  const brands = useLoad(() => api.get('/sponsors', { mine: true, limit: 50 }).catch(() => []), []);
  const events = useLoad(() => api.get('/events', { organizer_id: user.id, limit: 50 }).catch(() => []), [user.id]);
  const teams = useLoad(() => api.get('/teams', { mine: true, limit: 50 }).catch(() => []), []);
  const [mode, setMode] = useState(null);
  const [brand, setBrand] = useState([]);
  const [target, setTarget] = useState([]);
  const [tab, setTab] = useState(null);
  const [panel, setPanel] = useState(null);
  const isBrand = (mode ?? (brands.data?.length ? 'brand' : 'beneficiary')) === 'brand';
  const cur = brand[0] ?? (brands.data ?? [])[0] ? { id: (brand[0]?.id ?? brands.data[0].id), label: brand[0]?.label ?? brands.data[0].name } : null;
  const targets = [
    ...(events.data ?? []).map((e) => ({ id: e.id, label: e.name, sub: 'Event', type: 'event' })),
    ...(teams.data ?? []).map((t) => ({ id: t.id, label: t.name, sub: 'Team', type: 'team' })),
    ...(user.roles?.includes('athlete') ? [{ id: user.id, label: 'Me (athlete)', sub: 'Athlete', type: 'athlete' }] : []),
  ];
  const tgt = target[0] ? targets.find((x) => x.id === target[0].id) : null;
  const tabs = isBrand ? ['Portfolio', 'Compare', 'Valuation', 'Reports'] : ['Inventory', 'Sponsorships', 'Reports'];
  const t = tabs.includes(tab) ? tab : tabs[0];
  if (!brands.data && brands.loading) return <Screen><Loading /></Screen>;
  return (
    <Screen>
      <H1>Sponsorship ROI</H1>
      <T size={13} color={c.mute}>Measured exposure, deliverables, and renewal facts for every sponsorship — real figures only. Anything monetary is an estimate from assumptions you set.</T>
      {panel ? <AgreementPanel deal={panel} role={isBrand ? 'sponsor' : 'recipient'} onClose={() => setPanel(null)} /> : <>
      <Seg options={[{ value: 'brand', label: 'Brands I run' }, { value: 'beneficiary', label: 'I am sponsored' }]} value={isBrand ? 'brand' : 'beneficiary'} onChange={(v) => { setMode(v); setTab(null); setPanel(null); }} />
      {isBrand && brands.data?.length > 1 ? <EntityPicker label="Brand" noun="brand" value={cur ? [cur] : []} onChange={setBrand} options={brands.data.map((b) => ({ id: b.id, label: b.name, sub: b.my_role, emoji: b.emoji }))} /> : null}
      {isBrand && !brands.data?.length ? <Empty emoji="🏷" title="You do not run a brand" sub="Create a sponsor brand, or switch to “I am sponsored” if you are an event organiser, team owner or athlete." /> : null}
      {!isBrand ? <EntityPicker label="Event, team or athlete" noun="one" value={tgt ? [tgt] : []} onChange={setTarget} options={targets} /> : null}
      <Row>{tabs.map((x) => <Chip key={x} label={x} active={t === x} onPress={() => { setTab(x); setPanel(null); }} />)}</Row>
      {isBrand && cur && t === 'Portfolio' ? <Portfolio brand={cur} onOpen={(a) => setPanel({ id: a.id, beneficiary: a.beneficiary, sponsor: a.sponsor, sponsor_id: cur.id, ref: a.ref })} /> : null}
      {isBrand && cur && t === 'Compare' ? <Compare brand={cur} /> : null}
      {isBrand && cur && t === 'Valuation' ? <Valuation brand={cur} /> : null}
      {isBrand && cur && t === 'Reports' ? <Reports role="sponsor" brand={cur} /> : null}
      {!isBrand && t === 'Inventory' && tgt?.type === 'event' ? <Btn small title="Open the event console" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => push('EventCommand', { id: tgt.id })} /> : null}
      {!isBrand && t === 'Inventory' ? (tgt?.type === 'event' ? <Empty emoji="⚡" title="Event inventory lives in the event console" sub="Offer, book and release an event’s sponsor inventory under Business in the event console, next to its sponsors and vendors." /> : tgt ? <Inventory target={tgt} /> : <Empty emoji="👆" title="Pick an event, team or athlete" sub="Inventory belongs to what you run." />) : null}
      {!isBrand && t === 'Sponsorships' ? <BeneficiaryDeals target={tgt} onOpen={setPanel} /> : null}
      {!isBrand && t === 'Reports' ? <Reports role="recipient" /> : null}
      </>}
    </Screen>
  );
}
