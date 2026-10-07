import React, { useState } from 'react';
import { Linking, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Avatar, Btn, Card, Empty, ErrorBox, H1, H2, Loading, Screen, Seg, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, toneFor, money, when, day } from '../theme';

const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const parseWhen = (s) => { const d = new Date(String(s).trim().replace(' ', 'T')); if (isNaN(d)) throw new Error('Use the format 2026-11-02 17:30'); return d.toISOString(); };
const SPORT_ANY = { value: '', label: 'Any sport' };

export function useCols(max = 1120) {
  const { width } = useWindowDimensions();
  const inner = Math.min(width, max) - 32;
  const cols = inner >= 980 ? 3 : inner >= 620 ? 2 : 1;
  const gap = 14;
  return { cols, gap, w: cols === 1 ? '100%' : Math.floor((inner - gap * (cols - 1)) / cols) };
}

const Pill = ({ label, fg = c.mute, bg = c.violetSoft }) => (
  <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' }}>
    <T weight="700" size={11} color={fg} style={{ letterSpacing: 0.3 }}>{label}</T>
  </View>
);
const STATUS = { awaiting_payment: [c.sun, c.sunSoft], pending_payment: [c.sun, c.sunSoft], unpaid: [c.sun, c.sunSoft], paid: [c.lime, c.limeSoft], refunded: [c.mute, c.violetSoft], pending: [c.sun, c.sunSoft], accepted: [c.lime, c.limeSoft], declined: [c.red, '#FFE4E6'], requested: [c.sun, c.sunSoft], confirmed: [c.lime, c.limeSoft], completed: [c.mute, c.violetSoft], cancelled: [c.red, '#FFE4E6'], placed: [c.sun, c.sunSoft], shipped: [c.cyan, c.cyanSoft], delivered: [c.lime, c.limeSoft], active: [c.lime, c.limeSoft], proposed: [c.sun, c.sunSoft] };
const StatusPill = ({ s }) => <Pill label={nice(s).toUpperCase()} fg={(STATUS[s] ?? [c.mute])[0]} bg={(STATUS[s] ?? [0, c.violetSoft])[1]} />;

