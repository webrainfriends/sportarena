import React, { useEffect, useRef, useState } from 'react';
import { Switch, View } from 'react-native';
import { Btn, Chip, Field, Sheet, T, Seg } from './ui';
import { c } from './theme';
import { Counter, DateField, TimeField } from './pickers';
import { SportPicker } from './sportpicker';
import { api } from './api';
import { useLoad } from './hooks';
import { useSession } from './session';

const digits = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Colombo', 'Asia/Dhaka', 'Asia/Karachi', 'Asia/Kathmandu', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } };
const allZones = () => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ZONES; } };
const KEYBOARD = { phone: 'phone-pad', email: 'email-address', url: 'url', decimal: 'decimal-pad' };
const plain = (m) => (/expected (number|int)/i.test(m) ? 'Enter a number' : /received undefined|required/i.test(m) ? 'This is required' : /^invalid input$/i.test(m) ? 'This value is not valid' : /too small|>=/.test(m) ? `Too low — ${m}` : /too big|<=/.test(m) ? `Too high — ${m}` : m);
const same = (a, b) => a === b || a?.replace(/_(cents|bp|minutes|days|months)$/, '') === b?.replace(/_(cents|bp|minutes|days|months)$/, '');
const opt = (o) => (typeof o === 'object' ? o : { value: o, label: String(o) });

/**
 * One form, the right control for each kind of answer.
 * fields: [{ key, label, type, hint, optional, show?(values) }] where type is one of
 *   text (default) | multiline | secret | number | date | time
 *   stepper {min,max,step,suffix,default}   whole numbers and percentages with − / +
 *   money {currency}                        typed in whole currency units, submitted in minor units
 *   switch                                  yes / no
 *   choice {options}                        a few exclusive options (segmented), more than 4 become chips
 *   chips {options}                         exclusive options as wrapping chips
 *   multi {options}                         several of many
 *   weekdays                                day chips with Weekdays / Weekend / Every day shortcuts → [0..6]
 *   sport                                   search / quick-pick a sport → slug
 *   section {label}                         a heading between groups
 * `initial` is read each time the sheet opens. onSubmit(values) -> Promise; throws to show an error.
 */
function ZonePicker({ label, value, onChange }) {
  const [q, setQ] = useState('');
  const dz = deviceZone();
  const list = q.trim() ? allZones().filter((z) => z.toLowerCase().includes(q.trim().toLowerCase().replace(/ /g, '_'))).slice(0, 12) : [...new Set([...(dz ? [dz] : []), ...ZONES])];
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{label}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{list.map((z) => <Chip key={z} label={z.replace(/_/g, ' ')} active={z === value} onPress={() => onChange(z)} />)}</View>
      <Field value={q} onChangeText={setQ} placeholder="Search a city or region…" />
      {value && !list.includes(value) ? <T size={12} color={c.mute}>Selected: {value}</T> : null}
    </View>
  );
}

function CurrencyPicker({ label, value, onChange }) {
  const cur = useLoad(() => api.get('/currencies'), []);
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{label}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(cur.data ?? [{ code: value ?? 'INR', symbol: '' }]).map((x) => <Chip key={x.code} label={`${x.code} ${x.symbol ?? ''}`.trim()} active={x.code === value} onPress={() => onChange(x.code)} />)}</View>
    </View>
  );
}

function LocationPicker({ f, v, set }) {
  const [msg, setMsg] = useState(null);
  const here = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setMsg('Location is not available here — type the numbers instead.'); return; }
    setMsg('Finding you…');
    navigator.geolocation.getCurrentPosition((p) => { set(f.key, String(Math.round(p.coords.latitude * 1e6) / 1e6)); set(f.lngKey, String(Math.round(p.coords.longitude * 1e6) / 1e6)); setMsg('Location set ✓'); }, () => setMsg('Could not get your location — type the numbers instead.'), { enableHighAccuracy: true, timeout: 10000 });
  };
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{f.label}{f.optional ? ' (optional)' : ''}</T>
      <Btn small title="📍 Use my current location" color={c.violet} onPress={here} style={{ alignSelf: 'flex-start' }} />
      {msg ? <T size={12} color={c.mute}>{msg}</T> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Field label="Latitude" value={String(v[f.key] ?? '')} onChangeText={(x) => set(f.key, x.replace(/[^0-9.\-]/g, ''))} keyboardType="decimal-pad" /></View>
        <View style={{ flex: 1 }}><Field label="Longitude" value={String(v[f.lngKey] ?? '')} onChangeText={(x) => set(f.lngKey, x.replace(/[^0-9.\-]/g, ''))} keyboardType="decimal-pad" /></View>
      </View>
      <T size={12} color={c.mute}>Standing at the venue? Use the button. Otherwise copy the numbers from Google Maps (long-press the spot).</T>
    </View>
  );
}

