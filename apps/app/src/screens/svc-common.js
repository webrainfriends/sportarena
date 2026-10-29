// Shared pieces for the supplier workspace and the buyer procurement screens (#458): catalogue-driven forms, status tags, KPI tiles and PDF buttons.
// Everything here calls the API (capabilities); no business rule lives in the app.
import React from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { c } from '../theme';
import { Btn, Card, Chip, T, Tag } from '../ui';
import { MultiMenuField } from '../menu-field';
import { DateRangeField } from '../pickers';
import { openPdf } from '../open-file';
import { useSession } from '../session';
import { moneyIn, localToIso } from '../vtime';

export const money = (minor, cur) => moneyIn(Number(minor ?? 0), cur ?? 'INR');
export const label = (s) => String(s ?? '').replace(/_/g, ' ');
export const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
export const when = (iso) => (iso ? `${new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })} UTC` : '');

const TONE = { ok: c.mint, warn: c.sun, bad: c.red, info: c.cyan };
const OF = {
  ok: ['accepted', 'confirmed', 'completed', 'awarded', 'paid', 'matched', 'issued', 'active', 'exception_approved', 'valid', 'fully_signed', 'verified', 'applied', 'approved'],
  warn: ['pending_supplier', 'changes_proposed', 'approval_pending', 'partially_paid', 'partially_accepted', 'partially_awarded', 'exception', 'expiring', 'pending', 'proposed', 'draft', 'unquoted', 'unawarded', 'unconfirmed', 'paused', 'submitted_for_acceptance', 'quoting', 'evaluation', 'manual_pending'],
  bad: ['rejected', 'cancelled', 'terminated', 'expired', 'void', 'voided', 'no_show', 'rework', 'declined', 'withdrawn', 'suspended', 'superseded'],
};
export const tone = (s) => TONE[Object.keys(OF).find((k) => OF[k].includes(s)) ?? 'info'];
export const Status = ({ s }) => <Tag label={label(s)} color={tone(s)} />;

export function Kpi({ title, value, sub }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 150, minWidth: 140 }} accessible accessibilityLabel={`${title}: ${value}${sub ? `, ${sub}` : ''}`}>
      <Card pad={12}><T size={12} color={c.mute}>{title}</T><T weight="800" size={22}>{value}</T>{sub ? <T size={11} color={c.mute}>{sub}</T> : null}</Card>
    </View>
  );
}
export const Wrap = ({ children, gap = 8, style }) => <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap }, style]}>{children}</View>;
export const Kv = ({ k, v }) => (v === undefined || v === null || v === '' ? null : <View style={{ flexDirection: 'row', gap: 8 }}><T size={13} color={c.mute} style={{ width: 130 }}>{label(k)}</T><T size={13} style={{ flex: 1 }}>{Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)}</T></View>);

let cache = null;
/** The service catalogue (families, units, typed fields), loaded once. */
export function useCatalogue() {
  const r = useLoad(async () => (cache ??= await api.get('/service-catalogue')), []);
  return r.data ?? null;
}
export const catLabel = (cat, slug) => cat?.categories.find((x) => x.slug === slug)?.label ?? label(slug);

