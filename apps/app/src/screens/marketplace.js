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
import { TenderZone } from './tender-zone';
import { QuoteRequestSheet } from './insurance';
import { whoForFields, whoForInitial, whoForBody } from '../who-for';
import { SECTION_OPTIONS, SECTION_LABEL, TYPE_LABEL, UNIT, closing, payLine, say } from '../opportunity';

export const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const at = (date, time = '00:00') => new Date(`${date}T${time}:00`).toISOString();

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
      <T size={14} color={c.mute}>{target.label} · <T weight="800" size={14}>{money(target.amount, target.currency ?? m?.currency)}</T>{(target.currency ?? m?.currency) ? ` (${target.currency ?? m.currency})` : ''}</T>
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
  coach_wanted: ['Coach wanted', c.cyan, c.cyanSoft, 'Apply to coach'],
  assignment: ['Work & volunteering', c.violet, c.violetSoft, 'Apply'],
  service_request: ['Service wanted', c.mint, c.mintSoft, 'Offer my service'],
};

const PIPELINE_KINDS = ['match_players', 'team_recruiting', 'coach_wanted', 'assignment'];

function PostResponses({ post, onChanged }) {
  const { push } = useNav();
  const { toast } = useSession();
  const r = useLoad(() => api.get(`/billboard/${post.id}/responses`), [post.id]);
  const decide = async (x, status) => { try { await api.patch(`/billboard/responses/${x.response_id}`, { status }); await r.reload(); onChanged(); toast(status === 'accepted' ? 'Accepted' : 'Declined'); } catch (e) { toast(e.message); } };
  if (r.loading && !r.data) return <Loading />;
  if (!r.data?.length) return <T size={13} color={c.mute}>No responses yet.</T>;
  // player and coach posts run as a recruitment pipeline: shortlist, trial, evaluation, versioned offer
  if (PIPELINE_KINDS.includes(post.kind)) return <Btn small title={`Open recruitment pipeline (${r.data.length})`} onPress={() => push('RecruitmentPipeline', { id: post.id })} />;
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

function PostCard({ p, width, onRespond, onChanged, onReport }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const [label, fg, bg, cta] = KIND[p.kind];
  const meta = [p.sport && `${p.sport_emoji} ${p.sport}`, p.city, p.starts_at && when(p.starts_at)].filter(Boolean).join(' · ');
  const closes = closing(p);
  const canApply = p.status === 'open' && !p.is_expired;
  const paid = p.compensation === 'paid';
  return (
    <View style={{ width }}>
      <Card pad={16}>
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', flex: 1 }}>
              <Pill label={label.toUpperCase()} fg={fg} bg={bg} />
              {p.opportunity_type && TYPE_LABEL[p.opportunity_type] !== label ? <Pill label={TYPE_LABEL[p.opportunity_type].toUpperCase()} fg={c.ink} bg={c.bg} /> : null}
            </View>
            {p.status !== 'open' ? <StatusPill s={p.status} /> : p.is_expired ? <StatusPill s="closed" /> : p.kind !== 'sponsorship_wanted' && p.kind !== 'sponsor_call' ? <T size={12} color={c.mute} weight="700">{p.accepted}/{p.positions_needed} filled</T> : null}
          </View>
          <T weight="800" size={17} style={{ letterSpacing: -0.2 }}>{p.title}</T>
          {meta ? <T size={13} color={c.mute} weight="600">{meta}</T> : null}
          <View accessible accessibilityLabel={`Pay: ${payLine(p)}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <View style={{ backgroundColor: paid ? c.limeSoft : c.bg, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 }}><T size={13} weight="800" color={c.ink}>{payLine(p)}</T></View>
            {closes ? <T size={12} weight="700" color={p.is_expired ? c.red : c.mute}>{closes}</T> : null}
          </View>
          {p.body ? <T size={14} color={c.ink} style={{ lineHeight: 20 }}>{p.body}</T> : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Avatar user={{ avatar_emoji: p.author_emoji, avatar_color: p.author_color, avatar_url: p.author_avatar_url, handle: p.author_handle }} size={26} />
            <T size={13} color={c.mute} weight="600">{p.team_name ? `${p.team_emoji} ${p.team_name} · ` : ''}{p.author_name}</T>
            {p.publisher_verified ? <Pill label="✓ VERIFIED" fg={c.ink} bg={c.limeSoft} /> : null}
          </View>
          {!p.publisher_verified && !p.is_mine && (paid || p.opportunity_type === 'sponsorship') ? <T size={12} color={c.mute}>This publisher is not verified. Never pay to apply, and check the details before you share anything.</T> : null}
          {p.verified_applicants_only ? <T size={12} color={c.mute}>Only verified applicants can apply.</T> : null}
          {p.required_sections?.length ? <T size={12} color={c.mute}>You will share: {p.required_sections.map((x) => SECTION_LABEL[x]).join(', ')}</T> : null}
          {p.is_mine ? (
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn small title={open ? 'Hide responses' : 'View responses'} color={c.paper} onPress={() => setOpen(!open)} />
                {p.status === 'open' ? <Btn small title="Take down" color={c.paper} ink={c.red} onPress={async () => { try { await api.post(`/billboard/${p.id}/close`); onChanged(); toast('Post closed'); } catch (e) { toast(e.message); } }} /> : null}
              </View>
              {open ? <PostResponses post={p} onChanged={onChanged} /> : null}
            </View>
          ) : p.my_response ? <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T size={13} color={c.mute} weight="600">Your response:</T><StatusPill s={p.my_response} /></View>
            : canApply ? <Btn small title={cta} onPress={onRespond} style={{ alignSelf: 'flex-start' }} /> : null}
          {!p.is_mine ? <Pressable accessibilityRole="button" accessibilityLabel="Report this post" onPress={onReport} style={{ alignSelf: 'flex-start', minHeight: 44, minWidth: 44, justifyContent: 'center' }}><T size={13} color={c.mute} weight="700">⚑ Report this post</T></Pressable> : null}
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
          <T size={13} color={c.mute} weight="600">{[`${e.sport_emoji} ${e.sport}`, nice(e.kind), e.starts_on && day(e.starts_on + 'T12:00:00'), `${e.entrants} entered`, e.entry_fee_cents ? `Entry ${money(e.entry_fee_cents, e.currency)}` : null].filter(Boolean).join(' · ')}</T>
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
            <T size={13} color={c.mute} style={{ marginTop: 2 }}>{[d.amount_cents ? money(d.amount_cents, d.currency) : null, d.in_kind].filter(Boolean).join(' + ') || 'Support offered'}{d.starts_on ? ` · ${day(d.starts_on)} to ${d.ends_on ? day(d.ends_on) : 'open'}` : ''}</T>
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

const FILTERS = [['all', 'All'], ['match_players', 'Matches'], ['team_recruiting', 'Teams'], ['assignment', 'Work & volunteering'], ['trial', 'Trials'], ['sponsor', 'Sponsorship'], ['events', 'Events'], ['insurance', 'Insurance'], ['tender', 'Tender zone'], ['mine', 'My posts']];
const ROLE_OPTIONS = [['volunteer', 'Volunteer'], ['referee', 'Referee'], ['umpire', 'Umpire'], ['linesman', 'Assistant referee'], ['physio', 'Physio']].map(([value, label]) => ({ value, label }));
const PAY_OPTIONS = [['paid', 'Paid'], ['unpaid', 'Unpaid'], ['expenses', 'Expenses only'], ['in_kind', 'In-kind reward']].map(([value, label]) => ({ value, label }));
const isSponsorKind = (k) => k === 'sponsorship_wanted' || k === 'sponsor_call';

/** Post an opportunity: type, pay, dates, who may apply and what they must share, each with the control that fits the answer. */
function PostSheet({ onClose, onDone }) {
  const { has, user } = useSession();
  const teams = useLoad(() => api.get('/teams', { mine: true, limit: 50 }), []);
  const events = useLoad(() => api.get('/events', { organizer_id: user.id, limit: 50 }), []);
  const today = new Date().toISOString().slice(0, 10);
  const team = (teams.data ?? []).map((t) => ({ id: t.id, label: t.name, sub: t.sport ?? '', emoji: t.emoji }));
  const evs = (events.data ?? []).map((e) => ({ id: e.id, label: e.name, sub: e.starts_on ? day(`${String(e.starts_on).slice(0, 10)}T12:00:00`) : '', emoji: e.sport_emoji }));
  const kinds = [{ value: 'team_recruiting', label: 'Players for my team' }, { value: 'assignment', label: 'Work or volunteers' }, { value: 'sponsorship_wanted', label: 'A sponsor' }, ...(has('sponsor') ? [{ value: 'sponsor_call', label: 'Athletes (as sponsor)' }] : [])];
  const player = (v) => ['match_players', 'team_recruiting'].includes(v.kind);
  const paidAssignment = (v) => v.kind === 'assignment' && v.opportunity_type === 'paid_assignment';
  const showAmount = (v) => isSponsorKind(v.kind) || v.compensation === 'paid' || paidAssignment(v);
  return (
    <FormSheet visible onClose={onClose} title="Post an opportunity" submitLabel="Post"
      initial={{ kind: 'team_recruiting', opportunity_type: 'volunteering', positions_needed: 1, role: 'volunteer', required_sections: [], ...whoForInitial() }}
      fields={[
        { key: 'kind', label: 'What do you need?', type: 'chips', options: kinds },
        { key: 'opportunity_type', label: 'What kind of work is it?', type: 'chips', options: [{ value: 'volunteering', label: 'Volunteering' }, { value: 'paid_assignment', label: 'Paid assignment' }], show: (v) => v.kind === 'assignment' },
        { key: 'is_trial', label: 'This is a trial', type: 'switch', hint: 'Applicants are told they are trying out, not being hired.', show: player },
        { key: 'title', label: 'Headline', placeholder: 'Need 2 scorers for Sunday’s final' },
        { key: 'body', label: 'Details', optional: true, type: 'multiline' },
        { key: 'sport', label: 'Sport', type: 'sport', optional: true },
        { key: 'city', label: 'City or area', type: 'region', optional: true },
        { key: 'start_date', label: 'Starts on', type: 'date', optional: true, min: today },
        { key: 'start_time', label: 'Start time', type: 'time', optional: true, show: (v) => !!v.start_date },
        { key: 'end_date', label: 'Ends on', type: 'date', optional: true, min: today, show: (v) => !!v.start_date },
        { key: 'close_date', label: 'Applications close on', type: 'date', optional: true, min: today, hint: 'After this day nobody can apply. Leave empty to keep it open until you take it down.' },
        { key: 'positions_needed', label: 'How many people?', type: 'stepper', min: 1, max: 200 },
        { key: 'compensation', label: 'Pay', type: 'chips', optional: true, hint: 'Applicants always see this. If you leave it empty they see "Pay not stated".',
          options: (v) => (v.kind === 'assignment' ? PAY_OPTIONS.filter((o) => o.value !== 'paid') : PAY_OPTIONS), show: (v) => !isSponsorKind(v.kind) && !paidAssignment(v) },
        { key: 'currency', label: 'Currency', type: 'currency', show: showAmount },
        { key: 'budget', label: 'Amount', type: 'money', currency: (v) => v.currency, show: showAmount },
        { key: 'rate_unit', label: 'Paid', type: 'chips', optional: true, options: Object.entries(UNIT).map(([value, label]) => ({ value, label })), show: (v) => v.kind === 'team_recruiting' && v.compensation === 'paid' },
        { key: 'team_id', label: 'Team that pays or hosts', type: 'entity', entityKind: 'team', noun: 'team', optional: true, options: team, show: (v) => paidAssignment(v) || v.kind === 'team_recruiting' },
        { key: 'target_id', label: 'Event this is for', type: 'entity', entityKind: 'team', noun: 'event', optional: true, options: evs, show: (v) => v.kind === 'assignment', hint: 'Accepted people are added to the event with the role below.' },
        { key: 'target_role', label: 'Their role', type: 'chips', options: ROLE_OPTIONS, show: (v) => v.kind === 'assignment' && !!v.target_id },
        { key: '_apply', type: 'section', label: 'Who can apply' },
        { key: 'required_sections', label: 'Applicants must share', type: 'multi', options: SECTION_OPTIONS, optional: true, hint: 'From their player passport. They choose to share it; you only see what they allow.' },
        { key: 'verified_applicants_only', label: 'Verified applicants only', type: 'switch' },
        ...whoForFields({ positions: true, region: true }).map((f) => ({ ...f, show: (v) => (f.show ? f.show(v) : true) && player(v) })),
      ]}
      onSubmit={async (v) => {
        const sponsor = isSponsorKind(v.kind);
        const type = v.kind === 'assignment' ? v.opportunity_type : v.is_trial && player(v) ? 'trial' : undefined;
        const when = v.start_date ? at(v.start_date, v.start_time || '09:00') : undefined;
        const body = {
          kind: v.kind, title: v.title, body: v.body, sport: v.sport, city: v.city, positions_needed: v.positions_needed, opportunity_type: type,
          starts_at: when, ends_at: v.end_date ? at(v.end_date, '23:59') : undefined, closes_at: v.close_date ? at(v.close_date, '23:59') : undefined,
          compensation: sponsor ? undefined : paidAssignment(v) ? 'paid' : v.compensation, budget_cents: showAmount(v) ? v.budget : undefined, currency: showAmount(v) && v.budget !== undefined ? v.currency : undefined,
          rate_unit: v.kind === 'team_recruiting' && v.compensation === 'paid' ? v.rate_unit : undefined, team_id: v.team_id,
          target_type: v.target_id ? 'event' : undefined, target_id: v.target_id, target_role: v.target_id ? v.target_role ?? 'volunteer' : undefined,
          required_sections: v.required_sections ?? [], verified_applicants_only: !!v.verified_applicants_only,
          ...(player(v) ? whoForBody(v) : {}),
        };
        await api.post('/billboard', body);
        await onDone();
        return 'Posted';
      }} />
  );
}

/** Apply: sees the pay and what is asked first, then picks exactly which passport sections to share. */
function ApplySheet({ post, onClose, onDone }) {
  const { toast } = useSession();
  const [label] = KIND[post.kind];
  const pipeline = PIPELINE_KINDS.includes(post.kind);
  const required = post.required_sections ?? [];
  return (
    <FormSheet visible onClose={onClose} title={KIND[post.kind][3]} submitLabel="Send application"
      initial={{ shared_sections: required }}
      fields={[
        { key: '_terms', type: 'section', label: `${post.title} · ${payLine(post)}` },
        { key: 'message', label: 'Message', optional: true, type: 'multiline', placeholder: 'Position, experience, availability…' },
        ...(pipeline ? [
          { key: 'shared_sections', label: 'Share from my player passport', type: 'multi', optional: !required.length, options: SECTION_OPTIONS, hint: required.length ? `${required.map((x) => SECTION_LABEL[x]).join(', ')} required for this post. You can change what you share until a decision is made.` : 'Only the people running this post can see what you pick, and every view is logged. You can change it later.' },
          { key: 'source_kind', label: 'Evidence link', type: 'chips', optional: true, options: [{ value: 'passport', label: 'Player passport' }, { value: 'video', label: 'Highlights video' }, { value: 'profile', label: 'Profile' }, { value: 'other', label: 'Other' }] },
          { key: 'source_url', label: 'Link', optional: true, placeholder: 'https://…', input: 'url', hint: 'Only staff running this post can open it, and every open is logged.', show: (x) => !!x.source_kind },
        ] : []),
      ]}
      onSubmit={async (v) => {
        try {
          await api.post(`/billboard/${post.id}/responses`, { message: v.message, shared_sections: v.shared_sections ?? [], source_kind: v.source_url ? v.source_kind : undefined, source_url: v.source_url || undefined, idempotency_key: `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` });
        } catch (e) { throw new Error(say(e)); }
        await onDone();
        return 'Application sent';
      }} />
  );
}

export function Billboard() {
  const { toast } = useSession();
  const { push } = useNav();
  const { w } = useCols();
  const [f, setF] = useState('all');
  const [paidOnly, setPaidOnly] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [post, setPost] = useState(false);
  const [resp, setResp] = useState(null);
  const [report, setReport] = useState(null);
  const [quote, setQuote] = useState(null);
  const q = { ...(f === 'mine' ? { mine: true, include_closed: true } : f === 'match_players' || f === 'team_recruiting' || f === 'assignment' ? { kind: f } : f === 'trial' ? { opportunity_type: 'trial' } : {}), ...(paidOnly ? { paid: true } : {}), ...(verifiedOnly ? { verified_publisher: true } : {}) };
  const posts = useLoad(() => (f === 'events' || f === 'insurance' || f === 'tender' ? Promise.resolve([]) : api.get('/billboard', { ...q, limit: 50 })), [f, paidOnly, verifiedOnly]);
  const events = useLoad(() => (f === 'all' || f === 'events' ? api.get('/events', { status: 'open', limit: 20 }) : Promise.resolve([])), [f]);
  const list = (posts.data ?? []).filter((p) => (f === 'sponsor' ? p.kind.startsWith('sponsor') : true));
  const join = async (e) => { try { await api.post(`/events/${e.id}/entries`, {}); toast(`Registered for ${e.name} — awaiting approval`); } catch (x) { toast(x.message); } };
  const loading = (posts.loading && !posts.data) || (events.loading && !events.data);
  const empty = !loading && !list.length && !(events.data ?? []).length && f !== 'insurance' && f !== 'tender';
  const filtering = f !== 'events' && f !== 'insurance' && f !== 'tender';

  return (
    <Screen wide>
      <Head eyebrow="BILLBOARD" title="Who's looking for you" sub="Trials, matches, paid work, volunteering, sponsors and open events — with the pay stated up front."
        right={<View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="Find a game" color={c.paper} ink={c.ink} onPress={() => push('FindGames')} /><Btn small title="+ Post an opportunity" onPress={() => setPost(true)} /></View>} />
      <View style={{ marginTop: 14 }}><Seg options={FILTERS.map(([value, label]) => ({ value, label }))} value={f} onChange={setF} /></View>
      {filtering ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <Chip label="Paid only" active={paidOnly} onPress={() => setPaidOnly(!paidOnly)} />
          <Chip label="Verified publishers" active={verifiedOnly} onPress={() => setVerifiedOnly(!verifiedOnly)} />
        </View>
      ) : null}
      {f === 'match_players' ? (
        <Card color={c.cyanSoft} pad={14} style={{ marginTop: 12 }} onPress={() => push('FindGames')} accessibilityLabel="Open Find a game">
          <T weight="800">Need players for a match? Host a game instead.</T>
          <T size={13}>Games at a real venue with seats, a waitlist, level and cost. Older player posts stay listed below.</T>
        </Card>
      ) : null}
      {f === 'all' || f === 'sponsor' ? <SponsorInbox /> : null}
      {f === 'tender' ? <TenderZone embedded /> : f === 'insurance' ? <View style={{ marginTop: 14, gap: 10 }}><InsuranceMarket onAsk={() => setQuote({})} /></View> : posts.error ? <ErrorBox error={posts.error} onRetry={posts.reload} /> : loading ? <Loading /> : empty ? (
        <View style={{ marginTop: 14 }}><Empty emoji="📣" title={paidOnly || verifiedOnly ? 'Nothing matches those filters' : 'Nothing here yet'} sub={paidOnly || verifiedOnly ? 'Try clearing a filter.' : 'Be the first — post that you need players, helpers or a sponsor.'} /></View>
      ) : (
        <Grid>
          {list.map((p) => <PostCard key={p.id} p={p} width={w} onRespond={() => setResp(p)} onChanged={posts.reload} onReport={() => setReport(p)} />)}
          {(events.data ?? []).map((e) => <EventCard key={e.id} e={e} width={w} onJoin={() => join(e)} />)}
        </Grid>
      )}

      <QuoteRequestSheet target={quote} onClose={() => setQuote(null)} onDone={() => setQuote(null)} />
      {post ? <PostSheet onClose={() => setPost(false)} onDone={posts.reload} /> : null}
      {resp ? <ApplySheet post={resp} onClose={() => setResp(null)} onDone={posts.reload} /> : null}
      <NewCaseSheet visible={!!report} onClose={() => setReport(null)} kind="support" category="marketplace_report" links={report ? [{ type: 'billboard_post', id: report.id }] : []} />
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
                      <View style={{ flex: 1, backgroundColor: tone[1], borderRadius: 14, padding: 10 }}><T weight="800" size={18} color={tone[2]}>{money(p.coverage_cents, p.currency)}</T><T size={11} color={c.mute} weight="700">COVER</T></View>
                      <View style={{ flex: 1, backgroundColor: c.bg, borderRadius: 14, padding: 10 }}><T weight="800" size={18}>{money(p.premium_cents, p.currency)}</T><T size={11} color={c.mute} weight="700">PER MONTH</T></View>
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
                <T size={12} color={c.mute}>{p.policy_no ? `${p.policy_no} · ` : ''}until {p.ends_on ? day(`${String(p.ends_on).slice(0, 10)}T12:00:00`) : '—'} · cover {money(p.coverage_cents, p.currency)}</T>
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
          fields={[{ key: 'months', label: `Months (${money(buy.premium_cents, buy.currency)} each)`, type: 'number' }, { key: 'beneficiary', label: 'Beneficiary (encrypted)', optional: true }]}
          onSubmit={async (v) => { const p = await api.post('/insurance/policies', { plan_id: buy.id, ...v }); await pol.reload(); if (p.status === 'pending_payment') { setPaying({ type: 'insurance_policy', id: p.id, amount: p.premium_cents, label: buy.name }); return 'Policy created — pay to activate it'; } return `You're covered — ${money(p.premium_cents)} for ${v.months} months`; }} />
      ) : null}
    </Screen>
  );
}
