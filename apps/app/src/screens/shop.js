import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api, mediaUrl } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { useCart } from '../shop-store';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Screen, Seg, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { PaySheet } from '../PaySheet';
import { Counter, HScroll } from '../pickers';
import { SportSelect } from '../sportpicker';
import { pickMedia } from '../market/media';
import { c, toneFor, money, day } from '../theme';
import { Pill, StatusPill, nice } from './marketplace';

export const CATS = ['equipment', 'apparel', 'footwear', 'nutrition', 'medical', 'accessories', 'other'];
const CAT_EMOJI = { equipment: '🏏', apparel: '👕', footwear: '👟', nutrition: '🥤', medical: '🩹', accessories: '🎒', other: '✨' };
const SORTS = [['popular', 'Popular'], ['newest', 'New'], ['discount', 'Best offers'], ['price_asc', 'Price ↑'], ['price_desc', 'Price ↓'], ['rating', 'Top rated']];
const GOOD = '#047857';

// ---------------------------------------------------------------- small pieces

/** Responsive grid: 2 columns on a phone, up to 4 on a wide screen. */
function useGrid() {
  const { width } = useWindowDimensions();
  const L = useLayout();
  const inner = Math.min(width, L.contentMax) - L.gutter * 2;
  const cols = inner >= 1000 ? 4 : inner >= 700 ? 3 : 2;
  const gap = 12;
  return { cols, gap, w: Math.floor((inner - gap * (cols - 1)) / cols) };
}

export function Stars({ value = 0, size = 13 }) {
  return <T size={size} color="#F59E0B" style={{ letterSpacing: 1 }}>{[1, 2, 3, 4, 5].map((n) => (value >= n - 0.25 ? '★' : value >= n - 0.75 ? '⯨' : '☆')).join('')}</T>;
}

/** The product photo, or its emoji on a soft sport-coloured tile when the seller has not added one. */
function Photo({ p, size, radius = 16, index = 0, style }) {
  const url = p.images?.[index]?.url ?? (index === 0 ? p.image : null);
  const tone = toneFor(p.sport_slug ?? p.category ?? p.name);
  const box = { width: size ?? '100%', aspectRatio: size ? undefined : 1, height: size, borderRadius: radius, overflow: 'hidden', backgroundColor: tone[1], alignItems: 'center', justifyContent: 'center' };
  return (
    <View style={[box, style]}>
      {url ? <Image source={{ uri: mediaUrl(url) }} resizeMode="cover" accessibilityLabel={p.name} style={{ width: '100%', height: '100%' }} />
        : <T size={size ? Math.round(size * 0.46) : 54}>{p.emoji ?? '🎽'}</T>}
    </View>
  );
}

/** ₹ price, the struck-through usual price and a green "% off" tag. */
function Price({ p, size = 17 }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 6 }}>
      <T weight="800" size={size}>{money(p.price_cents)}</T>
      {p.compare_at_cents > p.price_cents ? <T size={size * 0.72} color={c.mute} style={{ textDecorationLine: 'line-through' }}>{money(p.compare_at_cents)}</T> : null}
      {p.discount_pct ? <T weight="800" size={size * 0.72} color={GOOD}>{p.discount_pct}% off</T> : null}
    </View>
  );
}

const Round = ({ label, onPress, children, active, badge }) => (
  <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => ({ width: 46, height: 46, borderRadius: 23, backgroundColor: active ? c.pinkSoft : c.paper, borderWidth: 1, borderColor: active ? c.pink : c.line, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}>
    {children}
    {badge ? <View style={{ position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, borderWidth: 2, borderColor: c.bg }}><T size={11} weight="800" color="#fff">{badge}</T></View> : null}
  </Pressable>
);

/** Add to cart; once it is in the cart the same spot becomes a − / + stepper (capped by stock). */
function AddControl({ p, big }) {
  const { user, toast } = useSession();
  const { set, lineOf } = useCart();
  const [busy, setBusy] = useState(false);
  const line = lineOf(p.id);
  const run = async (body) => { setBusy(true); try { await set(body); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  if (p.seller_id === user?.id) return <Pill label="YOUR LISTING" />;
  if (p.stock < 1) return <T size={13} weight="700" color={c.red}>Sold out</T>;
  const h = big ? 46 : 36;
  if (!line) return <Btn small={!big} title={big ? 'Add to cart' : 'Add'} onPress={() => run({ product_id: p.id, add: 1 })} loading={busy} style={big ? { flex: 1 } : undefined} />;
  const btn = (txt, on, off) => <Pressable disabled={off || busy} onPress={on} accessibilityLabel={txt === '+' ? 'More' : 'Fewer'} style={{ width: h, height: h, alignItems: 'center', justifyContent: 'center', opacity: off ? 0.35 : 1 }}><T size={20} weight="800" color="#fff">{txt === '−' && line.quantity === 1 ? '🗑' : txt}</T></Pressable>;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.pink, borderRadius: 999, height: h, alignSelf: big ? 'stretch' : 'auto', justifyContent: 'space-between', flex: big ? 1 : undefined }}>
      {btn('−', () => run({ product_id: p.id, quantity: line.quantity - 1 }))}
      <T weight="800" size={15} color="#fff" style={{ minWidth: 26, textAlign: 'center' }}>{line.quantity}</T>
      {btn('+', () => run({ product_id: p.id, quantity: line.quantity + 1 }), line.quantity >= Math.min(p.stock, 50))}
    </View>
  );
}

