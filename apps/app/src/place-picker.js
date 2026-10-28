// One place picker for every "where" in the app: a searchable list (countries, then cities and areas other people already use, then your own words),
// a country dropdown, and an exact map point taken from Google Maps, Apple Maps or the device. There is no map key or third-party SDK: the buttons open
// the person's own maps app, and a pasted share link (or "lat, lng") is read here. Value: { name, country?, lat?, lng? }.
import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { api } from './api';
import { Btn, Chip, Field, Sheet, T } from './ui';
import { CountryPicker, countryName, regionList } from './country-picker';
import { currentPosition } from './location';
import { c } from './theme';

const enc = encodeURIComponent;
const round = (n) => Math.round(n * 1e6) / 1e6;
const ok = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** Links that open a point (or a name) in Google Maps and Apple Maps. */
export function mapLinks({ name, lat, lng }) {
  const q = lat !== undefined && lat !== null ? `${lat},${lng}` : name ?? '';
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${enc(q)}`,
    apple: lat !== undefined && lat !== null ? `https://maps.apple.com/?ll=${lat},${lng}&q=${enc(name || 'Pinned location')}` : `https://maps.apple.com/?q=${enc(q)}`,
  };
}

/** Read a point out of what a person pastes: "12.97, 77.59", a Google Maps link (@lat,lng · !3d..!4d.. · ?q= · ?query=) or an Apple Maps link (?ll= · ?coordinate=). */
export function parseMapInput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (/(maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(raw)) return { error: 'That is a shortened link. Open it in your browser or maps app, then copy the full address (or the coordinates) and paste that.' };
  let s = raw; try { s = decodeURIComponent(raw); } catch { /* keep as typed */ }
  const pair = (a, b) => { const lat = Number(a), lng = Number(b); return ok(lat, lng) ? { lat: round(lat), lng: round(lng) } : null; };
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  let m = new RegExp(`^${num}\\s*[,; ]\\s*${num}$`).exec(s);
  if (m) return pair(m[1], m[2]);
  m = new RegExp(`!3d${num}!4d${num}`).exec(s) || new RegExp(`@${num},${num}`).exec(s) || new RegExp(`[?&](?:q|query|ll|sll|center|coordinate|destination|daddr|saddr)=${num}[, +]+${num}`).exec(s);
  const point = m ? pair(m[1], m[2]) : null;
  if (!point) return { error: 'No coordinates found. Paste a full Google or Apple Maps link, or type them as “12.9716, 77.5946”.' };
  const place = /\/place\/([^/@?]+)/.exec(s)?.[1]?.replace(/\+/g, ' ');
  return { ...point, ...(place ? { name: place } : {}) };
}

/** { name, country, lat, lng } -> the API's flat fields (prefix 'origin_' gives origin_country, origin_lat, origin_lng). With clear, a removed value is sent as null so an update really clears it. */
export const placeOut = (prefix, p, clear) => ({ [`${prefix}country`]: p?.country ?? (clear ? null : undefined), [`${prefix}lat`]: p?.lat ?? (clear ? null : undefined), [`${prefix}lng`]: p?.lng ?? (clear ? null : undefined) });
/** The reverse: read a place back out of a row (nameKey is the column that holds its name). */
export const placeIn = (prefix, o, nameKey) => ({ name: o[nameKey], country: o[`${prefix}country`] ?? undefined, lat: o[`${prefix}lat`] ?? undefined, lng: o[`${prefix}lng`] ?? undefined });
export const placeText = (p) => (p ? [p.name, p.country ? countryName(p.country) : null].filter(Boolean).join(' · ') : '');

