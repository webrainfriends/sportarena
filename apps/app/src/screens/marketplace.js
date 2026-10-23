import React, { useState } from 'react';
import { Linking, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Screen, Seg, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { NewCaseSheet } from './cases';
import { c, toneFor, money, when, day } from '../theme';
import { InsuranceMarket } from './insurer';
import { QuoteRequestSheet } from './insurance';

export const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const parseWhen = (s) => { const d = new Date(String(s).trim().replace(' ', 'T')); if (isNaN(d)) throw new Error('Use the format 2026-11-02 17:30'); return d.toISOString(); };

export function useCols(max = 1120) {
  const { width } = useWindowDimensions();
  const inner = Math.min(width, max) - 32;
  const cols = inner >= 980 ? 3 : inner >= 620 ? 2 : 1;
  const gap = 14;
  return { cols, gap, w: cols === 1 ? '100%' : Math.floor((inner - gap * (cols - 1)) / cols) };
}

export const Pill = ({ label, fg = c.mute, bg = c.violetSoft }) => (
  <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' }}>
    <T weight="700" size={11} color={fg} style={{ letterSpacing: 0.3 }}>{label}</T>
  </View>
);
const STATUS = { expired: [c.mute, c.violetSoft], awaiting_payment: [c.sun, c.sunSoft], pending_payment: [c.sun, c.sunSoft], unpaid: [c.sun, c.sunSoft], paid: [c.lime, c.limeSoft], refunded: [c.mute, c.violetSoft], pending: [c.sun, c.sunSoft], accepted: [c.lime, c.limeSoft], declined: [c.red, c.redSoft], requested: [c.sun, c.sunSoft], confirmed: [c.lime, c.limeSoft], completed: [c.mute, c.violetSoft], cancelled: [c.red, c.redSoft], placed: [c.sun, c.sunSoft], shipped: [c.cyan, c.cyanSoft], delivered: [c.lime, c.limeSoft], active: [c.lime, c.limeSoft], open: [c.lime, c.limeSoft], filled: [c.mute, c.violetSoft], pay_direct: [c.mute, c.violetSoft], proposed: [c.sun, c.sunSoft] };
export const StatusPill = ({ s }) => <Pill label={nice(s).toUpperCase()} fg={(STATUS[s] ?? [c.mute])[0]} bg={(STATUS[s] ?? [0, c.violetSoft])[1]} />;

/** Hosted checkout: pick Stripe or PayPal, go to the provider, then confirm. Card details never touch Gotmygame. */
export function PaySheet({ target, onClose, onDone }) {
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
          <T size={12} color={c.mute}>You'll be taken to the provider's secure page. Your card details never reach Gotmygame.</T>
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


export const Grid = ({ children }) => {
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
            <Avatar user={{ avatar_emoji: p.author_emoji, avatar_color: p.author_color, avatar_url: p.author_avatar_url, handle: p.author_handle }} size={26} />
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
  const { push } = useNav();
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
            <T size={13} color={c.mute} style={{ marginTop: 2 }}>{[d.amount_cents ? (d.currency ? `${d.currency} ${(d.amount_cents / 100).toLocaleString()}` : money(d.amount_cents)) : null, d.in_kind].filter(Boolean).join(' + ') || 'Support offered'}{d.starts_on ? ` · ${day(d.starts_on)} to ${d.ends_on ? day(d.ends_on) : 'open'}` : ''}</T>
            {d.deliverables ? <T size={12} style={{ marginTop: 4 }}><T size={12} weight="800">They expect: </T>{d.deliverables}</T> : null}
            {d.message ? <T size={12} color={c.mute}>“{d.message}”</T> : null}
            <T size={11} color={c.mute} style={{ marginTop: 4 }}>Accepted deals stay private unless you choose to show them (Ecosystem → Sponsors).</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>{d.agreement_ref ? <Btn small title="Review terms & negotiate" color={c.violet} onPress={() => push('SponsorDeal', { id: d.id })} /> : null}{d.agreement_ref ? null : <Btn small title="Accept" onPress={() => decide(d, 'active')} />}<Btn small title="Decline" color={c.paper} onPress={() => decide(d, 'declined')} /></View>
          </Card>
        ))}
      </View>
    </View>
  );
}