/** Form fields for the typed scope of every category, each shown only for its own category. Values come back as `s_<category>_<key>`. */
export function scopeFields(cat, tz) {
  const out = [];
  for (const k of cat?.categories ?? []) {
    out.push({ type: 'section', key: `sec_${k.slug}`, label: `${k.label} details`, show: (v) => v.category === k.slug });
    for (const f of k.fields) {
      const key = `s_${k.slug}_${f.key}`, show = (v) => v.category === k.slug, base = { key, label: f.label, optional: !f.required, show };
      if (f.type === 'number') out.push({ ...base, type: f.integer ? 'stepper' : 'number', ...(f.integer ? { min: 0, max: 100000, default: 0 } : {}) });
      else if (f.type === 'bool') out.push({ ...base, type: 'switch', default: false });
      else if (f.type === 'enum') out.push({ ...base, type: 'chips', options: f.options.map((o) => ({ value: o, label: label(o) })) });
      else if (f.type === 'multi') out.push({ ...base, type: 'multi', options: f.options.map((o) => ({ value: o, label: label(o) })) });
      else if (f.type === 'sport') out.push({ ...base, type: 'sport' });
      else if (f.type === 'date') out.push({ ...base, type: 'date' });
      else if (f.type === 'time') out.push({ ...base, type: 'time' });
      else if (f.type === 'datetime') { out.push({ ...base, key: `${key}__d`, type: 'date' }); out.push({ ...base, key: `${key}__t`, label: `${f.label} (time)`, type: 'time' }); }
      else out.push({ ...base, type: 'text' });
    }
  }
  return out;
}
/** Collect the typed scope for `category` out of form values. */
export function collectScope(cat, category, v, tz = 'UTC') {
  const k = cat?.categories.find((x) => x.slug === category);
  const out = {};
  for (const f of k?.fields ?? []) {
    const key = `s_${category}_${f.key}`;
    if (f.type === 'datetime') { const d = v[`${key}__d`], t = v[`${key}__t`]; if (d) out[f.key] = localToIso(d, t || '00:00', tz); continue; }
    const x = v[key];
    if (x === undefined || x === '' || (Array.isArray(x) && !x.length) || (f.type === 'bool' && x === false)) continue;
    out[f.key] = f.type === 'number' ? Number(x) : x;
  }
  return out;
}

/** Generate a branded PDF of a supplier-services document and open / share it. */
export function DocButton({ type, id, title = 'PDF', kitId, small = true }) {
  const { toast } = useSession();
  const [busy, setBusy] = React.useState(false);
  return (
    <Btn small={small} loading={busy} title={title} color={c.paper} ink={c.ink} accessibilityLabel={`Download ${title}`}
      onPress={async () => { setBusy(true); try { const d = await api.post('/service-documents', { type, source_id: id, ...(kitId ? { kit_id: kitId } : {}) }); await openPdf(`/branded-documents/${d.id}/file`, `${type}-${String(id).slice(0, 8)}`); } catch (e) { toast('' + e.message); } finally { setBusy(false); } }} />
  );
}
export const Pick = ({ items, value, onPick, all }) => (
  <Wrap>{all ? <Chip label={all} active={!value} onPress={() => onPick(null)} /> : null}{items.map(([k, l]) => <Chip key={k} label={l} active={value === k} onPress={() => onPick(k)} />)}</Wrap>
);
export const Tabs = ({ tabs, value, onChange }) => <Wrap gap={6}>{tabs.map(([k, l]) => <Chip key={k} label={l} active={value === k} onPress={() => onChange(k)} />)}</Wrap>;
export const Note = ({ children }) => <T size={12} color={c.mute}>{children}</T>;

/** Save or share a file that came back from the API as text / base64 (a background export). */
export async function shareFile(name, mime, data, encoding) {
  const bytes = encoding === 'base64' ? Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(data);
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const file = new File(Paths.cache, String(name).replace(/[^A-Za-z0-9._-]/g, '_'));
  file.create({ overwrite: true }); file.write(bytes);
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot share files from here. Use the web app.');
  await Sharing.shareAsync(file.uri, { mimeType: mime.split(';')[0], dialogTitle: name });
}

