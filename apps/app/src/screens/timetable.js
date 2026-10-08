// The owner's weekly timetable: price categories, bulk "open these courts on these days at these times under this category",
// bulk court creation, copying a timetable, and the launch checklist.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Section, Seg, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateField, TimeField } from '../pickers';
import { c } from '../theme';
import { WEEKDAYS, moneyIn } from '../vtime';

const COLORS = [['#4F46E5', 'Indigo'], ['#059669', 'Green'], ['#EA580C', 'Orange'], ['#E11D48', 'Red'], ['#0284C7', 'Blue'], ['#D97706', 'Amber'], ['#7C3AED', 'Purple']];
const ORDER = [1, 2, 3, 4, 5, 6, 0]; // weeks start on Monday for an owner
const digits = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
const toMinor = (text, cur) => Math.round(Number(String(text).replace(/,/g, '')) * 10 ** digits(cur));
const toMajorText = (minor, cur) => String(Number(minor) / 10 ** digits(cur));
const hh = (t) => { const [h, m] = t.split(':'); return m === '00' ? String(Number(h)) : `${Number(h)}:${m}`; };

/** The owner's launch checklist. Collapses to a single line once everything required is done. */
export function SetupChecklist({ venueId, go }) {
  const s = useLoad(() => api.get(`/venues/${venueId}/setup`), [venueId]);
  const [open, setOpen] = useState(false);
  if (!s.data) return null;
  const d = s.data;
  const TARGET = { courts: 'timetable', timetable: 'timetable', pricing: 'timetable', payments: 'setup', contacts: 'setup', photos: 'media', plans: 'plans' };
  if (d.ready && !open) return <Pressable onPress={() => setOpen(true)}><T size={12} color={c.mute} style={{ marginTop: 6 }}>✓ Venue is ready for bookings · show checklist</T></Pressable>;
  return (
    <Card color={d.ready ? c.limeSoft : c.sunSoft} style={{ marginTop: 10 }}>
      <T weight="800">{d.ready ? '✓ Ready for bookings' : `Get ready for bookings · ${d.done} of ${d.total} done`}</T>
      {d.steps.map((st) => (
        <Pressable key={st.key} onPress={() => go(TARGET[st.key])} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 8 }}>
          <T weight="800" color={st.done ? c.lime : c.mute}>{st.done ? '✓' : '○'}</T>
          <View style={{ flex: 1 }}><T weight="700" size={13}>{st.title}{st.optional ? ' (optional)' : ''}</T><T size={12} color={c.mute}>{st.detail}</T></View>
          {!st.done ? <T size={12} weight="700" color={c.pink}>Do it ›</T> : null}
        </Pressable>
      ))}
      {open ? <Btn small title="Hide" color={c.paper} onPress={() => setOpen(false)} style={{ marginTop: 10, alignSelf: 'flex-start' }} /> : null}
    </Card>
  );
}

function Toggle({ options, value, onChange }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{options.map((o) => <Chip key={o.value} label={o.label} active={value.includes(o.value)} onPress={() => onChange(value.includes(o.value) ? value.filter((x) => x !== o.value) : [...value, o.value])} />)}</View>;
}

