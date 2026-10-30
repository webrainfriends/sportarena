// "What this service needs" (follow-up to #591): the list is built by the API from the event (rules, usual credentials, optional AI drafts), not typed or fixed.
// The buyer ticks what applies and can add their own. AI drafts are tagged "verify"; live conditions say plainly when no data source is connected.
import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { c } from '../theme';
import { Btn, Field, Sheet, T } from '../ui';
import { MenuField } from '../menu-field';

const TAG = { rule: ['RULE', c.limeSoft, c.lime], catalogue: ['USUAL', c.cyanSoft, c.cyan], ai: ['AI · VERIFY', c.sunSoft, c.sun], custom: ['YOURS', c.violetSoft, c.violet] };
const KINDS = ['insurance', 'electrical', 'pool_operator', 'first_aid', 'safeguarding', 'vehicle', 'food_safety', 'business_registration', 'other'];
const words = (k) => k.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

function NeedRow({ it, on, onToggle }) {
  const [txt, bg, fg] = TAG[it.source] ?? TAG.custom;
  return (
    <Pressable onPress={onToggle} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`${it.label}. ${txt.toLowerCase()}${it.kind ? `, checked against the supplier's ${words(it.kind).toLowerCase()} credential` : ''}`}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: on ? c.pink : c.line, backgroundColor: on ? c.violetSoft : pressed ? c.bg : c.paper })}>
      <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 2, borderColor: c.pink, backgroundColor: on ? c.pink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>{on ? <T size={12} weight="800" color={c.onAccent}>✓</T> : null}</View>
      <View style={{ flex: 1 }}><T weight="700" size={14}>{it.label}</T>{it.detail ? <T size={12} color={c.mute}>{it.detail}</T> : null}{it.kind && it.source !== 'ai' ? <T size={11} color={c.mute}>Checked when suppliers quote and when you award</T> : null}</View>
      <View style={{ backgroundColor: bg, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 }}><T size={10} weight="800" color={fg}>{txt}</T></View>
    </Pressable>
  );
}

