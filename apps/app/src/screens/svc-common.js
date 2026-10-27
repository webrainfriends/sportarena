// Shared pieces for the supplier workspace and the buyer procurement screens (#458): catalogue-driven forms, status tags, KPI tiles and PDF buttons.
// Everything here calls the API (capabilities); no business rule lives in the app.
import React from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { c } from '../theme';
import { Btn, Card, Chip, T, Tag } from '../ui';
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
