// Guided setup for a new venue: courts and their sport → price categories → paint the weekly timetable → finish.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Field, Loading, T } from '../ui';
import { Counter, Stepper } from '../pickers';
import { SportPicker } from '../sportpicker';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { PaintGrid } from './paintgrid';

const digits = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
const toMinor = (text, cur) => Math.round(Number(String(text).replace(/,/g, '')) * 10 ** digits(cur));
const KINDS = [['court', '🏟️ Court'], ['table', '🏓 Table'], ['lane', '🎳 Lane'], ['pool', '🏊 Pool'], ['ground', '🌿 Ground'], ['room', '🚪 Room'], ['other', 'Other']];
const SLOTS = [[30, '30 min'], [45, '45 min'], [60, '1 hour'], [90, '1½ h'], [120, '2 hours']];
const PRESETS = [['Off-peak', '#059669'], ['Peak', '#EA580C'], ['Weekend', '#4F46E5'], ['Coaching', '#7C3AED']];

function CourtsStep({ v, data, reload, next }) {
  const { toast } = useSession();
  const [sport, setSport] = useState('');
  const [kind, setKind] = useState('court');
  const [prefix, setPrefix] = useState('Court');
  const [count, setCount] = useState(2);
  const [slot, setSlot] = useState(60);
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const noSport = data.courts.filter((x) => !x.sport_slug);
  const add = async () => {
    if (!sport) { toast('Choose the sport first'); return; }
    setBusy(true);
    try {
      const start = data.courts.filter((x) => x.name.toLowerCase().startsWith(prefix.toLowerCase())).length + 1;
      await api.post(`/venues/${v.id}/resources/bulk`, { kind, sport, name_prefix: prefix.trim(), count, start_number: start, slot_minutes: slot, ...(rate ? { hourly_rate_cents: toMinor(rate, v.currency) } : {}) });
      toast(`${count} added`); reload();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 12 }}>
      <T size={18} weight="800">What can people book?</T>
      <T color={c.mute} size={13}>Start with the sport, then add all the courts of that kind in one go. Repeat for another sport.</T>
      {data.courts.length ? <Card color={c.limeSoft} pad={12}><T weight="700">Added so far</T>{data.courts.map((x) => <T key={x.id} size={13}>{x.sport_emoji ?? '⚠'} {x.name}{x.sport ? '' : ' — no sport yet'} · {x.slot_minutes} min slots</T>)}</Card> : null}
      <SportPicker label="1 · Sport" value={sport} onChange={setSport} />
      <View style={{ gap: 6 }}><T weight="800" size={13}>2 · What is it</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{KINDS.map(([k, l]) => <Chip key={k} label={l} active={kind === k} onPress={() => { setKind(k); setPrefix(l.replace(/^\S+\s/, '')); }} />)}</View></View>
      <Field label="3 · Name (numbers are added)" value={prefix} onChangeText={setPrefix} placeholder="Court" />
      <View style={{ flexDirection: 'row', alignItems: 'center' }}><T weight="800" size={13} style={{ flex: 1 }}>4 · How many</T><Counter value={count} onChange={setCount} min={1} max={30} /></View>
      <View style={{ gap: 6 }}><T weight="800" size={13}>5 · Slot length</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{SLOTS.map(([m, l]) => <Chip key={m} label={l} active={slot === m} onPress={() => setSlot(m)} />)}</View></View>
      <Field label={`6 · Base rate per hour (${v.currency}) — optional`} value={rate} onChangeText={(x) => setRate(x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" placeholder="e.g. 800" hint="Used where no price category applies; you'll set Peak / Off-peak next" />
      <Btn title={`Add ${count} ${prefix || 'court'}${count > 1 ? 's' : ''}`} onPress={add} loading={busy} color={c.violet} />
      {noSport.length ? (
        <Card color={c.sunSoft} pad={12}><T size={13} weight="700">{noSport.map((x) => x.name).join(', ')} {noSport.length > 1 ? 'have' : 'has'} no sport.</T>
          <T size={12} color={c.mute}>Pick a sport above and tap below to apply it to them.</T>
          <Btn small title="Set the chosen sport on them" color={c.paper} style={{ marginTop: 6, alignSelf: 'flex-start' }} onPress={async () => { if (!sport) { toast('Choose a sport first'); return; } try { await api.patch(`/venues/${v.id}/resources`, { resource_ids: noSport.map((x) => x.id), sport }); reload(); } catch (e) { toast(e.message); } }} /></Card>
      ) : null}
      <Btn title="Next: prices" disabled={!data.courts.length || noSport.length > 0} onPress={next} />
    </View>
  );
}

function PricesStep({ v, data, reload, next }) {
  const { toast } = useSession();
  const have = new Set(data.categories.map((x) => x.name.toLowerCase()));
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const addPreset = (name, color) => setRows((p) => (p.some((r) => r.name === name) ? p : [...p, { name, color, rate: '' }]));
  const save = async () => {
    setBusy(true);
    try {
      for (const r of rows) { if (r.rate === '') throw new Error(`Enter a rate for ${r.name}`); await api.post(`/venues/${v.id}/categories`, { name: r.name, color: r.color, hourly_rate_cents: toMinor(r.rate, v.currency) }); }
      setRows([]); reload(); toast('Prices saved');
    } catch (e) { toast(e.message); reload(); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 12 }}>
      <T size={18} weight="800">What do you charge?</T>
      <T color={c.mute} size={13}>Name your prices once — you'll paint them onto the week in the next step. Skip this to charge each court's base rate all day.</T>
      {data.categories.filter((x) => x.active).map((x) => <Card key={x.id} pad={10}><T weight="700">● <T color={x.color} weight="800">{x.name}</T> · {moneyIn(x.hourly_rate_cents, v.currency)}/h</T></Card>)}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{PRESETS.filter(([n]) => !have.has(n.toLowerCase())).map(([n, col]) => <Chip key={n} label={`＋ ${n}`} onPress={() => addPreset(n, col)} />)}</View>
      {rows.map((r, i) => <Field key={r.name} label={`${r.name} — rate per hour (${v.currency})`} value={r.rate} onChangeText={(x) => setRows((p) => p.map((y, k) => (k === i ? { ...y, rate: x.replace(/[^0-9.,]/g, '') } : y)))} keyboardType="decimal-pad" placeholder="e.g. 1200" />)}
      {rows.length ? <Btn title="Save prices" onPress={save} loading={busy} color={c.violet} /> : null}
      <Btn title="Next: weekly timetable" onPress={next} />
    </View>
  );
}