const Group = ({ title, sub, children }) => (children && React.Children.count(children) ? (
  <View style={{ gap: 6 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800" size={12} color={c.mute} style={{ letterSpacing: 0.5 }}>{title.toUpperCase()}</T>{sub ? <T size={11} color={c.mute}>{sub}</T> : null}</View>
    {children}
  </View>
) : null);

/** value: the chosen items (stored on the requirement); onChange(items). buyerId + category are what the suggestions are built from. */
export function NeedsPicker({ buyerId, category, startsAt, endsAt, value = [], onChange }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const load = async (ai) => {
    if (!category) return;
    setBusy(true); setErr(null);
    try { setS(await api.post(`/service-buyers/${buyerId}/needs/suggest`, { category, ai: !!ai, ...(startsAt ? { starts_at: startsAt } : {}), ...(endsAt ? { ends_at: endsAt } : {}) })); } catch (e) { setErr(e.message ?? 'Could not load suggestions'); } finally { setBusy(false); }
  };
  useEffect(() => { setS(null); load(false); }, [buyerId, category, startsAt, endsAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const has = (k) => value.some((x) => x.key === k);
  const toggle = (it) => onChange(has(it.key) ? value.filter((x) => x.key !== it.key) : [...value, { key: it.key, label: it.label, detail: it.detail, source: it.source, kind: it.kind, rule_id: it.rule_id }]);
  const g = s?.groups;
  // chosen items stay visible even if the suggestions change
  const mine = value.filter((x) => x.source === 'custom');
  const stale = value.filter((x) => x.source !== 'custom' && ![...(g?.rules ?? []), ...(g?.suggested ?? []), ...(g?.ai ?? [])].some((y) => y.key === x.key));
  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 2 }}><T weight="800" size={13}>What this service needs</T><T size={12} color={c.mute}>Built from the event, its sport, venue and dates. Tick what applies.</T></View>
      {s?.context ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[words(s.context.category), s.context.purpose, ...(s.context.sports ?? []), s.context.city, s.context.starts_on ? String(s.context.starts_on).slice(0, 10) : null].filter(Boolean).map((t) => <View key={t} style={{ backgroundColor: c.pinkSoft, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 3 }}><T size={11}>{t}</T></View>)}</View> : null}
      {busy && !s ? <T size={12} color={c.mute}>Working out what applies…</T> : null}
      {err ? <View style={{ gap: 6 }}><T size={12} color={c.red}>{err}</T><Btn small color={c.paper} ink={c.ink} title="Try again" onPress={() => load(false)} accessibilityLabel="Try loading the suggestions again" /></View> : null}
      <Group title="Required by rules" sub="from the compliance module">{(g?.rules ?? []).map((it) => <NeedRow key={it.key} it={it} on={has(it.key)} onToggle={() => toggle(it)} />)}</Group>
      <Group title="Suggested for this service" sub="usual for this kind of work">{(g?.suggested ?? []).map((it) => <NeedRow key={it.key} it={it} on={has(it.key)} onToggle={() => toggle(it)} />)}</Group>
      {s ? (
        <View accessible accessibilityLabel={`Live conditions: ${s.live.note}`} style={{ borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.bg, padding: 10, opacity: 0.85 }}>
          <T size={12} weight="700">Weather, traffic and health advisories</T><T size={11} color={c.mute}>{s.live.connected ? 'Connected' : 'Not connected yet. Connect a provider to see real alerts here.'}</T>
        </View>
      ) : null}
      <Group title="AI suggestions" sub="unverified">{(g?.ai ?? []).map((it) => <NeedRow key={it.key} it={it} on={has(it.key)} onToggle={() => toggle(it)} />)}</Group>
      <Group title="Your own items">{[...mine, ...stale].map((it) => <NeedRow key={it.key} it={it} on onToggle={() => toggle(it)} />)}</Group>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Btn small color={c.paper} ink={c.ink} title="＋ Add your own" onPress={() => setDraft({ label: '', kind: '' })} accessibilityLabel="Add your own requirement" />
        <Btn small title={busy ? 'Thinking…' : '✨ Ask AI to suggest more'} disabled={busy || !category || (s && !s.ai.available)} onPress={() => load(true)} accessibilityLabel="Ask AI to suggest more requirements for this event" />
      </View>
      {s && !s.ai.available ? <T size={11} color={c.mute}>AI help is not switched on for this installation. Everything else works without it.</T> : null}
      {s?.ai.used && !(g?.ai ?? []).length ? <T size={11} color={c.mute}>AI had nothing to add beyond what is listed.</T> : null}
      <T size={11} color={c.mute}>{s?.ai.note ?? 'AI only drafts suggestions from this event’s facts; a person confirms every item.'}</T>
      <Sheet visible={!!draft} onClose={() => setDraft(null)} title="Add your own requirement">
        {draft ? (
          <View style={{ gap: 12 }}>
            <Field label="What the supplier must have or do" value={draft.label} onChangeText={(x) => setDraft({ ...draft, label: x })} maxLength={120} accessibilityLabel="Requirement" />
            <MenuField label="Check it against a supplier credential (optional)" value={draft.kind} onChange={(x) => setDraft({ ...draft, kind: x })} options={[{ value: '', label: 'No check, state it in the request' }, ...KINDS.map((k) => ({ value: k, label: words(k) }))]} hint="With a credential chosen, suppliers without a current one cannot quote or be awarded." />
            <Btn title="Add" disabled={draft.label.trim().length < 2} onPress={() => { onChange([...value, { key: `custom:${Date.now().toString(36)}`, label: draft.label.trim(), source: 'custom', ...(draft.kind ? { kind: draft.kind } : {}) }]); setDraft(null); }} accessibilityLabel="Add this requirement" />
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}