/** Background exports of the reports: ask for CSV / XLSX / PDF, watch them finish, download or share. */
export function ExportsPanel({ side, scopeId }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/service-reports/exports', { limit: 10 }), [scopeId]);
  const [fmt, setFmt] = React.useState('csv');
  const mine = (list.data ?? []).filter((x) => x.scope_id === scopeId);
  const ask = async (report) => { try { await api.post('/service-reports/exports', { side, scope_id: scopeId, report, format: fmt }); toast('Export started — it appears below when ready'); list.reload(); } catch (e) { toast('' + e.message); } };
  const get = async (x) => { try { const f = await api.get(`/service-reports/exports/${x.id}`); await shareFile(f.filename, f.content_type, f.data, f.encoding); } catch (e) { toast('' + e.message); } };
  return (
    <View style={{ gap: 8 }}>
      <T weight="800">Background exports</T>
      <Note>Large reports are built in the background (up to 100,000 rows) and kept private to you.</Note>
      <Wrap>{['csv', 'xlsx', 'pdf'].map((f) => <Chip key={f} label={f.toUpperCase()} active={fmt === f} onPress={() => setFmt(f)} />)}</Wrap>
      <Wrap>{['dashboard', 'orders', 'invoices', 'payments', 'tax'].map((r) => <Btn key={r} small color={c.paper} ink={c.ink} title={`Export ${r}`} onPress={() => ask(r)} />)}</Wrap>
      {mine.map((x) => (
        <Card key={x.id} pad={10}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}><T size={13} weight="700">{label(x.report)} · {x.format.toUpperCase()}</T><T size={12} color={c.mute}>{x.status === 'ready' ? `${x.row_count} rows${x.truncated ? ' (truncated)' : ''}` : x.status === 'failed' ? x.error : 'building…'}</T></View>
            {x.status === 'ready' ? <Btn small title="Download" onPress={() => get(x)} /> : <Btn small color={c.paper} ink={c.ink} title="Refresh" onPress={list.reload} />}
          </View>
        </Card>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- procurement chain (#520)
const DOT = { done: c.mint, active: c.sun, pending: c.line, gap: c.red };
const STAGE_WORD = { done: 'done', active: 'in progress', pending: 'not yet', gap: 'needs attention' };
const factText = (s, cur) => {
  const f = s.facts ?? {};
  if (s.key === 'fulfilment') return `${f.accepted} of ${f.ordered} accepted · ${f.invoiced} invoiced`;
  if (s.key === 'invoice' && f.issued) return `billed ${money(f.billed_minor, cur)} · ${f.matched} matched${f.exceptions ? ` · ${f.exceptions} need a decision` : ''}`;
  if (s.key === 'payment' && f.paid_minor) return `paid ${money(f.paid_minor, cur)}`;
  if (s.key === 'budget' && f.committed_minor !== undefined) return `committed ${money(f.committed_minor, cur)} · paid ${money(f.actual_minor, cur)} · still committed ${money(f.remaining_commitment_minor, cur)}`;
  if (s.key === 'order' && f.gross_minor) return `${money(f.gross_minor, cur)} incl. tax`;
  return '';
};
/**
 * The commercial chain of one order, demand to supplier performance, from the API (one definition for REST, OpenAPI and MCP). Works at phone,
 * tablet and desktop widths: a single column that becomes a wrapped grid of cards; every stage is readable by a screen reader as one item.
 */
export function ChainTrace({ path }) {
  const r = useLoad(() => api.get(path), [path]);
  if (r.loading && !r.data) return <T size={13} color={c.mute}>Loading the chain…</T>;
  if (r.error || !r.data) return <T size={13} color={c.mute}>The chain is not available for this order.</T>;
  const x = r.data, cur = x.stages.find((s) => s.key === 'order')?.facts?.currency;
  return (
    <View style={{ gap: 8 }} accessibilityRole="list">
      <T size={12} color={c.mute}>{x.route === 'tender' ? 'Formal tender' : x.route === 'rfq' ? 'Request for quotation' : 'Direct order'} · each step names the record it comes from{x.unlinked ? ' · not linked to a service order yet' : ''}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {x.stages.map((s) => (
          <View key={s.key} accessible accessibilityRole="text" accessibilityLabel={`${s.label}: ${STAGE_WORD[s.status]}. ${s.summary}. ${factText(s, cur)}`}
            style={{ flexGrow: 1, flexBasis: 220, minHeight: 56, borderWidth: 1, borderColor: c.line, borderLeftWidth: 5, borderLeftColor: DOT[s.status], borderRadius: 12, padding: 10, backgroundColor: c.paper }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 6 }}><T weight="700" size={13}>{s.label}</T><T size={11} color={c.mute}>{STAGE_WORD[s.status]}</T></View>
            <T size={12}>{s.summary}</T>
            {factText(s, cur) ? <T size={11} color={c.mute}>{factText(s, cur)}</T> : null}
          </View>
        ))}
      </View>
    </View>
  );
}

const pct = (v) => `${Math.round(v * 100)}%`;
const dimValue = (d) => (d.value === null ? '—' : d.unit === 'ratio' ? pct(d.value) : d.unit === 'hours' ? `${d.value} h` : d.unit === 'stars_1_5' ? `${d.value} / 5` : String(d.value));
/** Supplier facts with their sample size. Fewer than five observations are shown but marked; there is no combined score. */
export function PerformanceRecord({ profileId, buyerId }) {
  const [f, setF] = React.useState({ event_ids: [], venue_ids: [], competition_ids: [], categories: [], range: {} });
  const query = React.useMemo(() => ({
    ...(buyerId ? { buyer_id: buyerId } : {}),
    ...Object.fromEntries(['event_ids', 'venue_ids', 'competition_ids', 'categories'].filter((k) => f[k].length).map((k) => [k, f[k].join(',')])),
    ...(f.range.from ? { from: `${f.range.from}T00:00:00.000Z` } : {}), ...(f.range.to ? { to: new Date(Date.parse(`${f.range.to}T00:00:00Z`) + 864e5).toISOString() } : {}),
  }), [f, buyerId]);
  const r = useLoad(() => api.get(`/supplier-profiles/${profileId}/performance`, query), [profileId, JSON.stringify(query)]);
  // options come from the orders this reader may see, searched on the server as they type
  const opts = (kind) => React.useCallback(async (q) => (await api.get(`/supplier-profiles/${profileId}/performance/filters`, { kind, q: q || undefined, ...(buyerId ? { buyer_id: buyerId } : {}) })).map((x) => ({ value: x.id, label: kind === 'category' ? label(x.name) : x.name })), [kind, profileId, buyerId]);
  const loaders = { event_ids: opts('event'), venue_ids: opts('venue'), competition_ids: opts('competition'), categories: opts('category') };
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const filtered = f.event_ids.length || f.venue_ids.length || f.competition_ids.length || f.categories.length || f.range.from;
  const x = r.data;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {[['event_ids', 'Events', 'All events'], ['venue_ids', 'Venue', 'All venues'], ['competition_ids', 'Competition', 'All competitions'], ['categories', 'Service', 'All services']].map(([k, l, ph]) => (
          <View key={k} style={{ flexGrow: 1, flexBasis: 170 }}><MultiMenuField label={l} value={f[k]} onChange={set(k)} load={loaders[k]} placeholder={ph} /></View>
        ))}
        <View style={{ flexGrow: 1, flexBasis: 170 }}><DateRangeField label="Period" from={f.range.from} to={f.range.to} optional onChange={set('range')} /></View>
      </View>
      {filtered ? <Btn small color={c.paper} ink={c.ink} title="Clear filters" accessibilityLabel="Clear all scorecard filters" onPress={() => setF({ event_ids: [], venue_ids: [], competition_ids: [], categories: [], range: {} })} /> : null}
      {r.loading && !x ? <T size={13} color={c.mute}>Loading…</T> : r.error || !x ? <T size={13} color={c.mute}>Performance is not available.</T> : (
        <>
          <T size={12} color={c.mute}>{x.orders.total} order(s){filtered ? ' match these filters' : ''}{buyerId ? ' with you' : ` from ${x.orders.buyers} buyer(s)`}. {x.method}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {x.dimensions.map((d) => (
              <View key={d.key} accessible accessibilityLabel={`${d.label}: ${dimValue(d)} from ${d.n} observations${d.reliable ? '' : ', too few to rely on'}`} style={{ flexGrow: 1, flexBasis: 260, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 10, backgroundColor: c.paper, opacity: d.n ? 1 : 0.7 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="700" size={13}>{d.label}</T><T weight="800" size={14} color={d.n && !d.reliable ? c.sun : c.ink}>{dimValue(d)}</T></View>
                <T size={11} color={c.mute}>n = {d.n}{d.note ? ` · ${d.note}` : ''}</T>
                <T size={11} color={c.mute}>{d.definition}</T>
              </View>
            ))}
          </View>
        </>
      )}
    </View>
  );
}
