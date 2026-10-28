// Orders from awarded tenders, framework call-offs, and reports with background exports. The order is the shared handoff record that the
// supplier-services work (#458) continues from: scheduling, acceptance, invoices and payment stay separate statuses by design.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Screen, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { Head } from './coaching';
import { c } from '../theme';
import { explain } from '../access';
import { CATEGORIES } from './tender-zone';
import { ChainTrace } from './svc-common';
import { Checks, Chips, DataTable, KV, Notice, Panel, Split, Status, amount, day, nice, openDocument, saveExport, openBase64, when } from '../tender-ui';

export function TenderOrders() {
  const { push } = useNav();
  const [role, setRole] = useState('buyer');
  const list = useLoad(() => api.get('/procurement-orders', { role, limit: 100 }), [role]);
  return (
    <Screen wide>
      <Head eyebrow="TENDER ZONE" title="Orders" sub="Awarded work. Each accepted lot becomes one order with its own commitment." right={<Chips options={[{ value: 'buyer', label: 'I buy' }, { value: 'supplier', label: 'I supply' }]} value={role} onChange={setRole} />} />
      <View style={{ marginTop: 14 }}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : (
          <Card><DataTable rows={list.data ?? []} onRow={(o) => push('TenderOrder', { id: o.id })} empty="No orders yet. They appear when a supplier accepts an award." cols={[
            { key: 'ref', label: 'Order', min: 120, bold: true }, { key: 'title', label: 'Tender', flex: 2, min: 180, render: (o) => `${o.tender_ref} · ${o.title}` }, ...(role === 'buyer' ? [{ key: 'supplier', label: 'Supplier', min: 140 }] : []), { key: 'lot_code', label: 'Lot', min: 60, flex: 0.5 },
            { key: 'amount_minor', label: 'Amount', min: 130, render: (o) => amount(o.amount_minor, o.currency) }, { key: 'status', label: 'Order', min: 100, render: (o) => <Status tone="info" label={nice(o.status)} /> }, { key: 'contract_status', label: 'Contract', min: 130, render: (o) => nice(o.contract_status) }]} /></Card>
        )}
      </View>
    </Screen>
  );
}