function Heart({ p, onChange, style }) {
  const { user, toast } = useSession();
  const [on, setOn] = useState(!!p.wishlisted);
  useEffect(() => setOn(!!p.wishlisted), [p.wishlisted]);
  if (p.seller_id === user?.id) return null;
  const flip = async () => { const was = on; setOn(!was); try { const r = await api.post(`/shop/wishlist/${p.id}`); setOn(r.wishlisted); onChange?.(r.wishlisted); toast(r.wishlisted ? 'Saved to your wishlist' : 'Removed from wishlist'); } catch (e) { setOn(was); toast(e.message); } };
  return (
    <Pressable onPress={flip} accessibilityRole="button" accessibilityLabel={on ? 'Remove from wishlist' : 'Add to wishlist'} hitSlop={6}
      style={[{ width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.94)', alignItems: 'center', justifyContent: 'center', shadowColor: '#0F172A', shadowOpacity: 0.14, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }, style]}>
      <T size={18} color={on ? c.red : c.mute}>{on ? '♥' : '♡'}</T>
    </Pressable>
  );
}

/** One product tile: photo with offer / low-stock badges and a heart, brand, name, rating, price, quick add. */
function ProductCard({ p, w, onOpen, onHeart }) {
  const low = p.stock > 0 && p.stock < 5;
  return (
    <View style={{ width: w, flexShrink: 0, alignSelf: 'flex-start' }}>
      <Card pad={10} onPress={() => onOpen(p)}>
        <View>
          <Photo p={p} radius={14} />
          {p.discount_pct ? <View style={{ position: 'absolute', left: 8, top: 8, backgroundColor: GOOD, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}><T size={11} weight="800" color="#fff">{p.discount_pct}% OFF</T></View> : null}
          <Heart p={p} onChange={onHeart} style={{ position: 'absolute', right: 8, top: 8 }} />
          {p.stock < 1 ? <View style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.7)', alignItems: 'center', justifyContent: 'center', borderRadius: 14 }}><T weight="800" color={c.mute}>Sold out</T></View> : null}
        </View>
        <View style={{ gap: 3, marginTop: 10 }}>
          {p.brand ? <T size={11} weight="800" color={c.pink} style={{ letterSpacing: 0.8 }}>{p.brand.toUpperCase()}</T> : null}
          <T weight="700" size={14} numberOfLines={2} style={{ minHeight: 36, lineHeight: 18 }}>{p.name}</T>
          {p.rating_count ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><Stars value={p.rating} size={12} /><T size={11} color={c.mute} weight="600">({p.rating_count})</T></View> : <T size={11} color={c.mute}>{[p.sport, nice(p.category)].filter(Boolean).join(' · ')}</T>}
          <Price p={p} size={16} />
          {low ? <T size={11} weight="700" color={c.sun}>Only {p.stock} left</T> : null}
        </View>
        <View style={{ marginTop: 10, alignItems: 'flex-start' }}><AddControl p={p} /></View>
      </Card>
    </View>
  );
}

/** A bar that floats above the content while the cart has something in it: how many, how much, how much you save. */
function CartBar({ above = 0 }) {
  const { push } = useNav();
  const { cart } = useCart();
  const L = useLayout();
  const s = cart.summary;
  if (!s.units) return null;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: above + (L.floatingBar ? 92 : 12), alignItems: 'center', paddingHorizontal: 12 }}>
      <Pressable onPress={() => push('ShopCart')} accessibilityRole="button" accessibilityLabel="View cart"
        style={{ width: '100%', maxWidth: 560, backgroundColor: c.pink, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: '#312E81', shadowOpacity: 0.3, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }}>
        <T size={22}>🛒</T>
        <View style={{ flex: 1 }}>
          <T weight="800" size={15} color="#fff">{s.units} item{s.units === 1 ? '' : 's'} · {money(s.total_cents)}</T>
          {s.savings_cents > 0 ? <T size={12} weight="700" color="#C7F9E4">You save {money(s.savings_cents)}</T> : null}
        </View>
        <T weight="800" size={14} color="#fff">View cart ›</T>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------- storefront

export function Shop() {
  const { push } = useNav();
  const { user } = useSession();
  const { count } = useCart();
  const g = useGrid();
  const [cat, setCat] = useState('all');
  const [sport, setSport] = useState(undefined);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('popular');
  const [filters, setFilters] = useState({ on_offer: false, in_stock: false, min_rating: 0 });
  const [filtering, setFiltering] = useState(false);
  const [hearts, setHearts] = useState(false);
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 350); return () => clearTimeout(t); }, [text]);

  const params = useMemo(() => ({
    category: cat === 'all' ? undefined : cat, sport: sport || undefined, q: q || undefined, sort, limit: 60, wishlist: hearts || undefined,
    on_offer: filters.on_offer || undefined, in_stock: filters.in_stock || undefined, min_rating: filters.min_rating || undefined,
    min_price_cents: filters.min_price_cents || undefined, max_price_cents: filters.max_price_cents || undefined,
  }), [cat, sport, q, sort, filters, hearts]);
  const prods = useLoad(() => api.get('/shop/products', params), [JSON.stringify(params), user?.id]);
  const plain = cat === 'all' && !sport && !q && !hearts && !filters.on_offer && !filters.in_stock && !filters.min_rating && !filters.min_price_cents && !filters.max_price_cents;
  const deals = useLoad(() => (plain ? api.get('/shop/products', { on_offer: true, in_stock: true, sort: 'discount', limit: 10 }) : Promise.resolve([])), [plain, user?.id]);
  const active = [filters.on_offer, filters.in_stock, filters.min_rating, filters.min_price_cents, filters.max_price_cents].filter(Boolean).length;
  const open = (p) => push('ShopProduct', { id: p.id });

  return (
    <View style={{ flex: 1 }}>
      <Screen wide padBottom={150}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <View style={{ flex: 1 }}><Field label="" value={text} onChangeText={setText} placeholder="Search the shop…" /></View>
          <Round label="Wishlist" active={hearts} onPress={() => setHearts((v) => !v)}><T size={20} color={hearts ? c.red : c.mute}>{hearts ? '♥' : '♡'}</T></Round>
          <Round label="Cart" onPress={() => push('ShopCart')} badge={count || null}><T size={20}>🛒</T></Round>
          <Round label="Orders and selling" onPress={() => push('ShopOrders')}><T size={20}>📦</T></Round>
        </View>

        {plain ? (
          <LinearGradient colors={['#EEF0FF', '#E0F2FE']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 24, padding: 20, marginTop: 14, overflow: 'hidden' }}>
            <T weight="800" size={12} color={c.pink} style={{ letterSpacing: 1.4 }}>THE GOTMYGAME SHOP</T>
            <H1 style={{ fontSize: 28, marginTop: 4 }}>Gear up. Play better.</H1>
            <T size={14} color={c.mute} style={{ marginTop: 4, maxWidth: 520, lineHeight: 20 }}>Kit, footwear and nutrition from verified suppliers and sport brands. Add to cart, pay once, track every order.</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <Btn small title="🔥 Shop offers" onPress={() => { setSort('discount'); setFilters((f) => ({ ...f, on_offer: true })); }} />
              <Btn small title="Top rated" color={c.paper} ink={c.ink} onPress={() => setSort('rating')} />
            </View>
          </LinearGradient>
        ) : null}

        <View style={{ marginTop: 14 }}>
          <Seg value={cat} onChange={setCat} options={[{ value: 'all', label: '✨ All' }, ...CATS.filter((x) => x !== 'other').map((x) => ({ value: x, label: `${CAT_EMOJI[x]} ${nice(x).replace(/^./, (m) => m.toUpperCase())}` }))]} />
        </View>

        {plain && deals.data?.length ? (
          <View style={{ marginTop: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}><H2>🔥 Deals right now</H2><Pressable onPress={() => { setSort('discount'); setFilters((f) => ({ ...f, on_offer: true })); }}><T color={c.pink} weight="700" size={13}>See all ›</T></Pressable></View>
            <HScroll gap={12} style={{ marginTop: 10 }}>{deals.data.map((p) => <ProductCard key={p.id} p={p} w={Math.min(g.w, 190)} onOpen={open} />)}</HScroll>
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18 }}>
          <View style={{ flex: 1 }}><Seg value={sort} onChange={setSort} options={SORTS.map(([value, label]) => ({ value, label }))} /></View>
          <Chip label={active ? `Filters · ${active}` : 'Filters'} active={!!active} onPress={() => setFiltering(true)} />
        </View>
        <View style={{ marginTop: 4 }}><SportSelect label="" value={sport} onChange={setSport} optional allLabel="All sports" /></View>

        {prods.error ? <View style={{ marginTop: 14 }}><ErrorBox error={prods.error} onRetry={prods.reload} /></View> : prods.loading && !prods.data ? <Loading /> : !prods.data?.length ? (
          <View style={{ marginTop: 14 }}>
            <Empty emoji={hearts ? '♡' : '🛍️'} title={hearts ? 'Your wishlist is empty' : q || active || sport || cat !== 'all' ? 'Nothing matches' : 'No items yet'}
              sub={hearts ? 'Tap the heart on any product to keep it here.' : q || active || sport || cat !== 'all' ? 'Try another search or clear the filters.' : "Suppliers haven't listed anything yet."} />
            {(q || active || sport || cat !== 'all' || hearts) ? <Btn small title="Clear all" color={c.paper} ink={c.ink} style={{ alignSelf: 'center', marginTop: 10 }} onPress={() => { setText(''); setQ(''); setCat('all'); setSport(undefined); setHearts(false); setFilters({ on_offer: false, in_stock: false, min_rating: 0 }); }} /> : null}
          </View>
        ) : (
          <>
            <T size={12} color={c.mute} weight="600" style={{ marginTop: 14 }}>{prods.data.length} product{prods.data.length === 1 ? '' : 's'}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: g.gap, marginTop: 8 }}>
              {prods.data.map((p) => <ProductCard key={p.id} p={p} w={g.w} onOpen={open} onHeart={() => hearts && prods.reload()} />)}
            </View>
          </>
        )}
      </Screen>
      <CartBar />
      {filtering ? (
        <FormSheet visible onClose={() => setFiltering(false)} title="Filters" submitLabel="Show results"
          initial={filters}
          fields={[
            { key: 'min_price_cents', label: 'Lowest price', type: 'money', currency: 'INR', optional: true },
            { key: 'max_price_cents', label: 'Highest price', type: 'money', currency: 'INR', optional: true },
            { key: 'min_rating', label: 'Rating', type: 'chips', options: [{ value: 0, label: 'Any' }, { value: 4, label: '4★ & up' }, { value: 3, label: '3★ & up' }] },
            { key: 'on_offer', label: 'Only offers', type: 'switch' },
            { key: 'in_stock', label: 'Only in stock', type: 'switch' },
          ]}
          onSubmit={async (v) => { setFilters({ on_offer: false, in_stock: false, min_rating: 0, ...v }); }} />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- product page

function Reviews({ id, canReview, onWritten }) {
  const rev = useLoad(() => api.get('/testimonials', { subject_type: 'product', subject_id: id, limit: 30 }), [id]);
  const [writing, setWriting] = useState(false);
  const r = rev.data;
  return (
    <View style={{ marginTop: 22, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <H2>Ratings & reviews</H2>
        {canReview ? <Btn small title="Write a review" onPress={() => setWriting(true)} /> : null}
      </View>
      {r?.n ? (
        <Card pad={14}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <T size={38} weight="800">{Number(r.avg).toFixed(1)}</T>
          <View><Stars value={Number(r.avg)} size={18} /><T size={12} color={c.mute} weight="600">{r.n} review{r.n === 1 ? '' : 's'} from verified buyers</T></View>
        </View></Card>
      ) : <T size={13} color={c.mute}>No reviews yet. Only people who bought this can review it.</T>}
      {r?.items?.map((x) => (
        <Card key={x.id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><T weight="700" size={13}>{x.display_name}</T><T size={11} color={c.mute}>{day(x.created_at)}</T></View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}><Stars value={x.rating} /><Pill label="VERIFIED BUYER" fg={GOOD} bg={c.limeSoft} /></View>
          <T size={14} style={{ marginTop: 6, lineHeight: 20 }}>{x.body}</T>
        </Card>
      ))}
      {writing ? (
        <FormSheet visible onClose={() => setWriting(false)} title="Rate this product" submitLabel="Post review"
          fields={[{ key: 'rating', label: 'Your rating', type: 'chips', options: [5, 4, 3, 2, 1].map((n) => ({ value: n, label: `${'★'.repeat(n)}${'☆'.repeat(5 - n)}` })) }, { key: 'body', label: 'What did you think?', type: 'multiline', hint: 'Fit, quality, value — help the next player.' }]}
          onSubmit={async (v) => { await api.post('/testimonials', { subject_type: 'product', subject_id: id, ...v }); await rev.reload(); onWritten?.(); return 'Thanks for your review'; }} />
      ) : null}
    </View>
  );
}

export function ShopProduct({ id }) {
  const { push } = useNav();
  const { user, toast } = useSession();
  const L = useLayout();
  const g = useGrid();
  const { set, lineOf } = useCart();
  const res = useLoad(() => api.get(`/shop/products/${id}`), [id, user?.id]);
  const [at, setAt] = useState(0);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const p = res.data;
  if (res.error) return <Screen><ErrorBox error={res.error} onRetry={res.reload} /></Screen>;
  if (!p) return <Screen><Loading /></Screen>;
  const mine = p.seller_id === user?.id;
  const line = lineOf(p.id);
  const imgs = p.images?.length ? p.images : [null];
  const buyNow = async () => { setBusy(true); try { await set({ product_id: p.id, quantity: Math.max(qty, line?.quantity ?? 0) }); push('ShopCart'); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const stock = p.stock < 1 ? ['Sold out', c.red] : p.stock < 5 ? [`Only ${p.stock} left — order soon`, c.sun] : ['In stock', GOOD];
  return (
    <View style={{ flex: 1 }}>
      <Screen wide padBottom={150}>
        <View style={{ flexDirection: L.tablet ? 'row' : 'column', gap: 20, marginTop: 10 }}>
          <View style={{ flex: L.tablet ? 1 : undefined, gap: 10, maxWidth: L.tablet ? 460 : undefined }}>
            <View>
              <Photo p={{ ...p, images: imgs[at] ? [imgs[at]] : [] }} radius={22} />
              {p.discount_pct ? <View style={{ position: 'absolute', left: 12, top: 12, backgroundColor: GOOD, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 }}><T size={13} weight="800" color="#fff">{p.discount_pct}% OFF</T></View> : null}
              <Heart p={p} onChange={() => res.reload()} style={{ position: 'absolute', right: 12, top: 12 }} />
            </View>
            {p.images.length > 1 ? (
              <HScroll gap={8}>{p.images.map((im, n) => (
                <Pressable key={im.id} onPress={() => setAt(n)} accessibilityLabel={`Photo ${n + 1}`} style={{ borderRadius: 14, borderWidth: 2, borderColor: n === at ? c.pink : 'transparent' }}><Photo p={{ ...p, images: [im] }} size={64} radius={12} /></Pressable>
              ))}</HScroll>
            ) : null}
          </View>
          <View style={{ flex: L.tablet ? 1 : undefined, gap: 10 }}>
            {p.brand ? <T size={12} weight="800" color={c.pink} style={{ letterSpacing: 1.2 }}>{p.brand.toUpperCase()}</T> : null}
            <H1 style={{ fontSize: 26 }}>{p.name}</H1>
            <T size={13} color={c.mute} weight="600">{[p.sport, nice(p.category)].filter(Boolean).join(' · ')} · Sold by <T size={13} weight="700">{p.seller_name}</T></T>
            {p.rating_count ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Stars value={p.rating} size={16} /><T size={13} weight="700">{Number(p.rating).toFixed(1)}</T><T size={12} color={c.mute}>({p.rating_count} review{p.rating_count === 1 ? '' : 's'})</T></View> : null}
            <Price p={p} size={28} />
            {p.compare_at_cents > p.price_cents ? <T size={13} weight="700" color={GOOD}>You save {money(p.compare_at_cents - p.price_cents)} on each</T> : null}
            <T size={13} weight="800" color={stock[1]}>{stock[0]}</T>
            {p.highlights?.length ? <View style={{ gap: 6, marginTop: 4 }}>{p.highlights.map((h) => <View key={h} style={{ flexDirection: 'row', gap: 8 }}><T color={GOOD} weight="800">✓</T><T size={14} style={{ flex: 1, lineHeight: 20 }}>{h}</T></View>)}</View> : null}
            {!mine && p.stock > 0 ? (
              <View style={{ gap: 12, marginTop: 8 }}>
                {!line ? <Counter value={qty} onChange={setQty} min={1} max={Math.min(p.stock, 50)} label="Quantity" /> : null}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <AddControl p={p} big />
                  <Btn title="Buy now" color={c.violet} onPress={buyNow} loading={busy} style={{ flex: 1 }} />
                </View>
                {line ? <Pressable onPress={() => push('ShopCart')}><T color={c.pink} weight="700" size={13}>{line.quantity} in your cart · Go to cart ›</T></Pressable> : null}
              </View>
            ) : mine ? <Pill label="THIS IS YOUR LISTING — edit it from Orders & selling" /> : null}
            {p.description ? <View style={{ marginTop: 8 }}><H2>About this item</H2><T size={14} color={c.mute} style={{ marginTop: 6, lineHeight: 21 }}>{p.description}</T></View> : null}
            <Card pad={12} color={c.bg} style={{ marginTop: 6 }}><T size={12} color={c.mute} style={{ lineHeight: 18 }}>🔒 Your delivery address is encrypted. Pay securely once for everything in your cart; cancel before it ships for a full refund.</T></Card>
          </View>
        </View>

        <Reviews id={p.id} canReview={p.can_review} onWritten={res.reload} />

        {p.related?.length ? (
          <View style={{ marginTop: 24 }}>
            <H2>You may also like</H2>
            <HScroll gap={12} style={{ marginTop: 10 }}>{p.related.map((r) => <ProductCard key={r.id} p={r} w={Math.min(g.w, 190)} onOpen={(x) => push('ShopProduct', { id: x.id })} />)}</HScroll>
          </View>
        ) : null}
      </Screen>
      <CartBar />
    </View>
  );
}

// ---------------------------------------------------------------- cart & checkout

function CartLine({ it, onChange }) {
  const { toast } = useSession();
  const { push } = useNav();
  const { set } = useCart();
  const [busy, setBusy] = useState(false);
  const run = async (body) => { setBusy(true); try { await set(body); onChange?.(); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const saved = it.saved_for_later;
  return (
    <View style={{ flexDirection: 'row', gap: 12, opacity: busy ? 0.6 : 1 }}>
      <Pressable onPress={() => push('ShopProduct', { id: it.product_id })}><Photo p={it} size={84} radius={14} /></Pressable>
      <View style={{ flex: 1, gap: 3 }}>
        {it.brand ? <T size={11} weight="800" color={c.pink} style={{ letterSpacing: 0.8 }}>{it.brand.toUpperCase()}</T> : null}
        <T weight="700" size={14} numberOfLines={2}>{it.name}</T>
        <Price p={{ ...it, discount_pct: it.compare_at_cents > it.price_cents ? Math.round(100 * (it.compare_at_cents - it.price_cents) / it.compare_at_cents) : null }} size={15} />
        {!it.available ? <T size={12} weight="800" color={c.red}>{it.archived_at ? 'No longer sold' : 'Sold out'} — save it for later or remove it</T> : it.stock < 5 ? <T size={12} weight="700" color={c.sun}>Only {it.stock} left</T> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 14, marginTop: 4 }}>
          {!saved && it.available ? <Counter value={it.quantity} min={1} max={it.max_qty} onChange={(n) => run({ product_id: it.product_id, quantity: n })} /> : null}
          {saved && it.available ? <Pressable onPress={() => run({ product_id: it.product_id, saved_for_later: false })}><T color={c.pink} weight="800" size={13}>Move to cart</T></Pressable> : null}
          {!saved ? <Pressable onPress={() => run({ product_id: it.product_id, saved_for_later: true })}><T color={c.mute} weight="700" size={13}>Save for later</T></Pressable> : null}
          <Pressable onPress={() => run({ product_id: it.product_id, quantity: 0 })}><T color={c.red} weight="700" size={13}>Remove</T></Pressable>
        </View>
      </View>
    </View>
  );
}

export function ShopCart() {
  const { push, goTab } = useNav();
  const L = useLayout();
  const { user, toast } = useSession();
  const { cart, ready, refresh } = useCart();
  const [ship, setShip] = useState(user?.address ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [paying, setPaying] = useState(null);
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = cart.summary;
  const bySeller = useMemo(() => { const m = new Map(); for (const it of cart.items) m.set(it.seller_name, [...(m.get(it.seller_name) ?? []), it]); return [...m.entries()]; }, [cart.items]);

  const place = async () => {
    if (ship.trim().length < 5) return toast('Add your delivery address first');
    setBusy(true);
    try {
      const r = await api.post('/shop/cart/checkout', { ship_to: ship.trim() });
      await refresh();
      setDone(r);
      if (r.status === 'awaiting_payment') setPaying({ type: 'shop_checkout', id: r.checkout_id, amount: r.amount_due_cents, label: `${r.orders.length} item${r.orders.length === 1 ? '' : 's'} from the shop` });
    } catch (e) { toast(e.message); await refresh(); } finally { setBusy(false); }
  };

  if (done) {
    const unpaid = done.status === 'awaiting_payment';
    return (
      <Screen>
        <Card pad={22} style={{ marginTop: 16, alignItems: 'center' }}>
          <View style={{ alignItems: 'center', gap: 6 }}>
            <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: unpaid ? c.sunSoft : c.limeSoft, alignItems: 'center', justifyContent: 'center' }}><T size={36}>{unpaid ? '⏳' : '🎉'}</T></View>
            <H2>{unpaid ? 'Almost there — pay to confirm' : 'Order placed!'}</H2>
            <T size={14} color={c.mute} style={{ textAlign: 'center' }}>{done.orders.length} item{done.orders.length === 1 ? '' : 's'} · {money(done.total_cents)}{unpaid ? '. Your items are reserved while you pay.' : '. The sellers have been told to get it moving.'}</T>
          </View>
          <View style={{ alignSelf: 'stretch', gap: 8, marginTop: 14 }}>{done.orders.map((o) => <View key={o.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={13} weight="600" style={{ flex: 1 }}>{o.quantity} × {o.name}</T><T size={13} weight="700">{money(o.total_cents)}</T></View>)}</View>
          <View style={{ alignSelf: 'stretch', gap: 8, marginTop: 16 }}>
            {unpaid ? <Btn title={`Pay ${money(done.amount_due_cents)}`} onPress={() => setPaying({ type: 'shop_checkout', id: done.checkout_id, amount: done.amount_due_cents, label: 'Shop order' })} /> : null}
            <Btn title="Track my orders" color={unpaid ? c.paper : c.pink} ink={c.ink} onPress={() => push('ShopOrders')} />
            <Btn title="Keep shopping" color={c.paper} ink={c.ink} onPress={() => { goTab('Hub'); setTimeout(() => push('Shop'), 0); }} />
          </View>
        </Card>
        {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={async () => setDone((d) => ({ ...d, status: 'placed' }))} /> : null}
      </Screen>
    );
  }

  if (!ready) return <Screen><Loading /></Screen>;
  if (!cart.items.length && !cart.saved.length) {
    return (
      <Screen>
        <View style={{ marginTop: 20 }}><Empty emoji="🛒" title="Your cart is empty" sub="Add kit you love and it waits here, on every device." /></View>
        <Btn title="Browse the shop" style={{ marginTop: 14 }} onPress={() => { goTab('Hub'); setTimeout(() => push('Shop'), 0); }} />
      </Screen>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <Screen padBottom={L.floatingBar ? 220 : 130}>
        <H1 style={{ fontSize: 26, marginTop: 8 }}>Your cart <T size={16} color={c.mute} weight="600">· {s.units} item{s.units === 1 ? '' : 's'}</T></H1>
        {s.savings_cents > 0 ? <Card pad={12} color={c.limeSoft} style={{ marginTop: 10 }}><T weight="800" color={GOOD} size={14}>🎉 You're saving {money(s.savings_cents)} on this order</T></Card> : null}
        {bySeller.map(([seller, items]) => (
          <Card key={seller} pad={14} style={{ marginTop: 12 }}>
            <T size={12} weight="700" color={c.mute} style={{ marginBottom: 12 }}>SOLD BY {seller.toUpperCase()}</T>
            <View style={{ gap: 16 }}>{items.map((it) => <CartLine key={it.product_id} it={it} />)}</View>
          </Card>
        ))}
        {!cart.items.length ? <Card pad={14} style={{ marginTop: 12 }}><T color={c.mute} size={13}>Nothing to buy right now. Move something back from "Saved for later".</T></Card> : null}

        {s.lines ? (
          <>
            <Card pad={14} style={{ marginTop: 12 }}><View style={{ gap: 8 }}>
              <T weight="800" size={15}>Deliver to</T>
              <Field label="" value={ship} onChangeText={setShip} multiline placeholder="House / street, area, city, PIN" hint="🔒 Encrypted at rest. Only the sellers fulfilling your order can read it." />
            </View></Card>
            <Card pad={14} style={{ marginTop: 12 }}><View style={{ gap: 8 }}>
              <T weight="800" size={15}>Price details</T>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T color={c.mute}>Items ({s.units})</T><T weight="600">{money(s.subtotal_cents + s.savings_cents)}</T></View>
              {s.savings_cents > 0 ? <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T color={c.mute}>Offer savings</T><T weight="700" color={GOOD}>− {money(s.savings_cents)}</T></View> : null}
              <View style={{ height: 1, backgroundColor: c.line }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800" size={16}>Total</T><T weight="800" size={16}>{money(s.total_cents)}</T></View>
            </View></Card>
          </>
        ) : null}

        {cart.saved.length ? (
          <Card pad={14} style={{ marginTop: 12 }}>
            <T size={12} weight="700" color={c.mute} style={{ marginBottom: 12 }}>SAVED FOR LATER ({cart.saved.length})</T>
            <View style={{ gap: 16 }}>{cart.saved.map((it) => <CartLine key={it.product_id} it={it} />)}</View>
          </Card>
        ) : null}
      </Screen>
      {s.lines ? (
        <View style={{ position: 'absolute', left: L.floatingBar ? 24 : 0, right: L.floatingBar ? 24 : 0, bottom: L.floatingBar ? 92 : 0, backgroundColor: c.paper, borderTopWidth: L.floatingBar ? 0 : 1, borderWidth: L.floatingBar ? 1 : 0, borderColor: c.line, borderRadius: L.floatingBar ? 20 : 0, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'center', maxWidth: L.floatingBar ? 760 : undefined, shadowColor: '#0F172A', shadowOpacity: L.floatingBar ? 0.12 : 0, shadowRadius: 16 }}>
          <View style={{ flex: 1 }}><T weight="800" size={18}>{money(s.total_cents)}</T>{s.savings_cents > 0 ? <T size={12} weight="700" color={GOOD}>You save {money(s.savings_cents)}</T> : <T size={12} color={c.mute}>{s.units} item{s.units === 1 ? '' : 's'}</T>}</View>
          <Btn title="Place order" onPress={place} loading={busy} style={{ minWidth: 170 }} />
        </View>
      ) : null}
      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={async () => setDone((d) => (d ? { ...d, status: 'placed' } : d))} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------- orders & selling

const FLOW = ['placed', 'shipped', 'delivered'];
function Progress({ status }) {
  if (status === 'cancelled') return <Pill label="CANCELLED" fg={c.red} bg={c.redSoft} />;
  if (status === 'awaiting_payment') return <Pill label="WAITING FOR PAYMENT" fg={c.sun} bg={c.sunSoft} />;
  const at = FLOW.indexOf(status);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {FLOW.map((k, n) => (
        <React.Fragment key={k}>
          <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: n <= at ? GOOD : c.line, alignItems: 'center', justifyContent: 'center' }}>{n <= at ? <T size={10} weight="800" color="#fff">✓</T> : null}</View>
          <T size={11} weight={n === at ? '800' : '600'} color={n <= at ? GOOD : c.mute}>{nice(k === 'placed' ? 'ordered' : k)}</T>
          {n < FLOW.length - 1 ? <View style={{ width: 18, height: 2, backgroundColor: n < at ? GOOD : c.line }} /> : null}
        </React.Fragment>
      ))}
    </View>
  );
}

function MyOrders() {
  const { push } = useNav();
  const { toast } = useSession();
  const { set } = useCart();
  const orders = useLoad(() => api.get('/shop/orders', { limit: 100 }), []);
  const [paying, setPaying] = useState(null);
  const [rating, setRating] = useState(null);
  const groups = useMemo(() => {
    const m = new Map();
    for (const o of orders.data ?? []) { const k = o.checkout_id ?? o.id; m.set(k, [...(m.get(k) ?? []), o]); }
    return [...m.entries()];
  }, [orders.data]);
  const cancel = async (o) => { try { await api.patch(`/shop/orders/${o.id}`, { status: 'cancelled' }); await orders.reload(); toast('Order cancelled'); } catch (e) { toast(e.message); } };
  const again = async (o) => { try { await set({ product_id: o.product_id, add: o.quantity }); toast('Added to your cart'); push('ShopCart'); } catch (e) { toast(e.message); } };
  if (orders.error) return <ErrorBox error={orders.error} onRetry={orders.reload} />;
  if (orders.loading && !orders.data) return <Loading />;
  if (!groups.length) return <Empty emoji="📦" title="No orders yet" sub="Everything you buy shows up here with live status." />;
  return (
    <View style={{ gap: 12 }}>
      {groups.map(([key, lines]) => {
        const due = lines.filter((o) => o.status === 'awaiting_payment');
        const total = lines.reduce((t, o) => t + Number(o.total_cents), 0);
        return (
          <Card key={key} pad={14}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={12} color={c.mute} weight="700">ORDERED {day(lines[0].created_at).toUpperCase()}</T><T weight="800" size={14}>{money(total)}</T></View>
            <View style={{ gap: 14, marginTop: 12 }}>
              {lines.map((o) => (
                <View key={o.id} style={{ flexDirection: 'row', gap: 12 }}>
                  <Pressable onPress={() => push('ShopProduct', { id: o.product_id })}><Photo p={o} size={64} radius={12} /></Pressable>
                  <View style={{ flex: 1, gap: 4 }}>
                    <T weight="700" size={14} numberOfLines={2}>{o.quantity} × {o.product_name}</T>
                    <T size={12} color={c.mute}>{money(o.total_cents)} · from {o.seller_name}</T>
                    <Progress status={o.status} />
                    <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap', marginTop: 2 }}>
                      {['placed', 'shipped', 'delivered'].includes(o.status) ? <Pressable onPress={() => setRating(o)}><T color={c.pink} weight="800" size={12}>★ Rate</T></Pressable> : null}
                      <Pressable onPress={() => again(o)}><T color={c.pink} weight="800" size={12}>Buy again</T></Pressable>
                      {['placed', 'awaiting_payment'].includes(o.status) ? <Pressable onPress={() => cancel(o)}><T color={c.red} weight="700" size={12}>Cancel{o.status === 'placed' ? ' & refund' : ''}</T></Pressable> : null}
                    </View>
                  </View>
                </View>
              ))}
            </View>
            {due.length ? <Btn small title={`Pay ${money(due.reduce((t, o) => t + Number(o.total_cents), 0))}`} style={{ marginTop: 12, alignSelf: 'flex-start' }} onPress={() => setPaying(o0(lines[0], due))} /> : null}
          </Card>
        );
      })}
      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={orders.reload} /> : null}
      {rating ? (
        <FormSheet visible onClose={() => setRating(null)} title={`Rate ${rating.product_name}`} submitLabel="Post review"
          fields={[{ key: 'rating', label: 'Your rating', type: 'chips', options: [5, 4, 3, 2, 1].map((n) => ({ value: n, label: `${'★'.repeat(n)}${'☆'.repeat(5 - n)}` })) }, { key: 'body', label: 'What did you think?', type: 'multiline' }]}
          onSubmit={async (v) => { await api.post('/testimonials', { subject_type: 'product', subject_id: rating.product_id, ...v }); return 'Thanks for your review'; }} />
      ) : null}
    </View>
  );
}
// what to pay for an order group: the whole checkout when it was bought together, else the single order
const o0 = (first, due) => (first.checkout_id
  ? { type: 'shop_checkout', id: first.checkout_id, amount: due.reduce((t, o) => t + Number(o.total_cents), 0), label: 'Shop order' }
  : { type: 'shop_order', id: due[0].id, amount: Number(due[0].total_cents), label: due[0].product_name });

/** A seller's photo strip + the product form, in one sheet (photos upload as soon as they are picked). */
function ProductSheet({ product, onClose, onSaved }) {
  const { toast } = useSession();
  const editing = !!product;
  const [photos, setPhotos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const have = product?.images?.length ?? 0;
  const add = async () => {
    try {
      const f = await pickMedia({ photoOnly: true });
      if (!f) return;
      setUploading(true);
      const up = await api.upload('/market/media', f.blob);
      setPhotos((p) => [...p, up]);
    } catch (e) { toast(e.message); } finally { setUploading(false); }
  };
  const init = product && {
    ...product, price_cents: Number(product.price_cents), compare_at_cents: product.compare_at_cents == null ? undefined : Number(product.compare_at_cents),
    sport: product.sport_slug ?? undefined, highlights_text: (product.highlights ?? []).join('\n'), archived: !!product.archived_at,
  };
  return (
    <Sheet visible onClose={onClose} title={editing ? 'Edit listing' : 'List an item'}>
      <View style={{ gap: 6 }}>
        <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>PHOTOS · {have + photos.length}/8</T>
        <HScroll gap={10}>
          {(product?.images ?? []).map((im) => <Photo key={im.id} p={{ ...product, images: [im] }} size={72} radius={14} />)}
          {photos.map((ph) => <Image key={ph.id} source={{ uri: mediaUrl(ph.url) }} style={{ width: 72, height: 72, borderRadius: 14 }} />)}
          {have + photos.length < 8 ? <Pressable onPress={add} disabled={uploading} accessibilityLabel="Add photo" style={{ width: 72, height: 72, borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.pink, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}><T size={uploading ? 12 : 26} color={c.pink} weight="700">{uploading ? '…' : '+'}</T></Pressable> : null}
        </HScroll>
        <T size={12} color={c.mute}>The first photo is the cover. Clear, bright photos sell more.</T>
      </View>
      <FormSheet inline onClose={onClose} submitLabel={editing ? 'Save changes' : 'List item'} initial={init ?? {}}
        fields={[
          { key: 'name', label: 'Name' },
          { key: 'brand', label: 'Brand', optional: true },
          { key: 'category', label: 'Category', type: 'chips', options: CATS.map((x) => ({ value: x, label: nice(x).replace(/^./, (m) => m.toUpperCase()) })) },
          { key: 'sport', label: 'Sport', type: 'sport', optional: true },
          { key: 'price_cents', label: 'Selling price', type: 'money', currency: 'INR' },
          { key: 'compare_at_cents', label: 'Usual price', type: 'money', currency: 'INR', optional: true, hint: 'Higher than the selling price → shows as an offer with a % off tag.' },
          { key: 'stock', label: 'In stock', type: 'stepper', min: 0, max: 100000, default: 1 },
          { key: 'highlights_text', label: 'Highlights', type: 'multiline', optional: true, hint: 'One selling point per line (up to 8).' },
          { key: 'description', label: 'Description', type: 'multiline', optional: true },
          ...(editing ? [{ key: 'archived', label: 'Hide from the shop', type: 'switch', hint: 'Existing orders are kept.' }] : []),
        ]}
        onSubmit={async ({ highlights_text, price_cents, compare_at_cents, ...v }) => {
          const highlights = (highlights_text ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8);
          const body = { ...v, price_cents, highlights, media_ids: photos.map((x) => x.id) };
          if (editing) await api.patch(`/shop/products/${product.id}`, { ...body, compare_at_cents: compare_at_cents ?? null });
          else await api.post('/shop/products', { ...body, ...(compare_at_cents ? { compare_at_cents } : {}) });
          await onSaved?.();
          return editing ? 'Listing updated' : 'Listed';
        }} />
    </Sheet>
  );
}

function Selling() {
  const { toast } = useSession();
  const { push } = useNav();
  const mine = useLoad(() => api.get('/shop/products', { mine: true, limit: 100, sort: 'newest' }), []);
  const sales = useLoad(() => api.get('/shop/sales', { limit: 50 }), []);
  const [edit, setEdit] = useState(undefined); // undefined closed · null new · product edit
  const move = async (o, status) => { try { await api.patch(`/shop/orders/${o.id}`, { status }); await Promise.all([sales.reload(), mine.reload()]); toast(`Order ${status}`); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><H2>My listings</H2><Btn small title="+ List an item" onPress={() => setEdit(null)} /></View>
      {mine.loading && !mine.data ? <Loading /> : !mine.data?.length ? <Empty emoji="🏷️" title="Nothing listed yet" sub="Add photos, a price and stock — it's live in the shop straight away." /> : mine.data.map((p) => (
        <Card key={p.id} pad={12}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <Pressable onPress={() => push('ShopProduct', { id: p.id })}><Photo p={p} size={64} radius={12} /></Pressable>
            <View style={{ flex: 1, gap: 2 }}>
              <T weight="700" size={14} numberOfLines={1}>{p.name}</T>
              <Price p={p} size={14} />
              <T size={12} weight="700" color={p.archived_at ? c.mute : p.stock < 1 ? c.red : p.stock < 5 ? c.sun : GOOD}>{p.archived_at ? 'Hidden' : p.stock < 1 ? 'Sold out' : `${p.stock} in stock`} · {p.sold} sold{p.rating_count ? ` · ${Number(p.rating).toFixed(1)}★` : ''}</T>
            </View>
            <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setEdit(p)} />
          </View>
        </Card>
      ))}
      <H2 style={{ marginTop: 10 }}>Orders to fulfil</H2>
      {sales.loading && !sales.data ? <Loading /> : !sales.data?.length ? <T size={13} color={c.mute}>No orders yet.</T> : sales.data.map((o) => (
        <Card key={o.id} pad={12}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <Photo p={o} size={52} radius={12} />
            <View style={{ flex: 1 }}><T weight="700" size={14}>{o.quantity} × {o.product_name} → {o.buyer_name}</T><T size={12} color={c.mute}>{o.ship_to}</T></View>
            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              <StatusPill s={o.status} />
              {o.status === 'placed' ? <Btn small title="Ship" onPress={() => move(o, 'shipped')} /> : o.status === 'shipped' ? <Btn small title="Delivered" onPress={() => move(o, 'delivered')} /> : null}
            </View>
          </View>
        </Card>
      ))}
      {edit !== undefined ? <ProductSheet product={edit} onClose={() => setEdit(undefined)} onSaved={async () => { await mine.reload(); }} /> : null}
    </View>
  );
}

export function ShopOrders({ tab: start }) {
  const { has } = useSession();
  const seller = has('supplier', 'sponsor');
  const [tab, setTab] = useState(start ?? 'orders');
  return (
    <Screen>
      <H1 style={{ fontSize: 26, marginTop: 8 }}>Orders{seller ? ' & selling' : ''}</H1>
      {seller ? <View style={{ marginTop: 10 }}><Seg value={tab} onChange={setTab} options={[{ value: 'orders', label: '🛍️ My orders' }, { value: 'selling', label: '🏷️ Selling' }]} /></View> : null}
      <View style={{ marginTop: 12 }}>{tab === 'selling' && seller ? <Selling /> : <MyOrders />}</View>
    </Screen>
  );
}