/** Hosted checkout: pick Stripe or PayPal, go to the provider, then confirm. Card details never touch SportArena. */
function PaySheet({ target, onClose, onDone }) {
  const { toast } = useSession();
  const methods = useLoad(() => api.get('/payments/methods'), []);
  const [pay, setPay] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async (provider) => {
    setBusy(true); setErr(null);
    try {
      const p = await api.post('/payments', { purpose_type: target.type, purpose_id: target.id, provider, return_url: Platform.OS === 'web' ? `${window.location.origin}${window.location.pathname}` : undefined });
      setPay(p);
      if (Platform.OS === 'web') window.location.assign(p.checkout_url); else await Linking.openURL(p.checkout_url);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/payments/${pay.id}/confirm`);
      if (r.status === 'paid') { toast('Payment received ✓'); await onDone(); onClose(); } else setErr('Not paid yet — finish the checkout, then check again.');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const m = methods.data;
  return (
    <Sheet visible onClose={onClose} title="Pay securely">
      <T size={14} color={c.mute}>{target.label} · <T weight="800" size={14}>{money(target.amount)}</T>{m ? ` (${m.currency})` : ''}</T>
      {methods.loading && !m ? <Loading /> : !m?.providers.length ? (
        <T weight="700" color={c.red}>Online payments aren't switched on for this server yet. Ask the administrator to add Stripe or PayPal keys.</T>
      ) : pay ? (
        <View style={{ gap: 10 }}>
          <T size={14}>Checkout opened in {pay.provider === 'stripe' ? 'Stripe' : 'PayPal'}. When you're done, come back and check.</T>
          <Btn title="I've paid — check payment" onPress={check} loading={busy} />
          <Btn title="Reopen checkout" color={c.paper} onPress={() => (Platform.OS === 'web' ? window.location.assign(pay.checkout_url) : Linking.openURL(pay.checkout_url))} />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {m.providers.includes('stripe') ? <Btn title="Pay with card (Stripe)" onPress={() => go('stripe')} loading={busy} /> : null}
          {m.providers.includes('paypal') ? <Btn title="Pay with PayPal" color={c.paper} onPress={() => go('paypal')} loading={busy} /> : null}
          <T size={12} color={c.mute}>You'll be taken to the provider's secure page. Your card details never reach SportArena.</T>
        </View>
      )}
      {err ? <T color={c.red} weight="700">{err}</T> : null}
    </Sheet>
  );
}

const Head = ({ eyebrow, title, sub, right }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 6 }}>
    <View style={{ flexShrink: 1 }}>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{eyebrow}</T>
      <H1 style={{ fontSize: 28 }}>{title}</H1>
      {sub ? <T size={14} color={c.mute} style={{ marginTop: 2 }}>{sub}</T> : null}
    </View>
    {right}
  </View>
);

function useSportOptions() {
  const sports = useLoad(() => api.get('/sports'), []);
  return (sports.data ?? []).map((s) => ({ value: s.slug, label: `${s.emoji} ${s.name}` }));
}

const Grid = ({ children }) => {
  const { gap } = useCols();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap, marginTop: 14 }}>{children}</View>;
};

// ======================= BILLBOARD =======================

const KIND = {
  match_players: ['Players wanted', c.cyan, c.cyanSoft, 'Join the match'],
  team_recruiting: ['Team recruiting', c.pink, c.pinkSoft, 'Apply to join'],
  sponsorship_wanted: ['Seeking sponsor', c.sun, c.sunSoft, 'Offer sponsorship'],
  sponsor_call: ['Sponsor call', c.lime, c.limeSoft, "I'm interested"],
};

function PostResponses({ post, onChanged }) {
  const { toast } = useSession();
  const r = useLoad(() => api.get(`/billboard/${post.id}/responses`), [post.id]);
  const decide = async (x, status) => { try { await api.patch(`/billboard/responses/${x.response_id}`, { status }); await r.reload(); onChanged(); toast(status === 'accepted' ? 'Accepted' : 'Declined'); } catch (e) { toast(e.message); } };
  if (r.loading && !r.data) return <Loading />;
  if (!r.data?.length) return <T size={13} color={c.mute}>No responses yet.</T>;
  return (
    <View style={{ gap: 10 }}>
      {r.data.map((x) => (
        <View key={x.response_id} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Avatar user={x} size={34} />
          <View style={{ flex: 1 }}><T weight="700" size={14}>{x.display_name}</T>{x.message ? <T size={13} color={c.mute}>{x.message}</T> : null}</View>
          {x.status === 'pending' ? (
            <View style={{ flexDirection: 'row', gap: 6 }}><Btn small title="Accept" onPress={() => decide(x, 'accepted')} /><Btn small title="Decline" color={c.paper} onPress={() => decide(x, 'declined')} /></View>
          ) : <StatusPill s={x.status} />}
        </View>
      ))}
    </View>
  );
}

function PostCard({ p, width, onRespond, onChanged }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const [label, fg, bg, cta] = KIND[p.kind];
  const meta = [p.sport && `${p.sport_emoji} ${p.sport}`, p.city, p.starts_at && when(p.starts_at), p.budget_cents != null && `Budget ${money(p.budget_cents)}`].filter(Boolean).join(' · ');
  return (
    <View style={{ width }}>
      <Card pad={16}>
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Pill label={label.toUpperCase()} fg={fg} bg={bg} />
            {p.status !== 'open' ? <StatusPill s={p.status} /> : p.kind !== 'sponsorship_wanted' && p.kind !== 'sponsor_call' ? <T size={12} color={c.mute} weight="700">{p.accepted}/{p.positions_needed} filled</T> : null}
          </View>
          <T weight="800" size={17} style={{ letterSpacing: -0.2 }}>{p.title}</T>
          {meta ? <T size={13} color={c.mute} weight="600">{meta}</T> : null}
          {p.body ? <T size={14} color={c.ink} style={{ lineHeight: 20 }}>{p.body}</T> : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Avatar user={{ avatar_emoji: p.author_emoji, avatar_color: p.author_color, handle: p.author_handle }} size={26} />
            <T size={13} color={c.mute} weight="600">{p.team_name ? `${p.team_emoji} ${p.team_name} · ` : ''}{p.author_name}</T>
          </View>
          {p.is_mine ? (
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn small title={open ? 'Hide responses' : 'View responses'} color={c.paper} onPress={() => setOpen(!open)} />
                {p.status === 'open' ? <Btn small title="Take down" color={c.paper} ink={c.red} onPress={async () => { try { await api.post(`/billboard/${p.id}/close`); onChanged(); toast('Post closed'); } catch (e) { toast(e.message); } }} /> : null}
              </View>
              {open ? <PostResponses post={p} onChanged={onChanged} /> : null}
            </View>
          ) : p.my_response ? <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T size={13} color={c.mute} weight="600">Your response:</T><StatusPill s={p.my_response} /></View>
            : p.status === 'open' ? <Btn small title={cta} onPress={onRespond} style={{ alignSelf: 'flex-start' }} /> : null}
        </View>
      </Card>
    </View>
  );
}

function EventCard({ e, width, onJoin }) {
  const tone = toneFor(e.sport);
  return (
    <View style={{ width }}>
      <Card pad={16}>
        <View style={{ gap: 10 }}>
          <Pill label="OPEN EVENT" fg={tone[2]} bg={tone[1]} />
          <T weight="800" size={17} style={{ letterSpacing: -0.2 }}>{e.name}</T>
          <T size={13} color={c.mute} weight="600">{[`${e.sport_emoji} ${e.sport}`, nice(e.kind), e.starts_on && day(e.starts_on + 'T12:00:00'), `${e.entrants} entered`, e.entry_fee_cents ? `Entry ${money(e.entry_fee_cents)}` : null].filter(Boolean).join(' · ')}</T>
          <Btn small title="Register to play" onPress={onJoin} style={{ alignSelf: 'flex-start' }} />
        </View>
      </Card>
    </View>
  );
}

function SponsorInbox() {
  const { toast } = useSession();
  const deals = useLoad(() => api.get('/sponsorships', { status: 'proposed' }), []);
  const { user } = useSession();
  const mine = (deals.data ?? []).filter((d) => d.target_type === 'athlete' && d.target_id === user.id);
  if (!mine.length) return null;
  const decide = async (d, status) => { try { await api.patch(`/sponsorships/${d.id}`, { status }); await deals.reload(); toast(status === 'active' ? 'Sponsorship accepted 🎉' : 'Offer declined'); } catch (e) { toast(e.message); } };
  return (
    <View style={{ marginTop: 16 }}>
      <H2>Sponsor offers for you</H2>
      <View style={{ gap: 10, marginTop: 10 }}>
        {mine.map((d) => (
          <Card key={d.id} pad={14} color={c.sunSoft}>
            <T weight="800" size={15}>{d.sponsor_emoji} {d.sponsor_name} wants to sponsor you</T>
            <T size={13} color={c.mute} style={{ marginTop: 2 }}>{[d.amount_cents ? money(d.amount_cents) : null, d.in_kind].filter(Boolean).join(' + ') || 'Support offered'}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}><Btn small title="Accept" onPress={() => decide(d, 'active')} /><Btn small title="Decline" color={c.paper} onPress={() => decide(d, 'declined')} /></View>
          </Card>
        ))}
      </View>
    </View>
  );
}

const FILTERS = [['all', 'All'], ['match_players', 'Matches'], ['team_recruiting', 'Teams'], ['sponsor', 'Sponsorship'], ['events', 'Events'], ['mine', 'My posts']];

export function Billboard() {
  const { has, toast } = useSession();
  const { w } = useCols();
  const sports = useSportOptions();
  const [f, setF] = useState('all');
  const [post, setPost] = useState(false);
  const [resp, setResp] = useState(null);
  const q = f === 'mine' ? { mine: true, include_closed: true } : f === 'match_players' || f === 'team_recruiting' ? { kind: f } : {};
  const posts = useLoad(() => (f === 'events' ? Promise.resolve([]) : api.get('/billboard', { ...q, limit: 50 })), [f]);
  const events = useLoad(() => (f === 'all' || f === 'events' ? api.get('/events', { status: 'open', limit: 20 }) : Promise.resolve([])), [f]);
  const list = (posts.data ?? []).filter((p) => (f === 'sponsor' ? p.kind.startsWith('sponsor') : true));
  const join = async (e) => { try { await api.post(`/events/${e.id}/entries`, {}); toast(`Registered for ${e.name} — awaiting approval`); } catch (x) { toast(x.message); } };
  const loading = (posts.loading && !posts.data) || (events.loading && !events.data);
  const empty = !loading && !list.length && !(events.data ?? []).length;

  return (
    <Screen wide>
      <Head eyebrow="BILLBOARD" title="Who's looking for you" sub="Matches needing players, teams recruiting, sponsors and open events — all in one place."
        right={<Btn small title="+ Post a need" onPress={() => setPost(true)} />} />
      <View style={{ marginTop: 14 }}><Seg options={FILTERS.map(([value, label]) => ({ value, label }))} value={f} onChange={setF} /></View>
      {f === 'all' || f === 'sponsor' ? <SponsorInbox /> : null}
      {posts.error ? <ErrorBox error={posts.error} onRetry={posts.reload} /> : loading ? <Loading /> : empty ? (
        <View style={{ marginTop: 14 }}><Empty emoji="📣" title="Nothing here yet" sub="Be the first — post that you need players, a team, or a sponsor." /></View>
      ) : (
        <Grid>
          {list.map((p) => <PostCard key={p.id} p={p} width={w} onRespond={() => setResp(p)} onChanged={posts.reload} />)}
          {(events.data ?? []).map((e) => <EventCard key={e.id} e={e} width={w} onJoin={() => join(e)} />)}
        </Grid>
      )}

      {post ? (
        <FormSheet visible onClose={() => setPost(false)} title="Post on the billboard" submitLabel="Post"
          fields={[
            { key: 'kind', label: 'What do you need?', type: 'choice', options: [{ value: 'match_players', label: 'Players for a match' }, { value: 'team_recruiting', label: 'Players for my team' }, { value: 'sponsorship_wanted', label: 'A sponsor' }, ...(has('sponsor') ? [{ value: 'sponsor_call', label: 'Athletes (as sponsor)' }] : [])] },
            { key: 'title', label: 'Headline', placeholder: 'Need 2 players for Sunday 7-a-side' },
            { key: 'body', label: 'Details', optional: true, type: 'multiline' },
            { key: 'sport', label: 'Sport', type: 'choice', options: [SPORT_ANY, ...sports], optional: true },
            { key: 'city', label: 'City', optional: true },
            { key: 'when', label: 'When (2026-11-02 17:30)', optional: true },
            { key: 'positions_needed', label: 'How many people?', type: 'number', optional: true },
            { key: 'budget', label: 'Budget (₹)', type: 'number', optional: true, hint: 'Sponsorship only.' },
          ]}
          onSubmit={async ({ when: w2, budget, ...v }) => { await api.post('/billboard', { ...v, starts_at: w2 ? parseWhen(w2) : undefined, budget_cents: budget !== undefined ? Math.round(budget * 100) : undefined }); await posts.reload(); return 'Posted'; }} />
      ) : null}
      {resp ? (
        <FormSheet visible onClose={() => setResp(null)} title={KIND[resp.kind][3]} submitLabel="Send"
          fields={[{ key: 'message', label: 'Message', optional: true, type: 'multiline', placeholder: 'Position, experience, availability…' }]}
          onSubmit={async (v) => { await api.post(`/billboard/${resp.id}/responses`, v); await posts.reload(); return 'Sent'; }} />
      ) : null}
    </Screen>
  );
}

// ======================= SHOP =======================

const CATS = ['all', 'equipment', 'apparel', 'footwear', 'nutrition', 'medical', 'accessories'];

export function Shop() {
  const { user, has, toast } = useSession();
  const { w } = useCols();
  const sports = useSportOptions();
  const [cat, setCat] = useState('all');
  const [buy, setBuy] = useState(null);
  const [sell, setSell] = useState(false);
  const [paying, setPaying] = useState(null);
  const prods = useLoad(() => api.get('/shop/products', { category: cat === 'all' ? undefined : cat, limit: 60 }), [cat]);
  const orders = useLoad(() => api.get('/shop/orders', { limit: 20 }), []);
  const seller = has('supplier', 'sponsor');
  const sales = useLoad(() => (seller ? api.get('/shop/sales', { limit: 20 }) : Promise.resolve([])), [seller]);
  const move = async (o, status) => { try { await api.patch(`/shop/orders/${o.id}`, { status }); await Promise.all([orders.reload(), sales.reload(), prods.reload()]); toast(`Order ${status}`); } catch (e) { toast(e.message); } };

  return (
    <Screen wide>
      <Head eyebrow="SHOP" title="Gear up" sub="Equipment, kit and nutrition from verified suppliers." right={seller ? <Btn small title="+ List an item" onPress={() => setSell(true)} /> : null} />
      <View style={{ marginTop: 14 }}><Seg options={CATS.map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) }))} value={cat} onChange={setCat} /></View>
      {prods.error ? <ErrorBox error={prods.error} onRetry={prods.reload} /> : prods.loading && !prods.data ? <Loading /> : !prods.data?.length ? (
        <View style={{ marginTop: 14 }}><Empty emoji="🛍️" title="No items yet" sub="Suppliers haven't listed anything in this category." /></View>
      ) : (
        <Grid>
          {prods.data.map((p) => {
            const tone = toneFor(p.sport_slug ?? p.category);
            return (
              <View key={p.id} style={{ width: w }}>
                <Card pad={14}>
                  <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                    <View style={{ width: 60, height: 60, borderRadius: 18, backgroundColor: tone[1], alignItems: 'center', justifyContent: 'center' }}><T size={30}>{p.emoji}</T></View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <T weight="800" size={15}>{p.name}</T>
                      <T size={12} color={c.mute} weight="600">{[p.sport, nice(p.category), p.seller_name].filter(Boolean).join(' · ')}</T>
                      <T weight="800" size={17} color={tone[2]}>{money(p.price_cents)}</T>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                    <T size={12} weight="700" color={p.stock > 0 ? (p.stock < 5 ? c.sun : c.mute) : c.red}>{p.stock > 0 ? (p.stock < 5 ? `Only ${p.stock} left` : 'In stock') : 'Sold out'}</T>
                    {p.seller_id !== user.id ? <Btn small title="Buy" onPress={() => setBuy(p)} disabled={p.stock < 1} /> : <Pill label="YOUR LISTING" />}
                  </View>
                </Card>
              </View>
            );
          })}
        </Grid>
      )}

      <H2 style={{ marginTop: 28 }}>My orders</H2>
      <View style={{ gap: 10, marginTop: 10 }}>
        {!orders.data?.length ? <T size={13} color={c.mute}>Nothing ordered yet.</T> : orders.data.map((o) => (
          <Card key={o.id} pad={12}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <T size={26}>{o.emoji}</T>
              <View style={{ flex: 1 }}><T weight="700" size={14}>{o.quantity} × {o.product_name}</T><T size={12} color={c.mute}>{money(o.total_cents)} · {day(o.created_at)} · from {o.seller_name}</T></View>
              <View style={{ alignItems: 'flex-end', gap: 6 }}><StatusPill s={o.status} />{o.status === 'awaiting_payment' ? <Btn small title="Pay now" onPress={() => setPaying({ type: 'shop_order', id: o.id, amount: o.total_cents, label: o.product_name })} /> : null}{['placed', 'awaiting_payment'].includes(o.status) ? <Pressable onPress={() => move(o, 'cancelled')}><T size={12} weight="700" color={c.red}>Cancel{o.status === 'placed' ? ' & refund' : ''}</T></Pressable> : null}</View>
            </View>
          </Card>
        ))}
      </View>

      {seller ? (
        <>
          <H2 style={{ marginTop: 28 }}>Orders to fulfil</H2>
          <View style={{ gap: 10, marginTop: 10 }}>
            {!sales.data?.length ? <T size={13} color={c.mute}>No orders yet.</T> : sales.data.map((o) => (
              <Card key={o.id} pad={12}>
                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                  <T size={26}>{o.emoji}</T>
                  <View style={{ flex: 1 }}><T weight="700" size={14}>{o.quantity} × {o.product_name} → {o.buyer_name}</T><T size={12} color={c.mute}>{o.ship_to}</T></View>
                  <View style={{ alignItems: 'flex-end', gap: 6 }}>
                    <StatusPill s={o.status} />
                    {o.status === 'placed' ? <Btn small title="Ship" onPress={() => move(o, 'shipped')} /> : o.status === 'shipped' ? <Btn small title="Delivered" onPress={() => move(o, 'delivered')} /> : null}
                  </View>
                </View>
              </Card>
            ))}
          </View>
        </>
      ) : null}

      {buy ? (
        <FormSheet visible onClose={() => setBuy(null)} title={`Buy ${buy.name}`} submitLabel={`Place order`}
          initial={{ quantity: 1, ship_to: user.address ?? '' }}
          fields={[{ key: 'quantity', label: `Quantity (${money(buy.price_cents)} each)`, type: 'number' }, { key: 'ship_to', label: 'Delivery address', type: 'multiline', hint: 'Encrypted at rest. You pay on the next step.' }]}
          onSubmit={async (v) => { const o = await api.post('/shop/orders', { product_id: buy.id, ...v }); await Promise.all([prods.reload(), orders.reload()]); if (o.status === 'awaiting_payment') setPaying({ type: 'shop_order', id: o.id, amount: o.total_cents, label: buy.name }); return `Order placed — ${money(o.total_cents)}`; }} />
      ) : null}
      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={async () => { await orders.reload(); await sales.reload(); }} /> : null}
      {sell ? (
        <FormSheet visible onClose={() => setSell(false)} title="List an item" submitLabel="List"
          fields={[
            { key: 'name', label: 'Name' }, { key: 'category', label: 'Category', type: 'choice', options: CATS.slice(1).concat('other') },
            { key: 'sport', label: 'Sport', type: 'choice', options: [SPORT_ANY, ...sports], optional: true },
            { key: 'price', label: 'Price (₹)', type: 'number' }, { key: 'stock', label: 'Stock', type: 'number' },
            { key: 'emoji', label: 'Emoji', optional: true }, { key: 'description', label: 'Description', optional: true, type: 'multiline' },
          ]}
          onSubmit={async ({ price, ...v }) => { await api.post('/shop/products', { ...v, price_cents: Math.round(price * 100) }); await prods.reload(); return 'Listed'; }} />
      ) : null}
    </Screen>
  );
}

// ======================= HIRE =======================

export function Hire() {
  const { toast } = useSession();
  const { w } = useCols();
  const [tab, setTab] = useState('coach');
  const [book, setBook] = useState(null);
  const [paying, setPaying] = useState(null);
  const coaches = useLoad(() => api.get('/coaches', { limit: 50 }), []);
  const provs = useLoad(() => api.get('/providers', { limit: 50 }), []);
  const hires = useLoad(() => api.get('/hires', { limit: 30 }), []);
  const appts = useLoad(() => api.get('/appointments', { limit: 30 }), []);
  const reloadAll = () => Promise.all([hires.reload(), appts.reload()]);
  const setHire = async (h, status) => { try { await api.patch(`/hires/${h.id}`, { status }); await reloadAll(); toast(`Booking ${status}`); } catch (e) { toast(e.message); } };
  const setAppt = async (a, status) => { try { await api.patch(`/appointments/${a.id}`, { status }); await reloadAll(); toast(`Appointment ${status}`); } catch (e) { toast(e.message); } };
  const data = tab === 'coach' ? coaches : provs;
  const rate = (x) => (x.hourly_rate_cents ? `${money(x.hourly_rate_cents)}/hr` : 'Rate on request');

  return (
    <Screen wide>
      <Head eyebrow="HIRE" title="Build your team around you" sub="Book a coach or trainer, a physio or a doctor." />
      <View style={{ marginTop: 14 }}><Seg options={[{ value: 'coach', label: 'Coaches & trainers' }, { value: 'med', label: 'Physios & doctors' }, { value: 'mine', label: 'My bookings' }]} value={tab} onChange={setTab} /></View>

      {tab !== 'mine' ? (
        data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> : data.loading && !data.data ? <Loading /> : !data.data?.length ? (
          <View style={{ marginTop: 14 }}><Empty emoji="🧑‍🏫" title="Nobody listed yet" sub="Coaches and clinicians appear here once they add a sport profile." /></View>
        ) : (
          <Grid>
            {data.data.map((x, n) => {
              const tone = toneFor(x.sport ?? x.sport_slug);
              return (
                <View key={`${x.id}${n}`} style={{ width: w }}>
                  <Card pad={14}>
                    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                      <Avatar user={x} size={48} />
                      <View style={{ flex: 1, gap: 3 }}>
                        <T weight="800" size={15}>{x.display_name}</T>
                        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                          <Pill label={`${x.sport_emoji} ${x.sport}`} fg={tone[2]} bg={tone[1]} /><Pill label={nice(x.provider_role ?? 'coach').toUpperCase()} />
                        </View>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                      <View><T weight="800" size={15}>{rate(x)}</T><T size={12} color={c.mute}>{[nice(x.level), x.experience_years ? `${x.experience_years} yrs` : null].filter(Boolean).join(' · ')}</T></View>
                      <Btn small title="Book" onPress={() => setBook({ x, med: tab === 'med' })} />
                    </View>
                  </Card>
                </View>
              );
            })}
          </Grid>
        )
      ) : (
        <View style={{ gap: 10, marginTop: 14 }}>
          {!hires.data?.length && !appts.data?.length ? <Empty emoji="🗓️" title="No bookings yet" sub="Book a coach or clinician and it shows up here." /> : null}
          {(hires.data ?? []).map((h) => (
            <Card key={h.id} pad={14}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <T weight="800" size={15}>{h.i_am_coach ? `Session with ${h.hirer_name}` : `Coaching with ${h.coach_name}`}</T>
                  <T size={12} color={c.mute}>{h.sport_emoji} {h.sport} · {when(h.starts_at)} · {h.duration_min} min · {money(h.total_cents)}</T>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  <StatusPill s={h.status} />
                  {h.payment_status === 'unpaid' && h.status !== 'cancelled' ? <StatusPill s="unpaid" /> : h.payment_status === 'paid' ? <StatusPill s="paid" /> : null}
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {h.i_am_hirer && h.payment_status === 'unpaid' && h.status !== 'cancelled' ? <Btn small title={`Pay ${money(h.total_cents)}`} onPress={() => setPaying({ type: 'coach_hire', id: h.id, amount: h.total_cents, label: `Coaching · ${h.coach_name}` })} /> : null}
                    {h.i_am_coach && h.status === 'requested' && h.payment_status !== 'unpaid' ? <Btn small title="Confirm" onPress={() => setHire(h, 'confirmed')} /> : null}
                    {h.i_am_coach && h.status === 'confirmed' ? <Btn small title="Complete" onPress={() => setHire(h, 'completed')} /> : null}
                    {['requested', 'confirmed'].includes(h.status) ? <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => setHire(h, 'cancelled')} /> : null}
                  </View>
                </View>
              </View>
            </Card>
          ))}
          {(appts.data ?? []).map((a) => (
            <Card key={a.id} pad={14}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <View style={{ flex: 1 }}><T weight="800" size={15}>Appointment · {a.provider_name}</T><T size={12} color={c.mute}>{when(a.starts_at)} · {a.duration_min} min{a.reason ? ` · ${a.reason}` : ''}</T></View>
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  <StatusPill s={a.status} />
                  {['requested', 'confirmed'].includes(a.status) ? <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => setAppt(a, 'cancelled')} /> : null}
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}

      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={reloadAll} /> : null}
      {book ? (
        <FormSheet visible onClose={() => setBook(null)} title={`Book ${book.x.display_name}`} submitLabel="Request booking"
          fields={[
            { key: 'when', label: 'When (2026-11-02 17:30)' }, { key: 'duration_min', label: 'Minutes', type: 'number', optional: true },
            { key: 'note', label: book.med ? 'Reason (encrypted)' : 'What do you want to work on?', optional: true, type: 'multiline' },
          ]}
          onSubmit={async ({ when: w2, duration_min, note }) => {
            const base = { starts_at: parseWhen(w2), duration_min: duration_min ?? (book.med ? 30 : 60) };
            if (book.med) await api.post('/appointments', { provider_id: book.x.id, ...base, reason: note });
            let hire = null;
            if (!book.med) hire = await api.post('/hires', { coach_id: book.x.id, sport: book.x.sport_slug, ...base, note });
            await reloadAll(); setTab('mine');
            if (hire?.payment_status === 'unpaid') setPaying({ type: 'coach_hire', id: hire.id, amount: hire.total_cents, label: `Coaching · ${book.x.display_name}` });
            return hire?.payment_status === 'unpaid' ? 'Request sent — pay to let the coach confirm' : 'Request sent — waiting for confirmation';
          }} />
      ) : null}
    </Screen>
  );
}

// ======================= INSURE =======================

export function Insure() {
  const { toast } = useSession();
  const { w } = useCols();
  const plans = useLoad(() => api.get('/insurance/plans', { cover_for: 'individual' }), []);
  const pol = useLoad(() => api.get('/insurance/policies', { limit: 30 }), []);
  const [buy, setBuy] = useState(null);
  const [paying, setPaying] = useState(null);
  const active = (pol.data ?? []).filter((p) => p.effective_status === 'active');
  const covered = new Set(active.map((p) => p.plan_id));

  return (
    <Screen wide>
      <Head eyebrow="INSURE" title="Play protected" sub="Personal accident and injury cover for training and match days." />
      {plans.error ? <ErrorBox error={plans.error} onRetry={plans.reload} /> : plans.loading && !plans.data ? <Loading /> : !plans.data?.length ? (
        <View style={{ marginTop: 14 }}><Empty emoji="🛡️" title="No plans published yet" /></View>
      ) : (
        <Grid>
          {plans.data.map((p, n) => {
            const tone = toneFor(p.name);
            return (
              <View key={p.id} style={{ width: w }}>
                <Card pad={16}>
                  <View style={{ gap: 10 }}>
                    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                      <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: tone[1], alignItems: 'center', justifyContent: 'center' }}><T size={26}>{p.emoji}</T></View>
                      <View style={{ flex: 1 }}><T weight="800" size={16}>{p.name}</T><T size={12} color={c.mute} weight="600">{p.insurer}</T></View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <View style={{ flex: 1, backgroundColor: tone[1], borderRadius: 14, padding: 10 }}><T weight="800" size={18} color={tone[2]}>{money(p.coverage_cents)}</T><T size={11} color={c.mute} weight="700">COVER</T></View>
                      <View style={{ flex: 1, backgroundColor: c.bg, borderRadius: 14, padding: 10 }}><T weight="800" size={18}>{money(p.premium_cents)}</T><T size={11} color={c.mute} weight="700">PER MONTH</T></View>
                    </View>
                    {p.description ? <T size={13} color={c.mute}>{p.description}</T> : null}
                    {covered.has(p.id) ? <Pill label="✓ YOU'RE COVERED" fg={c.lime} bg={c.limeSoft} /> : <Btn small title="Get covered" onPress={() => setBuy(p)} style={{ alignSelf: 'flex-start' }} />}
                  </View>
                </Card>
              </View>
            );
          })}
        </Grid>
      )}

      <H2 style={{ marginTop: 28 }}>My policies</H2>
      <View style={{ gap: 10, marginTop: 10 }}>
        {!pol.data?.length ? <T size={13} color={c.mute}>No policies yet.</T> : pol.data.map((p) => (
          <Card key={p.id} pad={12}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <T size={26}>{p.emoji}</T>
              <View style={{ flex: 1 }}><T weight="700" size={14}>{p.plan_name}</T><T size={12} color={c.mute}>{p.policy_no} · until {day(p.ends_on + 'T12:00:00')} · cover {money(p.coverage_cents)}</T></View>
              <View style={{ alignItems: 'flex-end', gap: 6 }}><StatusPill s={p.effective_status === 'expired' ? 'completed' : p.effective_status} />{p.status === 'pending_payment' ? <Btn small title="Pay now" onPress={() => setPaying({ type: 'insurance_policy', id: p.id, amount: p.amount_cents, label: p.plan_name })} /> : null}</View>
            </View>
          </Card>
        ))}
        <T size={12} color={c.mute}>Need to file a claim or cover a team or event? Open Ecosystem → Insurance.</T>
      </View>

      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={pol.reload} /> : null}
      {buy ? (
        <FormSheet visible onClose={() => setBuy(null)} title={`Cover with ${buy.name}`} submitLabel="Buy policy"
          initial={{ months: 12 }}
          fields={[{ key: 'months', label: `Months (${money(buy.premium_cents)} each)`, type: 'number' }, { key: 'beneficiary', label: 'Beneficiary (encrypted)', optional: true }]}
          onSubmit={async (v) => { const p = await api.post('/insurance/policies', { plan_id: buy.id, ...v }); await pol.reload(); if (p.status === 'pending_payment') { setPaying({ type: 'insurance_policy', id: p.id, amount: p.premium_cents, label: buy.name }); return 'Policy created — pay to activate it'; } return `You're covered — ${money(p.premium_cents)} for ${v.months} months`; }} />
      ) : null}
    </Screen>
  );
}