/** Open (or close) many courts on many days at once. */
function BulkSlotsSheet({ venue, data, onClose, onDone }) {
  const { toast } = useSession();
  const [courts, setCourts] = useState([]);
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [start, setStart] = useState('06:00');
  const [end, setEnd] = useState('22:00');
  const [cat, setCat] = useState('');           // category id | '' base rate | 'closed'
  const [replace, setReplace] = useState('replace');
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const active = data.categories.filter((x) => x.active);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (!courts.length) throw new Error('Choose at least one court');
      if (!days.length) throw new Error('Choose at least one day');
      const r = await api.post(`/venues/${venue.id}/timetable`, {
        resource_ids: courts, weekdays: days, start, end, closed: cat === 'closed', ...(cat && cat !== 'closed' ? { category_id: cat } : {}), replace: replace === 'replace',
        ...(from ? { valid_from: from } : {}), ...(to ? { valid_to: to } : {}) });
      toast(r.closed ? `Closed on ${r.courts} court(s)` : `Slots set on ${r.courts} court(s)`); onDone(); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Open slots in bulk">
      <View style={{ gap: 12 }}>
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Courts</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Chip label="All courts" active={courts.length === data.courts.length && courts.length > 0} onPress={() => setCourts(courts.length === data.courts.length ? [] : data.courts.map((x) => x.id))} />
            {[...new Map(data.courts.filter((x) => x.sport_slug).map((x) => [x.sport_slug, x])).values()].map((x) => { const ids = data.courts.filter((y) => y.sport_slug === x.sport_slug).map((y) => y.id); const on = ids.every((i) => courts.includes(i)); return <Chip key={x.sport_slug} label={`${x.sport_emoji ?? ''} All ${x.sport}`} active={on} onPress={() => setCourts(on ? courts.filter((i) => !ids.includes(i)) : [...new Set([...courts, ...ids])])} />; })}
            {data.courts.map((x) => <Chip key={x.id} label={`${x.sport_emoji ?? ''} ${x.name}`.trim()} active={courts.includes(x.id)} onPress={() => setCourts(courts.includes(x.id) ? courts.filter((y) => y !== x.id) : [...courts, x.id])} />)}
          </View>
        </View>
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Days</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Chip label="Weekdays" onPress={() => setDays([1, 2, 3, 4, 5])} /><Chip label="Weekend" onPress={() => setDays([6, 0])} /><Chip label="Every day" onPress={() => setDays([0, 1, 2, 3, 4, 5, 6])} />
          </View>
          <Toggle options={ORDER.map((d) => ({ value: d, label: WEEKDAYS[d] }))} value={days} onChange={setDays} />
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}><TimeField label="From" value={start} onChange={setStart} step={30} /></View>
          <View style={{ flex: 1 }}><TimeField label="Until" value={end} onChange={setEnd} step={30} /></View>
        </View>
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Price category</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {active.map((x) => <Chip key={x.id} label={`${x.name} · ${moneyIn(x.hourly_rate_cents, venue.currency)}`} active={cat === x.id} onPress={() => setCat(x.id)} />)}
            <Chip label="Court base rate" active={cat === ''} onPress={() => setCat('')} />
            <Chip label="🚫 Closed" active={cat === 'closed'} onPress={() => setCat('closed')} />
          </View>
          {!active.length ? <T size={12} color={c.mute}>Tip: create categories like Peak and Off-peak first, then pick them here.</T> : null}
        </View>
        <DateField label="Season starts" value={from} onChange={setFrom} optional hint="Leave both dates empty for every week. A season takes priority over the everyday timetable." />
        {from ? <DateField label="Season ends" value={to} onChange={setTo} optional /> : null}
        <Seg options={[{ value: 'replace', label: 'Replace what is there' }, { value: 'free', label: 'Only where nothing is set' }]} value={replace} onChange={setReplace} color={c.violet} />
        {err ? <T color={c.red} weight="800">{err}</T> : null}
        <Btn title={cat === 'closed' ? 'Close these slots' : 'Create slots'} onPress={go} loading={busy} />
      </View>
    </Sheet>
  );
}

function CategorySheet({ venue, data, edit, onClose, onDone }) {
  const { toast } = useSession();
  const [name, setName] = useState(edit?.name ?? '');
  const [rate, setRate] = useState(edit ? toMajorText(edit.hourly_rate_cents, venue.currency) : '');
  const [color, setColor] = useState(edit?.color ?? COLORS[0][0]);
  const [over, setOver] = useState(Object.fromEntries(data.courts.map((x) => [x.id, edit?.rates?.[x.id] != null ? toMajorText(edit.rates[x.id], venue.currency) : ''])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const minor = toMinor(rate, venue.currency);
      if (!name.trim()) throw new Error('Give the category a name');
      if (!(minor >= 0) || rate === '') throw new Error('Enter the hourly rate');
      const cat = edit ? await api.patch(`/categories/${edit.id}`, { name, color, hourly_rate_cents: minor }) : await api.post(`/venues/${venue.id}/categories`, { name, color, hourly_rate_cents: minor });
      for (const x of data.courts) {
        const was = edit?.rates?.[x.id];
        const now = over[x.id] === '' ? null : toMinor(over[x.id], venue.currency);
        if ((was ?? null) !== now) await api.post(`/categories/${cat.id}/rates`, { resource_id: x.id, hourly_rate_cents: now });
      }
      toast('Saved'); onDone(); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={edit ? `Edit ${edit.name}` : 'New price category'}>
      <View style={{ gap: 10 }}>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Peak, Off-peak, Weekend, Coaching…" />
        <Field label={`Rate per hour (${venue.currency})`} value={rate} onChangeText={setRate} keyboardType="numeric" placeholder="1500" />
        <T weight="800" size={13}>Colour on the timetable</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {COLORS.map(([hex, label]) => <Pressable key={hex} accessibilityLabel={label} onPress={() => setColor(hex)} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: hex, borderWidth: 3, borderColor: color === hex ? c.ink : 'transparent' }} />)}
        </View>
        {data.courts.length > 1 ? (
          <View style={{ gap: 6 }}>
            <T weight="800" size={13}>Different rate on specific courts (optional)</T>
            {data.courts.map((x) => <Field key={x.id} label={x.name} value={over[x.id]} onChangeText={(t) => setOver((p) => ({ ...p, [x.id]: t }))} keyboardType="numeric" placeholder={`same as above`} />)}
          </View>
        ) : null}
        {err ? <T color={c.red} weight="800">{err}</T> : null}
        <Btn title="Save category" onPress={save} loading={busy} />
        {edit ? <Btn small title={edit.active ? 'Retire this category' : 'Use again'} color={c.paper} onPress={async () => { await api.patch(`/categories/${edit.id}`, { active: !edit.active }); onDone(); onClose(); }} /> : null}
      </View>
    </Sheet>
  );
}

