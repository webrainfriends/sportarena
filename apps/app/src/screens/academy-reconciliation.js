// Finance › Reconciliation (#787): the academy's cost and revenue work queue. It is a view over the SHARED Finance queue (fin_recon_items) through the academy
// capabilities: unlinked, unmatched, double-count-risk and disputed entries, each traced to its canonical record, with an audited human decision. It never
// edits an invoice, payment or payroll record. Also the provenance strip and cohort block that the P&L tab shows. All text goes through t().
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, ErrorBox, Loading, Row, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { t } from '../i18n';
import { moneyIn } from '../vtime';
import { Bars, Block, Kpi, pct } from './academy-ui';

const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const M = (v, cur) => (v == null ? t('arc.unknown') : moneyIn(v, cur));
const KINDS = ['cost_unlinked', 'revenue_unlinked', 'double_count_risk', 'supplier_unmatched', 'supplier_variance', 'venue_unbooked', 'payroll_unpriced', 'currency_mismatch', 'payment_unrecorded', 'refund_drift', 'amount_drift'];
const SOURCES = ['payroll', 'venue', 'supplier', 'payment_fee', 'manual'];
const TONE = { open: c.sun, disputed: c.cyan, resolved: c.mint };
const stamp = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** Basis, currency policy, cut-off time and cost-allocation version of a P&L, as chips. */
export function ProvenanceStrip({ provenance, currencies }) {
  if (!provenance) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="summary" accessibilityLabel={t('arc.prov.a11y')}>
      <Tag label={t('arc.prov.cutoff', { when: stamp(provenance.cut_off_at) })} />
      <Tag label={t('arc.prov.alloc', { v: provenance.cost_allocation_version })} />
      <Tag label={t('arc.prov.cur', { cur: (currencies ?? []).join(' · ') || '—' })} color={c.cyan} />
    </View>
  );
}

/** Cohort profitability for one currency. Only figures that name the cohort are attributed to it; the rest is its own row, and a missing figure reads "unknown". */
export function ByCohort({ rows, currency }) {
  if (!rows?.some((r) => r.cohort_id)) return null;
  return (
    <Block title={t('arc.cohort.by')}>
      {rows.map((k) => {
        const ttl = `${k.programme} · ${k.cohort_id ? k.name : t('arc.cohort.rest')}`;
        return (
        <Row key={`${k.programme_id}-${k.cohort_id ?? 'rest'}`} title={ttl}
          sub={`${t('arc.cohort.sub', { n: k.athletes_billed })} · ${t('aco.revenue')} ${M(k.management_revenue_minor, currency)} · ${t('arc.cost.staff')} ${M(k.staff_cost_minor, currency)} · ${t('arc.cost.venue')} ${M(k.venue_cost_minor, currency)} · ${t('arc.cost.fees')} ${M(k.payment_fee_minor, currency)}`}
          right={<Tag label={k.contribution_complete ? pct(k.margin_pct) : t('arc.unknown')} color={k.contribution_complete ? undefined : c.sun} />} />
        );
      })}
      <T size={11} color={c.mute}>{t('arc.cohort.note')}</T>
    </Block>
  );
}

