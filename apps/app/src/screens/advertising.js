// Advertising (#524): one home for promoting a venue, event, coaching profile or business with clearly labelled, sport-relevant reach — and, for the
// platform admin only, the review desk. Paid ads are kept apart from every organic list, ranking and review; rules live in the API, this only asks and shows.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { CampaignWizard } from './ad-wizard';
import { AdminAds } from './ad-admin';
import { StatusTag } from './ad-ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';

const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

function CampaignRow({ k, onPress }) {
  return (
    <Row onPress={onPress} title={k.name} sub={`${k.placements?.length ?? 0} placement${k.placements?.length === 1 ? '' : 's'} · ${day(k.starts_on)}–${day(k.ends_on)} · ${k.category_label}`}
      right={<View style={{ alignItems: 'flex-end', gap: 4 }}><StatusTag s={k.status} held={k.held_by_platform} /><T size={12} color={c.mute}>{moneyIn(k.spent_minor, k.currency)} of {moneyIn(k.budget_minor, k.currency)}</T></View>} />
  );
}

function Onboard({ who, policy, onDone }) {
  const [as, setAs] = useState(who.organisations.find((o) => o.can_manage && !o.advertiser_id)?.organisation_id ?? 'me');
  const [form, setForm] = useState(false);
  const opts = [{ value: 'me', label: 'As myself' }, ...who.organisations.filter((o) => o.can_manage && !o.advertiser_id).map((o) => ({ value: o.organisation_id, label: o.name }))];
  return (
    <Card color={c.paper}>
      <T weight="800" size={16}>Start advertising</T>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>Promote your venue, event or business next to the pages people already use — clearly marked <T weight="800" size={13}>Sponsored</T> or <T weight="800" size={13}>Promoted</T>, never mixed into results, rankings or reviews.</T>
      {opts.length > 1 ? <View style={{ marginVertical: 10 }}><Seg options={opts} value={as} onChange={setAs} /></View> : null}
      <Btn title="Review the policy and continue" onPress={() => setForm(true)} style={{ marginTop: 10 }} />
      <FormSheet visible={form} onClose={() => setForm(false)} title="Advertising policy" submitLabel="Accept and continue" initial={{ ok: false }}
        notice="You must own or run everything you promote. Alcohol, betting, tobacco, supplements and health claims, speculative finance, weapons, adult content, banned substances and political advocacy cannot be advertised. Ads are reviewed before they run, can be paused or withdrawn at any time, and are measured only by what the platform can see: views and clicks."
        fields={[
          { key: 'ok', label: 'I have read and accept the advertising policy', type: 'switch' },
        ]}
        onSubmit={async (v) => {
          if (!v.ok) throw new Error('Accept the policy to continue');
          await api.post('/advertising/advertisers', { ...(as !== 'me' ? { organisation_id: as } : {}), accept_policy: true });
          onDone(); return 'Advertiser account ready';
        }} />
    </Card>
  );
}