function CourtRow({ court, cats, data, onCopy, venue }) {
  const col = (id) => cats.get(id)?.color ?? '#94A3B8';
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T weight="800">{court.sport_emoji ?? '🏟️'} {court.name} <T size={12} color={c.mute}>· {court.slot_minutes}-min slots · base {moneyIn(court.hourly_rate_cents, venue.currency)}/h</T></T>
        {data.courts.length > 1 ? <Btn small title="Copy to…" color={c.paper} onPress={onCopy} /> : null}
      </View>
      {!court.windows.length ? <T size={13} color={c.red} weight="700" style={{ marginTop: 6 }}>No slots yet — this court can't be booked.</T> : ORDER.map((d) => {
        const ws = court.windows.filter((w) => w.weekdays.includes(d)).sort((a, b) => a.start.localeCompare(b.start));
        return (
          <View key={d} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 6 }}>
            <T size={12} weight="800" color={c.mute} style={{ width: 32, paddingTop: 4 }}>{WEEKDAYS[d]}</T>
            <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {ws.length ? ws.map((w) => (
                <View key={w.id + d} style={{ backgroundColor: `${col(w.category_id)}22`, borderLeftWidth: 4, borderLeftColor: col(w.category_id), borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
                  <T size={12} weight="700">{w.valid_from ? '🗓 ' : ''}{hh(w.start)}–{hh(w.end)} · {cats.get(w.category_id)?.name ?? 'Base rate'}</T>
                </View>
              )) : <T size={12} color={c.mute} style={{ paddingTop: 4 }}>Closed</T>}
            </View>
          </View>
        );
      })}
    </Card>
  );
}

