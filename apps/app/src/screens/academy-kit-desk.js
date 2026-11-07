// Academy kit desk (#798): fit, issue, return, exchange and report kit, scan a barcode or serial. One component for both entry points - the Academy
// Kit section (staff of the academy) and the venue Front desk (cashiers, who are not academy members) - so there is no second console.
// Every rule (stock locking, entitlements, payment-first, deposits, approvals, authority) is enforced by the API; this screen only calls it.
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Field, Loading, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { CameraScan, hasCamera } from '../camera-scan';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';
import { Initials } from './academy-ui';
import { shareText, uid } from './front-desk-kit';

export const day = (d) => { try { return d ? new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; } catch { return ''; } };
const STATUS_TONE = { reserved: c.sunSoft, issued: c.mint, returned: c.violetSoft, exchanged: c.violetSoft, writeoff_pending: c.orangeSoft, written_off: c.redSoft, cancelled: c.violetSoft };
export const statusText = (s) => ({ reserved: t('kit.st_reserved'), issued: t('kit.st_issued'), returned: t('kit.st_returned'), exchanged: t('kit.st_exchanged'), writeoff_pending: t('kit.st_pending'), written_off: t('kit.st_written_off'), cancelled: t('kit.st_cancelled') }[s] ?? s);
export const StatusTag = ({ s }) => <Tag label={statusText(s)} color={STATUS_TONE[s] ?? c.violetSoft} />;
const CODES = () => ({
  kit_payment_required: t('kit.e_payment_required'), no_stock_row: t('kit.e_no_stock'), size_required: t('kit.e_size_required'), entitlement_exhausted: t('kit.e_exhausted'), deposit_not_settled: t('kit.e_deposit_open'),
});
/** A refusal the desk can act on, in words: the API says why; this only translates what it can. */
export const kitError = (e) => CODES()[e?.code] ?? explain(e);
const slotLabel = (s) => (s ? s.replace(/_/g, ' ') : '');

/** The sizes a product comes in, from the stock catalogue ([{ style_key, sizes: [{ size_label, quantity, item_id }] }]). */
export const sizesOf = (cat, style) => [...new Set((cat?.styles ?? []).find((x) => x.style_key === style)?.sizes.map((s) => s.size_label).filter(Boolean) ?? [])];