export function Reconciliation({ o, archived, toast }) {
  const [status, setStatus] = useState('open'), [kind, setKind] = useState(''), [branch, setBranch] = useState(''), [busy, setBusy] = useState(false), [act, setAct] = useState(null), [open, setOpen] = useState(null);
  const sum = useLoad(() => api.get(`/organisations/${o.id}/academy/reconciliation`), [o.id]);
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/reconciliation/items`, { status, kind: kind || undefined, branch_id: branch || undefined, limit: 100 }), [o.id, status, kind, branch]);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/academy/programmes`, { limit: 100 }), [o.id]);
  const cohorts = useLoad(() => api.get(`/organisations/${o.id}/cohorts`, { limit: 100 }).catch(() => []), [o.id]);
  const branches = useLoad(() => api.get(`/organisations/${o.id}/academy/branches`).catch(() => null), [o.id]);
  const detail = useLoad(() => (open ? api.get(`/academy/reconciliation/items/${open}`) : Promise.resolve(null)), [open]);
  const refresh = () => { sum.reload(); list.reload(); };
  const check = async () => { setBusy(true); try { await api.post(`/organisations/${o.id}/academy/reconciliation/run`, {}); refresh(); } catch (e) { toast?.(e.message); } finally { setBusy(false); } };
  useEffect(() => { if (!archived) check(); }, [o.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const s = sum.data;
  const live = (branches.data?.branches ?? []).filter((b) => !b.archived_at);
  const progOptions = (progs.data ?? []).map((p) => ({ id: p.id, label: p.title, sub: p.sport }));
  const cohortOptions = (cohorts.data?.items ?? cohorts.data ?? []).map((k) => ({ id: k.id, label: k.name, sub: k.programme_title ?? undefined }));
  const reason = { key: 'reason', label: t('arc.f.reason'), type: 'multiline' };
  const fieldsFor = (d) => ({
    attribute: [{ key: 'programme_id', label: t('arc.f.programme'), type: 'entity', entityKind: 'programme', noun: t('arc.f.programme'), options: progOptions }, { key: 'cohort_id', label: t('arc.f.cohort'), type: 'entity', entityKind: 'programme', noun: t('arc.f.cohort'), options: cohortOptions, optional: true }, reason],
    overhead: [{ key: 'method', label: t('arc.f.method'), type: 'chips', options: [{ value: 'participants', label: t('arc.m.participants') }, { value: 'revenue_share', label: t('arc.m.revenue_share') }] }, reason],
    record_cost: [{ key: 'currency', label: t('arc.f.currency'), type: 'currency', optional: true }, { key: 'amount_minor', label: t('arc.f.amount'), type: 'money', currency: (v) => v.currency ?? act?.item.currency ?? 'INR' }, { key: 'invoice_ref', label: t('arc.f.invoice'), optional: true }, reason],
  }[d] ?? [reason]);
  const ACTION_COLOR = (i) => (i === 0 ? undefined : c.paper);

  return (
    <View style={{ gap: 12 }}>
      <Panel>
        <Block title={t('arc.title')} right={!archived ? <Btn small title={busy ? t('arc.running') : t('arc.run')} loading={busy} color={c.paper} ink={c.ink} onPress={check} accessibilityLabel={t('arc.run')} /> : null}>
          <T size={12} color={c.mute}>{t('arc.intro')}</T>
          {sum.error ? <ErrorBox error={sum.error} onRetry={sum.reload} /> : !s ? <Loading /> : (
            <>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Kpi label={t('arc.k.matched')} value={s.coverage.matched_pct == null ? t('arc.unknown') : pct(s.coverage.matched_pct)} sub={t('arc.k.matched_sub', { n: s.coverage.lines })} />
                <Kpi label={t('arc.k.attention')} value={s.counts.open + s.counts.disputed} tone={s.counts.open ? c.orange : undefined} sub={t('arc.k.attention_sub', { open: s.counts.open, disputed: s.counts.disputed })} />
                <Kpi label={t('arc.k.double')} value={s.by_kind.find((k) => k.kind === 'double_count_risk')?.open ?? 0} tone={s.held_out_by_currency.length ? c.red : undefined}
                  sub={s.held_out_by_currency.length ? s.held_out_by_currency.map((h) => t('arc.k.double_sub', { amount: moneyIn(h.minor, h.currency) })).join(' · ') : t('arc.k.none_held')} />
                <Kpi label={t('arc.k.cutoff')} value={stamp(s.cut_off_at)} sub={t('arc.prov.alloc', { v: s.cost_allocation_version })} />
              </View>
              <Bars label={t('arc.src.chart')} rows={s.coverage.by_source.map((x) => ({ label: t(`arc.src.${x.source}`), value: x.lines, text: `${x.lines} · ${x.matched_pct == null ? '—' : pct(x.matched_pct)}`, tone: x.flagged ? c.orange : undefined }))} />
              <T size={11} color={c.mute}>{s.currency_policy} {t('arc.k.window', { from: s.window.from, to: s.window.to })}</T>
            </>
          )}
        </Block>
      </Panel>
      <Panel>
        <Block title={t('arc.queue')}>
          <Seg value={status} onChange={setStatus} color={c.violet} options={[{ value: 'open', label: `${t('arc.st.open')}${s ? ` ${s.counts.open}` : ''}` }, { value: 'disputed', label: `${t('arc.st.disputed')}${s ? ` ${s.counts.disputed}` : ''}` }, { value: 'resolved', label: `${t('arc.st.resolved')}${s ? ` ${s.counts.resolved}` : ''}` }]} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <View style={{ flex: 1, minWidth: 220 }}><MenuField label={t('arc.f.kind')} value={kind} onChange={setKind} options={[{ value: '', label: t('arc.f.all_kinds') }, ...KINDS.map((k) => ({ value: k, label: t(`arc.kind.${k}`) }))]} /></View>
            {live.length ? <View style={{ flex: 1, minWidth: 220 }}><MenuField label={t('aco.branch.label')} value={branch} onChange={setBranch} options={[{ value: '', label: t('aco.branch.all') }, ...live.map((b) => ({ value: b.id, label: b.name, sub: b.city ?? undefined }))]} /></View> : null}
          </View>
          {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : !list.data.length ? (
            <Empty emoji={status === 'resolved' ? '🗂️' : '✅'} title={status === 'resolved' ? t('arc.empty.resolved') : t('arc.empty.title')} sub={status === 'resolved' ? t('arc.empty.resolved_sub') : t('arc.empty.sub')} />
          ) : list.data.map((it) => {
            const bg = it.kind === 'double_count_risk' && it.status === 'open' ? c.red : TONE[it.status];
            const d = it.detail ?? {};
            const what = d.title ?? d.label ?? d.manual_description ?? d.description ?? d.programme ?? d.charge_kind ?? '';
            return (
              <View key={it.id} style={{ backgroundColor: c.bg, borderRadius: 16, padding: 12, gap: 6 }} accessibilityLabel={t('arc.a11y.item', { kind: t(`arc.kind.${it.kind}`), status: t(`arc.st.${it.status}`) })}>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" size={14} style={{ flex: 1 }}>{t(`arc.kind.${it.kind}`)}</T><Tag label={t(`arc.st.${it.status}`)} color={bg} /></View>
                <T size={12} color={c.mute}>{[what, d.supplier, it.branch ? `${t('aco.branch.label')}: ${it.branch}` : null, d.on_date ?? null].filter(Boolean).join(' · ')}</T>
                <T weight="800" size={14}>{it.amount_minor != null && it.currency ? moneyIn(it.amount_minor, it.currency) : t('arc.unknown')}{it.kind === 'double_count_risk' ? ` · ${t('arc.held_out')}` : ''}{d.variance_pct != null ? ` · ${d.variance_pct > 0 ? '+' : ''}${d.variance_pct}%` : ''}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {!archived ? it.allowed_decisions.filter((a) => a !== 'note').map((a, i) => <Btn key={a} small title={t(`arc.a.${a}`)} color={ACTION_COLOR(i)} ink={i === 0 ? undefined : c.ink} onPress={() => setAct({ item: it, decision: a })} accessibilityLabel={`${t(`arc.a.${a}`)}: ${t(`arc.kind.${it.kind}`)}`} />) : null}
                  <Btn small title={open === it.id ? t('arc.hide') : t('arc.trace')} color={c.paper} ink={c.ink} onPress={() => setOpen(open === it.id ? null : it.id)} />
                </View>
                {open === it.id ? (
                  !detail.data ? <Loading /> : (
                    <View style={{ gap: 4, paddingTop: 6 }}>
                      <T size={11} weight="800" color={c.mute}>{t('arc.trace_title').toUpperCase()}</T>
                      {detail.data.trace.map((r) => <Row key={r.source_id} title={r.label} sub={Object.entries(r.summary).filter(([, v]) => v != null && v !== '' && typeof v !== 'object').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${k.endsWith('_minor') && it.currency ? moneyIn(v, it.currency) : v}`).join(' · ')} />)}
                      {detail.data.decisions.length ? <T size={11} weight="800" color={c.mute}>{t('arc.decisions').toUpperCase()}</T> : null}
                      {detail.data.decisions.map((x) => <Row key={x.id} title={[`v${x.version}`, t(`arc.a.${x.decision === 'programme' ? 'attribute' : x.decision}`)].join(' · ')} sub={`${x.by} · ${stamp(x.created_at)} · ${x.reason}`} />)}
                      <T size={11} weight="800" color={c.mute}>{t('arc.history').toUpperCase()}</T>
                      {detail.data.history.map((h, i) => <Row key={i} title={h.action.replace('_', ' ')} sub={`${stamp(h.at)}${h.reason ? ` · ${h.reason}` : ''}`} />)}
                      {it.resolution ? <T size={12} color={c.mute}>{it.resolution}</T> : null}
                      {!detail.data.history.length ? <T size={12} color={c.mute}>{t('arc.detected', { when: stamp(it.created_at) })}</T> : null}
                    </View>
                  )
                ) : null}
              </View>
            );
          })}
        </Block>
      </Panel>
      <FormSheet visible={!!act} onClose={() => setAct(null)} title={act ? t(`arc.a.${act.decision}`) : ''} submitLabel={t('arc.save')} fields={act ? fieldsFor(act.decision) : []}
        onSubmit={async (v) => {
          await api.post(`/academy/reconciliation/items/${act.item.id}/act`, { decision: act.decision, reason: v.reason, programme_id: v.programme_id, cohort_id: v.cohort_id, method: v.method, amount_minor: v.amount_minor, currency: v.currency, invoice_ref: v.invoice_ref });
          refresh(); return t('arc.saved');
        }} />
    </View>
  );
}