export function PlacePicker({ label, value, onChange, optional, hint }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? { name: '' });
  const [q, setQ] = useState('');
  const [regions, setRegions] = useState([]);
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState(null);
  const countries = useMemo(regionList, []);
  useEffect(() => { if (open) { setDraft(value ?? { name: '' }); setQ(value?.name ?? ''); setPaste(''); setMsg(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const t = setTimeout(() => { api.get('/regions', { q: q.trim() || undefined }).then((r) => { if (live) setRegions(r); }).catch(() => {}); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [open, q]);
  const typed = q.trim();
  const hits = typed ? countries.filter((x) => x.name.toLowerCase().includes(typed.toLowerCase()) || x.code.toLowerCase() === typed.toLowerCase()).slice(0, 6) : [];
  const shown = regions.filter((x) => x.toLowerCase() !== typed.toLowerCase()).slice(0, 8);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const pin = draft.lat !== undefined && draft.lat !== null ? { lat: draft.lat, lng: draft.lng } : null;
  const links = mapLinks({ name: draft.name || typed, ...(pin ?? {}) });
  const useHere = async () => { setMsg('Finding you…'); const p = await currentPosition(); if (!p) { setMsg('Location is not available. Paste a map link instead.'); return; } set({ lat: p.lat, lng: p.lng }); setMsg('Pinned to your current location (rounded to about 100 m).'); };
  const apply = () => {
    const r = parseMapInput(paste);
    if (!r) return;
    if (r.error) { setMsg(r.error); return; }
    set({ lat: r.lat, lng: r.lng, ...(r.name && !draft.name ? { name: r.name } : {}) });
    if (r.name && !draft.name) setQ(r.name);
    setPaste(''); setMsg('Map point saved.');
  };
  const done = () => {
    const name = (draft.name || typed).trim();
    if (!name) { setMsg('Choose or type a place first.'); return; }
    onChange({ name, ...(draft.country ? { country: draft.country } : {}), ...(pin ? { lat: pin.lat, lng: pin.lng } : {}) });
    setOpen(false);
  };
  return (
    <View style={{ gap: 6 }}>
      <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{(label + (optional ? ' (optional)' : '')).toUpperCase()}</T>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${label}. ${value ? placeText(value) : 'Choose a place'}`}
        style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 16, minHeight: 50, justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T style={{ flex: 1 }} color={value ? c.ink : c.mute} weight="600">{value ? `📍 ${placeText(value)}${value.lat !== undefined ? '  · pinned' : ''}` : 'Search a place or country'}</T><T size={16} color={c.mute}>▾</T>
      </Pressable>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={label} footer={<Btn title="Use this place" onPress={done} style={{ flex: 1 }} />}>
        <Field label="Search" value={q} onChangeText={(x) => { setQ(x); set({ name: x }); }} placeholder="Type a city, area or country" />
        {hits.length ? <View style={{ gap: 6 }}><T weight="800" size={13}>Countries</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{hits.map((x) => <Chip key={x.code} label={`🌍 ${x.name}`} active={draft.country === x.code} onPress={() => { set({ country: x.code, name: draft.name && draft.name !== typed ? draft.name : x.name }); setQ(x.name); }} />)}</View></View> : null}
        {shown.length ? <View style={{ gap: 6 }}><T weight="800" size={13}>Cities and areas people use</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{shown.map((x) => <Chip key={x} label={`📍 ${x}`} active={draft.name === x} onPress={() => { set({ name: x }); setQ(x); }} />)}</View></View> : null}
        {typed && !regions.some((x) => x.toLowerCase() === typed.toLowerCase()) ? <Chip label={`Use “${typed}”`} active={draft.name === typed} onPress={() => set({ name: typed })} /> : null}
        <CountryPicker label="Country" value={draft.country} onChange={(x) => set({ country: x || undefined })} optional hint="Pick the country so people, documents and filters line up." />
        <View style={{ gap: 8 }}>
          <T weight="800" size={13}>Exact spot on a map (optional)</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Btn small title="Open Google Maps" color={c.paper} ink={c.ink} onPress={() => Linking.openURL(links.google)} />
            <Btn small title="Open Apple Maps" color={c.paper} ink={c.ink} onPress={() => Linking.openURL(links.apple)} />
            <Btn small title="📍 Use my location" color={c.paper} ink={c.ink} onPress={useHere} />
          </View>
          <T size={12} color={c.mute}>Find the spot in Google Maps or Apple Maps, tap Share, copy the link and paste it below. Coordinates like “12.9716, 77.5946” work too.</T>
          <Field value={paste} onChangeText={setPaste} placeholder="Paste a map link or coordinates" />
          <Btn small title="Read the link" onPress={apply} disabled={!paste.trim()} style={{ alignSelf: 'flex-start' }} />
          {pin ? <View style={{ gap: 6 }}><T size={13} weight="700">📌 Pinned: {pin.lat}, {pin.lng}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Btn small title="View in Google Maps" color={c.paper} ink={c.ink} onPress={() => Linking.openURL(mapLinks({ name: draft.name, ...pin }).google)} /><Btn small title="View in Apple Maps" color={c.paper} ink={c.ink} onPress={() => Linking.openURL(mapLinks({ name: draft.name, ...pin }).apple)} /><Btn small title="Remove pin" color={c.paper} ink={c.red} onPress={() => set({ lat: undefined, lng: undefined })} /></View></View> : null}
          {msg ? <T size={12.5} color={c.mute}>{msg}</T> : null}
        </View>
      </Sheet>
    </View>
  );
}

/** Small "open in Google Maps / Apple Maps" links for a place that is already saved. */
export function MapLinks({ place }) {
  if (!place?.name && place?.lat === undefined) return null;
  const l = mapLinks(place);
  return (
    <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
      <Pressable accessibilityRole="link" accessibilityLabel={`Open ${place.name} in Google Maps`} onPress={() => Linking.openURL(l.google)} hitSlop={8}><T size={12.5} weight="700" color={c.violet}>Google Maps ↗</T></Pressable>
      <Pressable accessibilityRole="link" accessibilityLabel={`Open ${place.name} in Apple Maps`} onPress={() => Linking.openURL(l.apple)} hitSlop={8}><T size={12.5} weight="700" color={c.violet}>Apple Maps ↗</T></Pressable>
    </View>
  );
}