export function Advertising() {
  const { user } = useSession();
  const { push } = useNav();
  const home = useLoad(() => api.get('/advertising'), []);
  const policy = useLoad(() => api.get('/advertising/policy'), []);
  const [tab, setTab] = useState('campaigns');
  const [adv, setAdv] = useState(null);
  const [wizard, setWizard] = useState(false);
  const isAdmin = user?.roles?.includes('platform_admin');
  if (home.loading && !home.data) return <Screen><Loading /></Screen>;
  if (home.error) return <Screen><ErrorBox error={home.error} onRetry={home.reload} /></Screen>;
  const h = home.data;
  const accounts = [
    ...(h.me.advertiser_id ? [{ advertiser_id: h.me.advertiser_id, name: user?.display_name ?? 'Me', status: h.me.status, can_manage: true }] : []),
    ...h.organisations.filter((o) => o.advertiser_id).map((o) => ({ advertiser_id: o.advertiser_id, name: o.name, status: o.status, can_manage: o.can_manage })),
  ];
  const current = accounts.find((a) => a.advertiser_id === adv) ?? accounts[0];
  const academies = h.organisations.filter((o) => o.kind === 'academy' && o.can_manage).map((o) => ({ id: o.organisation_id, name: o.name }));
  const campaigns = h.campaigns.filter((k) => !current || k.advertiser_id === current.advertiser_id);

  return (
    <Screen onRefresh={() => { home.reload(); policy.reload(); }} wide>
      <H1 style={{ marginTop: 8 }}>Advertising</H1>
      <T color={c.mute} weight="600">Reach people by sport and place. Every ad is labelled, reviewed before it runs, and kept apart from search results, rankings and reviews — paying never changes where anyone ranks.</T>
      {isAdmin ? <View style={{ marginVertical: 10 }}><Seg options={[{ value: 'campaigns', label: 'My campaigns' }, { value: 'review', label: 'Review desk' }, { value: 'reports', label: 'Reports' }, { value: 'policy', label: 'Policy & overview' }]} value={tab} onChange={setTab} /></View> : null}

      {tab !== 'campaigns' && isAdmin ? <AdminAds tab={tab} onOpen={(id) => push('AdCampaign', { id, admin: true })} /> : (
        <>
          {!accounts.length ? <View style={{ marginTop: 14 }}><Onboard who={h} policy={policy.data} onDone={home.reload} /></View> : (
            <>
              {accounts.length > 1 || h.organisations.some((o) => o.can_manage && !o.advertiser_id) ? (
                <View style={{ marginTop: 10 }}><Seg options={accounts.map((a) => ({ value: a.advertiser_id, label: a.name }))} value={current?.advertiser_id} onChange={setAdv} /></View>
              ) : null}
              {h.waiting_on_you.length ? (
                <Section title="Needs you" color={c.sun}>
                  {h.waiting_on_you.map((w) => <Row key={w.campaign_id} color={c.sunSoft} title={w.name} sub={w.why} onPress={() => push('AdCampaign', { id: w.campaign_id })} right={<T weight="700" color={c.pink}>Open ›</T>} />)}
                </Section>
              ) : null}
              <Section title="Campaigns" action={current?.can_manage && current.status === 'active' ? '＋ New campaign' : undefined} onAction={() => setWizard(true)}>
                {campaigns.length ? campaigns.map((k) => <CampaignRow key={k.id} k={k} onPress={() => push('AdCampaign', { id: k.id })} />)
                  : <Empty emoji="📣" title="No campaigns yet" sub={current?.can_manage ? 'Create one: choose what to promote, where it shows, who can see it, and your budget.' : 'Only owners and administrators create campaigns.'} />}
                {current?.status === 'suspended' ? <T size={13} color={c.red} weight="700">This advertiser account is suspended. Contact the review team.</T> : null}
              </Section>
              {policy.data ? (
                <Section title="Where ads can appear" color={c.cyan}>
                  {policy.data.placements.map((p) => (
                    <Row key={p.code} title={p.label} sub={`${p.surface} · ${p.disclosure}${p.on_sale ? '' : ' · not on sale yet'}`} right={p.on_sale ? <Tag label="On sale" color={c.mint} /> : <Tag label="Off" color={c.violetSoft} />} />
                  ))}
                </Section>
              ) : null}
              <T size={12} color={c.mute} style={{ marginTop: 14 }}>Views and clicks are the only things measured, and they are counted when the platform serves the ad and when someone taps it. Reach across visits and conversions are not measured and never estimated.</T>
            </>
          )}
        </>
      )}
      {current ? <CampaignWizard visible={wizard} onClose={() => setWizard(false)} advertiser={{ ...current, academies }} policy={policy.data} onDone={(id) => { home.reload(); push('AdCampaign', { id }); }} /> : null}
    </Screen>
  );
}
