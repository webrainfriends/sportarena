// Athlete assistant (issue #337): ask once, get one source-linked answer across calendar, development, progress and opportunities.
// The screen only calls POST /me/assistant/answers and its resolve/export siblings. An answer is a draft: nothing is saved
// until the player reviews the suggested actions and confirms. A guardian (child_id) gets the same read-only, minus actions.
import React, { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Sheet, T, Tag } from '../ui';
import { HScroll, DateRangeField } from '../pickers';
import { useLayout } from '../layout';
import { c } from '../theme';

const PRESETS = [['week', 'My week'], ['focus', 'What should I work on?'], ['opportunities', 'Opportunities for me'], ['feedback', 'Explain my coach feedback'], ['overview', 'Everything'], ['ask', 'Ask my own question']];
const SOURCES = [['schedule', 'Schedule'], ['development', 'Development'], ['progress', 'Progress'], ['opportunities', 'Opportunities']];
const TONE = { good: c.mintSoft, watch: c.sunSoft, info: c.violetSoft };
const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const say = (e) => (e?.code === 'guardian_consent_required' ? e.message : e?.code === 'stale_version' || e?.code === 'stale_answer' ? `${e.message} Ask again to refresh.` : e?.message ?? 'Something went wrong, try again');
const key = () => `asst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const iso = (d) => d.toISOString().slice(0, 10);

function ItemView({ it, sources, open, onOpen }) {
  const [why, setWhy] = useState(false);
  const refs = it.source_refs.map((r) => sources.find((s) => s.ref === r)).filter(Boolean);
  return (
    <View style={{ backgroundColor: TONE[it.tone] ?? c.violetSoft, borderRadius: 14, padding: 12, marginTop: 10, gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <T weight="700" style={{ flexShrink: 1 }}>{it.title}</T>
        <Tag label={it.basis === 'observed' ? 'Observed' : 'Suggestion'} color={it.basis === 'observed' ? c.mint : c.sunSoft} />
      </View>
      {it.detail ? <T size={13}>{it.detail}</T> : null}
      {refs.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {refs.map((s) => (
            <Pressable key={s.ref} onPress={s.link ? () => onOpen(s.link) : undefined} accessibilityRole={s.link ? 'link' : 'text'} accessibilityLabel={`Source: ${s.label}, ${s.evidence}`}
              style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper, maxWidth: '100%' }}>
              <T size={12} weight="600">{label(s.kind)} · {s.label}</T>
              <T size={11} color={c.mute}>{s.evidence}{s.at ? ` · ${String(s.at).slice(0, 10)}` : ''}{s.link ? ' · open ›' : ''}</T>
            </Pressable>
          ))}
        </View>
      ) : <T size={11} color={c.mute}>No record backs this, so it is only a suggestion.</T>}
      {it.why ? (
        <Pressable onPress={() => setWhy(!why)} accessibilityRole="button" accessibilityLabel={`Why: ${it.title}`} style={{ minHeight: 44, justifyContent: 'center' }}>
          <T size={12} weight="700" color={c.pink}>{why ? 'Hide why' : 'Why am I seeing this?'}</T>
          {why ? <T size={12} color={c.mute}>{it.why}</T> : null}
        </Pressable>
      ) : null}
    </View>
  );
}

/** Review sheet: pick which suggested actions to add, edit titles, confirm. Nothing is applied for, accepted, signed or paid. */
function ReviewSheet({ answer, visible, onClose, onDone }) {
  const { toast } = useSession();
  const { push } = useNav();
  const acts = answer.output.items.filter((x) => x.action);
  const [on, setOn] = useState(() => new Set(acts.filter((x) => x.action.kind === 'goal').map((x) => x.id)));
  const [titles, setTitles] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const toggle = (id) => setOn((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const confirm = async () => {
    setBusy(true); setErr(null);
    try {
      const chosen = acts.filter((x) => on.has(x.id));
      const r = await api.post(`/me/assistant/answers/${answer.id}/resolve`, { decision: 'accept', row_version: answer.row_version, actions: chosen.map((x) => ({ item_id: x.id, ...(titles[x.id] && titles[x.id] !== x.action.title ? { title: titles[x.id] } : {}) })) });
      const goals = r.resolution?.goals?.length ?? 0;
      toast(goals ? `${goals} goal${goals === 1 ? '' : 's'} added to your development` : 'Done');
      onDone(r);
      const first = chosen.find((x) => x.action.kind === 'open');
      if (first && !goals) push(first.action.link.screen, first.action.link.params ?? {});
    } catch (e) { setErr(e); }
    setBusy(false);
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Review before adding" footer={<><Btn small title="Not now" color={c.paper} ink={c.ink} onPress={onClose} /><View style={{ flex: 1 }} /><Btn title={`Add ${on.size}`} disabled={!on.size} loading={busy} onPress={confirm} /></>}>
      <T size={13} color={c.mute}>Only what you tick is saved, as your own record. The assistant never accepts an offer, applies, signs or pays for you.</T>
      {acts.map((x) => (
        <View key={x.id} style={{ borderTopWidth: 1, borderColor: c.line, paddingTop: 10, gap: 6 }}>
          <Pressable onPress={() => toggle(x.id)} accessibilityRole="checkbox" accessibilityState={{ checked: on.has(x.id) }} accessibilityLabel={x.action.title} style={{ flexDirection: 'row', gap: 10, minHeight: 44, alignItems: 'center' }}>
            <View style={{ width: 26, height: 26, borderRadius: 8, borderWidth: 2, borderColor: c.ink, backgroundColor: on.has(x.id) ? c.ink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>{on.has(x.id) ? <T color={c.inkOn} size={14} weight="800">✓</T> : null}</View>
            <View style={{ flex: 1 }}><T weight="700">{x.action.title}</T><T size={12} color={c.mute}>{x.action.kind === 'goal' ? 'Saved as your own goal' : 'Opens the existing screen'}</T></View>
          </Pressable>
          {x.action.kind === 'goal' && on.has(x.id) ? <Field label="Goal wording" value={titles[x.id] ?? x.action.title} onChangeText={(v) => setTitles({ ...titles, [x.id]: v })} maxLength={160} /> : null}
        </View>
      ))}
      {err ? <ErrorBox error={{ message: say(err) }} /> : null}
    </Sheet>
  );
}

const saveCsv = (filename, csv, setText) => {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  } else setText(csv);
};

/** Assistant for me, or (child_id) a verified guardian's read-only view for a young person. */
export function PlayerAssistant({ child_id, name }) {
  const { toast } = useSession();
  const { push } = useNav();
  const { tablet } = useLayout();
  const self = !child_id;
  const profiles = useLoad(() => (self ? api.get('/me/sport-profiles') : Promise.resolve([])), [self]);
  const [task, setTask] = useState('week');
  const [question, setQuestion] = useState('');
  const [sources, setSources] = useState(['schedule', 'development', 'progress', 'opportunities']);
  const [sport, setSport] = useState(null);
  const [range, setRange] = useState({ from: iso(new Date()), to: iso(new Date(Date.now() + 14 * 864e5)) });
  const [state, setState] = useState({ busy: false, error: null, answer: null });
  const [review, setReview] = useState(false);
  const [csv, setCsv] = useState(null);
  const attempt = useRef(null);
  const allowed = SOURCES.filter(([k]) => self || k !== 'schedule');
  const athleteSports = useMemo(() => (profiles.data ?? []).filter((p) => p.role === 'athlete'), [profiles.data]);

  const toggle = (k) => setSources((s) => (s.includes(k) ? (s.length > 1 ? s.filter((x) => x !== k) : s) : [...s, k]));
  const ask = async () => {
    // one idempotency key per attempt: a retry after a dropped connection returns the same answer
    attempt.current = attempt.current ?? key();
    setState((s) => ({ ...s, busy: true, error: null })); setCsv(null);
    try {
      const a = await api.post('/me/assistant/answers', { task, ...(task === 'ask' ? { question } : {}), ...(child_id ? { athlete_id: child_id } : {}), sources: sources.filter((k) => allowed.some(([x]) => x === k)), ...(sport ? { sport } : {}), from: range.from, to: range.to, client_key: attempt.current });
      attempt.current = null;
      setState({ busy: false, error: null, answer: a });
    } catch (e) { setState((s) => ({ ...s, busy: false, error: e })); if (e.status && e.status < 500) attempt.current = null; }
  };
  const { busy, error, answer } = state;
  const acts = answer?.output?.items?.filter((x) => x.action) ?? [];
  const resolved = answer && answer.status !== 'draft';
  const discard = async () => {
    try { const r = await api.post(`/me/assistant/answers/${answer.id}/resolve`, { decision: 'discard' }); setState({ busy: false, error: null, answer: r }); toast('Discarded. Nothing was saved.'); } catch (e) { toast(say(e)); }
  };
  const exportCsv = async () => {
    try { const e = await api.get(`/me/assistant/answers/${answer.id}/export`); saveCsv(e.filename, e.csv, setCsv); toast('Exported. This download is logged.'); } catch (e) { toast(say(e)); }
  };
  const form = (
    <Card>
      <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>ASK</T>
      <View style={{ marginTop: 8 }}><HScroll>{PRESETS.filter(([k]) => self || k !== 'ask').map(([k, l]) => <Chip key={k} label={l} active={task === k} onPress={() => setTask(k)} />)}</HScroll></View>
      {task === 'ask' ? <View style={{ marginTop: 10 }}><Field label="Your question" value={question} onChangeText={setQuestion} multiline maxLength={400} placeholder="What do you want to know about your own records?" /></View> : null}
      <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 1, marginTop: 14 }}>USE THESE SOURCES</T>
      <View style={{ marginTop: 8 }}><HScroll>{allowed.map(([k, l]) => <Chip key={k} label={`${sources.includes(k) ? '✓ ' : ''}${l}`} active={sources.includes(k)} onPress={() => toggle(k)} />)}</HScroll></View>
      {self && athleteSports.length > 1 ? (
        <>
          <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 1, marginTop: 14 }}>SPORT</T>
          <View style={{ marginTop: 8 }}><HScroll><Chip label="All my sports" active={!sport} onPress={() => setSport(null)} />{athleteSports.map((p) => <Chip key={p.id} label={`${p.sport_emoji ?? ''} ${p.sport}`.trim()} active={sport === p.sport_slug} onPress={() => setSport(p.sport_slug)} />)}</HScroll></View>
        </>
      ) : null}
      {self && sources.includes('schedule') ? <View style={{ marginTop: 14 }}><DateRangeField label="Calendar period" from={range.from} to={range.to} onChange={(r) => setRange({ from: r.from, to: r.to })} hint="Up to 92 days." /></View> : null}
      <View style={{ marginTop: 14, flexDirection: 'row' }}><Btn title="Ask assistant" loading={busy} disabled={task === 'ask' && question.trim().length < 2} onPress={ask} accessibilityLabel="Ask assistant" /></View>
      <T size={12} color={c.mute} style={{ marginTop: 10 }}>🔒 Reads only records you may already see. A young person's guardian consent is checked on every ask, and switching it off hides these sources at once.</T>
    </Card>
  );
  const result = busy ? <Loading /> : error ? <ErrorBox error={{ message: say(error) }} onRetry={ask} /> : !answer ? (
    <Empty emoji="🧭" title="Ask anything about your week, progress or options" sub="Pick a question, choose the sources and ask. The answer shows exactly which records it used." />
  ) : answer.hidden ? <Empty emoji="🔒" title="Hidden until consent is restored" sub={answer.note} /> : (
    <>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>ANSWER · {answer.ai ? 'AI-worded' : 'built-in rules'}</T>
          <Tag label={answer.stale && !resolved ? 'Out of date' : label(answer.status)} color={answer.status === 'draft' ? c.sunSoft : c.mint} />
        </View>
        <T weight="800" size={17} style={{ marginTop: 6 }}>{answer.output.headline}</T>
        {answer.output.items.length ? answer.output.items.map((it) => <ItemView key={it.id} it={it} sources={answer.sources} onOpen={(l) => push(l.screen, l.params ?? {})} />) : <T size={13} color={c.mute} style={{ marginTop: 8 }}>Nothing to show from the sources you chose.</T>}
        {answer.limitations.length ? (
          <View style={{ backgroundColor: c.sunSoft, borderRadius: 14, padding: 12, marginTop: 12, gap: 2 }}>
            <T weight="700" size={13}>Data limits</T>
            {answer.limitations.map((l) => <T key={l} size={12} color={c.mute}>• {l}</T>)}
          </View>
        ) : null}
      </Card>
      {acts.length && self ? (
        <Card style={{ marginTop: 12 }}>
          <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>SUGGESTED ACTIONS · YOU DECIDE</T>
          {acts.map((x) => <T key={x.id} size={13} style={{ marginTop: 6 }}>• {x.action.title} <T size={12} color={c.mute}>({x.action.kind === 'goal' ? 'saved as your goal' : 'opens existing screen'})</T></T>)}
          {resolved ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>{answer.status === 'discarded' ? 'Discarded. Nothing was saved.' : `Reviewed${answer.resolution?.goals?.length ? `: ${answer.resolution.goals.length} goal(s) added.` : '.'}`}</T> : (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <Btn small title="Discard" color={c.paper} ink={c.ink} onPress={discard} />
              <Btn small title="Review & add" disabled={answer.stale} onPress={() => setReview(true)} />
            </View>
          )}
          {answer.stale && !resolved ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Records may have changed since this answer. Ask again.</T> : null}
        </Card>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}><Btn small title="Export CSV" color={c.paper} ink={c.ink} onPress={exportCsv} /><Btn small title="Ask again" color={c.paper} ink={c.ink} onPress={ask} /></View>
      {csv ? <Card pad={12} style={{ marginTop: 8 }}><T size={12} selectable>{csv}</T></Card> : null}
      {review ? <ReviewSheet answer={answer} visible onClose={() => setReview(false)} onDone={(r) => { setReview(false); setState({ busy: false, error: null, answer: r }); }} /> : null}
    </>
  );
  return (
    <Screen wide>
      <H1>{child_id ? `${name ?? 'Your child'} · assistant` : 'Assistant'}</H1>
      <T size={13} color={c.mute}>{child_id ? 'Read-only. Built only from what you may already see for them.' : 'Part of My development. Answers only from records you may see; nothing changes until you review it. It never gives medical, contract or payment advice.'}</T>
      <View style={{ marginTop: 12, flexDirection: tablet ? 'row' : 'column', gap: 16, alignItems: 'flex-start' }}>
        <View style={{ width: tablet ? 340 : '100%' }}>{form}</View>
        <View style={{ flex: 1, minWidth: 0, width: tablet ? undefined : '100%' }}>{result}</View>
      </View>
    </Screen>
  );
}
