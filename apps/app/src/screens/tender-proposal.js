// Supplier proposal workspace: lots, technical answers, evidence, commercial pricing grid with live totals, and a review step that submits and
// shows the immutable receipt. The draft autosaves with a version check, so two colleagues never overwrite each other; nothing here is a
// submission until the server returns a receipt.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Screen, Sheet, T } from '../ui';
import { Counter, DateField } from '../pickers';
import { pickEvidence } from '../evidence';
import { Head } from './coaching';
import { c } from '../theme';
import { explain } from '../access';
import { Checks, Chips, Countdown, DataTable, KV, Notice, Panel, Split, StageTag, Status, Tabs, amount, blobOf, exponentOf, fromMinor, lineMinor, nice, openDocument, openStored, pickText, saveExport, toMinor, when } from '../tender-ui';

const SECTION_TABS = [{ value: 'lots', label: 'Lots' }, { value: 'technical', label: 'Technical' }, { value: 'evidence', label: 'Evidence' }, { value: 'commercial', label: 'Commercial' }, { value: 'review', label: 'Review' }];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** One questionnaire answer, with the control that fits its type. */
function Answer({ q, value, onChange }) {
  const label = `${q.prompt}${q.required ? '' : ' (optional)'}`;
  switch (q.type) {
    case 'yes_no': return <View style={{ gap: 6 }}><T weight="700" size={13}>{label}</T><Chips options={[{ value: true, label: 'Yes' }, { value: false, label: 'No' }]} value={value} onChange={onChange} /></View>;
    case 'single_select': return <View style={{ gap: 6 }}><T weight="700" size={13}>{label}</T><Chips options={q.options ?? []} value={value} onChange={onChange} /></View>;
    case 'multi_select': return <View style={{ gap: 6 }}><T weight="700" size={13}>{label}</T><Chips multi options={q.options ?? []} value={value ?? []} onChange={onChange} /></View>;
    case 'number': return <View style={{ gap: 6 }}><T weight="700" size={13}>{label}{q.unit ? ` (${q.unit})` : ''}</T><Counter value={Number(value ?? 0)} onChange={onChange} min={0} max={10000000} /></View>;
    case 'date': return <DateField label={label} value={value} onChange={onChange} optional={!q.required} />;
    case 'currency': return <Field label={label} value={value === undefined ? '' : String(value / 100)} onChangeText={(x) => { const m = toMinor(x, 'INR'); onChange(m === null ? undefined : m); }} keyboardType="decimal-pad" />;
    case 'table': { const cols = q.options?.length ? q.options : ['Item', 'Detail']; const rows = value ?? [];
      return (
        <View style={{ gap: 6 }}><T weight="700" size={13}>{label}</T>
          {rows.map((r, i) => <View key={i} style={{ gap: 6, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 10 }}>{cols.map((col) => <Field key={col} label={col} value={r[col] ?? ''} onChangeText={(x) => onChange(rows.map((y, j) => (j === i ? { ...y, [col]: x } : y)))} />)}<Btn small title="Remove row" color={c.violet} onPress={() => onChange(rows.filter((_, j) => j !== i))} style={{ alignSelf: 'flex-start' }} /></View>)}
          <Btn small title="+ Add row" color={c.violet} onPress={() => onChange([...rows, {}])} style={{ alignSelf: 'flex-start' }} />
        </View>); }
    case 'attachment': return <T size={12} color={c.mute}>{label}: attach the file on the Evidence step.</T>;
    default: return <Field label={label} value={value ?? ''} onChangeText={onChange} multiline />;
  }
}

