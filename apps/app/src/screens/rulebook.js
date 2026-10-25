// Tools > Rules & rulebook: each sport's standard rules as readable cards, a link to the official book, a printable booklet, and a way
// to localise the few rules a competition may change. The standard text is never edited: a local rule set is a named, versioned
// list of settings (scoped to you, an organisation, a team or an event) and a card that differs from the standard says so.
import React, { useMemo, useState } from 'react';
import { Platform, Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H2, Loading, Seg, T, Tag } from '../ui';
import { Counter } from '../pickers';
import { openLink } from './pathways';
import { c } from '../theme';

const SCOPES = [['personal', 'Just me'], ['organisation', 'An organisation'], ['team', 'A team'], ['event', 'An event']];
const show = (v, unit) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : `${v}${unit ? ` ${unit}` : ''}`);

export async function openBlobPdf(path, toast) {
  try {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return toast?.('Printable rulebooks open in the web app');
    const url = URL.createObjectURL(await api.download(path));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) { toast?.(e.message); }
}

/** One setting of a rule: a stepper for numbers, chips for fixed choices, a switch for on/off. */
function Setting({ p, value, onChange }) {
  const changed = value !== p.std;
  return (
    <View style={{ gap: 6 }} accessible={false}>
      <T weight="700" size={13}>{p.label}</T>
      {p.type === 'int' ? <Counter value={value} min={p.min} max={p.max} step={p.step ?? 1} suffix={p.unit ? ` ${p.unit}` : ''} onChange={onChange} />
        : p.type === 'choice' ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{p.options.map((o) => <Chip key={o} label={o} active={value === o} onPress={() => onChange(o)} />)}</View>
          : <Switch value={!!value} onValueChange={onChange} accessibilityLabel={p.label} />}
      {p.help ? <T size={12} color={c.mute}>{p.help}</T> : null}
      {changed ? <T size={12} weight="700" color={c.orange}>Standard: {show(p.std, p.unit)}</T> : null}
    </View>
  );
}

