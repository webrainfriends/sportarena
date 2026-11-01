// Growth tab of Analytics (#73), for platform operators. The governed participation and business metrics (first activity, repeat play, activation,
// vacancy fill, booking and payment failure, provider earnings) are in the Explore tab like every other KPI; this tab adds what Explore cannot show:
// how trustworthy the growth data is, and feature-flag experiments with a written hypothesis, exposure records and success / guardrail measures.
// Every figure comes from the server; this screen decides nothing about who may see it.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, Loading, Section, Seg, Sheet, StatPill, T, Tag } from '../ui';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { Counter } from '../pickers';
import { saveExport } from '../open-file';
import { t } from '../i18n';

const Wrap = ({ children, gap = 8 }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>{children}</View>;
const Label = ({ children }) => <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{String(children).toUpperCase()}</T>;
const FRESH = { current: [c.lime, 'growth.fresh.current'], stale: [c.sunSoft, 'growth.fresh.stale'], no_records: [c.paper, 'growth.fresh.none'] };
const STATUS_TONE = { draft: c.violetSoft, running: c.lime, stopped: c.sunSoft, concluded: c.paper };
const SHARES = [{ value: 10, label: '10%' }, { value: 25, label: '25%' }, { value: 50, label: '50%' }];
const outcomeLabel = (o) => { const k = `growth.outcome.${o.key ?? o.metric}`; const v = t(k); return v === k ? o.label : v; };
const pct = (v) => (v == null ? '—' : `${v}%`);

// ------------------------------------------------------------------ data quality
function Quality() {
  const q = useLoad(() => api.get('/analytics/growth/quality'), []);
  if (q.error) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const d = q.data, fr = FRESH[d.telemetry.freshness];
  return (
    <Section title={t('growth.quality')} color={c.cyan}>
      <Wrap>
        <StatPill value={String(d.telemetry.last_24h)} label={t('growth.events_24h')} />
        <StatPill value={String(d.telemetry.replays_ignored)} label={t('growth.replays')} />
        <StatPill value={`${d.consent.coverage_percent}%`} label={t('growth.opted_in')} />
      </Wrap>
      <Wrap gap={6}><Tag label={t(fr[1])} color={fr[0]} /><Tag label={t('growth.retention', { days: d.retention.days })} /></Wrap>
      {d.warnings.map((w) => <View key={w.code} accessibilityRole="alert" style={{ backgroundColor: w.severity === 'warn' ? c.sunSoft : c.paper, borderRadius: 12, padding: 10 }}><T size={12}>{w.text}</T></View>)}
      {d.reconciliation.length ? (
        <View style={{ gap: 6 }}>
          <Label>{t('growth.reconciled')}</Label>
          {d.reconciliation.map((r) => (
            <Card key={r.event_key} color={c.paper} accessibilityLabel={`${r.event_key}: ${r.matched} ${t('growth.matched')}, ${r.unmatched} ${t('growth.unmatched')}, ${r.pending} ${t('growth.waiting')}`}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <T weight="700">{r.event_key.replaceAll('_', ' ')}</T>
                <T size={12} color={c.mute}>{r.matched} {t('growth.matched')} · {r.unmatched} {t('growth.unmatched')} · {r.pending} {t('growth.waiting')}</T>
              </View>
            </Card>))}
        </View>) : null}
    </Section>
  );
}

// ------------------------------------------------------------------ create
function NewExperiment({ open, onClose, outcomes, onSaved }) {
  const { toast } = useSession();
  const [f, setF] = useState({ name: '', key: '', hypothesis: '', share: 50, success: 'completed_activity', guard: ['payment_failure', 'booking_failure'], min_sample: 100, window_days: 14 });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const key = f.key || f.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const ok = f.name.trim().length >= 3 && key.length >= 3 && f.hypothesis.trim().length >= 10;
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/analytics/experiments', {
        key, name: f.name.trim(), hypothesis: f.hypothesis.trim(), variants: [{ key: 'control', weight: 100 - f.share }, { key: 'change', weight: f.share }],
        success_metric: f.success, guardrails: f.guard.filter((g) => g !== f.success), min_sample: f.min_sample, window_days: f.window_days,
      });
      toast(t('common.done')); onSaved(); onClose();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={open} onClose={onClose} title={t('growth.new')} footer={<><Btn title={t('common.cancel')} color={c.paper} ink={c.ink} onPress={onClose} style={{ flex: 1 }} /><Btn title={t('growth.create')} onPress={save} loading={busy} disabled={!ok} style={{ flex: 1 }} /></>}>
      <Field label={t('growth.f.name')} value={f.name} onChangeText={(v) => set('name', v)} maxLength={120} />
      <Field label={t('growth.f.key')} value={f.key} onChangeText={(v) => set('key', v.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder={key} maxLength={40} />
      <Field label={t('growth.f.hyp')} value={f.hypothesis} onChangeText={(v) => set('hypothesis', v)} placeholder={t('growth.f.hyp_ph')} multiline maxLength={600} />
      <View style={{ gap: 6 }}><Label>{t('growth.f.share')}</Label><Seg options={SHARES} value={f.share} onChange={(v) => set('share', v)} /></View>
      <View style={{ gap: 6 }}>
        <Label>{t('growth.f.success')}</Label>
        <Wrap>{outcomes.map((o) => <Chip key={o.key} label={outcomeLabel(o)} active={f.success === o.key} onPress={() => set('success', o.key)} />)}</Wrap>
      </View>
      <View style={{ gap: 6 }}>
        <Label>{t('growth.f.guard')}</Label>
        <Wrap>{outcomes.filter((o) => o.key !== f.success).map((o) => <Chip key={o.key} label={outcomeLabel(o)} active={f.guard.includes(o.key)} onPress={() => set('guard', f.guard.includes(o.key) ? f.guard.filter((g) => g !== o.key) : [...f.guard, o.key])} />)}</Wrap>
      </View>
      <Counter label={t('growth.f.sample')} value={f.min_sample} onChange={(v) => set('min_sample', v)} min={10} max={10000} step={10} />
      <Counter label={t('growth.f.window')} value={f.window_days} onChange={(v) => set('window_days', v)} min={1} max={90} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ one experiment
function Detail({ id, onClose, onChanged }) {
  const { toast } = useSession();
  const e = useLoad(() => (id ? api.get(`/analytics/experiments/${id}`) : Promise.resolve(null)), [id]);
  const res = useLoad(() => (id ? api.get(`/analytics/experiments/${id}/results`) : Promise.resolve(null)), [id]);
  const [concluding, setConcluding] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const x = e.data, r = res.data;
  const move = async (status, conclusion) => {
    setBusy(true);
    try { await api.patch(`/analytics/experiments/${id}`, { row_version: x.row_version, status, ...(conclusion ? { conclusion } : {}) }); setConcluding(false); setNote(''); e.reload(); res.reload(); onChanged(); } catch (err) { toast(explain(err)); if (err?.status === 409) e.reload(); } finally { setBusy(false); }
  };
  const exportCsv = async () => { try { await saveExport(await api.get(`/analytics/experiments/${id}/export`)); toast(t('common.done')); } catch (err) { toast(explain(err)); } };
  const actions = !x ? [] : { draft: [['running', 'growth.act.start']], running: [['stopped', 'growth.act.stop'], ['concluded', 'growth.act.conclude']], stopped: [['running', 'growth.act.resume'], ['concluded', 'growth.act.conclude']], concluded: [] }[x.status];
  return (
    <Sheet visible={!!id} onClose={onClose} title={x?.name ?? t('growth.experiments')}>
      {e.error ? <LoadError error={e.error} onRetry={e.reload} /> : !x ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <Wrap gap={6}><Tag label={t(`growth.status.${x.status}`)} color={STATUS_TONE[x.status]} /><Tag label={t('growth.exposed', { n: x.exposed })} /></Wrap>
          <T size={13}>{x.hypothesis}</T>
          {x.conclusion ? <T size={13} weight="600">{x.conclusion}</T> : null}
          {actions.length ? <Wrap>{actions.map(([s, label]) => <Btn key={s} small title={t(label)} color={s === 'concluded' ? c.paper : c.pink} ink={s === 'concluded' ? c.ink : '#fff'} loading={busy} onPress={() => (s === 'concluded' ? setConcluding(true) : move(s))} />)}</Wrap> : null}
          {concluding ? (
            <View style={{ gap: 8 }}>
              <Field label={t('growth.conclusion')} value={note} onChangeText={setNote} multiline maxLength={600} />
              <Btn small title={t('growth.act.conclude')} loading={busy} disabled={note.trim().length < 10} onPress={() => move('concluded', note.trim())} style={{ alignSelf: 'flex-start' }} />
            </View>) : null}
          <Section title={t('growth.results')} color={c.violet}>
            {res.error ? <LoadError error={res.error} onRetry={res.reload} /> : !r ? <Loading /> : (
              <View style={{ gap: 10 }}>
                {r.warnings.map((w) => <View key={w.code} accessibilityRole="alert" style={{ backgroundColor: w.severity === 'warn' ? c.sunSoft : c.paper, borderRadius: 12, padding: 10 }}><T size={12}>{w.code === 'insufficient_data' ? t('growth.not_enough') : w.code === 'guardrail_breached' ? t('growth.guardrail_bad') : w.text}</T></View>)}
                {r.variants.map((v) => (
                  <Card key={v.key} color={c.paper} accessibilityLabel={`${v.control ? t('growth.control') : v.key}: ${pct(v.outcomes[r.success.metric].rate)}`}>
                    <View style={{ gap: 4 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800">{v.control ? t('growth.control') : v.key}</T><T weight="800" size={20}>{pct(v.outcomes[r.success.metric].rate)}</T></View>
                      <T size={12} color={c.mute}>{outcomeLabel(r.success)} · {pct(v.outcomes[r.success.metric].low)}–{pct(v.outcomes[r.success.metric].high)}</T>
                      <T size={12} color={c.mute}>{t('growth.finished', { n: v.mature })}{v.maturing ? ` · ${t('growth.following', { n: v.maturing })}` : ''}</T>
                    </View>
                  </Card>))}
                {r.success.vs_control.map((d) => <T key={d.variant} size={12} weight="600">{d.difference_points == null ? d.variant : t('growth.points', { variant: d.variant, n: `${d.difference_points > 0 ? '+' : ''}${d.difference_points}` })} · {d.clear_difference ? t('growth.clear') : t('growth.unclear')}</T>)}
                {r.guardrails.map((g) => (
                  <Card key={g.metric} color={g.breached ? c.sunSoft : c.paper}>
                    <T weight="700" size={13}>{outcomeLabel(g)}</T>
                    {r.variants.map((v) => <T key={v.key} size={12} color={c.mute}>{v.control ? t('growth.control') : v.key}: {pct(v.outcomes[g.metric].rate)}</T>)}
                  </Card>))}
                <T size={11} color={c.mute}>{t('growth.basis')}</T>
                <Btn small title={t('growth.export')} color={c.paper} ink={c.ink} onPress={exportCsv} style={{ alignSelf: 'flex-start' }} />
              </View>)}
          </Section>
        </View>)}
    </Sheet>
  );
}

// ------------------------------------------------------------------ tab
export function Growth() {
  const list = useLoad(() => api.get('/analytics/experiments', { limit: 100 }), []);
  const outcomes = useLoad(() => api.get('/analytics/experiments/outcomes'), []);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  return (
    <View style={{ gap: 16 }}>
      <Quality />
      <Section title={t('growth.experiments')} action={t('growth.new')} onAction={() => setCreating(true)} color={c.pink}>
        {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : !list.data.length ? <Empty emoji="🧪" title={t('growth.empty_title')} sub={t('growth.empty_sub')} /> : list.data.map((x) => (
          <Card key={x.id} color={c.paper} onPress={() => setOpen(x.id)} accessibilityLabel={`${x.name}, ${t(`growth.status.${x.status}`)}`}>
            <View style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={15} style={{ flex: 1 }}>{x.name}</T><Tag label={t(`growth.status.${x.status}`)} color={STATUS_TONE[x.status]} /></View>
              <T size={12} color={c.mute} numberOfLines={2}>{x.hypothesis}</T>
              <T size={11} color={c.mute}>{t('growth.exposed', { n: x.exposed })}</T>
            </View>
          </Card>))}
      </Section>
      <NewExperiment open={creating} onClose={() => setCreating(false)} outcomes={outcomes.data ?? []} onSaved={list.reload} />
      <Detail id={open} onClose={() => setOpen(null)} onChanged={list.reload} />
    </View>
  );
}