function PricingLine({ lot, line, set, cur, extra, editable }) {
  const [rate, setRate] = useState(line ? fromMinor(line.rate_minor, line.currency ?? cur) : '');
  const lc = line?.currency ?? cur;
  const calc = line ? lineMinor(line) : null;
  return (
    <Card>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="700" size={14} style={{ flexShrink: 1 }}>{lot.code} · {lot.title}</T><T size={12} color={c.mute}>Requested {lot.qty} {lot.unit ?? ''}{lot.allow_partial ? '' : ' (offer in full)'}</T></View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <View style={{ flexGrow: 1, flexBasis: 110 }}><Field label={`Quantity${lot.unit ? ` (${lot.unit})` : ''}`} value={String(line?.qty ?? lot.qty)} onChangeText={(x) => set({ qty: x.replace(/[^0-9.]/g, '') })} keyboardType="decimal-pad" /></View>
          <View style={{ flexGrow: 1, flexBasis: 140 }}><Field label={`Unit rate (${lc})`} value={rate} onChangeText={(x) => { const t = x.replace(/[^0-9.,]/g, ''); setRate(t); const m = toMinor(t, lc); if (m !== null) set({ rate_minor: m }); }} keyboardType="decimal-pad" placeholder="0.00" /></View>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
          <View style={{ gap: 4 }}><T size={11} weight="700" color={c.mute}>DISCOUNT %</T><Counter value={(line?.discount_bp ?? 0) / 100} onChange={(x) => set({ discount_bp: Math.round(x * 100) })} min={0} max={100} /></View>
          <View style={{ gap: 4 }}><T size={11} weight="700" color={c.mute}>TAX %</T><Counter value={(line?.tax_bp ?? 0) / 100} onChange={(x) => set({ tax_bp: Math.round(x * 100) })} min={0} max={100} /></View>
          <View style={{ gap: 4 }}><T size={11} weight="700" color={c.mute}>PRICE INCLUDES TAX</T><Chips options={[{ value: true, label: 'Yes' }, { value: false, label: 'No' }]} value={!!line?.tax_inclusive} onChange={(x) => set({ tax_inclusive: x })} /></View>
          {extra.length > 1 ? <View style={{ gap: 4 }}><T size={11} weight="700" color={c.mute}>CURRENCY</T><Chips options={extra} value={lc} onChange={(x) => set({ currency: x })} /></View> : null}
        </View>
        {calc ? <KV items={[['Net', amount(calc.net, lc)], ['Tax', amount(calc.tax, lc)], ['Gross', amount(calc.gross, lc)]]} /> : <T size={12} color={c.mute}>Enter a unit rate to see the line total.</T>}
        <Field label="Note (optional)" value={line?.notes ?? ''} onChangeText={(x) => set({ notes: x })} />
      </View>
    </Card>
  );
}