export function Timetable({ v, reload }) {
  const { toast } = useSession();
  const tt = useLoad(() => api.get(`/venues/${v.id}/timetable`), [v.id]);
  const [bulk, setBulk] = useState(false);
  const [cat, setCat] = useState(null);       // {} new | category
  const [courts, setCourts] = useState(false);
  const [copy, setCopy] = useState(null);
  const [pick, setPick] = useState([]);
  const refresh = () => { tt.reload(); reload?.(); };
  if (tt.loading && !tt.data) return <Loading />;
  if (tt.error) return <ErrorBox error={tt.error} onRetry={tt.reload} />;
  const d = tt.data;
  const cats = new Map(d.categories.map((x) => [x.id, x]));
  return (
    <>
      <Section title="Price categories" color={c.sun}>
        <T color={c.mute} size={13}>Name the prices you charge — Peak, Off-peak, Weekend — once, then drop them on the timetable. Change a rate here and every slot using it updates.</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {d.categories.map((x) => (
            <Pressable key={x.id} onPress={() => setCat(x)} style={{ borderRadius: 12, borderWidth: 1.5, borderColor: x.color, backgroundColor: `${x.color}18`, paddingHorizontal: 12, paddingVertical: 8, opacity: x.active ? 1 : 0.5 }}>
              <T weight="800" size={13}>{x.name}{x.active ? '' : ' (retired)'}</T><T size={12} color={c.mute}>{moneyIn(x.hourly_rate_cents, v.currency)}/h{Object.keys(x.rates).length ? ' · court rates' : ''}</T>
            </Pressable>
          ))}
          <Btn small title="＋ Category" onPress={() => setCat({})} />
        </View>
      </Section>

      <Section title="Weekly timetable" color={c.cyan}>
        <T color={c.mute} size={13}>Each court is open only when it has slots here. Set many courts and days in one go.</T>
        {!d.courts.length ? <Empty emoji="🏟️" title="Add your courts first" sub="Add several at once — Court 1 to Court 6 — then set their slots." /> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="＋ Add courts" color={c.violet} onPress={() => setCourts(true)} />
          {d.courts.length ? <Btn small title="Open slots in bulk" onPress={() => setBulk(true)} /> : null}
        </View>
        {d.courts_without_timetable.length ? <T size={13} color={c.red} weight="700">{d.courts.filter((x) => d.courts_without_timetable.includes(x.id)).map((x) => x.name).join(', ')} {d.courts_without_timetable.length > 1 ? 'have' : 'has'} no slots yet.</T> : null}
        {d.courts.map((x) => <CourtRow key={x.id} court={x} cats={cats} data={d} venue={v} onCopy={() => { setCopy(x); setPick([]); }} />)}
        <T size={12} color={c.mute}>Special rates (holidays, one-off events) live under "Courts & special rates" and override these categories on the days they apply.</T>
      </Section>

      {bulk ? <BulkSlotsSheet venue={v} data={d} onClose={() => setBulk(false)} onDone={refresh} /> : null}
      {cat ? <CategorySheet venue={v} data={d} edit={cat.id ? cat : null} onClose={() => setCat(null)} onDone={refresh} /> : null}
      <Sheet visible={!!copy} onClose={() => setCopy(null)} title={`Copy ${copy?.name ?? ''} timetable to`}>
        <View style={{ gap: 10 }}>
          <Toggle options={d.courts.filter((x) => x.id !== copy?.id).map((x) => ({ value: x.id, label: x.name }))} value={pick} onChange={setPick} />
          <T size={12} color={c.mute}>Their current slots are replaced.</T>
          <Btn title="Copy" disabled={!pick.length} onPress={async () => { try { await api.post(`/venues/${v.id}/timetable/copy`, { from_resource_id: copy.id, to_resource_ids: pick }); toast('Timetable copied'); setCopy(null); refresh(); } catch (e) { toast(e.message); } }} />
        </View>
      </Sheet>
      <FormSheet visible={courts} onClose={() => setCourts(false)} title="Add courts" submitLabel="Add"
        fields={[{ key: 'sport', label: 'Sport', type: 'sport' }, { key: 'kind', label: 'Type', type: 'chips', options: [{ value: 'court', label: '🏟️ Court' }, { value: 'table', label: '🏓 Table' }, { value: 'ground', label: '🌿 Ground' }, { value: 'pool', label: '🏊 Pool' }, { value: 'lane', label: '🎳 Lane' }, { value: 'rink', label: '⛸️ Rink' }, { value: 'range', label: '🎯 Range' }, { value: 'track', label: '🏃 Track' }, { value: 'room', label: '🚪 Room' }, { value: 'studio', label: '🧘 Studio' }, { value: 'other', label: 'Other' }] },
          { key: 'name_prefix', label: 'Name', placeholder: 'Court  →  Court 1, Court 2…' }, { key: 'count', label: 'How many', type: 'stepper', min: 1, max: 30, default: 2 },
          { key: 'start_number', label: 'Numbering starts at', type: 'stepper', min: 1, max: 99, default: 1 },
          { key: 'hourly_rate_cents', label: 'Base rate per hour', type: 'money', currency: v.currency, optional: true, hint: 'Used where no price category applies' },
          { key: 'slot_minutes', label: 'Slot length', type: 'chips', default: 60, options: [{ value: 30, label: '30 min' }, { value: 45, label: '45 min' }, { value: 60, label: '1 hour' }, { value: 90, label: '1½ h' }, { value: 120, label: '2 hours' }] },
          { key: 'capacity', label: 'Bookings at once', type: 'stepper', min: 1, max: 100, default: 1 }, { key: 'max_players', label: 'Players per court', type: 'stepper', min: 1, max: 100, default: 2 }]}
        onSubmit={async (f) => { const r = await api.post(`/venues/${v.id}/resources/bulk`, f); refresh(); return `${r.created.length} added`; }} />
    </>
  );
}
