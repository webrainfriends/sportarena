// New (or changed) campaign, in five short steps: what you promote, where it shows, who may see it, money and dates, the ad itself — then a preview of
// exactly what people will see, with its "Sponsored" / "Promoted" label. Every answer is a control that fits it (pickers, chips, a calendar, a currency
// amount, a stepper); the only typing is the wording of the ad. Everything is checked again by the API.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { pickMedia } from '../market/media';
import { AdCard, CTA_LABEL } from '../ads';
import { c } from '../theme';

const PROMOTE = [
  { value: 'venue', label: '🏟️ My venue' }, { value: 'event', label: '🏆 My event' }, { value: 'coach', label: '🎓 My coaching profile' },
  { value: 'academy', label: '🏫 My academy' }, { value: 'supplier', label: '📦 My supplier profile' }, { value: 'website', label: '🔗 A page on my website' }, { value: 'awareness', label: '📣 Just my name (awareness)' },
];
const BILLING = [{ value: 'cpm', label: 'Per 1,000 views' }, { value: 'cpc', label: 'Per click' }, { value: 'flat', label: 'One flat fee' }];
const BILLING_HINT = {
  cpm: 'You pay a set price for every 1,000 times the ad is shown. Nothing is charged beyond the budget you fund.',
  cpc: 'Being shown is free. You pay a set price each time someone taps the button.',
  flat: 'One fee for the whole run, taken when it starts. It is credited back if the campaign ends before the ad was shown.',
};
const STEPS = ['What', 'Where', 'Who', 'Budget', 'The ad'];

/** The placements that can carry this kind of campaign: the ones that need a venue/event/… only with that destination, plus the open ones. */
const placementsFor = (policy, promote) => (policy?.placements ?? []).filter((p) => p.on_sale && p.in_app && (p.needs === null || p.needs === 'keywords' || p.needs === promote));

