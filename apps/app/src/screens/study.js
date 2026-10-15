// Learn & study, discovery side: find where to study the sports on your profile in your region (colleges that list themselves here plus
// AI suggestions), keep a bucket list, and read or write reviews. Reviews use the platform's single review system.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Section, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { SportsMulti } from '../sportpicker';
import { RegionPicker } from '../region-picker';
import { COUNTRIES } from '../countries';
import { c, when } from '../theme';
import { moneyIn } from '../vtime';

export const KINDS = [['course', 'Course'], ['certification', 'Certification'], ['diploma', 'Diploma'], ['degree', 'Degree'], ['postgraduate', 'Postgraduate'], ['short_course', 'Short course']];
export const MODES = [['on_campus', 'On campus'], ['online', 'Online'], ['hybrid', 'Hybrid']];
export const STAGES = [['saved', 'Saved'], ['shortlisted', 'Shortlisted'], ['applying', 'Applying'], ['applied', 'Applied'], ['accepted', 'Accepted'], ['not_for_me', 'Not for me']];
const label = (list, v) => list.find(([k]) => k === v)?.[1] ?? String(v).replace(/_/g, ' ');
const opts = (list) => list.map(([value, l]) => ({ value, label: l }));
const place = (x) => [x.city, x.country].filter(Boolean).join(', ');
const isExt = (type) => type.startsWith('study_');

export const Stars = ({ value, size = 14 }) => <T size={size} color={c.sun} weight="800">{'★'.repeat(Math.round(value || 0))}{'☆'.repeat(5 - Math.round(value || 0))}</T>;
export const RatingTag = ({ rating, reviews }) => (reviews ? <Tag label={`★ ${Number(rating).toFixed(1)} (${reviews})`} color={c.sun} /> : <Tag label="No reviews yet" />);

/** Rating summary, the reviews people left, and a form to add yours. type: institution | programme | study_institution | study_programme. */
export function Reviews({ type, id, title = 'Ratings & reviews' }) {
  const { user } = useSession();
  const [form, setForm] = useState(false);
  const r = useLoad(() => api.get('/testimonials', { subject_type: type, subject_id: id, limit: 30 }), [type, id]);
  return (
    <Section title={title} color={c.sun} action={user ? 'Write a review' : undefined} onAction={() => setForm(true)}>
      {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !r.data ? <Loading /> : (
        <>
          {r.data.n ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><T size={30} weight="800">{Number(r.data.avg).toFixed(1)}</T><View><Stars value={r.data.avg} size={18} /><T size={12} color={c.mute}>{r.data.n} review{r.data.n === 1 ? '' : 's'}{r.data.verified ? ` · ${r.data.verified} from enrolled students` : ''}</T></View></View> : null}
          {r.data.items.length ? r.data.items.map((x) => (
            <Card key={x.id} pad={14}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Stars value={x.rating} /><T size={11} color={c.mute}>{when(x.created_at)}</T></View>
              <T style={{ marginTop: 6 }}>{x.body}</T>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', marginTop: 6 }}><T size={12} color={c.mute}>{x.avatar_emoji} {x.display_name}</T>{x.verification === 'verified_interaction' ? <Tag label="Enrolled student" color={c.mint} /> : null}</View>
            </Card>
          )) : <Empty emoji="💬" title="No reviews yet" sub="Studied here, or looked into it closely? Be the first to share what it is really like." />}
        </>
      )}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Your review" submitLabel="Post review"
        fields={[
          { key: 'rating', label: 'Rating', type: 'chips', options: [5, 4, 3, 2, 1].map((n) => ({ value: n, label: `${'★'.repeat(n)}` })) },
          { key: 'body', label: 'What was it like? Teaching, facilities, cost, support, getting in…', type: 'multiline' },
        ]}
        initial={{ rating: 5 }}
        onSubmit={async (v) => { await api.post('/testimonials', { subject_type: type, subject_id: id, rating: Number(v.rating), body: v.body }); r.reload(); return 'Review posted'; }} />
    </Section>
  );
}