export function SetupWizard({ v, onExit, goTab }) {
  const [step, setStep] = useState(0);
  const tt = useLoad(() => api.get(`/venues/${v.id}/timetable`), [v.id]);
  const st = useLoad(() => api.get(`/venues/${v.id}/setup`), [v.id, step]);
  if (tt.loading && !tt.data) return <Loading />;
  const d = tt.data;
  return (
    <View style={{ gap: 8 }}>
      <Stepper steps={['Courts', 'Prices', 'Timetable', 'Finish']} current={step} onJump={setStep} />
      {step === 0 ? <CourtsStep v={v} data={d} reload={tt.reload} next={() => setStep(1)} /> : null}
      {step === 1 ? <PricesStep v={v} data={d} reload={tt.reload} next={() => setStep(2)} /> : null}
      {step === 2 ? (
        <View style={{ gap: 12 }}>
          <T size={18} weight="800">When are you open, and at what price?</T>
          <T color={c.mute} size={13}>Paint the usual week for all your courts. You can fine-tune single courts, seasons and holidays later.</T>
          <PaintGrid venue={v} data={d} courtIds={d.courts.map((x) => x.id)} saveLabel="Save & continue" onSaved={() => { tt.reload(); setStep(3); }} />
          <Btn small title="Skip for now" color={c.paper} onPress={() => setStep(3)} />
        </View>
      ) : null}
      {step === 3 ? (
        <View style={{ gap: 10 }}>
          <T size={18} weight="800">{st.data?.ready ? '🎉 You are ready for bookings' : 'Almost there'}</T>
          {(st.data?.steps ?? []).map((s) => <T key={s.key} size={13} color={s.done ? c.lime : c.ink}>{s.done ? '✓' : '○'} {s.title} <T size={12} color={c.mute}>— {s.detail}</T></T>)}
          <Btn title="Invoices, tax & contact details" color={c.violet} onPress={() => { goTab('setup'); onExit(); }} />
          <Btn title="Photos" color={c.paper} onPress={() => { goTab('media'); onExit(); }} />
          <Btn title="Open the venue console" onPress={onExit} />
        </View>
      ) : null}
    </View>
  );
}
