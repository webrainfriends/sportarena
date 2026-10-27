// Public race page (issue #487): live progress and results for spectators, families and entrants. It reads only the approved public endpoints, so it
// shows exactly what the organiser's policy allows: results labelled provisional / final / corrected, approved splits when published, names only for
// entrants who agreed (never young account holders), and no contact, medical or other private data.
import { locale } from '../locale';
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { usePoll } from '../live';
import { useSession } from '../session';
import { Btn, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Section, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, grad } from '../theme';

const LABEL = { provisional: ['Provisional', c.sun], final: ['Final', c.mint], corrected: ['Corrected', c.cyan], not_published: ['Results not published yet', c.violetSoft] };
const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '');
const dayTime = (iso) => (iso ? new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

const Result = ({ r }) => (
  <Row left={<View style={{ width: 44, alignItems: 'center' }}><T size={r.rank ? 22 : 14} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{r.rank ?? '–'}</T>{r.tied ? <T size={10} color={c.sun} weight="700">TIE</T> : null}</View>}
    title={`${r.bib ? `#${r.bib}  ` : ''}${r.name ?? 'Entrant'}`} sub={[r.category, r.status !== 'finished' ? r.status_label : null].filter(Boolean).join(' · ') || undefined}
    right={<T size={17} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{r.time ?? '–'}</T>} />
);

export function RaceLive({ id }) {
  const { user, toast } = useSession();
  const live = useLoad(() => api.get(`/races/${id}/live`), [id]);
  const mine = useLoad(() => (user ? api.get('/me/races') : Promise.resolve([])), [id, user?.id]);
  const [cls, setCls] = useState('overall');
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [list, setList] = useState({ items: [], next: null });
  const [more, setMore] = useState(false);
  const [entering, setEntering] = useState(false);
  const board = useLoad(async () => { const r = await api.get(`/races/${id}/public-results`, { classification: cls, limit: 25 }); setList(r); return r; }, [id, cls, live.data?.results?.version]);
  usePoll(() => { live.reload(); }, 20000);
  if (live.error) return <Screen><ErrorBox error={live.error} onRetry={live.reload} /></Screen>;
  if (!live.data) return <Screen><Loading /></Screen>;
  const d = live.data;
  const [label, tone] = LABEL[d.results.label] ?? LABEL.not_published;
  const me = (mine.data ?? []).find((m) => m.race_id === id);
  const search = async (text) => {
    setQ(text);
    if (!text.trim()) return setFound(null);
    try { setFound(await api.get(`/races/${id}/search`, { q: text.trim() })); } catch (e) { toast('' + e.message); }
  };
  const loadMore = async () => { setMore(true); try { const r = await api.get(`/races/${id}/public-results`, { classification: cls, limit: 25, after: list.next }); setList((p) => ({ ...r, items: [...p.items, ...r.items] })); } finally { setMore(false); } };
  const classes = [['overall', 'Overall'], ...(d.features.categories ? [['gender:male', 'Men'], ['gender:female', 'Women'], ...d.categories.map((k) => [`category:${k.id}`, k.name])] : [])];
  return (
    <Screen>
      <GradCard colors={grad.hero}>
        <T size={44}>🏃</T>
        <H1 color="#fff" style={{ fontSize: 30 }}>{d.race.name}</H1>
        <T color="#fff" weight="800">{d.event.name}{d.event.city ? ` · ${d.event.city}` : ''}</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Tag label={label} color={tone} />
          {d.results.published_at ? <T size={12} color="#fff">as of {hm(d.results.published_at)}</T> : null}
        </View>
      </GradCard>
      {d.results.label === 'provisional' ? <T size={13} color={c.mute} style={{ marginTop: 10 }}>Provisional results can still change while officials check the timing.</T> : null}
      {d.results.label === 'corrected' ? <T size={13} color={c.mute} style={{ marginTop: 10 }}>These results were corrected after an official review; earlier versions are kept on record.</T> : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <StatPill value={d.counts.entrants} label="ENTRANTS" /><StatPill value={d.counts.started} label="STARTED" /><StatPill value={d.counts.finished} label="FINISHED" color={c.lime} />
      </View>

      {me ? (
        <Section title="My race">
          <Row left={<T size={22} weight="800">{me.bib_no ? `#${me.bib_no}` : 'No bib'}</T>}
            title={me.rank_overall ? `Place ${me.rank_overall}${me.official_time ? ` · ${me.official_time}` : ''}` : me.published_status && me.published_status !== 'registered' ? `${me.published_status.toUpperCase()}` : me.wave ? `Wave ${me.wave}` : 'You are entered'}
            sub={me.rank_overall || me.published_status ? `${me.result_label} result` : me.wave_start ? `Start ${dayTime(me.wave_start)}` : 'Your bib number and start wave will be sent to you.'} />
        </Section>
      ) : user ? <Btn title="Enter this race" style={{ marginTop: 14 }} onPress={() => setEntering(true)} /> : null}

      <Section title="Find a runner" color={c.cyan}>
        <Field value={q} onChangeText={search} placeholder="Bib number or name" accessibilityLabel="Find a runner by bib number or name" />
        {found ? (found.items.length ? found.items.map((r) => <Result key={r.bib ?? r.name} r={r} />) : <Empty emoji="🔎" title="Nobody found" sub="Names appear only for entrants who agreed to publish theirs. Try the bib number." />) : null}
      </Section>

      <Section title="Start waves" color={c.mint}>
        {d.waves.length ? d.waves.map((w) => <Row key={w.name} title={w.name} sub={dayTime(w.start_at)} right={<Tag label={w.status === 'started' ? `gun ${hm(w.gun_at)}` : w.status} color={w.status === 'started' ? c.lime : c.violetSoft} />} />) : <Empty emoji="🚦" title="Waves will be announced" />}
      </Section>

      <Section title="Results">
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{classes.map(([k, l]) => <Chip key={k} label={l} active={cls === k} onPress={() => setCls(k)} />)}</View>
        {list.items.map((r, i) => <Result key={`${r.bib}${i}`} r={r} />)}
        {!board.loading && !list.items.length ? <Empty emoji="⏱️" title={d.results.label === 'not_published' ? 'Results will appear here' : 'No results in this classification yet'} /> : null}
        {list.next ? <Btn title={more ? 'Loading…' : 'Show more'} loading={more} color={c.paper} ink={c.ink} onPress={loadMore} /> : null}
      </Section>

      {d.course.length ? (
        <Section title="The course" color={c.orange}>
          {d.course.map((k) => <Row key={k.code} title={k.label} right={<T weight="700">{(Number(k.distance_m) / 1000).toFixed(Number(k.distance_m) % 1000 ? 2 : 0)} {k.unit === 'mi' ? 'mi' : 'km'}</T>} />)}
        </Section>
      ) : null}

      <FormSheet visible={entering} onClose={() => setEntering(false)} title="Enter this race" submitLabel="Enter"
        fields={[
          { key: 'gender', label: 'Gender for the race and category rules', type: 'chips', optional: true, options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }] },
          { key: 'name_public', label: 'Show my name on the public results', type: 'switch', default: false, hint: 'Your bib number is always shown. Names are never shown for under-18 accounts.' },
        ]}
        onSubmit={async (v) => { await api.post(`/races/${id}/entries`, v); mine.reload(); live.reload(); return 'You are entered'; }} />
    </Screen>
  );
}
