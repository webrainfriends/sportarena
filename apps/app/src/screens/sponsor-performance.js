import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain } from '../access';

// Performance review for an agreement with an individual athlete. Results are read live from the athlete's own records and only while
// they have shared them; objectives are a review aid and never change a due.
const loadOr = async (fn) => { try { return { data: await fn() }; } catch (e) { return { error: e }; } };
const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function SponsorPerformance({ deal }) {
  const { toast } = useSession();
  const sponsor = deal.role === 'sponsor', recipient = deal.role === 'recipient';
  const mayEvaluate = !sponsor || !deal.can || deal.can.includes('evaluate'); // finance, legal and approvers can read but not set objectives or write reviews
  const perf = useLoad(() => loadOr(() => api.get(`/sponsorships/${deal.id}/performance`)), [deal.id]);
  const reviews = useLoad(() => loadOr(() => api.get(`/sponsorships/${deal.id}/reviews`)), [deal.id]);
  const [form, setForm] = useState(null);
  const reload = () => { perf.reload(); reviews.reload(); };
  const act = async (fn, m) => { try { await fn(); toast(m); reload(); } catch (e) { toast(explain(e)); if (e.status === 409) reload(); } };
  const p = perf.data?.data, list = reviews.data?.data ?? [];
  const live = ['active', 'ended', 'term_expired'].includes(deal.status);
  const shared = p?.access.enabled;
  return (
    <Section title="Performance & reviews" color={c.cyan}>
      {recipient ? (
        <Card>
          <T weight="900">{shared ? `Sharing ${p.access.scope === 'official' ? 'official results' : 'all your results'} with ${deal.sponsor.name}` : `Your results are not shared with ${deal.sponsor.name}`}</T>
          <T size={12} color={c.mute}>Private match notes, ratings, health and contact details are never shared. You can switch this off at any time; payments and the agreement are not affected.</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            {deal.status === 'active' ? <Btn small title={shared ? 'Share official results only' : 'Share official results'} color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/sponsorships/${deal.id}/performance-access`, { enabled: true, scope: 'official' }), 'Sharing on')} /> : null}
            {deal.status === 'active' ? <Btn small title="Also share practice & imported" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/sponsorships/${deal.id}/performance-access`, { enabled: true, scope: 'all_evidence' }), 'Sharing on')} /> : null}
            {shared ? <Btn small title="Stop sharing" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/sponsorships/${deal.id}/performance-access`, { enabled: false }), 'Sharing off')} /> : null}
          </View>
        </Card>) : null}
      {perf.data?.error && sponsor ? <Empty emoji="🔒" title="Not shared" sub={live ? `${perf.data.error.message}` : 'Results become available once the athlete accepts and shares them.'} /> : null}
      {p ? (
        <>
          {p.metrics.length ? p.metrics.map((m) => (
            <Card key={`${m.sport}-${m.metric}-${m.evidence}`}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="900" style={{ flex: 1 }}>{m.sport_name} · {m.metric}</T><Tag label={m.evidence_label} color={m.evidence === 'approved_competition' ? c.lime : c.sunSoft} /></View>
              <T size={12} color={c.mute}>{m.results} result{m.results === 1 ? '' : 's'} · {day(m.first_on)} – {day(m.latest_on)} · best {m.best}{m.unit ? ` ${m.unit}` : ''} ({m.direction === 'lower' ? 'lower is better' : 'higher is better'}) · latest {m.latest}</T>
            </Card>)) : <Empty emoji="📈" title="No results yet" sub="Nothing recorded yet in what is shared. Different sports and evidence are never combined into one score." />}
          {p.objectives.map((o) => (
            <Card key={o.id}>
              <T weight="900">{o.sport} · {o.metric}: target {o.target_value} ({o.direction === 'lower' ? 'lower' : 'higher'} is better)</T>
              <T size={12} color={c.mute}>{day(o.window_start)} – {day(o.window_end)}{o.baseline_value != null ? ` · baseline ${o.baseline_value} on ${day(o.baseline_on)}` : ''} · {o.status}. A review aid only — it never changes a payment.</T>
              {o.progress ? <T size={12}>{o.progress.state === 'measured' ? `Best in window ${o.progress.best_in_window} · ${o.progress.met ? 'target met' : 'target not met yet'} (${o.progress.results} results, ${o.progress.source})` : o.progress.note}</T> : null}
              {recipient && o.status === 'proposed' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}><Btn small title="Agree" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorship-objectives/${o.id}`, { status: 'agreed' }), 'Objective agreed')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/sponsorship-objectives/${o.id}`, { status: 'declined' }), 'Declined')} /></View> : null}
              {sponsor && mayEvaluate ? <Btn small title="Archive" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => act(() => api.patch(`/sponsorship-objectives/${o.id}`, { status: 'archived' }), 'Archived')} /> : null}
            </Card>))}
        </>) : null}
      {sponsor && mayEvaluate && ['proposed', 'active'].includes(deal.status) ? <Btn small title="Propose a review objective" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('objective')} /> : null}
      {list.map((r) => (
        <Card key={r.id}>
          <T size={12} color={c.mute}>{day(r.created_at)} · {r.author}{r.visibility === 'author_only' ? ' · only you' : ''}{r.next_review_on ? ` · next review ${day(r.next_review_on)}` : ''}</T>
          <T>{r.body}</T>
          {r.response ? <T size={12} color={c.mute}>Reply: {r.response}</T> : recipient && !r.mine && r.visibility === 'shared' ? <Btn small title="Reply" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => setForm({ reply: r })} /> : null}
        </Card>))}
      {live && mayEvaluate ? <Btn small title="Add a review note" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('review')} /> : null}

      <FormSheet visible={form === 'objective'} onClose={() => setForm(null)} title="Review objective" submitLabel="Propose"
        fields={[{ key: 'sport', label: 'Sport', type: 'sport', optional: false }, { key: 'metric', label: 'Metric', hint: 'As recorded for the sport, e.g. 100m_time_s or goals' },
          { key: 'direction', label: 'Better is', type: 'chips', options: [{ value: 'higher', label: 'Higher' }, { value: 'lower', label: 'Lower (times)' }] },
          { key: 'evidence', label: 'Evidence that counts', type: 'chips', options: [{ value: 'approved_competition', label: 'Official results' }, { value: 'self_reported', label: 'Self-reported' }, { value: 'imported', label: 'Imported' }] },
          { key: 'target_value', label: 'Target', type: 'number' }, { key: 'baseline_value', label: 'Baseline', type: 'number', optional: true }, { key: 'baseline_on', label: 'Baseline date', type: 'date', optional: true },
          { key: 'window_start', label: 'Evaluation window', type: 'daterange', toKey: 'window_end' }]}
        onSubmit={async (v) => { await api.post(`/sponsorships/${deal.id}/objectives`, v); reload(); return 'Proposed — the athlete decides whether to agree'; }} />
      <FormSheet visible={form === 'review'} onClose={() => setForm(null)} title="Review note" submitLabel="Save"
        fields={[{ key: 'body', label: 'Note', type: 'multiline' }, { key: 'visibility', label: 'Who can read it', type: 'chips', options: [{ value: 'shared', label: 'Both sides' }, { value: 'author_only', label: 'Only me' }] }, { key: 'next_review_on', label: 'Next review', type: 'date', optional: true }]}
        onSubmit={async (v) => { await api.post(`/sponsorships/${deal.id}/reviews`, v); reload(); return 'Saved'; }} />
      <FormSheet visible={!!form?.reply} onClose={() => setForm(null)} title="Reply to review" submitLabel="Send" fields={[{ key: 'response', label: 'Your reply', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-reviews/${form.reply.id}/response`, v); reload(); return 'Sent'; }} />
    </Section>
  );
}