/** Save to the bucket list, or change its stage / note / deadline / remove it once saved. */
export function BucketButton({ type, id }) {
  const { toast } = useSession();
  const [sheet, setSheet] = useState(false);
  const list = useLoad(() => api.get('/me/bucket', { limit: 100 }), [type, id]);
  const item = (list.data ?? []).find((x) => x.target_type === type && x.target_id === id);
  const save = async () => { try { await api.post('/me/bucket', { target_type: type, target_id: id }); toast('Saved to your bucket list'); list.reload(); } catch (e) { toast('' + e.message); } };
  if (!list.data) return null;
  return (
    <>
      {item ? <Btn small title={`🔖 In bucket list · ${label(STAGES, item.status)}`} color={c.mint} onPress={() => setSheet(true)} /> : <Btn small title="🔖 Add to bucket list" color={c.violet} onPress={save} />}
      <FormSheet visible={sheet} onClose={() => setSheet(false)} title="Bucket list" submitLabel="Save changes"
        fields={[
          { key: 'status', label: 'Where are you with this?', type: 'chips', options: opts(STAGES) },
          { key: 'target_date', label: 'Application deadline or target date', type: 'date', optional: true },
          { key: 'note', label: 'Notes (scholarships, questions to ask, people to call)', type: 'multiline', optional: true },
          { key: 'remove', label: 'Remove from my bucket list', type: 'switch', default: false, hint: 'You can save it again later and keep your notes.' },
        ]}
        initial={{ status: item?.status, target_date: item?.target_date?.slice(0, 10), note: item?.note ?? '' }}
        onSubmit={async (v) => { await api.patch(`/me/bucket/${item.id}`, v.remove ? { remove: true } : { status: v.status, target_date: v.target_date ?? null, note: v.note ?? null }); list.reload(); return v.remove ? 'Removed' : 'Updated'; }} />
    </>
  );
}


/** Several countries: chips for the chosen ones (tap to remove) and a search that suggests matching countries. */
export function CountriesMulti({ label: title, value = [], onChange, hint }) {
  const [q, setQ] = useState('');
  const typed = q.trim().toLowerCase();
  const found = typed ? COUNTRIES.filter((x) => x.toLowerCase().includes(typed) && !value.includes(x)).slice(0, 8) : [];
  return (
    <View style={{ gap: 8 }}>
      {title ? <T weight="800" size={13}>{title}</T> : null}
      {value.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{value.map((x) => <Chip key={x} active label={`🌍 ${x}  ✕`} onPress={() => onChange(value.filter((y) => y !== x))} />)}</View> : null}
      <Field value={q} onChangeText={setQ} placeholder={value.length ? 'Add another country…' : 'Search a country…'} />
      {found.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{found.map((x) => <Chip key={x} label={x} onPress={() => { onChange([...value, x]); setQ(''); }} />)}</View> : null}
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </View>
  );
}

/** Sport filter for study search: any sport, general sports (not tied to one sport), and/or specific sports (multi-select). */
export function SportFilter({ any, onAny, general, onGeneral, slugs, onSlugs }) {
  return (
    <View style={{ gap: 8 }}>
      <T weight="800" size={13}>Sports</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label="✨ Any sport" active={any} onPress={() => onAny(!any)} />
        <Chip label="🏅 General sports" active={general && !any} onPress={() => { onGeneral(!general); if (any) onAny(false); }} />
      </View>
      {any ? <T size={12} color={c.mute}>Showing everything, whatever the sport.</T> : (
        <>
          <T size={12} color={c.mute}>General sports = coaching, sports science, management and other courses not tied to one sport.</T>
          <SportsMulti value={slugs} onChange={onSlugs} />
        </>
      )}
    </View>
  );
}

// ------------------------------------------------------------------ explore
function SuggestionCard({ inst, push, onSaved }) {
  const { toast } = useSession();
  const save = async (type, id) => { try { await api.post('/me/bucket', { target_type: type, target_id: id }); toast('Saved to your bucket list'); onSaved(); } catch (e) { toast('' + e.message); } };
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <T weight="800" size={17} onPress={() => push('Institution', { id: inst.id, ext: true })}>{inst.name}</T>
          <T size={12} color={c.mute}>{label([['university', 'University'], ['college', 'College'], ['academy', 'Academy'], ['school', 'School'], ['institute', 'Institute'], ['other', 'Institution']], inst.kind)} · {place(inst)}</T>
        </View>
        <RatingTag rating={inst.rating} reviews={inst.reviews} />
      </View>
      {inst.known_for ? <T size={13} style={{ marginTop: 6 }}>{inst.known_for}</T> : null}
      {inst.programmes.map((p) => (
        <Row key={p.id} title={p.title} onPress={() => push('Programme', { id: p.id, ext: true })}
          sub={`${label(KINDS, p.kind)}${p.mode ? ` · ${label(MODES, p.mode)}` : ''}${p.duration_text ? ` · ${p.duration_text}` : ''}${p.fee_text ? `\n${p.fee_text}` : ''}${p.sports.length ? `\n${p.sports.map((s) => s.emoji).join(' ')}` : ''}`}
          right={<Chip label="🔖" onPress={() => save('study_programme', p.id)} />} />
      ))}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Btn small title="Details, contact & process" color={c.paper} ink={c.ink} onPress={() => push('Institution', { id: inst.id, ext: true })} />
        <Btn small title="🔖 Save college" color={c.violet} onPress={() => save('study_institution', inst.id)} />
      </View>
    </Card>
  );
}

