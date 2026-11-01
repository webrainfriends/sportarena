// Map + list discovery of venues, open games and coach classes near you, saved searches with alerts, and city / venue leaderboards (#696).
// This is a mode of the Find screen (find-games.js), not a screen of its own. It only calls the discover_nearby / saved-search capabilities;
// the rules (visibility, minors, availability) are decided on the server. Pins and rows come from the same response, so they always agree.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, Field, HScroll, Loading, Seg, Sheet, T, Tag } from '../ui';
import { MenuField, MultiMenuField } from '../menu-field';
import { SportsMulti, SportSelect } from '../sportpicker';
import { DateRangeField, TimeField, Counter } from '../pickers';
import { currentPosition } from '../location';
import { MapView } from '../map-view';
import { RankingsPanel } from './rankings';
import { ClassSheet } from './coach-classes';
import { c, when } from '../theme';
import { t } from '../i18n';
import { parseAmount } from '../money-core';
import { moneyIn } from '../vtime';
import { pinColor, pinEmoji } from '../map-core';

const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const LEVELS = ['beginner', 'amateur', 'semi_pro', 'pro'];
const KINDS = ['venue', 'game', 'class'];
const kindLabel = { venue: 'disc.kind_venues', game: 'disc.kind_games', class: 'disc.kind_classes' };
const dayStart = (d) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + 1); return x.toISOString(); };

const priceText = (x) => {
  if (x.price_cents == null) return null;
  if (x.price_cents === 0) return t('disc.free');
  const p = moneyIn(x.price_cents, x.currency ?? 'INR');
  return t(x.price_unit === 'hour' ? 'disc.per_hour' : x.price_unit === 'seat' ? 'disc.per_seat' : 'disc.per_player', { price: p });
};
const distText = (km) => (km == null ? null : km < 1 ? t('disc.under_1km') : t('disc.away', { km: Math.round(km) }));

/** One row for any kind of result. */
export function DiscoverCard({ x, selected, onOpen, onFocus }) {
  const bits = [x.starts_at ? when(x.starts_at) : null, x.place?.name ? `${x.place.name}${x.place.city ? `, ${x.place.city}` : ''}` : x.is_online ? t('disc.online') : null, distText(x.distance_km)].filter(Boolean);
  const seats = x.seats_left == null ? null : x.is_full ? t('disc.full') : t('disc.seats_left', { n: x.seats_left });
  const label = `${t(`disc.kind_${x.kind}`)}: ${x.title}. ${bits.join('. ')}${seats ? `. ${seats}` : ''}`;
  return (
    <Pressable onPress={onOpen} onHoverIn={onFocus} onFocus={onFocus} accessibilityRole="button" accessibilityLabel={label} style={{ minHeight: 44 }}>
      <Card pad={14} color={selected ? c.violetSoft : c.paper} style={selected ? { borderWidth: 2, borderColor: c.pink } : undefined}>
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: pinColor(x.kind), alignItems: 'center', justifyContent: 'center' }}><T size={18}>{pinEmoji(x.kind)}</T></View>
            <View style={{ flex: 1 }}>
              <T weight="800" size={16} numberOfLines={2}>{x.title}</T>
              {x.sport ? <T size={12} color={c.mute}>{x.emoji ?? ''} {x.sport}</T> : null}
            </View>
            <Tag label={t(`disc.kind_${x.kind}`)} color={x.kind === 'class' ? c.cyan : x.kind === 'game' ? c.pinkSoft : c.violetSoft} />
          </View>
          {bits.map((b, i) => <T key={i} size={13} color={i === 0 && x.starts_at ? c.pink : c.mute} weight={i === 0 && x.starts_at ? '700' : '500'}>{i === 0 && !x.starts_at ? '📍 ' : ''}{b}</T>)}
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {priceText(x) ? <Tag label={priceText(x)} color={x.price_cents === 0 ? c.mint : c.violetSoft} /> : null}
            {seats ? <Tag label={seats} color={x.is_full ? c.red : c.mint} /> : null}
            {x.level ? <Tag label={x.level} /> : null}
            {x.is_online ? <Tag label={t('disc.online')} color={c.cyan} /> : null}
            {x.kind === 'venue' && x.rating ? <Tag label={`★ ${x.rating}`} color={c.sun} /> : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

function SaveSheet({ filters, onClose, onSaved }) {
  const { toast } = useSession();
  const [name, setName] = useState('');
  const [alerts, setAlerts] = useState(true);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.post('/me/saved-searches', { name: name.trim(), alerts_on: alerts, ...filters }); toast(t('disc.saved')); onSaved(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('disc.save')} footer={<Btn title={t('disc.save')} onPress={save} disabled={!name.trim()} loading={busy} />}>
      <View style={{ gap: 12 }}>
        <Field label={t('disc.save_name')} value={name} onChangeText={setName} maxLength={80} />
        <Chip label={`${alerts ? '🔔' : '🔕'} ${t(alerts ? 'disc.alerts_on' : 'disc.alerts_off')}`} active={alerts} onPress={() => setAlerts(!alerts)} />
        <T size={12} color={c.mute}>{t('disc.save_alerts')}</T>
      </View>
    </Sheet>
  );
}