export function TenderProposal({ id }) {
  const { toast } = useSession();
  const { push, back } = useNav();
  const p = useLoad(() => api.get(`/proposals/${id}`), [id]);
  const notice = useLoad(async () => (p.data ? api.get(`/tenders/${p.data.project_id}`) : null), [p.data?.project_id]);
  const [tab, setTab] = useState('lots');
  const [d, setD] = useState(null);
  const [lotsSel, setLotsSel] = useState(null);
  const [state, setState] = useState('saved');
  const [version, setVersion] = useState(1);
  const [sheet, setSheet] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checklist, setChecklist] = useState(null);
  const key = useRef(`submit-${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const saved = useRef(null);
  useEffect(() => { if (p.data && !d) { setD(p.data.draft); setLotsSel(p.data.lots); setVersion(p.data.draft_version); saved.current = JSON.stringify({ d: p.data.draft, l: p.data.lots }); } }, [p.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // autosave: 1.5 s after the last edit, with the version that was read. A conflict stops saving and asks to reload.
  const snap = JSON.stringify({ d, l: lotsSel });
  useEffect(() => {
    if (!d || snap === saved.current || state === 'conflict') return undefined;
    setState('dirty');
    const t = setTimeout(async () => {
      setState('saving');
      try {
        const r = await api.patch(`/proposals/${id}/draft`, { draft_version: version, technical: d.technical, commercial: d.commercial, lots: lotsSel });
        saved.current = snap; setVersion(r.draft_version); setState('saved');
      } catch (e) { setState(e.status === 409 ? 'conflict' : 'error'); if (e.status !== 409) toast(explain(e)); }
    }, 1500);
    return () => clearTimeout(t);
  }, [snap]); // eslint-disable-line react-hooks/exhaustive-deps

  // the review step shows the server's own checklist, refreshed whenever the saved version changes
  useEffect(() => { if (tab === 'review') api.post(`/proposals/${id}/validate`).then(setChecklist).catch(() => {}); }, [tab, version, id]);

  if (p.error) return <Screen><ErrorBox error={p.error} onRetry={p.reload} /></Screen>;
  if (!p.data || !d || !notice.data) return <Screen><Loading /></Screen>;
  const t = p.data.tender, nt = notice.data.notice, cur = t.currency;
  const editable = p.data.editable;
  const lots = (nt.lots ?? []).filter((l) => lotsSel.includes(l.code));
  const qs = notice.data.questionnaire ?? [];
  const answers = { ...d.technical.answers, ...d.commercial.answers };
  const visible = (q) => (!q.show_if || answers[q.show_if.key] === q.show_if.equals) && (!q.lot_code || lotsSel.includes(q.lot_code));
  const setTech = (patch) => setD((x) => ({ ...x, technical: { ...x.technical, ...patch } }));
  const setComm = (patch) => setD((x) => ({ ...x, commercial: { ...x.commercial, ...patch } }));
  const setAnswer = (q, v) => (q.section === 'commercial' ? setComm({ answers: { ...d.commercial.answers, [q.key]: v } }) : setTech({ answers: { ...d.technical.answers, [q.key]: v } }));
  const setLine = (code, patch) => setComm({ lines: d.commercial.lines.some((l) => l.lot_code === code) ? d.commercial.lines.map((l) => (l.lot_code === code ? { ...l, ...patch } : l)) : [...d.commercial.lines, { lot_code: code, qty: String(nt.lots.find((l) => l.code === code).qty), unit: nt.lots.find((l) => l.code === code).unit, rate_minor: 0, discount_bp: 0, tax_bp: 0, tax_inclusive: false, ...patch }] });
  const entCurrencies = [cur, ...(nt.fx?.currencies ?? []).filter((x) => x !== cur)];
  const upload = async (envelope, qkey) => {
    try {
      const f = await pickEvidence('files'); if (!f) return;
      const r = await api.upload(`/proposals/${id}/files`, await blobOf(f), { envelope, name: f.file_name });
      if (qkey) setTech({ evidence: { ...d.technical.evidence, [qkey]: [...(d.technical.evidence[qkey] ?? []), r.id] }, attachments: [...d.technical.attachments, r.id] });
      else if (envelope === 'technical') setTech({ attachments: [...d.technical.attachments, r.id] });
      else setComm({ attachments: [...d.commercial.attachments, r.id] });
      toast('File uploaded and checked');
    } catch (e) { toast(explain(e)); }
  };
  const cl = checklist ?? p.data.checklist;
  const items = cl.items.map((x) => ({ key: x.key, state: x.severity === 'error' ? 'bad' : 'warn', title: x.message }));
  const totals = (() => { const o = {}; for (const l of d.commercial.lines.filter((x) => lotsSel.includes(x.lot_code))) { const m = lineMinor(l); if (!m) continue; const k = l.currency ?? cur; o[k] ??= { net: 0, gross: 0 }; o[k].net += m.net; o[k].gross += m.gross; } return o; })();
  const submit = async () => {
    setBusy(true);
    try { const r = await api.post(`/proposals/${id}/submit`, { idempotency_key: key.current, declaration: true, expected_draft_version: version }); setReceipt(r); setSheet(null); p.reload(); }
    catch (e) { if (e.status === 422 && e.details?.items) { setChecklist({ ok: false, items: e.details.items.map((x) => ({ ...x })) }); setSheet(null); setTab('review'); toast('Some items are missing. Fix them and submit again.'); } else toast(e.status === 409 || e.status === 0 ? `${explain(e)} Your draft is safe. If you are unsure whether it arrived, submit again: the same request never creates a duplicate.` : explain(e)); }
    finally { setBusy(false); }
  };
  const stateWord = { saved: 'All changes saved', dirty: 'Unsaved changes', saving: 'Saving…', conflict: 'A colleague saved a newer draft', error: 'Could not save. Retrying on your next change.' }[state];
  const sections = {
    lots: <Panel title="Lots you are bidding on"><Chips multi options={nt.lots.map((l) => ({ value: l.code, label: `${l.code} · ${l.title}` }))} value={lotsSel} onChange={(v) => v.length && editable && setLotsSel(v)} />{nt.lots.some((l) => l.bundle_with?.length) ? <T size={12} color={c.mute}>Some lots must be bid together: {nt.lots.filter((l) => l.bundle_with?.length).map((l) => `${l.code} with ${l.bundle_with.join(', ')}`).join('; ')}.</T> : null}</Panel>,
    technical: (
      <>
        <Panel title="Technical answers · sealed until opening">
          {qs.filter((q) => q.section !== 'commercial' && q.type !== 'attachment' && visible(q)).map((q) => <Answer key={q.key} q={q} value={answers[q.key]} onChange={(v) => setAnswer(q, v)} />)}
          <Field label="Delivery plan" multiline value={d.technical.delivery_plan ?? ''} onChangeText={(x) => setTech({ delivery_plan: x })} />
          <View style={{ gap: 6 }}><T weight="700" size={13}>Crew headcount you will commit</T><Counter value={d.technical.staffing?.headcount ?? 0} onChange={(x) => setTech({ staffing: { ...d.technical.staffing, headcount: x } })} min={0} max={100000} /></View>
          <Field label="Assumptions" multiline value={d.technical.assumptions ?? ''} onChangeText={(x) => setTech({ assumptions: x })} />
          <Field label="Deviations from the tender (optional)" multiline value={d.technical.deviations ?? ''} onChangeText={(x) => setTech({ deviations: x })} />
          <T size={12} color={c.mute}>Prices and fees are not allowed here. They go in the commercial envelope.</T>
        </Panel>
        <Panel title="Subcontractors" right={<Btn small title="+ Add" color={c.violet} onPress={() => setTech({ subcontractors: [...d.technical.subcontractors, { name: '', scope: '' }] })} />}>
          {d.technical.subcontractors.length ? d.technical.subcontractors.map((s, i) => <View key={i} style={{ gap: 6 }}><Field label="Name" value={s.name} onChangeText={(x) => setTech({ subcontractors: d.technical.subcontractors.map((y, j) => (j === i ? { ...y, name: x } : y)) })} /><Field label="Scope" value={s.scope} onChangeText={(x) => setTech({ subcontractors: d.technical.subcontractors.map((y, j) => (j === i ? { ...y, scope: x } : y)) })} /><Btn small title="Remove" color={c.violet} onPress={() => setTech({ subcontractors: d.technical.subcontractors.filter((_, j) => j !== i) })} style={{ alignSelf: 'flex-start' }} /></View>) : <T size={13} color={c.mute}>None disclosed.</T>}
        </Panel>
      </>
    ),
    evidence: (
      <Panel title="Evidence and attachments" right={<Btn small title="Attach file" onPress={() => upload('technical')} />}>
        {qs.filter((q) => q.evidence_required || q.type === 'attachment').map((q) => (
          <View key={q.key} style={{ gap: 6, paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}>
            <T weight="700" size={13}>{q.prompt}</T>
            <T size={12} color={c.mute}>{(d.technical.evidence[q.key] ?? []).length ? `${d.technical.evidence[q.key].length} file(s) attached` : 'No file attached yet'}</T>
            <Btn small title="Attach evidence" color={c.violet} onPress={() => upload('technical', q.key)} style={{ alignSelf: 'flex-start' }} />
          </View>
        ))}
        <T size={12} color={c.mute}>{d.technical.attachments.length} technical file(s) and {d.commercial.attachments.length} commercial file(s) attached. PDFs, photos and Word or Excel files without macros are accepted; spreadsheets cannot go in the technical envelope because they can carry prices. Every file is checked on upload.</T>
        <Btn small title="Attach a priced document (commercial envelope)" color={c.violet} onPress={() => upload('commercial')} style={{ alignSelf: 'flex-start' }} />
      </Panel>
    ),
    commercial: (
      <>
        <Panel title="Pricing · sealed until opening" right={<View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Btn small title="Export sheet" color={c.violet} onPress={async () => { try { await saveExport(await api.get(`/proposals/${id}/pricing-sheet`, { format: 'csv' })); } catch (e) { toast(explain(e)); } }} />
          <Btn small title="Import sheet" color={c.violet} onPress={async () => { try { const csv = await pickText(); if (!csv) return; const r = await api.post(`/proposals/${id}/pricing-sheet`, { csv, draft_version: version }); toast(`${r.imported_lines} priced lot(s) imported`); setD(null); p.reload(); } catch (e) { toast(explain(e)); } }} /></View>}>
          <T size={13} color={c.mute}>Prices in {cur}{entCurrencies.length > 1 ? ' or the currencies the tender has approved rates for' : ''}. Costs are compared {nt.cost_basis} of tax. Enter each lot's unit rate; totals update as you type.</T>
        </Panel>
        {lots.map((l) => <PricingLine key={l.code} lot={l} line={d.commercial.lines.find((x) => x.lot_code === l.code)} set={(patch) => editable && setLine(l.code, patch)} cur={cur} extra={entCurrencies} editable={editable} />)}
        <Panel title="Your totals">{Object.keys(totals).length ? Object.entries(totals).map(([k, v]) => <KV key={k} items={[[`Net (${k})`, amount(v.net, k)], [`Gross (${k})`, amount(v.gross, k)]]} />) : <T size={13} color={c.mute}>Totals appear when lots are priced.</T>}</Panel>
        <Panel title="Terms">
          <View style={{ gap: 6 }}><T weight="700" size={13}>Price validity (days)</T><Counter value={d.commercial.validity_days ?? 60} onChange={(x) => setComm({ validity_days: x })} min={1} max={730} step={5} /></View>
          <Field label="Payment terms" multiline value={d.commercial.payment_terms ?? ''} onChangeText={(x) => setComm({ payment_terms: x })} />
          <Field label="Commercial assumptions" multiline value={d.commercial.assumptions ?? ''} onChangeText={(x) => setComm({ assumptions: x })} />
          {qs.filter((q) => q.section === 'commercial' && q.type !== 'attachment' && visible(q)).map((q) => <Answer key={q.key} q={q} value={answers[q.key]} onChange={(v) => setAnswer(q, v)} />)}
        </Panel>
      </>
    ),
    review: (
      <>
        <Panel title="Before you submit"><Checks items={items} empty="Everything required is complete." />{cl.ok ? <Status tone="ok" label="Ready to submit" /> : <Status tone="bad" label={`${cl.missing ?? items.filter((x) => x.state === 'bad').length} item(s) to fix`} />}</Panel>
        {p.data.submissions.length ? <Panel title="Submitted versions">{p.data.submissions.map((s) => <View key={s.version} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T size={13} weight="700">Version {s.version}</T><T size={12} color={c.mute} style={{ flex: 1 }}>{when(s.submitted_at, t.timezone)} · {s.receipt_no}</T>{s.late ? <Status tone="warn" label="Late window" /> : null}</View>)}<Btn small title="Receipt PDF" color={c.violet} onPress={() => openDocument('receipt', id, {}, 'receipt').catch((e) => toast(explain(e)))} style={{ alignSelf: 'flex-start' }} /></Panel> : null}
      </>
    ),
  };
  const side = (
    <>
      <Card><View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><StageTag stage={t.stage} /><Status tone={state === 'saved' ? 'ok' : state === 'conflict' || state === 'error' ? 'bad' : 'warn'} label={stateWord} /></View>
        {['open', 'submission'].includes(t.stage) ? <Countdown to={t.closes_at} /> : null}
        <T size={12} color={c.mute}>Closes {when(t.closes_at, t.timezone)}. Revisions {t.allow_revision ? 'are allowed until then' : 'are not allowed'}; withdrawal {t.allow_withdrawal ? 'is allowed' : 'is not allowed'}.</T>
        {state === 'conflict' ? <Btn small title="Load the newer draft" onPress={() => { setD(null); setState('saved'); p.reload(); }} /> : null}
      </View></Card>
      <Panel title="Completion"><View style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }}><View style={{ height: 8, width: `${cl.total_required ? Math.max(4, Math.round(100 * (1 - Math.min(cl.missing ?? 0, cl.total_required + 6) / (cl.total_required + 6)))) : 100}%`, backgroundColor: cl.ok ? c.lime : c.pink }} /></View><T size={12} color={c.mute}>{cl.ok ? 'Complete' : `${cl.missing} item(s) still to do`}</T></Panel>
      {!editable ? <Notice>{t.stage === 'closed' ? 'The tender has closed. This proposal can no longer be edited.' : 'This proposal cannot be edited now.'}</Notice> : null}
    </>
  );
  return (
    <Screen wide>
      <Head eyebrow={`PROPOSAL · ${t.ref}`} title={t.title} sub={`Bidding as ${p.data.alt_key === 'base' ? 'your main proposal' : 'an alternative proposal'}${p.data.round > 1 ? ` · round ${p.data.round}` : ''}`}
        right={<View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{p.data.status === 'submitted' && t.allow_withdrawal && editable ? <Btn small title="Withdraw" color={c.violet} onPress={() => setSheet('withdraw')} /> : null}<Btn small title={p.data.status === 'submitted' ? 'Submit revision' : 'Submit proposal'} disabled={!editable} onPress={() => { setTab('review'); setSheet('confirm'); }} /></View>} />
      <Tabs tabs={SECTION_TABS} value={tab} onChange={setTab} />
      <View style={{ marginTop: 14 }}><Split main={<View style={{ gap: 14 }}>{sections[tab]}</View>} side={side} sideWidth={320} /></View>
      <Sheet visible={sheet === 'confirm'} onClose={() => setSheet(null)} title="Submit your proposal" footer={<Btn title={busy ? 'Submitting…' : 'Submit now'} disabled={busy || !cl.ok || state !== 'saved'} loading={busy} onPress={submit} style={{ flex: 1 }} />}>
        <Notice tone={cl.ok ? 'info' : 'warn'}>{cl.ok ? 'The server will seal both envelopes and give you a receipt with the exact time it was received. Until you see the receipt, the proposal is not submitted.' : 'Some required items are still missing. Review them first.'}</Notice>
        {state !== 'saved' ? <T size={13} color={c.mute}>Waiting for your draft to finish saving…</T> : null}
        <T size={13}>By submitting you confirm you are authorised to bind this supplier to the offer, valid for {d.commercial.validity_days ?? 60} days.</T>
        <T size={12} color={c.mute}>If your connection drops, submit again: the same request never creates a duplicate.</T>
      </Sheet>
      <Sheet visible={sheet === 'withdraw'} onClose={() => setSheet(null)} title="Withdraw proposal" footer={<Btn title="Withdraw" onPress={async () => { try { await api.post(`/proposals/${id}/withdraw`, {}); setSheet(null); p.reload(); toast('Proposal withdrawn. You can resubmit before the deadline.'); } catch (e) { toast(explain(e)); } }} style={{ flex: 1 }} />}><T size={14}>Your submitted versions are kept for the record. A withdrawn proposal is not evaluated unless you submit again before the deadline.</T></Sheet>
      <Sheet visible={!!receipt} onClose={() => setReceipt(null)} title="Proposal received ✓" footer={<><Btn title="Receipt PDF" onPress={() => openDocument('receipt', id, { version: receipt.version }, 'receipt').catch((e) => toast(explain(e)))} style={{ flex: 1 }} /><Btn title="Close" color={c.violet} onPress={() => setReceipt(null)} style={{ flex: 1 }} /></>}>
        {receipt ? <><KV items={[['Receipt', receipt.receipt_no], ['Received (server time)', when(receipt.submitted_at, t.timezone)], ['Version', receipt.version], ['Tender version', receipt.rfp_version], ['Content hash', `${receipt.content_hash.slice(0, 16)}…`]]} /><T size={13} color={c.mute}>Keep the receipt. It proves the proposal was durably received at that time. It contains no prices.</T></> : null}
      </Sheet>
    </Screen>
  );
}

export function TenderProposals() {
  const { push } = useNav();
  const list = useLoad(() => api.get('/proposals', { limit: 100 }), []);
  return (
    <Screen wide>
      <Head eyebrow="TENDER ZONE" title="My proposals" sub="Drafts, submissions and receipts for the supplier entities you belong to." />
      <View style={{ marginTop: 14 }}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : !(list.data ?? []).length ? <Empty emoji="📝" title="No proposals yet" sub="Open a tender in the Tender zone and start a proposal." /> : (
          <Card><DataTable onRow={(r) => push('TenderProposal', { id: r.id })} rows={list.data} cols={[
            { key: 'title', label: 'Tender', flex: 2, min: 180, render: (r) => `${r.ref} · ${r.title}` }, { key: 'supplier', label: 'Supplier', min: 130 },
            { key: 'status', label: 'Status', min: 110, render: (r) => <Status tone={r.status === 'submitted' ? 'ok' : r.status === 'withdrawn' ? 'neutral' : 'warn'} label={nice(r.status)} /> },
            { key: 'closes_at', label: 'Closes', min: 160, render: (r) => when(r.closes_at, r.timezone) }, { key: 'receipt_no', label: 'Receipt', min: 140, render: (r) => r.receipt_no ?? '—' }]} /></Card>
        )}
      </View>
    </Screen>
  );
}
