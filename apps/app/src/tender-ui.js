// Shared building blocks for the Tender zone screens. One set of components for iOS, iPadOS, Android and web: stacked cards on phones,
// real tables and split panes from tablet width up, 44pt touch targets, labelled controls, and semantic colour with a text label.
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { c } from './theme';
import { useLayout } from './layout';
import { Btn, Card, Chip, T } from './ui';
import { api } from './api';
import { openPdf } from './open-file';
import { saveText, openBase64 } from './evidence';

export const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const TONES = { ok: [c.limeSoft, c.lime], warn: [c.sunSoft, c.sun], bad: [c.redSoft, c.red], info: [c.violetSoft, c.violet], neutral: [c.violetSoft, c.mute], accent: [c.pinkSoft, c.pink] };

/** Money in its own currency from minor units, using the currency's own number of decimals. */
export function amount(minor, cur) {
  if (minor === null || minor === undefined) return '—';
  try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(Number(minor) / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${minor} ${cur ?? ''}`; }
}
export const exponentOf = (cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
/** "12.50" -> 1250 for the currency's decimals; null when it is not a plain amount. */
export function toMinor(text, cur) {
  const s = String(text ?? '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const e = exponentOf(cur);
  const [w, f = ''] = s.split('.');
  if (f.length > e) return null;
  return Number(w) * 10 ** e + Number(f.padEnd(e, '0') || 0);
}
export const fromMinor = (minor, cur) => (minor === null || minor === undefined ? '' : (Number(minor) / 10 ** exponentOf(cur)).toFixed(exponentOf(cur)));

/** A moment in the tender's own time zone and in UTC. The tender, not the viewer's phone, decides when it closes. */
export function when(iso, tz) {
  if (!iso) return '—';
  const d = new Date(iso);
  let local = '';
  try { local = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz || undefined }).format(d); } catch { local = d.toISOString(); }
  return `${local}${tz ? ` ${tz.split('/').pop().replace(/_/g, ' ')}` : ''} · ${d.toISOString().slice(11, 16)} UTC`;
}
export const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '—');

export function Status({ tone = 'neutral', label }) {
  const [bg, fg] = TONES[tone] ?? TONES.neutral;
  return <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' }}><T weight="700" size={11} color={fg} style={{ letterSpacing: 0.2 }}>{label}</T></View>;
}
const STAGE_TONE = { open: 'ok', submission: 'ok', closed: 'warn', evaluation: 'info', award: 'info', awarded: 'ok', cancelled: 'bad', suspended: 'warn', draft: 'neutral', approval: 'warn', approved: 'info', scheduled: 'info', archived: 'neutral' };
export const StageTag = ({ stage }) => <Status tone={STAGE_TONE[stage] ?? 'neutral'} label={nice(stage)[0].toUpperCase() + nice(stage).slice(1)} />;

/** The sourcing journey as a progress strip: done / current / upcoming, with the key date under each step. */
export function Stages({ steps }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
      {steps.map((s) => (
        <View key={s.label} style={{ minWidth: 92, flexGrow: 1, borderTopWidth: 4, borderColor: s.state === 'done' ? c.lime : s.state === 'on' ? c.pink : c.line, paddingTop: 8, paddingRight: 8 }} accessible accessibilityLabel={`${s.label}, ${s.state === 'done' ? 'done' : s.state === 'on' ? 'current' : 'upcoming'}${s.sub ? `, ${s.sub}` : ''}`}>
          <T weight="700" size={12} color={s.state === 'done' ? c.lime : s.state === 'on' ? c.ink : c.mute}>{s.label}</T>
          {s.sub ? <T size={11} color={c.mute}>{s.sub}</T> : null}
        </View>
      ))}
    </ScrollView>
  );
}

/** Ticks every second. Informative only: the server's receipt time decides, and the tender is closed at the exact deadline instant. */
export function Countdown({ to }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const ms = Math.max(0, new Date(to).getTime() - now);
  const parts = [[Math.floor(ms / 864e5), 'days'], [Math.floor(ms / 36e5) % 24, 'hrs'], [Math.floor(ms / 6e4) % 60, 'min'], [Math.floor(ms / 1e3) % 60, 'sec']];
  return (
    <View style={{ flexDirection: 'row', gap: 6 }} accessible accessibilityLabel={ms ? `Closes in ${parts[0][0]} days ${parts[1][0]} hours ${parts[2][0]} minutes` : 'Closed'}>
      {ms ? parts.map(([n, l]) => <View key={l} style={{ backgroundColor: c.violet, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, minWidth: 54, alignItems: 'center' }}><T weight="800" size={18} color="#fff" style={{ fontVariant: ['tabular-nums'] }}>{String(n).padStart(2, '0')}</T><T size={9} color="#fff" style={{ opacity: 0.75, textTransform: 'uppercase', letterSpacing: 0.6 }}>{l}</T></View>) : <Status tone="warn" label="Closed" />}
    </View>
  );
}

/** A checklist row: ✓ ok, ! warning, ✕ blocking, with a plain-language line under it. */
export function Checks({ items, empty = 'Nothing to check.' }) {
  if (!items.length) return <T size={13} color={c.mute}>{empty}</T>;
  return (
    <View>
      {items.map((x, i) => (
        <View key={`${x.key ?? i}`} style={{ flexDirection: 'row', gap: 10, paddingVertical: 9, borderTopWidth: i ? 1 : 0, borderColor: c.line }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: x.state === 'ok' ? c.lime : x.state === 'bad' ? c.red : x.state === 'warn' ? c.sun : c.line, marginTop: 1 }}><T size={11} weight="800" color="#fff">{x.state === 'ok' ? '✓' : x.state === 'bad' ? '✕' : x.state === 'warn' ? '!' : '•'}</T></View>
          <View style={{ flex: 1, minWidth: 0 }}><T weight="600" size={13}>{x.title}</T>{x.detail ? <T size={12} color={c.mute}>{x.detail}</T> : null}</View>
          {x.action ? <Btn small title={x.action} onPress={x.onAction} color={c.violet} /> : null}
        </View>
      ))}
    </View>
  );
}

/** Label/value tiles that wrap to the width they are given. */
export function KV({ items }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.filter((x) => x[1] !== undefined && x[1] !== null && x[1] !== '').map(([k, v]) => (
        <View key={k} style={{ flexGrow: 1, flexBasis: 150, backgroundColor: c.bg, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: c.line }}>
          <T size={10} weight="700" color={c.mute} style={{ letterSpacing: 0.7, textTransform: 'uppercase' }}>{k}</T>
          <T size={13} weight="700" style={{ marginTop: 2 }}>{v}</T>
        </View>
      ))}
    </View>
  );
}

/** A data table on tablet and desktop; on a phone each row becomes a card, so nothing needs sideways scrolling. */
export function DataTable({ cols, rows, onRow, empty = 'Nothing here yet.', keyOf = (r, i) => r.id ?? i }) {
  const L = useLayout();
  if (!rows.length) return <T size={13} color={c.mute}>{empty}</T>;
  if (L.phone) {
    return (
      <View style={{ gap: 8 }}>
        {rows.map((r, i) => (
          <Pressable key={keyOf(r, i)} disabled={!onRow} onPress={() => onRow?.(r)} accessibilityRole={onRow ? 'button' : undefined} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 12, gap: 6, backgroundColor: c.paper }}>
            {cols.map((col) => { const v = col.render ? col.render(r) : r[col.key]; return v === undefined || v === null || v === '' ? null : <View key={col.key} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}><T size={11} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0 }}>{col.label}</T><View style={{ flexShrink: 1, alignItems: 'flex-end' }}>{typeof v === 'object' ? v : <T size={13} weight={col.bold ? '700' : '500'} style={{ textAlign: 'right' }}>{String(v)}</T>}</View></View>; })}
          </Pressable>
        ))}
      </View>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ minWidth: '100%' }}>
      <View style={{ flex: 1, minWidth: '100%' }}>
        <View style={{ flexDirection: 'row', backgroundColor: c.bg, borderRadius: 10, paddingVertical: 8 }}>
          {cols.map((col) => <View key={col.key} style={{ flex: col.flex ?? 1, minWidth: col.min ?? 90, paddingHorizontal: 10 }}><T size={10} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.7, textAlign: col.right ? 'right' : 'left' }}>{col.label}</T></View>)}
        </View>
        {rows.map((r, i) => (
          <Pressable key={keyOf(r, i)} disabled={!onRow} onPress={() => onRow?.(r)} accessibilityRole={onRow ? 'button' : undefined} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 44, borderBottomWidth: 1, borderColor: c.line, opacity: pressed ? 0.85 : 1 })}>
            {cols.map((col) => { const v = col.render ? col.render(r) : r[col.key]; return <View key={col.key} style={{ flex: col.flex ?? 1, minWidth: col.min ?? 90, paddingHorizontal: 10, paddingVertical: 8, alignItems: col.right ? 'flex-end' : 'flex-start' }}>{v !== null && typeof v === 'object' ? v : <T size={13} weight={col.bold ? '700' : '500'} style={{ textAlign: col.right ? 'right' : 'left' }}>{v === undefined || v === null || v === '' ? '—' : String(v)}</T>}</View>; })}
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

/** A score cell shaded by how good it is. The number is always printed, so colour is never the only signal. */
export function Heat({ value, max = 10, na }) {
  if (na) return <T size={12} color={c.mute}>N/A</T>;
  if (value === null || value === undefined) return <T size={12} color={c.mute}>—</T>;
  const p = Math.max(0, Math.min(1, value / max));
  return <View style={{ minWidth: 48, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8, alignItems: 'center', backgroundColor: p >= 0.5 ? c.limeSoft : c.redSoft, borderWidth: 1, borderColor: p >= 0.5 ? c.lime : c.red }}><T weight="800" size={13} color={p >= 0.5 ? c.lime : c.red} style={{ fontVariant: ['tabular-nums'] }}>{Number(value).toFixed(1)}</T></View>;
}

/** Main column and side column: side by side from tablet width up, stacked on a phone. */
export function Split({ main, side, sideWidth = 340 }) {
  const L = useLayout();
  if (L.phone || !side) return <View style={{ gap: 14 }}>{main}{side}</View>;
  return <View style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}><View style={{ flex: 1, gap: 14, minWidth: 0 }}>{main}</View><View style={{ width: sideWidth, gap: 14 }}>{side}</View></View>;
}

export const Panel = ({ title, right, children, style }) => (
  <Card style={style}>
    {title || right ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>{title ? <T weight="700" size={14} style={{ flexShrink: 1 }}>{title}</T> : <View />}{right}</View> : null}
    <View style={{ gap: 10 }}>{children}</View>
  </Card>
);

export function Tabs({ tabs, value, onChange }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }} style={{ borderBottomWidth: 1, borderColor: c.line, marginTop: 10 }}>
      {tabs.map((t) => <Pressable key={t.value} onPress={() => onChange(t.value)} accessibilityRole="tab" accessibilityState={{ selected: value === t.value }} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderBottomWidth: 3, borderColor: value === t.value ? c.pink : 'transparent' }}><T weight="700" size={13} color={value === t.value ? c.pink : c.mute}>{t.label}</T></Pressable>)}
    </ScrollView>
  );
}

export const Chips = ({ options, value, onChange, multi }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
    {options.map((o) => { const v = o.value ?? o; const on = multi ? (value ?? []).includes(v) : value === v; return <Chip key={String(v)} label={o.label ?? nice(o)} active={on} onPress={() => onChange(multi ? (on ? value.filter((x) => x !== v) : [...(value ?? []), v]) : v)} />; })}
  </View>
);

export const Notice = ({ tone = 'warn', children }) => (
  <View accessibilityRole="alert" style={{ backgroundColor: TONES[tone][0], borderRadius: 12, padding: 12 }}><T size={13}>{children}</T></View>
);

// ---- files ----
const WEB = Platform.OS === 'web';
/** Open a PDF the server renders from an immutable snapshot (a tab on the web, the share sheet on a device). */
export const openDocument = (kind, id, q = {}, name = kind) => {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== null)).toString();
  return openPdf(`/tender-documents/${kind}/${id}.pdf${qs ? `?${qs}` : ''}`, name);
};
/** Save the file an export capability returns: text for CSV, base64 for XLSX and ZIP. */
export async function saveExport(f) {
  if (f.encoding === 'utf8') return saveText(f.filename, f.data, f.content_type?.split(';')[0] ?? 'text/csv');
  return openBase64({ file_name: f.filename, content_type: f.content_type, data: f.data });
}
export async function blobOf(file) { return (await fetch(`data:${file.type};base64,${file.data}`)).blob(); }
export const openStored = async (url, name = 'file') => {
  const blob = await api.download(url.replace('/api/v1', ''));
  if (WEB) { const u = URL.createObjectURL(blob); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 120000); return; }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const f = new File(Paths.cache, String(name).replace(/[^\w. -]/g, '_'));
  f.create({ overwrite: true }); f.write(new Uint8Array(await new Response(blob).arrayBuffer()));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open files from here. Open it in the web app.');
  await Sharing.shareAsync(f.uri, { dialogTitle: name });
};

// ---- time zones: a tender's dates are wall-clock times in its own zone; the server stores the exact instant ----
const wallParts = (ms, tz) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, asUtc: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) };
};
/** "2026-11-28" + "17:00" in Asia/Kolkata -> the UTC instant, correct across daylight-saving changes. */
export function zonedIso(date, time, tz = 'UTC') {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = (time || '00:00').split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - (wallParts(guess, tz).asUtc - guess);
  return new Date(guess).toISOString();
}
/** The wall-clock date and time of an instant in a zone, for editing. */
export const wallOf = (iso, tz = 'UTC') => (iso ? wallParts(new Date(iso).getTime(), tz) : { date: null, time: null });

// ---- display-only mirror of the server's line arithmetic (BigInt, half-up once per step). The server's figures are the ones that count. ----
const half = (a, b) => (a * 2n + b) / (b * 2n);
export function lineMinor({ qty, rate_minor, discount_bp = 0, tax_bp = 0, tax_inclusive = false }) {
  const q = String(qty ?? '').trim();
  if (!/^\d+(\.\d{1,4})?$/.test(q) || !Number.isInteger(rate_minor) || rate_minor < 0) return null;
  const [w, f = ''] = q.split('.');
  const scaled = BigInt(w) * 10000n + BigInt(f.padEnd(4, '0'));
  const base = half(scaled * BigInt(rate_minor), 10000n), disc = half(base * BigInt(10000 - discount_bp), 10000n);
  let net, tax, gross;
  if (tax_inclusive) { gross = disc; net = half(gross * 10000n, BigInt(10000 + tax_bp)); tax = gross - net; } else { net = disc; tax = half(net * BigInt(tax_bp), 10000n); gross = net + tax; }
  return { net: Number(net), tax: Number(tax), gross: Number(gross) };
}

/** Pick a text file (CSV): the web opens the browser's file chooser, a phone or tablet the system file picker. */
export async function pickText(accept = '.csv,text/csv') {
  if (Platform.OS === 'web') {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = accept;
      input.onchange = async () => { const f = input.files?.[0]; if (!f) return resolve(null); if (f.size > 400000) return reject(new Error('That file is too large for a pricing sheet.')); resolve(await f.text()); };
      input.oncancel = () => resolve(null);
      input.click();
    });
  }
  const DocumentPicker = await import('expo-document-picker');
  const r = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'text/plain'], copyToCacheDirectory: true });
  if (r.canceled || !r.assets?.[0]) return null;
  const { File } = await import('expo-file-system');
  return new File(r.assets[0].uri).text();
}