export function CampaignWizard({ visible, onClose, advertiser, policy, campaign, onDone }) {
  const { toast, user } = useSession();
  const edit = !!campaign;
  const [step, setStep] = useState(0);
  const [d, setD] = useState({});
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const venues = useLoad(() => (visible ? api.get('/me/venues').catch(() => []) : Promise.resolve([])), [visible]);
  const events = useLoad(() => (visible && user ? api.get('/events', { organizer_id: user.id, limit: 50 }).catch(() => []) : Promise.resolve([])), [visible, user?.id]);
  const suppliers = useLoad(() => (visible ? api.get('/me/supplier-profiles').catch(() => []) : Promise.resolve([])), [visible]);
  const academies = (advertiser?.academies ?? []);

  const init = useMemo(() => {
    if (!campaign) return { objective: 'awareness', billing_model: 'cpm', audience: 'everyone', frequency_per_day: 3, cta: 'learn_more', claims: [] };
    const l = campaign.campaign.landing;
    const cr = campaign.creatives.find((x) => x.id === campaign.campaign.current_creative_id) ?? campaign.creatives[0];
    const k = campaign.campaign;
    return {
      name: k.name, promote: l ? (l.type === 'entity' ? l.entity_type : 'website') : 'awareness', [`${l?.entity_type}_id`]: l?.entity_id, landing_url: l?.url, category: k.category, objective: k.objective,
      placements: k.placements, keywords_text: k.keywords?.join(', '), sports: k.sports, countries: k.countries, cities: k.cities, audience: k.audience, frequency_per_day: k.frequency_per_day ?? 3,
      billing_model: k.billing_model, currency: k.currency, rate_minor: k.rate_minor, budget_minor: k.budget_minor, starts_on: k.starts_on, ends_on: k.ends_on,
      headline: cr?.headline, body: cr?.body, cta: cr?.cta ?? 'learn_more', claims: cr?.claims ?? [], alt_text: cr?.alt_text, media_id: cr?.media_id,
    };
  }, [campaign]);
  const v = { ...init, ...d };

  const close = () => { setStep(0); setD({}); setPhoto(null); onClose(); };
  const next = (vals) => { setD((x) => ({ ...x, ...vals })); setStep((s) => s + 1); return undefined; };
  const promote = v.promote;
  const entityOpts = {
    venue: (venues.data ?? []).map((x) => ({ id: x.id, label: x.name, sub: x.city, emoji: x.emoji ?? '🏟️' })),
    event: (events.data ?? []).filter((x) => ['open', 'live', 'upcoming', 'in_progress'].includes(x.status) || !x.status).map((x) => ({ id: x.id, label: x.name, sub: [x.sport, x.city].filter(Boolean).join(' · '), emoji: '🏆' })),
    supplier: (suppliers.data ?? []).map((x) => ({ id: x.id, label: x.trading_name ?? x.legal_name, sub: x.supplier_type, emoji: '📦' })),
    academy: academies.map((x) => ({ id: x.id, label: x.name, sub: 'Academy', emoji: '🏫' })),
    coach: user ? [{ id: user.id, label: user.display_name, sub: 'My coaching profile', emoji: user.avatar_emoji ?? '🎓' }] : [],
  };
  const entityField = (type, label, noun) => ({ key: `${type}_id`, label, type: 'entity', entityKind: 'person', noun, options: entityOpts[type], show: (x) => x.promote === type, hint: entityOpts[type].length ? 'Only things you manage are listed.' : `You do not manage any ${noun} yet.` });

  const categories = (policy?.categories?.allowed ?? []).map((x) => ({ value: x.code, label: x.label }));
  const chosen = placementsFor(policy, promote);

  const create = async (vals) => {
    const all = { ...v, ...vals };
    const rate = all.rate_minor, budget = all.billing_model === 'flat' ? all.rate_minor : all.budget_minor;
    const body = {
      name: all.name, objective: all.objective, category: all.category, placements: all.placements, billing_model: all.billing_model, rate_minor: rate, currency: all.currency, budget_minor: budget,
      starts_on: all.starts_on, ends_on: all.ends_on, sports: all.sports ?? [], countries: all.countries ?? [], cities: all.cities ?? [], audience: all.audience ?? 'everyone', frequency_per_day: all.frequency_per_day,
      keywords: (all.keywords_text ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    };
    if (['venue', 'event', 'coach', 'academy', 'supplier'].includes(all.promote)) { body.landing_entity_type = all.promote; body.landing_entity_id = all[`${all.promote}_id`]; }
    else if (all.promote === 'website') body.landing_url = all.landing_url;
    const creative = { headline: all.headline, body: all.body || undefined, cta: all.cta, claims: all.claims ?? [], ...(photo?.media_id ?? all.media_id ? { media_id: photo?.media_id ?? all.media_id, alt_text: all.alt_text } : {}) };
    setBusy(true);
    try {
      let id = campaign?.campaign.id;
      if (edit) { await api.patch(`/advertising/campaigns/${id}`, body); await api.post(`/advertising/campaigns/${id}/creatives`, creative); }
      else { const made = await api.post('/advertising/campaigns', { advertiser_id: advertiser.advertiser_id, ...body, creative }); id = made.id; }
      toast(edit ? 'Saved — send it for review when you are ready' : 'Saved as a draft');
      close(); onDone?.(id);
    } finally { setBusy(false); }
  };

  const upload = async () => {
    try {
      const f = await pickMedia({ photoOnly: true });
      if (!f) return;
      const m = await api.upload('/market/media', f.blob);
      setPhoto({ media_id: m.id, url: m.url });
    } catch (e) { toast(e.message); }
  };

  const preview = {
    label: chosen.length && v.placements?.every((p) => (policy.placements.find((x) => x.code === p)?.disclosure) === 'Promoted') ? 'Promoted' : 'Sponsored',
    advertiser: { name: advertiser?.name ?? 'You' }, headline: v.headline || 'Your headline', body: v.body, cta: v.cta, image_url: photo?.url, image_alt: v.alt_text,
  };

  return (
    <Sheet visible={visible} onClose={close} title={`${edit ? 'Change' : 'New'} campaign · ${STEPS[step]} (${step + 1}/5)`}>
      <View style={{ flexDirection: 'row', gap: 4 }}>{STEPS.map((s, i) => <View key={s} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= step ? c.pink : c.line }} />)}</View>

      {step === 0 ? (
        <FormSheet key="s0" inline onClose={() => {}} submitLabel="Next" initial={v} onSubmit={next} fields={[
          { key: 'name', label: 'Name this campaign', hint: 'Only you and the review team see this.' },
          { key: 'promote', label: 'What are you promoting?', type: 'chips', options: PROMOTE },
          entityField('venue', 'Which venue?', 'venue'), entityField('event', 'Which event?', 'event'), entityField('coach', 'Whose profile?', 'profile'),
          entityField('academy', 'Which academy?', 'academy'), entityField('supplier', 'Which supplier profile?', 'supplier'),
          { key: 'landing_url', label: 'The page it opens', input: 'url', placeholder: 'https://…', show: (x) => x.promote === 'website', hint: 'A secure https link to a public page.' },
          { key: 'category', label: 'What kind of business is it?', type: 'chips', options: categories, hint: 'Alcohol, betting, tobacco, supplements and health claims, speculative finance and similar categories cannot be advertised.' },
          { key: 'objective', label: 'What do you want?', type: 'choice', options: [{ value: 'awareness', label: 'Be seen' }, { value: 'traffic', label: 'Get visits' }] },
        ]} />
      ) : null}

      {step === 1 ? (
        <FormSheet key="s1" inline onClose={() => {}} submitLabel="Next" initial={v} onBack={() => setStep(0)} onSubmit={next} fields={[
          { key: 'placements', label: 'Where should it appear?', type: 'multi', options: chosen.map((p) => ({ value: p.code, label: p.label })), hint: (x) => (x.placements ?? []).map((code) => { const p = policy.placements.find((y) => y.code === code); return p ? `${p.label}: ${p.surface}. Organic results beside it stay exactly as they are.` : ''; }).join('\n') },
          { key: 'keywords_text', label: 'Words people search for', optional: true, show: (x) => (x.placements ?? []).includes('search_sponsored'), hint: 'For a sponsored search slot: separate up to five words with commas, e.g. badminton, racket.' },
        ]} />
      ) : null}

      {step === 2 ? (
        <FormSheet key="s2" inline onClose={() => {}} submitLabel="Next" initial={v} onBack={() => setStep(1)} onSubmit={next} fields={[
          { key: 'sports', label: 'Which sports?', type: 'sports', optional: true, hint: 'The ad shows beside pages about these sports. Leave empty for any sport.' },
          { key: 'countries', label: 'Which countries?', type: 'countries', optional: true },
          { key: 'cities', label: 'Which cities?', type: 'regions', optional: true, hint: 'Only used when the page itself is about that city. No one’s position is ever used.' },
          { key: 'audience', label: 'Who can see it?', type: 'chips', options: [{ value: 'everyone', label: 'Anyone viewing the page' }, ...(['venue', 'event'].includes(promote) ? [{ value: 'followers', label: `People who follow my ${promote}` }] : [])] },
          { key: 'frequency_per_day', label: 'Most times one person sees it in a day', type: 'stepper', min: 1, max: policy?.frequency?.max_per_day ?? 10 },
        ]} notice="Targeting is limited to sport, place and what is on the page. Health, legal or insurance matters, private messages, precise location and anything about young people are never available." />
      ) : null}

      {step === 3 ? (
        <FormSheet key="s3" inline onClose={() => {}} submitLabel="Next" initial={v} onBack={() => setStep(2)} onSubmit={next} fields={[
          { key: 'billing_model', label: 'How do you pay?', type: 'chips', options: BILLING, hint: (x) => BILLING_HINT[x.billing_model] },
          { key: 'currency', label: 'Currency', type: 'currency' },
          { key: 'rate_minor', label: 'Price', type: 'money', currency: (x) => x.currency },
          { key: 'budget_minor', label: 'Most you want to spend', type: 'money', currency: (x) => x.currency, show: (x) => x.billing_model !== 'flat', hint: 'Delivery stops when this is reached or the funds you added run out, whichever comes first.' },
          { key: 'starts_on', toKey: 'ends_on', label: 'When does it run?', type: 'daterange', min: new Date().toISOString().slice(0, 10) },
        ].map((f) => (f.key === 'rate_minor' ? { ...f, label: v.billing_model === 'flat' ? 'The flat fee' : v.billing_model === 'cpc' ? 'Price per click' : 'Price per 1,000 views' } : f))} />
      ) : null}

      {step === 4 ? (
        <>
          <FormSheet key="s4" inline onClose={() => {}} submitLabel={edit ? 'Save changes' : 'Save as draft'} initial={v} onBack={() => setStep(3)} onSubmit={async (vals) => { setD((x) => ({ ...x, ...vals })); await create(vals); }}
            notice="After saving you send it for review. It cannot show until the review team approves it and it is funded."
            fields={[
              { key: 'headline', label: 'Headline', hint: 'Up to 60 characters.' },
              { key: 'body', label: 'A line of text', type: 'multiline', optional: true, hint: 'Up to 150 characters.' },
              { key: 'cta', label: 'Button', type: 'chips', options: Object.entries(CTA_LABEL).map(([value, label]) => ({ value, label })) },
              { key: 'alt_text', label: 'Describe the picture for screen readers', optional: true, show: () => !!(photo?.media_id ?? v.media_id), hint: 'Required with a picture.' },
              { key: 'claims', label: 'What does the ad claim?', type: 'multi', optional: true, options: [{ value: 'price', label: 'Prices or discounts' }, { value: 'results', label: 'Results or rankings' }, { value: 'availability', label: 'Availability or limited offers' }, { value: 'endorsement', label: 'Endorsements or reviews' }, { value: 'health', label: 'Health or fitness outcomes' }], hint: 'So the reviewer knows what to check. Tell the truth: a claim that cannot be backed up is rejected.' },
            ]} />
          <View style={{ gap: 8 }}>
            <Btn small title={photo || v.media_id ? '🖼️ Change picture' : '🖼️ Add a picture (optional)'} color={c.paper} ink={c.ink} onPress={upload} style={{ alignSelf: 'flex-start' }} />
            <T weight="800" size={13}>This is what people will see</T>
            <AdCard ad={preview} preview />
          </View>
        </>
      ) : null}
      {busy ? <T size={12} color={c.mute}>Saving…</T> : null}
    </Sheet>
  );
}