function RuleCard({ card, draft, setValue, reset }) {
  const [open, setOpen] = useState(false);
  const changed = card.params.some((p) => (p.key in draft ? draft[p.key] : p.value) !== p.std);
  return (
    <Card pad={16} accessibilityLabel={`${card.no} ${card.title}${changed ? ', local change' : ''}`} style={changed ? { borderWidth: 2, borderColor: c.orange } : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{card.no.toUpperCase()}</T>
        <View style={{ flex: 1 }} />
        <Tag label={changed ? 'Local change' : 'Standard'} color={changed ? c.orangeSoft : c.violetSoft} />
      </View>
      <H2>{card.title}</H2>
      <T>{card.body}</T>
      {card.params.length ? (
        <View style={{ gap: 10, marginTop: 4 }}>
          <Btn small title={open || changed ? 'Hide local settings' : 'Localise this rule'} color={c.violet} onPress={() => setOpen(!open)} style={{ alignSelf: 'flex-start' }} />
          {open || changed ? (
            <View style={{ gap: 12 }}>
              {card.params.map((p) => <Setting key={p.key} p={p} value={p.key in draft ? draft[p.key] : p.value} onChange={(v) => setValue(p.key, v)} />)}
              {changed ? <Btn small title="Back to the standard" color={c.violet} onPress={() => reset(card)} style={{ alignSelf: 'flex-start' }} /> : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

export function Rulebook({ sport }) {
  const { toast, user } = useSession();
  const { push } = useNav();
  const L = useLayout();
  const [format, setFormat] = useState(null);
  const [localId, setLocalId] = useState(null);
  const [draft, setDraft] = useState({});
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('personal');
  const [target, setTarget] = useState(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const book = useLoad(() => api.get(`/rulebook/${sport}`, { format: format ?? undefined, local_id: localId ?? undefined }), [sport, format, localId]);
  const locals = useLoad(() => api.get('/local-rules', { sport }), [sport]);
  const orgs = useLoad(() => (scope === 'organisation' ? api.get('/organisations') : Promise.resolve([])), [scope]);
  const teams = useLoad(() => (scope === 'team' ? api.get('/teams', { mine: true, limit: 50 }) : Promise.resolve([])), [scope]);
  const events = useLoad(() => (scope === 'event' ? api.get('/events', { organizer_id: user.id, limit: 50 }) : Promise.resolve([])), [scope]);
  const b = book.data;
  const current = (locals.data ?? []).find((x) => x.id === localId) ?? null;

  const cards = useMemo(() => (b?.cards ?? []).filter((x) => !q.trim() || `${x.no} ${x.title} ${x.body}`.toLowerCase().includes(q.trim().toLowerCase())), [b, q]);
  const merged = useMemo(() => Object.fromEntries((b?.cards ?? []).flatMap((x) => x.params.map((p) => [p.key, p.key in draft ? draft[p.key] : p.value]))), [b, draft]);
  const changes = (b?.cards ?? []).flatMap((x) => x.params.filter((p) => merged[p.key] !== p.std).map((p) => ({ card: x.title, p, value: merged[p.key] })));
  const dirty = Object.keys(draft).length > 0;

  const pick = (id) => { setLocalId(id); setDraft({}); setErr(null); const s = (locals.data ?? []).find((x) => x.id === id); setFormat(s?.format || format); };
  const setValue = (key, v) => setDraft((d) => ({ ...d, [key]: v }));
  const reset = (card) => setDraft((d) => ({ ...d, ...Object.fromEntries(card.params.map((p) => [p.key, p.std])) }));
  const targets = scope === 'organisation' ? (orgs.data ?? []).filter((o) => o.my_status === 'active' && ['owner', 'admin', 'coach'].includes(o.my_role)) : scope === 'team' ? (teams.data ?? []) : scope === 'event' ? (events.data ?? []) : [];

  const publish = async (asNew) => {
    setBusy(true); setErr(null);
    try {
      const body = { settings: Object.fromEntries(changes.map((x) => [x.p.key, x.value])), note: note.trim() || undefined };
      const r = !asNew && localId
        ? await api.post('/local-rules', { set_id: localId, ...body })
        : await api.post('/local-rules', { sport, format: b.format || undefined, scope, name: name.trim(), ...(scope === 'organisation' ? { organisation_id: target } : scope === 'team' ? { team_id: target } : scope === 'event' ? { event_id: target } : {}), ...body });
      toast(`Local rules published (version ${r.current_version})`);
      await locals.reload(); setLocalId(r.id); setDraft({}); setName(''); setNote('');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (book.error) return <ErrorBox error={book.error} onRetry={book.reload} />;
  if (!b) return <Loading />;
  const ownsCurrent = !!current;
  const canNew = name.trim().length >= 2 && (scope === 'personal' || !!target);
  return (
    <View style={{ gap: 14 }}>
      <Card pad={16} color={c.mintSoft}>
        <T size={28}>{b.emoji}</T>
        <H2>{b.name} rulebook</H2>
        <T size={13} color={c.mute}>Source: {b.body}. {b.note}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
          <Btn small title="Official book ↗" color={c.cyan} onPress={() => openLink(b.official_url)} />
          <Btn small title="Rulebook PDF" color={c.pink} onPress={() => openBlobPdf(`/rulebook/${sport}/pdf?${new URLSearchParams({ ...(b.format ? { format: b.format } : {}), ...(localId ? { local_id: localId } : {}) })}`, toast)} />
          <Btn small title="Start a scoring sheet" color={c.violet} onPress={() => push('ScoringTool', { tab: 'start', sport, localRulesId: localId, variant: b.format || undefined })} />
        </View>
      </Card>

      {b.formats ? (
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Format</T>
          <Seg options={b.formats.map((f) => ({ label: f, value: f }))} value={b.format} onChange={(f) => { setFormat(f); setLocalId(null); setDraft({}); }} />
        </View>
      ) : null}

      <View style={{ gap: 6 }}>
        <T weight="800" size={13}>Rules in force</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Chip label="Standard rules" active={!localId} onPress={() => pick(null)} />
          {(locals.data ?? []).filter((x) => !x.format || x.format === (b.format || '')).map((x) => <Chip key={x.id} label={`${x.name} · v${x.current_version}${x.scope === 'personal' ? '' : ` · ${x.organisation_name ?? x.team_name ?? x.event_name ?? x.scope}`}`} active={localId === x.id} onPress={() => pick(x.id)} />)}
        </View>
        {localId && current ? <T size={12} color={c.mute}>Local rules: {current.name} (version {current.current_version}). Cards that differ from the standard are marked.</T> : <T size={12} color={c.mute}>Change a rule below to make local rules for your competition, club or team.</T>}
      </View>

      <Field label="Search the rules" value={q} onChangeText={setQ} placeholder="e.g. offside, overs, timeout" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {cards.length ? cards.map((x) => (
          <View key={x.key} style={{ width: L.tablet ? '48.5%' : '100%', flexGrow: 1 }}><RuleCard card={x} draft={draft} setValue={setValue} reset={reset} /></View>
        )) : <Empty emoji="🔎" title="No rule matches" sub="Try another word." />}
      </View>

      <Card pad={16} color={changes.length ? c.orangeSoft : c.paper}>
        <H2>Your local rules for {b.name}</H2>
        {changes.length ? changes.map((x) => <T key={x.p.key} size={13}><T weight="800" size={13}>{x.card}:</T> {x.p.label} {show(x.value, x.p.unit)} <T size={12} color={c.mute}>(standard {show(x.p.std, x.p.unit)})</T></T>) : <T size={13} color={c.mute}>No changes: this competition plays the standard rules.</T>}
        {changes.length || dirty ? (
          <View style={{ gap: 10, marginTop: 8 }}>
            {ownsCurrent ? <Btn title={`Publish as version ${current.current_version + 1} of “${current.name}”`} loading={busy} onPress={() => publish(false)} disabled={!dirty} /> : null}
            <T weight="800" size={13}>{ownsCurrent ? 'Or save as a new set' : 'Save as'}</T>
            <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Under-12 league rules" maxLength={80} />
            <T weight="800" size={13}>Applies to</T>
            <Seg options={SCOPES.map(([value, label]) => ({ label, value }))} value={scope} onChange={(s) => { setScope(s); setTarget(null); }} />
            {scope !== 'personal' ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {targets.length ? targets.map((o) => <Chip key={o.id} label={o.name} active={target === o.id} onPress={() => setTarget(o.id)} />) : <T size={12} color={c.mute}>{scope === 'organisation' ? 'You are not an owner, admin or coach of an organisation.' : scope === 'team' ? 'You have no teams yet.' : 'You are not running an event.'}</T>}
              </View>
            ) : null}
            <Field label="Why (optional)" value={note} onChangeText={setNote} multiline maxLength={300} />
            {err ? <T weight="700" size={13} color={c.red} accessibilityRole="alert">{err}</T> : null}
            <Btn title="Publish local rules" loading={busy} disabled={!canNew} onPress={() => publish(true)} />
            <T size={12} color={c.mute}>Publishing makes a new version. The standard rules are never edited, and games already played keep the rules they were played under.</T>
          </View>
        ) : null}
      </Card>
    </View>
  );
}