// ------------------------------------------------------------------------------------------------------------------ receipt
export function ReceiptSheet({ issueId, onClose }) {
  const { toast } = useSession();
  const r = useLoad(() => (issueId ? api.get(`/academy/kit/issues/${issueId}/receipt`) : Promise.resolve(null)), [issueId]);
  return (
    <Sheet visible={!!issueId} onClose={onClose} title={t('kit.receipt_title')}>
      {r.error ? <LoadError error={r.error} onRetry={r.reload} /> : !r.data ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <View accessible accessibilityRole="summary" accessibilityLabel={r.data.text.replace(/\n/g, '. ')} style={{ gap: 6 }}>
            {r.data.text.split('\n').map((line, i) => <T key={i} size={i === 0 ? 16 : 14} weight={i === 0 ? '800' : '600'}>{line}</T>)}
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title={t('kit.share')} onPress={() => shareText(r.data.text, toast)} accessibilityLabel={t('kit.share_a11y')} />
            <Btn small title={t('common.close')} color={c.paper} ink={c.ink} onPress={onClose} />
          </View>
        </View>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------ one due line
function DueCard({ r, onFit, onIssue }) {
  return (
    <Card pad={14}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Initials name={r.athlete} user={{ display_name: r.athlete }} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <T weight="800" style={{ flexShrink: 1 }}>{r.athlete}</T>
            {r.overdue ? <Tag label={t('kit.overdue')} color={c.red} /> : <Tag label={t('kit.due_on', { date: day(r.due_on) })} color={c.violetSoft} />}
          </View>
          <T size={13} color={c.mute}>{r.entitlement} · {t('kit.qty_n', { n: r.outstanding })}{r.reason === 'replacement' ? ` · ${t('kit.replacement')}` : ''}</T>
          <T size={12} color={c.mute}>{[r.cohort, r.programme].filter(Boolean).join(' · ')}</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {r.needs_fitting ? <Tag label={t('kit.needs_fitting')} color={c.sunSoft} /> : r.size ? <Tag label={t('kit.size_n', { size: r.size })} color={c.pinkSoft} /> : null}
        {r.needs_fitting ? null : <Tag label={r.available > 0 ? t('kit.in_stock_n', { n: r.available }) : t('kit.out_of_stock')} color={r.available > 0 ? c.mint : c.redSoft} />}
        {r.mode === 'deposit' ? <Tag label={t('kit.mode_deposit')} color={c.cyanSoft} /> : r.mode === 'charged' ? <Tag label={t('kit.mode_charged')} color={c.cyanSoft} /> : null}
        {r.loan_days ? <Tag label={t('kit.loan_days', { n: r.loan_days })} color={c.cyanSoft} /> : null}
      </View>
      {r.collection_note ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{r.collection_note}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}>
        <Btn small title={r.needs_fitting ? t('kit.fit') : t('kit.refit')} color={c.paper} ink={c.ink} onPress={() => onFit(r)} accessibilityLabel={t('kit.fit_a11y', { name: r.athlete })} />
        <Btn small title={t('kit.issue')} disabled={r.needs_fitting} onPress={() => onIssue(r)} accessibilityLabel={t('kit.issue_a11y', { name: r.athlete, item: r.entitlement })} />
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------------------ issue sheet
function IssueSheet({ row, base, venueId, venues, onClose, onDone, toast }) {
  const ref = useRef(uid() + uid());
  const [venue, setVenue] = useState(venueId ?? row?.collect_at ?? venues[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [problem, setProblem] = useState(null);
  const go = async () => {
    setBusy(true); setProblem(null);
    try { setResult(await api.post(`${base}/issues`, { enrolment_id: row.enrolment_id, entitlement_id: row.entitlement_id, venue_id: venue, client_ref: ref.current })); onDone?.(); } catch (e) { setProblem(e); } finally { setBusy(false); }
  };
  const close = () => { setResult(null); setProblem(null); ref.current = uid() + uid(); onClose(); };
  const money = (m) => (m ? `${moneyIn(m.amount_minor, m.currency)}` : null);
  return (
    <Sheet visible={!!row} onClose={close} title={t('kit.issue_title')}>
      {row ? (
        <View style={{ gap: 10 }}>
          <T weight="800">{row.athlete}</T>
          <T size={13} color={c.mute}>{row.entitlement}{row.size ? ` · ${t('kit.size_n', { size: row.size })}` : ''} · {t('kit.qty_n', { n: row.outstanding })}</T>
          {!venueId && venues.length > 1 ? <MenuField label={t('kit.from_venue')} value={venue} onChange={setVenue} options={venues.map((v) => ({ value: v.id, label: v.name }))} /> : null}
          {problem ? (
            <Card color={c.sunSoft} pad={12}>
              <T weight="800">{kitError(problem)}</T>
              {problem.code === 'kit_payment_required' ? <T size={12} color={c.mute}>{t('kit.pay_first_hint')}</T> : null}
            </Card>
          ) : null}
          {result ? (
            <Card color={c.mint} pad={12}>
              <T weight="800">{result.status === 'reserved' ? t('kit.reserved_msg') : t('kit.issued_msg')}</T>
              <T size={13}>{result.item}{result.size_label ? ` · ${t('kit.size_n', { size: result.size_label })}` : ''}{result.serial_no ? ` · ${t('kit.serial_n', { serial: result.serial_no })}` : ''}</T>
              {result.charge ? <T size={13}>{t('kit.fee_line', { amount: money(result.charge), status: result.charge.status === 'paid' ? t('kit.paid') : t('kit.to_pay') })}</T> : null}
              {result.deposit ? <T size={13}>{t('kit.deposit_line', { amount: money(result.deposit), status: result.deposit.status === 'paid' ? t('kit.paid') : t('kit.to_pay') })}</T> : null}
              {result.replayed ? <T size={12} color={c.mute}>{t('kit.replayed')}</T> : null}
            </Card>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {result ? <Btn title={t('kit.view_receipt')} onPress={() => { const id = result.id; close(); onDone?.(id); }} /> : <Btn title={t('kit.confirm_issue')} onPress={go} loading={busy} disabled={!venue} accessibilityLabel={t('kit.confirm_issue_a11y', { name: row.athlete })} />}
            <Btn title={t('common.close')} color={c.paper} ink={c.ink} onPress={close} />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------ with the athletes: return, exchange, report
export function HeldCard({ r, onReturn, onExchange, onReport, onReceipt, onHandover }) {
  return (
    <Card pad={14}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Initials name={r.athlete} user={{ display_name: r.athlete }} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800" style={{ flexShrink: 1 }}>{r.athlete}</T><StatusTag s={r.status} /></View>
          <T size={13} color={c.mute}>{r.item}{r.size_label ? ` · ${t('kit.size_n', { size: r.size_label })}` : ''}{r.serial_no ? ` · ${t('kit.serial_n', { serial: r.serial_no })}` : ''}</T>
          <T size={12} color={c.mute}>{r.venue}{r.issued_at ? ` · ${t('kit.issued_on', { date: day(r.issued_at) })}` : ''}{r.due_back_at ? ` · ${t('kit.back_by', { date: day(r.due_back_at) })}` : ''}</T>
        </View>
      </View>
      {r.overdue ? <Tag label={t('kit.return_overdue')} color={c.red} /> : null}
      {r.status === 'writeoff_pending' ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{t('kit.waiting_decision', { kind: r.writeoff_kind === 'lost' ? t('kit.lost') : t('kit.damaged') })}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}>
        <Btn small title={t('kit.receipt')} color={c.paper} ink={c.ink} onPress={() => onReceipt(r)} accessibilityLabel={t('kit.receipt_a11y', { name: r.athlete })} />
        {r.status === 'reserved' ? <Btn small title={t('kit.handover')} onPress={() => onHandover(r)} /> : null}
        {r.status === 'issued' ? <><Btn small title={t('kit.report')} color={c.paper} ink={c.red} onPress={() => onReport(r)} /><Btn small title={t('kit.exchange')} color={c.paper} ink={c.ink} onPress={() => onExchange(r)} /><Btn small title={t('kit.take_back')} onPress={() => onReturn(r)} accessibilityLabel={t('kit.take_back_a11y', { name: r.athlete, item: r.item })} /></> : null}
      </View>
    </Card>
  );
}

function ReturnSheet({ row, base, onClose, onDone }) {
  const [cond, setCond] = useState('good');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const close = () => { setOut(null); setErr(null); setNote(''); setCond('good'); onClose(); };
  const go = async () => {
    setBusy(true); setErr(null);
    try { setOut(await api.post(`${base}/issues/${row.id}/return`, { condition: cond, note: note.trim() || undefined })); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const d = out?.deposit;
  return (
    <Sheet visible={!!row} onClose={close} title={t('kit.return_title')}>
      {row ? (
        <View style={{ gap: 10 }}>
          <T weight="800">{row.athlete} · {row.item}{row.size_label ? ` (${row.size_label})` : ''}</T>
          {out ? (
            <Card color={c.mint} pad={12}>
              <T weight="800">{out.status === 'writeoff_pending' ? t('kit.return_pending') : t('kit.return_done')}</T>
              {d ? <T size={13}>{({ cancelled_unpaid: t('kit.dep_cancelled'), refund_at_desk: t('kit.dep_refund_desk', { amount: moneyIn(d.refund_minor, d.currency) }), refund_online: t('kit.dep_refund_online', { amount: moneyIn(d.refund_minor, d.currency) }), refund_pending: t('kit.dep_refund_pending'), forfeited: t('kit.dep_forfeited') })[d.action]}</T> : null}
              <Btn small title={t('common.done')} onPress={close} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
            </Card>
          ) : (
            <>
              <T weight="800" size={13}>{t('kit.condition')}</T>
              <Seg options={[{ value: 'good', label: t('kit.cond_good') }, { value: 'worn', label: t('kit.cond_worn') }, { value: 'damaged', label: t('kit.cond_damaged') }]} value={cond} onChange={setCond} />
              {cond === 'damaged' ? <T size={12} color={c.mute}>{t('kit.damaged_goes_to_manager')}</T> : null}
              <Field label={t('kit.note')} value={note} onChangeText={setNote} multiline maxLength={300} />
              {err ? <T color={c.red} weight="800">{kitError(err)}</T> : null}
              <Btn title={t('kit.take_back')} onPress={go} loading={busy} disabled={cond === 'damaged' && note.trim().length < 3} />
            </>
          )}
        </View>
      ) : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------ the desk
/**
 * The kit desk. `desk` (venue front desk) fixes the venue and hides academy-wide tabs; the Academy section passes `venues` to pick from.
 * orgId + venueId are all the API needs: a cashier of the venue is let in by the server for exactly that venue.
 */
export function KitIssueDesk({ orgId, venueId = null, venues = [], toast, onChanged }) {
  const { tablet } = useLayout();
  const base = `/organisations/${orgId}/academy/kit`;
  const vq = venueId ? { venue_id: venueId } : {};
  const [view, setView] = useState('due');
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [cam, setCam] = useState(false);
  const [code, setCode] = useState('');
  const [found, setFound] = useState(null);
  const [fit, setFit] = useState(null);
  const [issueRow, setIssueRow] = useState(null);
  const [ret, setRet] = useState(null);
  const [ex, setEx] = useState(null);
  const [rep, setRep] = useState(null);
  const [rcpt, setRcpt] = useState(null);
  const cat = useLoad(() => api.get(`${base}/catalogue`, vq), [orgId, venueId]);
  const due = useLoad(() => (view === 'due' ? api.get(`${base}/due`, { ...vq, q: q || undefined, status: filter || undefined, limit: 50 }) : Promise.resolve(null)), [orgId, venueId, view, q, filter]);
  const held = useLoad(() => (view !== 'due' ? api.get(`${base}/issues`, { ...vq, status: view === 'held' ? 'issued' : view === 'reserved' ? 'reserved' : 'issued', overdue: view === 'overdue' ? true : undefined, q: q || undefined, limit: 50 }) : Promise.resolve(null)), [orgId, venueId, view, q]);
  const refresh = () => { due.reload?.(); held.reload?.(); cat.reload?.(); onChanged?.(); };
  const scan = async (value) => {
    const v = String(value ?? '').trim();
    if (!v) return;
    try { setFound(await api.get(`${base}/resolve`, { ...vq, code: v })); setCam(false); setCode(''); } catch (e) { toast(e.status === 404 ? t('kit.code_unknown') : kitError(e)); }
  };
  const doAction = async (fn, ok) => { try { await fn(); toast(ok); refresh(); } catch (e) { toast(kitError(e)); } };
  const list = view === 'due' ? due : held;
  const venueOptions = venues.length ? venues : [];
  return (
    <View style={{ gap: 12 }}>
      <Seg options={[{ value: 'due', label: t('kit.view_due') }, { value: 'held', label: t('kit.view_held') }, { value: 'reserved', label: t('kit.view_reserved') }, { value: 'overdue', label: t('kit.view_overdue') }]} value={view} onChange={setView} />
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 10, alignItems: tablet ? 'flex-end' : 'stretch' }}>
        <View style={{ flex: 1 }}><Field label={t('kit.search')} value={q} onChangeText={setQ} placeholder={t('kit.search_ph')} accessibilityLabel={t('kit.search_a11y')} /></View>
        <View style={{ flex: 1 }}><Field label={t('kit.scan_label')} value={code} onChangeText={setCode} placeholder={t('kit.scan_ph')} hint={t('kit.scan_hint')} accessibilityLabel={t('kit.scan_a11y')} /></View>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 2 }}>
          <Btn small title={t('kit.look_up')} onPress={() => scan(code)} disabled={!code.trim()} />
          {hasCamera ? <Btn small title={cam ? t('common.close') : t('kit.scan')} color={c.paper} ink={c.ink} onPress={() => setCam((x) => !x)} accessibilityLabel={t('kit.scan_camera_a11y')} /> : null}
        </View>
      </View>
      {cam && hasCamera ? <CameraScan onCode={scan} onClose={() => setCam(false)} /> : null}
      {view === 'due' ? (
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {[['', t('common.all')], ['overdue', t('kit.f_overdue')], ['needs_fitting', t('kit.f_fitting')], ['short', t('kit.f_short')]].map(([v, l]) => <Chip key={v || 'all'} label={l} active={filter === v} onPress={() => setFilter(v)} />)}
        </View>
      ) : null}
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length === 0 ? (
        <Empty emoji={view === 'due' ? '🎽' : '📦'} title={view === 'due' ? t('kit.empty_due_title') : t('kit.empty_held_title')} sub={view === 'due' ? t('kit.empty_due_sub') : t('kit.empty_held_sub')} />
      ) : view === 'due'
        ? <View style={{ gap: 8 }}>{list.data.map((r) => <DueCard key={`${r.enrolment_id}:${r.entitlement_id}`} r={r} onFit={setFit} onIssue={setIssueRow} />)}</View>
        : <View style={{ gap: 8 }}>{list.data.map((r) => (
          <HeldCard key={r.id} r={r} onReturn={setRet} onExchange={setEx} onReport={setRep} onReceipt={(x) => setRcpt(x.id)}
            onHandover={(x) => doAction(() => api.post(`${base}/issues/${x.id}/handover`), t('kit.handed_over'))} />))}</View>}

      <FormSheet visible={!!fit} onClose={() => setFit(null)} title={fit ? t('kit.fit_title', { name: fit.athlete }) : ''} submitLabel={t('common.save')} initial={{ size_label: fit?.size }}
        fields={[
          { key: 'size_label', label: t('kit.size'), type: 'chips', options: fit ? sizesOf(cat.data, fit.style_key).map((s) => ({ value: s, label: s })) : [], hint: t('kit.size_hint') },
          { key: 'fit_note', label: t('kit.fit_note'), type: 'multiline', optional: true, hint: t('kit.fit_note_hint') },
        ]}
        onSubmit={async (v) => { await api.post(`${base}/sizes`, { ...vq, athlete_id: fit.athlete_id, slot: fit.kit_slot ?? fit.style_key, size_label: v.size_label, fit_note: v.fit_note }); toast(t('kit.fit_saved')); setFit(null); refresh(); }} />
      <IssueSheet row={issueRow} base={base} venueId={venueId} venues={venueOptions} toast={toast} onClose={() => setIssueRow(null)} onDone={(id) => { refresh(); if (id) setRcpt(id); }} />
      <ReturnSheet row={ret} base={base} onClose={() => setRet(null)} onDone={refresh} />
      <FormSheet visible={!!ex} onClose={() => setEx(null)} title={ex ? t('kit.exchange_title', { name: ex.athlete }) : ''} submitLabel={t('kit.exchange')}
        fields={[
          { key: 'size_label', label: t('kit.new_size'), type: 'chips', options: ex ? sizesOf(cat.data, ex.style_key).filter((s) => s !== ex.size_label).map((s) => ({ value: s, label: s })) : [] },
          { key: 'reason', label: t('kit.reason'), type: 'chips', options: [{ value: 'wrong_size', label: t('kit.r_wrong_size') }, { value: 'growth', label: t('kit.r_growth') }, { value: 'defect', label: t('kit.r_defect') }, { value: 'other', label: t('kit.r_other') }] },
        ]} initial={{ reason: 'wrong_size' }}
        onSubmit={async (v) => { try { await api.post(`${base}/issues/${ex.id}/exchange`, { size_label: v.size_label, reason: v.reason, client_ref: uid() + uid() }); } catch (e) { throw new Error(kitError(e)); } toast(t('kit.exchanged')); setEx(null); refresh(); }} />
      <FormSheet visible={!!rep} onClose={() => setRep(null)} title={rep ? t('kit.report_title', { name: rep.athlete }) : ''} submitLabel={t('kit.send_report')} notice={t('kit.report_notice')}
        fields={[
          { key: 'kind', label: t('kit.what_happened'), type: 'chips', options: [{ value: 'damaged', label: t('kit.damaged') }, { value: 'lost', label: t('kit.lost') }] },
          { key: 'note', label: t('kit.note'), type: 'multiline' },
        ]} initial={{ kind: 'lost' }}
        onSubmit={async (v) => { await api.post(`${base}/issues/${rep.id}/report`, { kind: v.kind, note: v.note }); toast(t('kit.report_sent')); setRep(null); refresh(); }} />
      <Sheet visible={!!found} onClose={() => setFound(null)} title={t('kit.scan_result')}>
        {found ? (
          <View style={{ gap: 8 }}>
            {found.kind === 'item' ? <><T weight="800">{found.item.name}{found.item.size_label ? ` · ${t('kit.size_n', { size: found.item.size_label })}` : ''}</T><T size={13} color={c.mute}>{found.item.venue} · {t('kit.on_hand_n', { n: found.item.quantity })}</T></> : null}
            {found.kind === 'unit' ? <><T weight="800">{found.unit.name} · {t('kit.serial_n', { serial: found.unit.serial_no })}</T><T size={13} color={c.mute}>{found.unit.athlete ? t('kit.held_by', { name: found.unit.athlete }) : t('kit.unit_state', { state: String(found.unit.status).replace('_', ' ') })}</T>
              {found.unit.issue_id ? <Btn small title={t('kit.receipt')} onPress={() => { setRcpt(found.unit.issue_id); setFound(null); }} /> : null}</> : null}
            {found.kind === 'issue' ? <><T weight="800">{found.issue.name}</T><T size={13} color={c.mute}>{found.issue.athlete} · {statusText(found.issue.status)}</T><Btn small title={t('kit.receipt')} onPress={() => { setRcpt(found.issue.id); setFound(null); }} /></> : null}
            <Btn small title={t('common.close')} color={c.paper} ink={c.ink} onPress={() => setFound(null)} />
          </View>
        ) : null}
      </Sheet>
      <ReceiptSheet issueId={rcpt} onClose={() => setRcpt(null)} />
    </View>
  );
}

export { slotLabel };
