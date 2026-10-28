// The venue workspace: everything a venue owner or staff member runs from one page. Their venues (each opens its management
// console), registering a new venue, the revenue summary across venues, and the partner account with the platform
// (status, contracts, price requests, settlements). The platform team's Partner management console stays admin-only.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Bubble, Btn, Empty, ErrorBox, H1, Loading, Row, Screen, Section, T } from '../ui';
import { RegisterVenue } from './book';
import { c } from '../theme';

export function VenueWorkspace() {
  const { push } = useNav();
  const [form, setForm] = useState(false);
  const venues = useLoad(() => api.get('/me/venues'), []);
  const desks = useLoad(() => api.get('/me/front-desks').catch(() => []), []);
  const cashierOnly = (desks.data ?? []).filter((d) => d.role === 'cashier');
  const list = venues.data ?? [];
  return (
    <Screen onRefresh={venues.reload}>
      <H1>Venue workspace</H1>
      <T color={c.mute} weight="700">Run your venues, see how they earn, and manage your partner account.</T>
      <Section title="My venues" color={c.violet}>
        <Btn title="＋ Register a venue" color={c.violet} onPress={() => setForm(true)} />
        {venues.error ? <ErrorBox error={venues.error} onRetry={venues.reload} /> : venues.loading && !venues.data ? <Loading /> : list.length ? list.map((v) => (
          <Row key={v.id} onPress={() => push('Manage', { id: v.id })} left={<Bubble emoji={v.emoji} color={c.violet} />} title={v.name} sub={`${v.role} · manage bookings, pricing, blocks, reports`} right={<View style={{ alignItems: 'flex-end', gap: 6 }}><T color={c.pink} weight="700">Manage ›</T><Btn small title="🧾 Front desk" onPress={() => push('Manage', { id: v.id, tab: 'frontdesk' })} accessibilityLabel={`Open the front desk of ${v.name}`} /></View>} />
        )) : <Empty emoji="🏟️" title="No venues yet" sub="Tap Register a venue. A setup checklist then takes you through opening it for bookings." />}
      </Section>
      {cashierOnly.length ? (
        <Section title="Front desks I work" color={c.pink}>
          {cashierOnly.map((d) => <Row key={d.id} onPress={() => push('Manage', { id: d.id, tab: 'frontdesk', desk: true })} left={<Bubble emoji={d.emoji} color={c.pink} />} title={d.name} sub="Cashier · sell, take payment, run the drawer" right={<T color={c.pink} weight="700">Open ›</T>} />)}
        </Section>
      ) : null}
      <Section title="Money & account" color={c.mint}>
        <Row onPress={() => push('OwnerSummary')} left={<Bubble emoji="📊" color={c.violet} />} title="All my venues" sub="Revenue, tax and payments per venue and per currency" right={<T color={c.pink} weight="700">Open ›</T>} />
        <Row onPress={() => push('MyPartner')} left={<Bubble emoji="🤝" color={c.mint} />} title="Partner account" sub="Status, contracts, price requests and settlements" right={<T color={c.pink} weight="700">Open ›</T>} />
      </Section>
      <RegisterVenue visible={form} onClose={() => setForm(false)} onCreated={venues.reload} />
    </Screen>
  );
}