const FILTERS = [['all', 'All'], ['match_players', 'Matches'], ['team_recruiting', 'Teams'], ['sponsor', 'Sponsorship'], ['events', 'Events'], ['insurance', 'Insurance'], ['mine', 'My posts']];

export function Billboard() {
  const { has, toast } = useSession();
  const { w } = useCols();
  const [f, setF] = useState('all');
  const [post, setPost] = useState(false);
  const [resp, setResp] = useState(null);
  const [quote, setQuote] = useState(null);
  const q = f === 'mine' ? { mine: true, include_closed: true } : f === 'match_players' || f === 'team_recruiting' ? { kind: f } : {};
  const posts = useLoad(() => (f === 'events' || f === 'insurance' ? Promise.resolve([]) : api.get('/billboard', { ...q, limit: 50 })), [f]);
  const events = useLoad(() => (f === 'all' || f === 'events' ? api.get('/events', { status: 'open', limit: 20 }) : Promise.resolve([])), [f]);
  const list = (posts.data ?? []).filter((p) => (f === 'sponsor' ? p.kind.startsWith('sponsor') : true));
  const join = async (e) => { try { await api.post(`/events/${e.id}/entries`, {}); toast(`Registered for ${e.name} — awaiting approval`); } catch (x) { toast(x.message); } };
  const loading = (posts.loading && !posts.data) || (events.loading && !events.data);
  const empty = !loading && !list.length && !(events.data ?? []).length && f !== 'insurance';

  return (
    <Screen wide>
      <Head eyebrow="BILLBOARD" title="Who's looking for you" sub="Matches needing players, teams recruiting, sponsors and open events — all in one place."
        right={<Btn small title="+ Post a need" onPress={() => setPost(true)} />} />
      <View style={{ marginTop: 14 }}><Seg options={FILTERS.map(([value, label]) => ({ value, label }))} value={f} onChange={setF} /></View>
      {f === 'all' || f === 'sponsor' ? <SponsorInbox /> : null}
      {f === 'insurance' ? <View style={{ marginTop: 14, gap: 10 }}><InsuranceMarket onAsk={() => setQuote({})} /></View> : posts.error ? <ErrorBox error={posts.error} onRetry={posts.reload} /> : loading ? <Loading /> : empty ? (
        <View style={{ marginTop: 14 }}><Empty emoji="📣" title="Nothing here yet" sub="Be the first — post that you need players, a team, or a sponsor." /></View>
      ) : (
        <Grid>
          {list.map((p) => <PostCard key={p.id} p={p} width={w} onRespond={() => setResp(p)} onChanged={posts.reload} />)}
          {(events.data ?? []).map((e) => <EventCard key={e.id} e={e} width={w} onJoin={() => join(e)} />)}
        </Grid>
      )}

      <QuoteRequestSheet target={quote} onClose={() => setQuote(null)} onDone={() => setQuote(null)} />
      {post ? (
        <FormSheet visible onClose={() => setPost(false)} title="Post on the billboard" submitLabel="Post"
          fields={[
            { key: 'kind', label: 'What do you need?', type: 'choice', options: [{ value: 'match_players', label: 'Players for a match' }, { value: 'team_recruiting', label: 'Players for my team' }, { value: 'sponsorship_wanted', label: 'A sponsor' }, ...(has('sponsor') ? [{ value: 'sponsor_call', label: 'Athletes (as sponsor)' }] : [])] },
            { key: 'title', label: 'Headline', placeholder: 'Need 2 players for Sunday 7-a-side' },
            { key: 'body', label: 'Details', optional: true, type: 'multiline' },
            { key: 'sport', label: 'Sport', type: 'sport', optional: true },
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

// ======================= INSURE =======================

const VIA = [['athlete', 'As an athlete'], ['team', 'Via team'], ['event', 'Via event'], ['venue', 'Via venue']];
const routeLabel = ({ via, capacity }, p) => (via === 'athlete' ? 'COVERED AS AN ATHLETE' : `${via.toUpperCase()}: ${p.subject_name ?? ''} · ${nice(capacity)}`.toUpperCase());

export function Insure() {
  const { toast, user } = useSession();
  const { push } = useNav();
  const { w } = useCols();
  const plans = useLoad(() => api.get('/insurance/plans', { cover_for: 'individual' }), []);
  const pol = useLoad(() => api.get('/insurance/policies', { limit: 30 }), []);
  const cov = useLoad(() => api.get('/insurance/policies', { covering_me: true, limit: 50 }), []);
  const [buy, setBuy] = useState(null);
  const [paying, setPaying] = useState(null);
  const active = (pol.data ?? []).filter((p) => p.effective_status === 'active' && p.subject_type === 'individual');
  const covered = new Set(active.map((p) => p.plan_id));
  // One list: what protects me (athlete / team / event / venue, from covering_me) plus what I hold or manage (pay, renew), each policy once.
  const byId = new Map();
  for (const p of cov.data ?? []) byId.set(p.id, { ...p, routes: p.covered_via });
  for (const p of pol.data ?? []) byId.set(p.id, { ...(byId.get(p.id) ?? {}), ...p, routes: byId.get(p.id)?.routes ?? [{ via: p.subject_type === 'individual' ? 'athlete' : p.subject_type, capacity: p.subject_type === 'individual' ? 'athlete' : 'manager' }] });
  const rows = [...byId.values()];

  return (
    <Screen wide>
      <Head eyebrow="INSURE" title="Play protected" sub="Personal accident and injury cover for training and match days." />
      {user?.roles?.includes('insurer') ? (
        <Card color={c.cyanSoft} pad={14} style={{ marginTop: 14 }}>
          <T weight="900" size={16}>You are an insurer too</T>
          <T size={13} color={c.mute}>Publish your plans (they are listed on the Billboard and can be shared to the community) and answer quote requests from players, teams, venues and events.</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <Btn small title="Create a plan" onPress={() => push('InsurerDesk', { tab: 'plans' })} />
            <Btn small title="Answer requests" color={c.paper} ink={c.ink} onPress={() => push('InsurerDesk', { tab: 'requests' })} />
          </View>
        </Card>
      ) : null}
      {plans.error ? <ErrorBox error={plans.error} onRetry={plans.reload} /> : plans.loading && !plans.data ? <Loading /> : !plans.data?.length ? (
        <View style={{ marginTop: 14 }}><Empty emoji="🛡️" title="No plans published yet" sub="Insurers publish their plans here as soon as they are on sale." /></View>
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
                    {p.exclusions ? <T size={12} color={c.mute}>Not covered: {p.exclusions}</T> : null}
                    {covered.has(p.id) ? <Pill label="✓ YOU'RE COVERED" fg={c.lime} bg={c.limeSoft} /> : <Btn small title="Get covered" onPress={() => setBuy(p)} style={{ alignSelf: 'flex-start' }} />}
                  </View>
                </Card>
              </View>
            );
          })}
        </Grid>
      )}

      <H2 style={{ marginTop: 28 }}>My cover</H2>
      <T size={13} color={c.mute}>Everything that protects you: your own policies as an athlete, and the team, event and venue cover you are part of as a player, physio, doctor, official or sponsor.</T>
      {pol.error || cov.error ? <ErrorBox error={pol.error ?? cov.error} onRetry={() => { pol.reload(); cov.reload(); }} /> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {VIA.map(([k, label]) => <Pill key={k} label={`${label}: ${rows.filter((r) => r.routes.some((x) => x.via === k)).length}`} fg={rows.some((r) => r.routes.some((x) => x.via === k)) ? c.lime : c.mute} bg={rows.some((r) => r.routes.some((x) => x.via === k)) ? c.limeSoft : c.violetSoft} />)}
      </View>
      <View style={{ gap: 10, marginTop: 10 }}>
        {!rows.length ? <T size={13} color={c.mute}>Nothing covers you yet. Get a plan above, or ask your team or event organiser to insure the squad or the event.</T> : rows.map((p) => (
          <Card key={p.id} pad={12}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <T size={26}>{p.emoji}</T>
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="700" size={14}>{p.plan_name}</T>
                <T size={12} color={c.mute}>{p.policy_no ? `${p.policy_no} · ` : ''}until {p.ends_on ? day(`${String(p.ends_on).slice(0, 10)}T12:00:00`) : '—'} · cover {money(p.coverage_cents)}</T>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  {p.routes.map((x, n) => <Pill key={n} label={routeLabel(x, p)} fg={c.violet} bg={c.violetSoft} />)}
                  {p.held_by_me || p.holder_id === user?.id ? <Pill label="HELD BY YOU" fg={c.mute} bg={c.bg} /> : null}
                </View>
              </View>
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
