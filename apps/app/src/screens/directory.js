// Explore → Academies and Suppliers: the public directories, and their detail pages. They read the same public capabilities MCP agents use
// (search_academies, get_academy_listing, search_suppliers, get_supplier_profile, list_service_offerings). Lists are ordered by name only;
// a labelled, paid placement (#524) may sit above them but never inside them.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Bubble, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Section, T, Tag } from '../ui';
import { HScroll } from '../pickers';
import { SportSelect } from '../sportpicker';
import { AdSlot } from '../ads';
import { useCatalogue, catLabel } from './svc-common';
import { moneyIn } from '../vtime';
import { c } from '../theme';

const pretty = (s) => String(s ?? '').replace(/_/g, ' ');
const useDebounced = (v, ms = 350) => { const [d, setD] = React.useState(v); React.useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; };

export function AcademiesTab() {
  const { push } = useNav();
  const [q, setQ] = useState('');
  const [sport, setSport] = useState(null);
  const dq = useDebounced(q.trim());
  const list = useLoad(() => api.get('/academies', { q: dq || undefined, sport: sport || undefined, limit: 50 }), [dq, sport]);
  return (
    <View style={{ gap: 12, marginTop: 8 }}>
      <Field value={q} onChangeText={setQ} placeholder="Search academies by name" />
      <SportSelect allLabel="All sports" value={sport} onChange={setSport} />
      <AdSlot placement="featured_academy" sport={sport || undefined} />
      <AdSlot placement="search_sponsored" q={dq} sport={sport || undefined} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((a) => (
        <Row key={a.id} onPress={() => push('AcademyPage', { id: a.id })} left={<Bubble emoji="🏫" color={c.violetSoft} />} title={a.name}
          sub={[a.city, a.sports?.slice(0, 3).map(pretty).join(', '), `${a.programmes} programme${a.programmes === 1 ? '' : 's'}`].filter(Boolean).join(' · ')} />
      )) : <Empty emoji="🏫" title="No academies listed" sub={dq || sport ? 'Try another name or sport.' : 'Academies appear here once they publish a programme and choose to be listed.'} />}
    </View>
  );
}

export function SuppliersTab() {
  const { push } = useNav();
  const cat = useCatalogue();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState(null);
  const dq = useDebounced(q.trim());
  const list = useLoad(() => api.get('/suppliers', { q: dq || undefined, category: category || undefined, limit: 50 }), [dq, category]);
  const cats = [...new Set((list.data ?? []).flatMap((s) => s.categories ?? []))].sort();
  return (
    <View style={{ gap: 12, marginTop: 8 }}>
      <Field value={q} onChangeText={setQ} placeholder="Search suppliers by name" />
      {cats.length || category ? <HScroll><Chip label="All services" active={!category} onPress={() => setCategory(null)} />{[...new Set([...(category ? [category] : []), ...cats])].map((k) => <Chip key={k} label={catLabel(cat, k)} active={category === k} onPress={() => setCategory(category === k ? null : k)} />)}</HScroll> : null}
      <AdSlot placement="promoted_supplier" />
      <AdSlot placement="search_sponsored" q={dq} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((s) => (
        <Row key={s.id} onPress={() => push('SupplierPage', { id: s.id })} left={<Bubble emoji="📦" color={c.cyanSoft} />} title={s.trading_name ?? s.legal_name}
          sub={[s.categories?.slice(0, 3).map((k) => catLabel(cat, k)).join(', '), `${s.offerings} offering${s.offerings === 1 ? '' : 's'}`].filter(Boolean).join(' · ')} />
      )) : <Empty emoji="📦" title="No suppliers found" sub="Try another name or service." />}
    </View>
  );
}

export function AcademyPage({ id }) {
  const { push } = useNav();
  const a = useLoad(() => api.get(`/academies/${id}`), [id]);
  if (a.loading && !a.data) return <Screen><Loading /></Screen>;
  if (a.error) return <Screen><ErrorBox error={a.error} onRetry={a.reload} /></Screen>;
  const d = a.data;
  return (
    <Screen onRefresh={a.reload}>
      <H1 style={{ marginTop: 8, fontSize: 28 }}>{d.name}</H1>
      <T color={c.mute} weight="600">{[d.city, pretty(d.focus), d.age_min != null || d.age_max != null ? `ages ${d.age_min ?? 0}–${d.age_max ?? '∞'}` : null].filter(Boolean).join(' · ')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>{d.sports.map((s) => <Tag key={s} label={pretty(s)} color={c.cyan} />)}</View>
      <Section title="Programmes">
        {d.programmes.map((p) => (
          <Row key={p.id} title={p.title}
            sub={[p.sport, pretty(p.format), p.age_min != null || p.age_max != null ? `ages ${p.age_min ?? 0}–${p.age_max ?? '∞'}` : null, p.starts_on ? `from ${String(p.starts_on).slice(0, 10)}` : null].filter(Boolean).join(' · ')}
            right={p.fee_minor ? <T weight="800">{moneyIn(p.fee_minor, p.currency)}</T> : null} />
        ))}
      </Section>
      <Btn title="Enquire or apply" onPress={() => push('AcademyFamily')} style={{ marginTop: 14 }} />
      <T size={12} color={c.mute} style={{ marginTop: 6 }}>Applications and enquiries go through My academy, where you choose who they are for.</T>
    </Screen>
  );
}

export function SupplierPage({ id }) {
  const cat = useCatalogue();
  const p = useLoad(() => api.get(`/supplier-profiles/${id}`), [id]);
  const offers = useLoad(() => api.get('/service-offerings', { profile_id: id, limit: 50 }).catch(() => []), [id]);
  if (p.loading && !p.data) return <Screen><Loading /></Screen>;
  if (p.error) return <Screen><ErrorBox error={p.error} onRetry={p.reload} /></Screen>;
  const d = p.data;
  return (
    <Screen onRefresh={() => { p.reload(); offers.reload(); }}>
      <H1 style={{ marginTop: 8, fontSize: 28 }}>{d.trading_name ?? d.legal_name}</H1>
      <T color={c.mute} weight="600">{pretty(d.supplier_type)}{d.lead_time_days ? ` · ${d.lead_time_days} days lead time` : ''}</T>
      {d.description ? <T style={{ marginTop: 8 }}>{d.description}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>{(d.categories ?? []).map((k) => <Tag key={k} label={catLabel(cat, k)} color={c.cyan} />)}</View>
      {d.credentials?.length ? <Section title="Checked credentials">{d.credentials.map((k) => <Row key={k.id} title={k.title} sub={`${pretty(k.kind)} · ${k.badge ?? pretty(k.verification)}`} />)}</Section> : null}
      <Section title="What they offer">
        {offers.data?.length ? offers.data.map((o) => <Row key={o.id} title={o.title} sub={[catLabel(cat, o.category), pretty(o.mode)].filter(Boolean).join(' · ')} />) : <T size={13} color={c.mute}>No offerings published yet.</T>}
      </Section>
    </Screen>
  );
}