export function Explore({ push, onSaved }) {
  const ctx = useLoad(() => api.get('/me/study/context'), []);
  const [any, setAny] = useState(false), [general, setGeneral] = useState(false), [slugs, setSlugs] = useState(null);
  const [countries, setCountries] = useState([]), [region, setRegion] = useState(null);
  const [q, setQ] = useState(''), [kind, setKind] = useState(null), [mode, setMode] = useState(null);
  const [ai, setAi] = useState(null), [busy, setBusy] = useState(false), [aiErr, setAiErr] = useState(null);
  useEffect(() => { if (ctx.data) { setSlugs((s) => s ?? ctx.data.sports.map((x) => x.slug)); setRegion((r) => r ?? ctx.data.regions[0] ?? ''); } }, [ctx.data]);
  const picked = any ? [] : (slugs ?? []);
  const reset = (set) => (v) => { set(v); setAi(null); };
  const ready = slugs !== null;
  const sportsQ = !any && (picked.length || general) ? { sports: picked.join(',') || undefined, general: general ? 'true' : undefined } : {};
  const placeQ = { countries: countries.join(',') || undefined, region: region || undefined };
  const params = { q: q.trim() || undefined, ...sportsQ, ...placeQ, kind: kind || undefined, mode: mode || undefined, limit: 50 };
  const dep = [ready, q, kind, mode, any, general, picked.join(','), countries.join(','), region];
  const progs = useLoad(() => (ready ? api.get('/programmes', params) : Promise.resolve(null)), dep);
  const insts = useLoad(() => (ready ? api.get('/institutions', { q: params.q, ...sportsQ, ...placeQ, limit: 20 }) : Promise.resolve(null)), dep);
  const hasPlace = countries.length > 0 || !!region;
  const need = !any && !picked.length && !general ? 'Pick a sport, General sports or Any sport' : (any || (!picked.length && general)) && !hasPlace ? 'Choose a country or region' : null;
  const ask = async (refresh) => {
    setBusy(true); setAiErr(null);
    try { setAi(await api.post('/me/study/discover', { sports: any || general || !picked.length ? undefined : picked, any_sport: any || (general && !picked.length), countries, region: region || undefined, refresh })); } catch (e) { setAiErr(e.message); }
    setBusy(false);
  };
  if (ctx.error) return <ErrorBox error={ctx.error} onRetry={ctx.reload} />;
  if (!ctx.data) return <Loading />;
  return (
    <>
      <Section title="What and where?" color={c.violet}>
        <SportFilter any={any} onAny={reset(setAny)} general={general} onGeneral={reset(setGeneral)} slugs={slugs ?? []} onSlugs={reset(setSlugs)} />
        {!ctx.data.sports.length ? <T size={12} color={c.mute}>Add sports to your profile and they will be filled in here for you.</T> : null}
        <CountriesMulti label="Countries" value={countries} onChange={reset(setCountries)} hint="Pick several to compare. Leave empty to search near your region only." />
        <RegionPicker label="City or area" optional value={region ?? ''} onChange={reset(setRegion)} hint={ctx.data.regions.length ? 'Filled in from your sport profile.' : undefined} />
        <Field value={q} onChangeText={setQ} placeholder="Narrow by course or college name…" />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Chip label="Any level" active={!kind} onPress={() => setKind(null)} />
          {KINDS.map(([k, l]) => <Chip key={k} label={l} active={kind === k} onPress={() => setKind(kind === k ? null : k)} />)}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Chip label="Any way of studying" active={!mode} onPress={() => setMode(null)} />
          {MODES.map(([k, l]) => <Chip key={k} label={l} active={mode === k} onPress={() => setMode(mode === k ? null : k)} />)}
        </View>
      </Section>

      <Section title="✨ Suggested by AI" color={c.pink}>
        <T size={13} color={c.mute}>Universities, colleges and academies with sport courses, certifications and degrees for your choices, including contacts and how to apply. Suggestions are not endorsements: always confirm with the institution.</T>
        <Btn title={ai ? 'Search again' : 'Find colleges with AI'} onPress={() => ask(!!ai)} loading={busy} disabled={!!need} />
        {need ? <T size={12} color={c.mute}>{need} to search.</T> : null}
        {aiErr ? <T color={c.red}>{aiErr}</T> : null}
        {ai ? (ai.institutions.length ? (
          <>
            <T size={12} color={c.mute}>{ai.cached ? 'Saved result from a recent search. ' : ''}{ai.disclaimer}</T>
            {ai.institutions.map((x) => <SuggestionCard key={x.id} inst={x} push={push} onSaved={onSaved} />)}
          </>
        ) : <Empty emoji="🔎" title="No suggestions" sub="Try more countries or a different sport." />) : null}
      </Section>

      <Section title="On Sportarena: ask them directly" color={c.cyan}>
        {progs.error ? <ErrorBox error={progs.error} onRetry={progs.reload} /> : !progs.data ? <Loading /> : progs.data.length ? progs.data.map((p) => (
          <Row key={p.id} title={p.title} onPress={() => push('Programme', { id: p.id })}
            sub={`${p.institution} · ${place(p)}\n${label(KINDS, p.kind)} · ${label(MODES, p.mode)}${p.sports.length ? '' : ' · General sports'}${p.reviews ? ` · ★ ${p.rating.toFixed(1)} (${p.reviews})` : ''}`}
            right={p.fee_minor != null ? <Tag label={moneyIn(p.fee_minor, p.currency)} /> : null} />
        )) : <Empty emoji="🏫" title="No listed courses match yet" sub="Institutions appear here once they list themselves. The AI suggestions above cover the rest." />}
        {insts.data?.length ? insts.data.map((o) => <Row key={o.id} title={o.name} sub={`${place(o)} · ${o.programmes} programme${o.programmes === 1 ? '' : 's'}${o.reviews ? ` · ★ ${o.rating.toFixed(1)} (${o.reviews})` : ''}`} onPress={() => push('Institution', { id: o.id })} />) : null}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ the bucket list
export function Saved({ push }) {
  const [stage, setStage] = useState(null);
  const list = useLoad(() => api.get('/me/bucket', { limit: 100 }), []);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const shown = list.data.filter((x) => !stage || x.status === stage);
  const open = (x) => (x.target_type.endsWith('programme') ? push('Programme', { id: x.target_id, ext: isExt(x.target_type) }) : push('Institution', { id: x.target_id, ext: isExt(x.target_type) }));
  return (
    <Section title={`Your bucket list${list.data.length ? ` (${list.data.length})` : ''}`} color={c.mint}>
      {list.data.length ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Chip label="All" active={!stage} onPress={() => setStage(null)} />
            {STAGES.map(([k, l]) => <Chip key={k} label={`${l} ${list.data.filter((x) => x.status === k).length || ''}`.trim()} active={stage === k} onPress={() => setStage(stage === k ? null : k)} />)}
          </View>
          {shown.map((x) => (
            <Row key={x.id} title={`${x.target_type.endsWith('programme') ? '📜' : '🏛️'} ${x.title}`} onPress={() => open(x)}
              sub={`${x.target_type.endsWith('programme') ? `${x.institution} · ` : ''}${[x.city, x.country].filter(Boolean).join(', ')}${x.reviews ? ` · ★ ${x.rating.toFixed(1)} (${x.reviews})` : ''}${x.target_date ? `\nDeadline ${new Date(x.target_date).toLocaleDateString()}` : ''}${x.note ? `\n${x.note}` : ''}`}
              right={<Tag label={label(STAGES, x.status)} />} />
          ))}
          {!shown.length ? <Empty emoji="🔖" title="Nothing at this stage" /> : null}
        </>
      ) : <Empty emoji="🔖" title="Your bucket list is empty" sub="Save colleges and courses from Explore. Track where you are with each, add deadlines and notes, and come back when you are ready to apply." />}
    </Section>
  );
}