export function TenderOrder({ id }) {
  const { toast } = useSession();
  const [sheet, setSheet] = useState(null);
  const o = useLoad(() => api.get(`/procurement-orders/${id}`), [id]);
  if (o.error) return <Screen><ErrorBox error={o.error} onRetry={o.reload} /></Screen>;
  if (o.loading && !o.data) return <Screen><Loading /></Screen>;
  const d = o.data, s = d.scope;
  const act = async (action, reason) => { try { await api.post(`/procurement-orders/${id}/update`, { action, reason }); toast('Updated'); o.reload(); } catch (e) { toast(explain(e)); } };
  return (
    <Screen wide>
      <Head eyebrow={`ORDER · ${s.tender.ref}`} title={d.ref} sub={`${s.supplier.legal_name} · lot ${s.lot.code} ${s.lot.title}`}
        right={<View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="Agreement PDF" color={c.violet} onPress={() => openDocument('agreement', id, {}, d.ref).catch((e) => toast(explain(e)))} />{d.status === 'confirmed' ? <Btn small title="Start" onPress={() => act('start')} /> : null}{d.status === 'in_progress' ? <Btn small title="Mark completed" onPress={() => act('complete')} /> : null}</View>} />
      <View style={{ marginTop: 14 }}>
        <Split main={
          <>
            <Panel title="Three separate statuses"><Checks items={[{ state: 'ok', title: `Award line: ${nice(d.award_line_status ?? 'accepted')}`, detail: 'The supplier accepted the provisional award.' }, { state: d.status === 'cancelled' ? 'bad' : d.status === 'completed' ? 'ok' : 'warn', title: `Order: ${nice(d.status)}`, detail: 'Completion is confirmed by the buyer. It does not mean the work was paid.' }, { state: d.contract_status === 'pending' ? 'warn' : 'ok', title: `Contract: ${nice(d.contract_status)}`, detail: 'Signed here is a manual record, not a validated e-signature.' }]} /></Panel>
            <Panel title="Delivery, invoice and payment" right={d.viewer?.buyer && !d.service_order && d.status !== 'cancelled' ? <Btn small title="Link to service order" onPress={async () => { try { await api.post(`/procurement-orders/${id}/service-order`, {}); toast('Linked'); o.reload(); } catch (e) { toast(explain(e)); } }} accessibilityLabel="Link this order to a service order" /> : null}>
              <T size={13} color={c.mute}>{d.service_order ? `Service order ${d.service_order.number} carries scheduling, receiving and acceptance, invoices and matching, payments and the event commitment. This tender order is its contract record.` : 'This older order has no service order yet. Link it to run delivery, acceptance, invoices and payments in one place; nothing is lost.'}</T>
              <ChainTrace path={`/procurement-orders/${id}/chain`} />
            </Panel>
            <Panel title="Order"><KV items={[['Amount', amount(d.amount_minor, d.currency)], ['Contract type', nice(d.contract_type)], ['Preparation', d.prep_start ? day(d.prep_start) : null], ['Service', d.service_start ? `${day(d.service_start)} to ${day(d.service_end)}` : null], ['Teardown', d.teardown_end ? day(d.teardown_end) : null], ['Commitment', d.commitment ? amount(d.commitment.amount_minor, d.commitment.currency) : null], ['Proposal receipt', s.submission.receipt_no], ['Tender version', `v${s.tender.version}`], ['Rubric version', `v${s.award.rubric_version}`]]} />{d.commitment?.note ? <Notice tone="info">{d.commitment.note}</Notice> : null}<T size={12} color={c.mute}>A commitment is not proof of delivery or payment. Service scheduling, acceptance, invoices and payment continue from this order.</T></Panel>
            {d.terms && (d.terms.renewal_options > 0 || d.terms.notice_days > 0 || d.terms.milestones.length || d.terms.notice) ? (
              <Panel title="Contract terms" right={d.viewer?.buyer && d.terms.renewals_left > 0 && !d.terms.notice && ['confirmed', 'in_progress'].includes(d.status) ? <Btn small title={`Renew (${d.terms.renewals_used + 1} of ${d.terms.renewal_options})`} onPress={() => setSheet('renew')} accessibilityLabel="Exercise the next renewal option" /> : null}>
                <KV items={[['Renewals', d.terms.renewal_options > 0 ? `${d.terms.renewals_used} used of ${d.terms.renewal_options} · ${d.terms.renewal_term_months} months each` : null], ['Added ceiling per renewal', d.terms.renewal_ceiling_minor ? amount(d.terms.renewal_ceiling_minor, d.currency) : null], ['Notice period', d.terms.notice_days > 0 ? `${d.terms.notice_days} days` : null]]} />
                {d.terms.notice ? <Notice tone="warn">{d.terms.notice.kind === 'terminate' ? 'Notice of termination' : 'Notice of non-renewal'} served {day(d.terms.notice.served_at)}, effective {day(d.terms.notice.effective_on)}. The order carries on until then.</Notice> : null}
                {d.terms.renewals.map((r) => <T key={r.n} size={12} color={c.mute}>Renewal {r.n}: service end {day(r.previous_service_end)} → {day(r.new_service_end)}{Number(r.added_ceiling_minor) ? `, ceiling +${amount(r.added_ceiling_minor, d.currency)}` : ''}</T>)}
                {d.terms.milestones.length ? (
                  <View style={{ gap: 8 }}>
                    <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.7 }}>MILESTONES</T>
                    {d.terms.milestones.map((m) => (
                      <View key={m.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <T size={13} weight="700" style={{ minWidth: 100 }}>{day(m.due_on)}</T>
                        <T size={13} style={{ flex: 1, minWidth: 160 }}>{m.name}{m.note ? <T size={12} color={c.mute}> · {m.note}</T> : null}</T>
                        <Status tone={m.status === 'completed' ? 'ok' : m.status === 'waived' ? 'neutral' : 'warn'} label={nice(m.status)} />
                        {d.viewer?.buyer && d.status !== 'cancelled' && m.status === 'planned' ? <><Btn small title="Completed" onPress={() => setSheet({ milestone: m, status: 'completed' })} accessibilityLabel={`Mark ${m.name} completed`} /><Btn small title="Waive" color={c.paper} ink={c.ink} onPress={() => setSheet({ milestone: m, status: 'waived' })} accessibilityLabel={`Waive ${m.name}`} /></> : null}
                        {d.viewer?.buyer && m.status !== 'planned' && d.status !== 'cancelled' ? <Btn small title="Reopen" color={c.paper} ink={c.ink} onPress={async () => { try { await api.post(`/procurement-milestones/${m.id}/update`, { status: 'planned' }); o.reload(); } catch (e) { toast(explain(e)); } }} /> : null}
                      </View>
                    ))}
                    <T size={12} color={c.mute}>A milestone record is not acceptance of delivered work and does not trigger payment.</T>
                  </View>
                ) : null}
              </Panel>
            ) : null}
            {d.framework ? (
              <Panel title="Framework call-offs" right={<Btn small title="New call-off" onPress={() => setSheet('calloff')} />}>
                <KV items={[['Ceiling', amount(d.framework.ceiling_minor, d.currency)], ['Committed call-offs', amount(d.framework.committed_call_offs_minor, d.currency)], ['Remaining', amount(d.framework.remaining_minor, d.currency)]]} />
                <DataTable rows={d.call_offs} empty="No call-offs yet." cols={[{ key: 'description', label: 'Call-off', flex: 2, min: 180 }, { key: 'amount_minor', label: 'Amount', min: 120, render: (x) => amount(x.amount_minor, d.currency) }, { key: 'service_date', label: 'Service date', min: 110, render: (x) => day(x.service_date) }, { key: 'status', label: 'Status', min: 100, render: (x) => nice(x.status) }]} />
                <T size={12} color={c.mute}>{d.framework.note}</T>
              </Panel>
            ) : null}
          </>
        } side={
          <>
            {(d.viewer?.buyer || d.viewer?.supplier) && !d.terms?.notice && ['confirmed', 'in_progress'].includes(d.status) ? <Panel title="Notice"><T size={13} color={c.mute}>A notice takes effect after the {d.terms?.notice_days ?? 0}-day notice period the tender published. It is recorded permanently.</T><Btn small title="Serve notice" color={c.violet} onPress={() => setSheet('notice')} accessibilityLabel="Serve a notice of termination or non-renewal" /></Panel> : null}
            {d.viewer?.buyer && d.status !== 'cancelled' && d.status !== 'completed' ? <Panel title="Buying team"><Btn small title="Record agreement" color={c.violet} onPress={() => act('record_agreement')} /><Btn small title="Record signature" color={c.violet} onPress={() => act('record_signature')} /><Btn small title="Cancel order" color={c.red} onPress={() => setSheet('cancel')} /></Panel> : null}
          </>
        } />
      </View>
      <FormSheet visible={sheet === 'renew'} onClose={() => setSheet(null)} title="Exercise a renewal" submitLabel="Renew"
        fields={[]} notice={`This extends the service period by ${d.terms?.renewal_term_months} months${d.terms?.renewal_ceiling_minor ? ` and adds ${amount(d.terms.renewal_ceiling_minor, d.currency)} to the ceiling` : ''}, as published in the tender. It must be done before the notice period begins and cannot be undone.`}
        onSubmit={async () => { await api.post(`/procurement-orders/${id}/renew`, { renewal_no: (d.terms?.renewals_used ?? 0) + 1 }); o.reload(); return 'Renewed. The earlier terms are kept in the history.'; }} />
      <FormSheet visible={!!sheet?.milestone} onClose={() => setSheet(null)} title={sheet?.status === 'waived' ? 'Waive the milestone' : 'Mark the milestone completed'} submitLabel="Save" fields={[{ key: 'note', label: sheet?.status === 'waived' ? 'Reason' : 'Note (optional)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/procurement-milestones/${sheet.milestone.id}/update`, { status: sheet.status, note: v.note || undefined }); o.reload(); return 'Recorded'; }} />
      <FormSheet visible={sheet === 'notice'} onClose={() => setSheet(null)} title="Serve a notice" submitLabel="Serve notice" initial={{ kind: 'not_renew' }}
        fields={[{ key: 'kind', label: 'Notice', type: 'chips', options: [{ value: 'not_renew', label: 'Non-renewal' }, { value: 'terminate', label: 'Termination' }] }, { key: 'reason', label: 'Reason (at least 10 characters)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/procurement-orders/${id}/notice`, { kind: v.kind, reason: v.reason }); o.reload(); return 'Notice served'; }} />
      <FormSheet visible={sheet === 'calloff'} onClose={() => setSheet(null)} title="New call-off" submitLabel="Place call-off" fields={[{ key: 'description', label: 'What is being called off' }, { key: 'amount_minor', label: 'Amount', type: 'money', currency: d.currency }, { key: 'service_date', label: 'Service date', type: 'date', optional: true }]}
        onSubmit={async (v) => { await api.post(`/procurement-orders/${id}/call-offs`, { description: v.description, amount_minor: v.amount_minor, service_date: v.service_date || undefined, idempotency_key: `co-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }); o.reload(); return 'Call-off placed'; }} />
      <FormSheet visible={sheet === 'cancel'} onClose={() => setSheet(null)} title="Cancel the order" submitLabel="Cancel order" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/procurement-orders/${id}/update`, { action: 'cancel', reason: v.reason }); o.reload(); return 'Order cancelled. Its budget commitment is voided; history is kept.'; }} />
    </Screen>
  );
}

// ------------------------------------------------------------------ reports
const money = (o) => Object.entries(o ?? {}).map(([k, v]) => amount(v, k)).join(' · ') || '—';

export function TenderReports() {
  const { toast } = useSession();
  const [scope, setScope] = useState('buyer');
  const [f, setF] = useState({ date_basis: 'published' });
  const rep = useLoad(() => api.get('/procurement/reports', { scope, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }), [scope, JSON.stringify(f)]);
  const ex = useLoad(() => api.get('/procurement/exports', { limit: 20 }).catch(() => []), []);
  const r = rep.data;
  const quick = async (format) => { try { await saveExport(await api.get('/procurement/reports/export', { scope, format, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) })); } catch (e) { toast(explain(e)); } };
  const later = async (format) => { try { await api.post('/procurement/exports', { kind: 'report', format, scope, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }); toast('Export started. It appears below when ready.'); ex.reload(); } catch (e) { toast(explain(e)); } };
  const get = async (x) => { try { const file = await api.get(`/procurement/exports/${x.id}`); if (file.status !== 'ready') return toast(`Export is ${file.status}`); await saveExport({ filename: file.filename, content_type: file.content_type, encoding: file.encoding, data: file.data }); } catch (e) { toast(explain(e)); } };
  return (
    <Screen wide>
      <Head eyebrow="TENDER ZONE" title="Reports" sub="Every figure states its basis. Amounts stay in their own currency and are never added across currencies." right={<Chips options={[{ value: 'buyer', label: 'Buying' }, { value: 'supplier', label: 'Supplying' }]} value={scope} onChange={setScope} />} />
      <View style={{ marginTop: 14, gap: 14 }}>
        <Panel title="Filters"><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}><View style={{ gap: 6 }}><T size={11} weight="700" color={c.mute}>DATE BASIS</T><Chips options={[{ value: 'published', label: 'Published' }, { value: 'created', label: 'Created' }, { value: 'closing', label: 'Closing' }]} value={f.date_basis} onChange={(v) => setF({ ...f, date_basis: v })} /></View>
          {scope === 'buyer' ? <View style={{ gap: 6 }}><T size={11} weight="700" color={c.mute}>CATEGORY</T><Chips options={[{ value: '', label: 'All' }, ...CATEGORIES.slice(0, 6).map((x) => ({ value: x, label: x }))]} value={f.category ?? ''} onChange={(v) => setF({ ...f, category: v })} /></View> : null}</View></Panel>
        {rep.error ? <ErrorBox error={rep.error} onRetry={rep.reload} /> : rep.loading && !r ? <Loading /> : scope === 'buyer' ? (
          <>
            <Panel title="Pipeline"><KV items={[['Tenders', r.tenders], ...Object.entries(r.pipeline).map(([k, v]) => [nice(k), v])]} /></Panel>
            <Split main={
              <>
                <Panel title="Participation and conversion"><KV items={[['Took part', r.participation.interested], ['Proposals submitted', r.participation.submitted], ['Awarded suppliers', r.participation.awarded_entities], ['Submitted per interested', r.participation.submitted_per_interested != null ? `${r.participation.submitted_per_interested}%` : '—'], ['Awarded per submitted', r.participation.awarded_per_submitted != null ? `${r.participation.awarded_per_submitted}%` : '—'], ['Eligible', r.qualification.eligible], ['Ineligible', r.qualification.ineligible], ['Average proposals per closed tender', r.competition.average_proposals ?? '—'], ['Median days publish to award', r.cycle_time_days.median_publish_to_award ?? '—']]} /><T size={12} color={c.mute}>{r.participation.denominators}</T></Panel>
                <Panel title="Money"><KV items={[['Committed (orders)', money(r.spend.committed_minor)], ['Framework call-offs', money(r.spend.call_offs_minor)], ['Published budget (awarded)', money(r.spend.baseline_minor)], ['Observed saving', money(r.spend.observed_saving_minor)], ['Forecast saving (pending award)', money(r.spend.forecast_saving_minor)]]} /><T size={12} color={c.mute}>{r.spend.note}</T></Panel>
              </>
            } side={
              <>
                <Panel title="Upcoming deadlines"><Checks items={r.upcoming_deadlines.map((d) => ({ state: 'warn', title: `${d.ref} · ${d.title}`, detail: when(d.closes_at) }))} empty="No deadlines in the next 14 days." /></Panel>
                <Panel title="Readiness warnings"><Checks items={[...r.coverage.unfilled_lots.map((u) => ({ state: 'bad', title: `${u.ref} lot ${u.lot} unfilled`, detail: `${u.missing_qty} still needed` })), ...r.conflict_warnings.map((w) => ({ state: 'warn', title: w.message }))]} empty="No unfilled lots or venue and date overlaps." /></Panel>
                <Panel title="Reviewer workload"><Checks items={r.reviewer_workload.map((w) => ({ state: w.locked >= w.started ? 'ok' : 'warn', title: w.handle, detail: `${w.locked} locked of ${w.started} started` }))} empty="No scoring yet." /></Panel>
              </>
            } />
          </>
        ) : (
          <Split main={
            <>
              <Panel title="My proposals"><KV items={[['Drafts', r.proposals.drafts], ['Submitted', r.proposals.submitted], ['Withdrawn', r.proposals.withdrawn], ['Open invitations', r.invitations.open_invitations], ['Tenders joined', r.invitations.tenders_joined], ['Won / decided', `${r.success.won} / ${r.success.decided}`], ['Success rate', r.success.rate_percent != null ? `${r.success.rate_percent}%` : '—']]} /><T size={12} color={c.mute}>{r.basis.note}</T></Panel>
              <Panel title="Awarded pipeline"><KV items={[...Object.entries(r.awarded_pipeline.orders).map(([k, v]) => [`Orders ${nice(k)}`, v]), ...Object.entries(r.awarded_pipeline.by_currency).flatMap(([cur, o]) => Object.entries(o).map(([k, v]) => [`${nice(k)} (${cur})`, amount(v, cur)]))]} /></Panel>
            </>
          } side={<Panel title="Clarification and closing dates"><Checks items={r.clarification_deadlines.map((d) => ({ state: 'warn', title: `${d.ref} · ${d.title}`, detail: `Questions by ${when(d.clarification_by)} · closes ${when(d.closes_at)}` }))} empty="No open tenders you are part of." /></Panel>} />
        )}
        <Panel title="Export"><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="CSV now" color={c.violet} onPress={() => quick('csv')} /><Btn small title="XLSX now" color={c.violet} onPress={() => quick('xlsx')} /><Btn small title="XLSX in the background" color={c.violet} onPress={() => later('xlsx')} /></View>
          <T size={12} color={c.mute}>Exports use the same figures as this page, escape spreadsheet formulas, and stop at 5,000 rows. Larger ones should run in the background.</T>
          <DataTable rows={ex.data ?? []} empty="No background exports yet." onRow={get} cols={[{ key: 'name', label: 'File', flex: 2, min: 160, render: (x) => x.name ?? `${nice(x.kind)}.${x.format}` }, { key: 'status', label: 'Status', min: 100, render: (x) => <Status tone={x.status === 'ready' ? 'ok' : x.status === 'failed' ? 'bad' : 'warn'} label={nice(x.status)} /> }, { key: 'created_at', label: 'Requested', min: 150, render: (x) => when(x.created_at) }]} /></Panel>
      </View>
    </Screen>
  );
}