function SavedList({ onUse, reloadKey }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/me/saved-searches', { limit: 20 }), [reloadKey]);
  const remove = async (s) => { try { await api.del(`/me/saved-searches/${s.id}`); toast(t('disc.removed')); q.reload(); } catch (e) { toast(e.message); } };
  const flip = async (s) => { try { await api.patch(`/me/saved-searches/${s.id}`, { alerts_on: !s.alerts_on }); q.reload(); } catch (e) { toast(e.message); } };
  if (!q.data?.length) return <T size={12} color={c.mute}>{t('disc.saved_none')}</T>;
  return (
    <View style={{ gap: 8 }}>
      {q.data.map((s) => (
        <Card key={s.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <T weight="800" style={{ flex: 1, minWidth: 120 }}>{s.name}</T>
            <Chip label={`${s.alerts_on ? '🔔' : '🔕'} ${t(s.alerts_on ? 'disc.alerts_on' : 'disc.alerts_off')}`} active={s.alerts_on} onPress={() => flip(s)} />
            <Btn small title={t('disc.apply')} onPress={() => onUse(s.filters)} />
            <Btn small title={t('disc.remove')} color={c.paper} ink={c.red} onPress={() => remove(s)} />
          </View>
        </Card>
      ))}
    </View>
  );
}

/** Map + list with filters. */
export function DiscoverPanel() {
  const { user, toast } = useSession();
  const { push } = useNav();
  const { tablet, width } = useLayout();
  const [kinds, setKinds] = useState(KINDS);
  const [sports, setSports] = useState([]);
  const [range, setRange] = useState({});
  const [timeFrom, setTimeFrom] = useState(null);
  const [timeTo, setTimeTo] = useState(null);
  const [priceText2, setPriceText] = useState('');
  const [level, setLevel] = useState(null);
  const [seats, setSeats] = useState(0);
  const [pos, setPos] = useState(null);
  const [radius, setRadius] = useState(25);
  const [bbox, setBbox] = useState(null);
  const [view, setView] = useState('map');
  const [sel, setSel] = useState(null);
  const [more, setMore] = useState(false);
  const [save, setSave] = useState(false);
  const [saved, setSaved] = useState(0);
  const [showSaved, setShowSaved] = useState(false);
  const [openClass, setOpenClass] = useState(null);
  const [locating, setLocating] = useState(false);
  const split = tablet && width >= 900;

  const price = priceText2 ? parseAmount(priceText2, 'INR') : null;
  const filters = useMemo(() => ({
    kinds: kinds.length < 3 ? kinds.join(',') : undefined,
    sport: sports.length ? sports.join(',') : undefined,
    from: range.from ? dayStart(range.from) : undefined, to: range.to ? dayEnd(range.to) : range.from ? dayEnd(range.from) : undefined,
    time_from: timeFrom || undefined, time_to: timeTo || undefined, tz: zone(),
    max_price_cents: price != null && !Number.isNaN(price) ? price : undefined, level: level || undefined, seats_left: seats > 0 ? seats : undefined,
    ...(bbox ? { bbox } : pos ? { lat: pos.lat, lng: pos.lng, radius_km: radius } : {}),
    sort: pos && !bbox ? 'distance' : 'soonest', limit: 150,
  }), [kinds, sports, range, timeFrom, timeTo, price, level, seats, pos, radius, bbox]);
  const res = useLoad(() => api.get('/discover', filters), [JSON.stringify(filters)]);
  const data = res.data;
  const items = data?.items ?? [];
  useEffect(() => { if (sel && !items.some((x) => `${x.kind}:${x.id}` === sel)) setSel(null); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const near = async () => {
    if (pos) { setPos(null); setBbox(null); return; }
    setLocating(true);
    const p = await currentPosition();
    setLocating(false);
    if (p) { setPos(p); setBbox(null); } else toast(t('disc.location_off'));
  };
  const open = (x) => { if (x.kind === 'game') push('OpenGame', { id: x.id }); else if (x.kind === 'venue') push('Venue', { id: x.id }); else setOpenClass(x.id); };
  const apply = (f) => {
    setKinds(f.kinds ? String(f.kinds).split(',') : KINDS); setSports(f.sport ? String(f.sport).split(',') : []); setRange({ from: f.from?.slice(0, 10), to: undefined });
    setLevel(f.level ?? null); setSeats(f.seats_left ?? 0); setBbox(f.bbox ?? null); setPos(f.lat != null ? { lat: f.lat, lng: f.lng } : null); if (f.radius_km) setRadius(f.radius_km);
    setShowSaved(false);
  };
  const clear = () => { setKinds(KINDS); setSports([]); setRange({}); setTimeFrom(null); setTimeTo(null); setPriceText(''); setLevel(null); setSeats(0); setBbox(null); };
  const active = [sports.length, range.from, timeFrom, timeTo, priceText2, level, seats, bbox, kinds.length < 3].filter(Boolean).length;
  const selected = items.find((x) => `${x.kind}:${x.id}` === sel);

  const list = !res.error && res.loading && !data ? <Loading /> : !items.length ? <Empty emoji="🧭" title={t('disc.empty_title')} sub={t('disc.empty_sub')} /> : (
    <View style={{ gap: 10 }}>
      {items.map((x) => <DiscoverCard key={`${x.kind}:${x.id}`} x={x} selected={sel === `${x.kind}:${x.id}`} onOpen={() => open(x)} onFocus={() => setSel(`${x.kind}:${x.id}`)} />)}
    </View>
  );
  const map = <MapView pins={data?.pins ?? []} selectedKey={sel} center={pos} onSelect={(p) => setSel(p.key)} onSearchArea={(b) => setBbox(b)} height={split ? 560 : tablet ? 480 : 320} />;

  return (
    <View style={{ gap: 12, marginTop: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} accessibilityLabel={t('disc.kinds')}>
        {KINDS.map((k) => <Chip key={k} label={`${pinEmoji(k)} ${t(kindLabel[k])}`} active={kinds.includes(k)} onPress={() => setKinds(kinds.includes(k) ? (kinds.length > 1 ? kinds.filter((x) => x !== k) : kinds) : [...kinds, k])} />)}
      </View>
      <SportsMulti label={t('disc.sports')} value={sports} onChange={setSports} optional />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip label={locating ? t('disc.finding') : pos ? `📍 ${t('disc.near_me')} ✕` : `📍 ${t('disc.near_me')}`} active={!!pos} onPress={near} />
        {pos ? [5, 10, 25, 50].map((km) => <Chip key={km} label={`${km} km`} active={radius === km} onPress={() => { setRadius(km); setBbox(null); }} />) : null}
        <Chip label={`${more ? '▴' : '▾'} ${t('disc.dates')}${active ? ` (${active})` : ''}`} active={more || active > 0} onPress={() => setMore(!more)} />
        {user ? <Chip label={`${showSaved ? '▴' : '▾'} ${t('disc.saved_searches')}`} active={showSaved} onPress={() => setShowSaved(!showSaved)} /> : null}
        {active ? <Chip label={t('disc.clear')} onPress={clear} /> : null}
      </View>
      {more ? (
        <Card pad={14}>
          <View style={{ gap: 12 }}>
            <DateRangeField label={t('disc.dates')} from={range.from} to={range.to} onChange={setRange} optional />
            <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 150 }}><TimeField label={t('disc.time_from')} value={timeFrom} onChange={setTimeFrom} optional /></View>
              <View style={{ flex: 1, minWidth: 150 }}><TimeField label={t('disc.time_to')} value={timeTo} onChange={setTimeTo} optional /></View>
            </View>
            <Field label={t('disc.max_price')} value={priceText2} onChangeText={(v) => setPriceText(v.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" maxLength={9} />
            <View style={{ gap: 6 }}>
              <T weight="600" size={12} color={c.mute}>{t('disc.level').toUpperCase()}</T>
              <HScroll>{LEVELS.map((k) => <Chip key={k} label={t(`disc.lvl_${k}`)} active={level === k} onPress={() => setLevel(level === k ? null : k)} />)}</HScroll>
            </View>
            <Counter label={t('disc.seats')} value={seats} min={0} max={20} onChange={setSeats} />
          </View>
        </Card>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <View style={{ flexShrink: 1 }}>
          <T weight="800" size={13}>{data ? t('disc.counts', { venues: data.counts.venue, games: data.counts.game, classes: data.counts.class }) : ' '}</T>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {!split ? <Seg options={[{ value: 'map', label: t('disc.view_map') }, { value: 'list', label: t('disc.view_list') }]} value={view} onChange={setView} /> : null}
          <Btn small title={user ? t('disc.save') : t('disc.signin_save')} color={c.paper} ink={c.ink} onPress={() => (user ? setSave(true) : toast(t('disc.signin_save')))} accessibilityLabel={t('disc.save')} />
        </View>
      </View>
      {showSaved ? <SavedList reloadKey={saved} onUse={apply} /> : null}
      {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : split ? (
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>{list}</View>
          <View style={{ flex: 1, gap: 10 }}>{map}{selected ? <DiscoverCard x={selected} selected onOpen={() => open(selected)} /> : null}</View>
        </View>
      ) : view === 'map' ? (
        <View style={{ gap: 10 }}>{map}{selected ? <DiscoverCard x={selected} selected onOpen={() => open(selected)} /> : null}</View>
      ) : list}
      {save ? <SaveSheet filters={Object.fromEntries(Object.entries(filters).filter(([k, v]) => v !== undefined && !['limit', 'sort', 'from', 'to'].includes(k)))} onClose={() => setSave(false)} onSaved={() => { setSave(false); setSaved((n) => n + 1); }} /> : null}
      {openClass ? <ClassSheet id={openClass} onClose={() => setOpenClass(null)} onChanged={res.reload} /> : null}
    </View>
  );
}

/** City and venue leaderboards: the governed rankings (formula, version and sample on every table), scoped by where the results were played. */
export function BoardsPanel() {
  const [sport, setSport] = useState(null);
  const [scope, setScope] = useState('city');
  const [region, setRegion] = useState(null);
  const [venue, setVenue] = useState(null);
  const model = useLoad(() => (sport ? api.get('/rankings', { sport, limit: 1 }) : Promise.resolve(null)), [sport]);
  const cities = (model.data?.sport_model?.cities ?? []).map((x) => ({ value: x, label: x }));
  const sports = useLoad(() => api.get('/sports'), []);
  const loadVenues = useMemo(() => async (q) => (await api.get('/venues', { q: q || undefined, sport: sport || undefined, limit: 30 })).map((v) => ({ value: v.id, label: v.name, sub: v.city })), [sport]);
  return (
    <View style={{ gap: 12, marginTop: 12 }}>
      <T size={13} color={c.mute}>{t('disc.board_hint')}</T>
      <SportSelect label={t('disc.sports')} value={sport} onChange={(s) => { setSport(s); setRegion(null); setVenue(null); }} />
      {sport ? (
        <>
          <Seg options={[{ value: 'city', label: t('disc.board_city') }, { value: 'venue', label: t('disc.board_venue') }]} value={scope} onChange={setScope} />
          {scope === 'city'
            ? <MenuField label={t('disc.board_city')} value={region} onChange={setRegion} options={cities} placeholder={t('disc.board_city')} />
            : <MultiMenuField label={t('disc.board_venue')} value={venue ? [venue] : []} max={1} onChange={(v) => setVenue(v[0] ?? null)} load={loadVenues} placeholder={t('disc.board_venue')} />}
          <RankingsPanel sport={sport} sports={sports.data} region={scope === 'city' ? region : undefined} venueId={scope === 'venue' ? venue : undefined} />
        </>
      ) : <Empty emoji="🏅" title={t('disc.mode_boards')} sub={t('disc.board_need_sport')} />}
    </View>
  );
}