export function FormSheet({ visible, onClose, title, fields, initial = {}, submitLabel = 'Save', onSubmit, color = c.pink }) {
  const start = () => {
    const o = {};
    for (const f of fields) {
      const x = initial[f.key];
      if (f.type === 'money') o[f.key] = x === undefined || x === null || x === '' ? '' : String(Number(x) / 10 ** digits(f.currency));
      else if (f.type === 'stepper') o[f.key] = x ?? f.default ?? f.min ?? 0;
      else if (f.type === 'switch') o[f.key] = x ?? f.default ?? false;
      else if (f.type === 'multi' || f.type === 'weekdays') o[f.key] = x ?? f.default ?? [];
      else if (f.type === 'choice' || f.type === 'chips') o[f.key] = x ?? f.default ?? (f.optional ? undefined : opt(f.options[0]).value);
      else if (x !== undefined) o[f.key] = x;
      if (f.type === 'location' && initial[f.lngKey] !== undefined) o[f.lngKey] = initial[f.lngKey];
    }
    return o;
  };
  const [v, setV] = useState(start);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [bad, setBad] = useState({});   // field key -> what is wrong with it
  const { toast } = useSession();
  const was = useRef(false);
  useEffect(() => { if (visible && !was.current) { setV(start()); setErr(null); setBad({}); } was.current = visible; }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, x) => setV((p) => ({ ...p, [k]: x }));

  const submit = async () => {
    setBusy(true); setErr(null); setBad({});
    try {
      const out = {};
      for (const f of fields) {
        let x = f.type === 'choice' ? (v[f.key] ?? f.options[0]?.value ?? f.options[0]) : v[f.key];
        if (x === '' || x === undefined || (f.type === 'multi' && !x.length)) { if (!f.optional) throw new Error(`${f.label} is required`); continue; }
        out[f.key] = f.type === 'number' ? Number(x) : x;
      }
      const msg = await onSubmit(out);
      onClose(); if (typeof msg === 'string') toast(msg);
    } catch (e) {
      // the server says which fields are wrong; show each under its own control, in the words of the form's labels
      const det = Array.isArray(e.details) ? e.details : [];
      const marks = {}; const loose = [];
      for (const d of det) {
        const path = String(d.path ?? '').split('.')[0];
        const f = fields.find((x) => x.type !== 'section' && (same(x.key, path) || x.lngKey === path || x.apiKey === path));
        if (f) marks[f.key] = plain(d.message ?? 'Not valid'); else loose.push(`${path ? `${path}: ` : ''}${plain(d.message ?? 'Not valid')}`);
      }
      const names = Object.keys(marks).map((k) => fields.find((x) => x.key === k)?.label).filter(Boolean);
      setBad(marks);
      setErr(names.length || loose.length ? [names.length ? `Please check: ${names.join(', ')}.` : null, ...loose].filter(Boolean).join(' ') : e.message);
    } finally { setBusy(false); }
  };

  const lab = (f) => <T weight="800" size={13}>{f.label}{f.optional ? ' (optional)' : ''}</T>;
  const hint = (f) => (f.hint ? <T size={12} color={c.mute}>{f.hint}</T> : null);
  const control = (f) => {
    switch (f.type) {
      case 'section': return <T weight="800" size={15} style={{ marginTop: 8 }}>{f.label}</T>;
      case 'date': return <DateField label={f.label} value={v[f.key]} onChange={(x) => set(f.key, x)} optional={f.optional} min={f.min} max={f.max} hint={f.hint} />;
      case 'time': return <TimeField label={f.label} value={v[f.key]} onChange={(x) => set(f.key, x)} optional={f.optional} step={f.step} hint={f.hint} />;
      case 'timezone': return <ZonePicker label={f.label} value={v[f.key]} onChange={(x) => set(f.key, x)} />;
      case 'currency': return <CurrencyPicker label={f.label} value={v[f.key]} onChange={(x) => set(f.key, x)} />;
      case 'location': return <LocationPicker f={f} v={v} set={set} />;
      case 'sport': return <SportPicker label={f.label} optional={f.optional} value={v[f.key]} onChange={(x) => set(f.key, x)} />;
      case 'stepper': return (
        <View style={{ gap: 6 }}><View style={{ flexDirection: 'row', alignItems: 'center' }}><View style={{ flex: 1 }}>{lab(f)}</View><Counter value={v[f.key]} onChange={(x) => set(f.key, x)} min={f.min ?? 0} max={f.max ?? 999} step={f.step ?? 1} suffix={f.suffix} /></View>{hint(f)}</View>);
      case 'switch': return (
        <View style={{ gap: 4 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}>{lab(f)}</View><Switch value={!!v[f.key]} onValueChange={(x) => set(f.key, x)} trackColor={{ true: c.pink }} /></View>{hint(f)}</View>);
      case 'money': return (
        <View style={{ gap: 6 }}><Field label={`${f.label}${f.optional ? ' (optional)' : ''}`} value={String(v[f.key] ?? '')} onChangeText={(x) => set(f.key, x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" placeholder={`${f.currency ?? ''} ${f.placeholder ?? '0'}`.trim()} hint={f.hint} /></View>);
      case 'weekdays': return (
        <View style={{ gap: 6 }}>{lab(f)}
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Chip label="Weekdays" onPress={() => set(f.key, [1, 2, 3, 4, 5])} /><Chip label="Weekend" onPress={() => set(f.key, [6, 0])} /><Chip label="Every day" onPress={() => set(f.key, [0, 1, 2, 3, 4, 5, 6])} /></View>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{DAYS.map(([d, n]) => <Chip key={d} label={n} active={v[f.key]?.includes(d)} onPress={() => set(f.key, v[f.key]?.includes(d) ? v[f.key].filter((x) => x !== d) : [...(v[f.key] ?? []), d])} />)}</View>{hint(f)}</View>);
      case 'multi': return (
        <View style={{ gap: 6 }}>{lab(f)}<View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{f.options.map(opt).map((o) => <Chip key={String(o.value)} label={o.label} active={v[f.key]?.includes(o.value)} onPress={() => set(f.key, v[f.key]?.includes(o.value) ? v[f.key].filter((x) => x !== o.value) : [...(v[f.key] ?? []), o.value])} />)}</View>{hint(f)}</View>);
      case 'chips': return (
        <View style={{ gap: 6 }}>{lab(f)}<View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{f.options.map(opt).map((o) => <Chip key={String(o.value)} label={o.label} active={v[f.key] === o.value} onPress={() => set(f.key, o.value)} />)}</View>{hint(f)}</View>);
      case 'choice': {
        const os = f.options.map(opt);
        if (os.length > 4) return control({ ...f, type: 'chips' });
        return <View style={{ gap: 6 }}>{lab(f)}<Seg options={os} value={v[f.key] ?? os[0]?.value} onChange={(x) => set(f.key, x)} color={color} />{hint(f)}</View>;
      }
      default: return <Field label={f.label + (f.optional ? ' (optional)' : '')} value={String(v[f.key] ?? '')} onChangeText={(x) => set(f.key, x)} secure={f.type === 'secret'} multiline={f.type === 'multiline'} keyboardType={f.type === 'number' ? 'numeric' : KEYBOARD[f.input]} placeholder={f.placeholder} hint={f.hint} />;
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      {fields.map((f) => f.type === 'date' ? (
        <DateField key={f.key} label={f.label} value={v[f.key]} onChange={(x) => set(f.key, x)} optional={f.optional} min={f.min} max={f.max} hint={f.hint} />
      ) : f.type === 'time' ? (
        <TimeField key={f.key} label={f.label} value={v[f.key]} onChange={(x) => set(f.key, x)} optional={f.optional} step={f.step} hint={f.hint} />
      ) : f.type === 'choice' ? (
        <View key={f.key} style={{ gap: 6 }}><T weight="800" size={13}>{f.label}</T><Seg options={f.options} value={v[f.key] ?? f.options[0]?.value ?? f.options[0]} onChange={(x) => set(f.key, x)} color={c.pink} /></View>
      ) : f.type === 'multi' ? (
        <View key={f.key} style={{ gap: 6 }}><T weight="800" size={13}>{f.label}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {f.options.map((o) => { const cur = v[f.key] ?? []; return <Chip key={o.value} label={o.label} active={cur.includes(o.value)} onPress={() => set(f.key, cur.includes(o.value) ? cur.filter((x) => x !== o.value) : [...cur, o.value])} />; })}
          </View></View>
      ) : (
        <Field key={f.key} label={f.label + (f.optional ? ' (optional)' : '')} value={String(v[f.key] ?? '')} onChangeText={(x) => set(f.key, x)} secure={f.type === 'secret'} multiline={f.type === 'multiline'} keyboardType={f.type === 'number' ? 'numeric' : undefined} hint={f.hint} placeholder={f.placeholder} />
      ))}
      {err ? <T color={c.red} weight="800">{err}</T> : null}
      <Btn title={submitLabel} onPress={submit} loading={busy} color={color} />
    </Sheet>
  );
}
