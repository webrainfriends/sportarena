// Finance Stage 2 — invoices, credit notes, instalments, deposits (#564)
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { t } from '../i18n';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { DateRangeField } from '../pickers';
import { MenuField, MultiMenuField } from '../menu-field';
import { c } from '../theme';
import { Kpi, money } from './academy-ui';
import { atLeast } from './finance-parts';

const STATUS_COLORS = { draft: 'mute', sent: 'info', partial: 'warn', paid: 'ok', void: 'mute', overdue: 'alert' };
const CN_STATUS_COLORS = { draft: 'mute', issued: 'ok', applied: 'ok', void: 'mute' };
const INST_STATUS_COLORS = { active: 'info', completed: 'ok', cancelled: 'mute', defaulted: 'alert' };
const DEP_STATUS_COLORS = { requested: 'mute', received: 'info', partially_released: 'warn', released: 'ok', forfeited: 'alert' };

const INV_TABS = ['invoices', 'credit_notes', 'instalments', 'deposits'];

export function FinanceInstruments({ scope, level, toast }) {
  const [sub, setSub] = useState('invoices');
  return (
    <View style={{ gap: 12 }}>
      <Seg
        options={INV_TABS.map((v) => ({ value: v, label: t(`fin.inst.tab.${v}`) }))}
        value={sub} onChange={setSub}
      />
      {sub === 'invoices' ? <InvoicesList scope={scope} level={level} toast={toast} /> : null}
      {sub === 'credit_notes' ? <CreditNotesList scope={scope} level={level} toast={toast} /> : null}
      {sub === 'instalments' ? <InstalmentsList scope={scope} level={level} toast={toast} /> : null}
      {sub === 'deposits' ? <DepositsList scope={scope} level={level} toast={toast} /> : null}
    </View>
  );
}

// ─── Invoices ────────────────────────────────────────────────────────────────

function InvoicesList({ scope, level, toast }) {
  const [status, setStatus] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const q = { ...scope, status: status || undefined };
  const list = useLoad(() => api.get('/finance/invoices', q), [JSON.stringify(q)]);

  const statusOpts = [null, 'draft', 'sent', 'partial', 'paid', 'void', 'overdue'].map((v) => ({ value: v, label: v ? t(`fin.inv.status.${v}`) : t('fin.any') }));

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <MenuField label={t('fin.inv.filter_status')} value={status ?? ''} onChange={(v) => setStatus(v || null)} options={statusOpts} />
        {atLeast(level, 'accountant') ? <Btn label={t('fin.inv.new')} onPress={() => setShowNew(true)} /> : null}
      </View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (
        <View style={{ gap: 6 }}>
          {!(list.data?.invoices?.length) ? <Empty emoji="🧾" title={t('fin.inv.empty')} sub={t('fin.inv.empty_sub')} /> : (
            list.data.invoices.map((inv) => (
              <Row key={inv.id}
                title={`${inv.number} · ${inv.customer_name ?? t('fin.inv.no_customer')}`}
                sub={`${t('fin.inv.issued')} ${inv.issue_date}${inv.due_date ? ` · ${t('fin.inv.due')} ${inv.due_date}` : ''}`}
                right={
                  <View style={{ alignItems: 'flex-end', gap: 3 }}>
                    <T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{money(inv.total * 100, inv.currency)}</T>
                    <Tag label={t(`fin.inv.status.${inv.status}`)} tone={STATUS_COLORS[inv.status]} />
                    {inv.amount_due > 0 ? <T size={11} color={c.mute}>{t('fin.inv.due_amount', { v: money(inv.amount_due * 100, inv.currency) })}</T> : null}
                  </View>
                }
                onPress={() => setOpenId(inv.id)}
              />
            ))
          )}
        </View>
      )}
      {openId ? <InvoiceDetail invoiceId={openId} scope={scope} level={level} toast={toast} onClose={() => { setOpenId(null); list.reload(); }} /> : null}
      {showNew ? <NewInvoiceSheet scope={scope} onClose={() => { setShowNew(false); list.reload(); }} toast={toast} /> : null}
    </View>
  );
}

function InvoiceDetail({ invoiceId, scope, level, toast, onClose }) {
  const detail = useLoad(() => api.get(`/finance/invoices/${invoiceId}`, scope), [invoiceId]);
  const inv = detail.data?.invoice;
  const [sending, setSending] = useState(false);
  const [voiding, setVoiding] = useState(false);

  const send = async () => {
    setSending(true);
    try { await api.post(`/finance/invoices/${invoiceId}/send`, scope); toast(t('fin.inv.sent_ok')); detail.reload(); } catch (e) { toast(e.message, 'error'); }
    setSending(false);
  };
  const voidInv = async () => {
    setVoiding(true);
    try { await api.post(`/finance/invoices/${invoiceId}/void`, scope); toast(t('fin.inv.voided_ok')); detail.reload(); } catch (e) { toast(e.message, 'error'); }
    setVoiding(false);
  };

  return (
    <Sheet title={inv ? `${inv.number}` : t('fin.inv.detail_title')} onClose={onClose}>
      {detail.loading ? <Loading /> : detail.error ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : !inv ? null : (
        <View style={{ gap: 14 }}>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Tag label={t(`fin.inv.status.${inv.status}`)} tone={STATUS_COLORS[inv.status]} />
            {inv.customer_name ? <T color={c.mute}>{inv.customer_name}</T> : null}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <Kpi label={t('fin.inv.kpi.total')} value={money(inv.total * 100, inv.currency)} />
            <Kpi label={t('fin.inv.kpi.paid')} value={money(inv.amount_paid * 100, inv.currency)} />
            <Kpi label={t('fin.inv.kpi.due')} value={money(inv.amount_due * 100, inv.currency)} tone={inv.amount_due > 0 ? 'warn' : undefined} />
          </View>
          <Section title={t('fin.inv.lines')}>
            {inv.lines.map((l, i) => (
              <Row key={l.id ?? i} title={l.description}
                sub={`${l.quantity} × ${money(l.unit_price * 100, inv.currency)}${l.tax_rate_bp ? ` + ${(l.tax_rate_bp / 100).toFixed(2)}% ${t('fin.inv.tax')}` : ''}`}
                right={<T weight="700">{money(l.line_total * 100, inv.currency)}</T>}
              />
            ))}
          </Section>
          {inv.allocations?.length ? (
            <Section title={t('fin.inv.credit_notes_applied')}>
              {inv.allocations.map((a) => (
                <Row key={a.id} title={a.credit_note_number} sub={a.allocated_at?.slice(0, 10)} right={<T color={c.ok} weight="700">-{money(a.amount * 100, inv.currency)}</T>} />
              ))}
            </Section>
          ) : null}
          {inv.receipts?.length ? (
            <Section title={t('fin.inv.receipts')}>
              {inv.receipts.map((r) => (
                <Row key={r.id} title={r.receipt_number} sub={`${r.method} · ${r.received_at?.slice(0, 10)}`}
                  right={<View style={{ alignItems: 'flex-end' }}><T weight="700">{money(r.amount * 100, inv.currency)}</T><Tag label={t(`fin.rec.status.${r.status}`)} /></View>}
                />
              ))}
            </Section>
          ) : null}
          {atLeast(level, 'accountant') ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {inv.status === 'draft' ? <Btn label={t('fin.inv.action.send')} loading={sending} onPress={send} /> : null}
              {['draft','sent','overdue'].includes(inv.status) && atLeast(level, 'controller') ? <Btn label={t('fin.inv.action.void')} tone="danger" loading={voiding} onPress={voidInv} /> : null}
            </View>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}

function NewInvoiceSheet({ scope, onClose, toast }) {
  const [currency, setCurrency] = useState('USD');
  const [lines, setLines] = useState([{ description: '', quantity: 1, unit_price: '', tax_rate_bp: 0 }]);
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  const addLine = () => setLines([...lines, { description: '', quantity: 1, unit_price: '', tax_rate_bp: 0 }]);
  const updateLine = (i, f, v) => setLines(lines.map((l, j) => j === i ? { ...l, [f]: v } : l));

  const save = async () => {
    const validLines = lines.filter((l) => l.description && Number(l.unit_price) > 0);
    if (!validLines.length) { toast(t('fin.inv.error.no_lines'), 'error'); return; }
    setSaving(true);
    try {
      await api.post('/finance/invoices', {
        ...scope,
        currency,
        due_date: dueDate || undefined,
        lines: validLines.map((l) => ({ description: l.description, quantity: Number(l.quantity) || 1, unit_price: Number(l.unit_price), tax_rate_bp: Number(l.tax_rate_bp) || 0 })),
      });
      toast(t('fin.inv.created_ok'));
      onClose();
    } catch (e) { toast(e.message, 'error'); }
    setSaving(false);
  };

  return (
    <Sheet title={t('fin.inv.new')} onClose={onClose}>
      <View style={{ gap: 14 }}>
        <MenuField label={t('fin.inv.currency')} value={currency} onChange={setCurrency}
          options={['USD','GBP','EUR','INR','AUD','AED','SGD','LKR','IDR'].map((v) => ({ value: v, label: v }))} />
        <Field label={t('fin.inv.due_date')} value={dueDate} onChangeText={setDueDate} placeholder="YYYY-MM-DD" />
        <Section title={t('fin.inv.lines')}>
          {lines.map((l, i) => (
            <Card key={i} style={{ gap: 8, padding: 10 }}>
              <Field label={t('fin.inv.line.description')} value={l.description} onChangeText={(v) => updateLine(i, 'description', v)} />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Field label={t('fin.inv.line.qty')} value={String(l.quantity)} onChangeText={(v) => updateLine(i, 'quantity', v)} keyboardType="numeric" style={{ flex: 1 }} />
                <Field label={t('fin.inv.line.price')} value={String(l.unit_price)} onChangeText={(v) => updateLine(i, 'unit_price', v)} keyboardType="decimal-pad" style={{ flex: 2 }} />
              </View>
            </Card>
          ))}
          <Btn label={t('fin.inv.add_line')} onPress={addLine} />
        </Section>
        <Btn label={t('fin.inv.save')} loading={saving} onPress={save} />
      </View>
    </Sheet>
  );
}

// ─── Credit Notes ─────────────────────────────────────────────────────────────

function CreditNotesList({ scope, level, toast }) {
  const [openId, setOpenId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const list = useLoad(() => api.get('/finance/credit-notes', scope), [JSON.stringify(scope)]);

  return (
    <View style={{ gap: 12 }}>
      {atLeast(level, 'accountant') ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn label={t('fin.cn.new')} onPress={() => setShowNew(true)} />
        </View>
      ) : null}
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (
        !(list.data?.credit_notes?.length) ? <Empty emoji="📋" title={t('fin.cn.empty')} sub={t('fin.cn.empty_sub')} /> : (
          list.data.credit_notes.map((cn) => (
            <Row key={cn.id}
              title={`${cn.number} · ${cn.customer_name ?? ''}`}
              sub={cn.reason ?? cn.issue_date}
              right={
                <View style={{ alignItems: 'flex-end', gap: 3 }}>
                  <T weight="800">{money(cn.total * 100, cn.currency)}</T>
                  <Tag label={t(`fin.cn.status.${cn.status}`)} tone={CN_STATUS_COLORS[cn.status]} />
                  {cn.amount_remaining > 0 ? <T size={11} color={c.mute}>{t('fin.cn.remaining', { v: money(cn.amount_remaining * 100, cn.currency) })}</T> : null}
                </View>
              }
              onPress={() => setOpenId(cn.id)}
            />
          ))
        )
      )}
      {showNew ? <NewCreditNoteSheet scope={scope} onClose={() => { setShowNew(false); list.reload(); }} toast={toast} /> : null}
    </View>
  );
}

function NewCreditNoteSheet({ scope, onClose, toast }) {
  const [currency, setCurrency] = useState('USD');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState([{ description: '', quantity: 1, unit_price: '' }]);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const validLines = lines.filter((l) => l.description && Number(l.unit_price) > 0);
    if (!validLines.length) { toast(t('fin.inv.error.no_lines'), 'error'); return; }
    setSaving(true);
    try {
      await api.post('/finance/credit-notes', {
        ...scope, currency, reason: reason || undefined,
        lines: validLines.map((l) => ({ description: l.description, quantity: Number(l.quantity) || 1, unit_price: Number(l.unit_price) })),
      });
      toast(t('fin.cn.created_ok'));
      onClose();
    } catch (e) { toast(e.message, 'error'); }
    setSaving(false);
  };

  return (
    <Sheet title={t('fin.cn.new')} onClose={onClose}>
      <View style={{ gap: 14 }}>
        <MenuField label={t('fin.inv.currency')} value={currency} onChange={setCurrency}
          options={['USD','GBP','EUR','INR','AUD','AED','SGD','LKR','IDR'].map((v) => ({ value: v, label: v }))} />
        <Field label={t('fin.cn.reason')} value={reason} onChangeText={setReason} placeholder={t('fin.cn.reason_hint')} />
        <Section title={t('fin.inv.lines')}>
          {lines.map((l, i) => (
            <Card key={i} style={{ gap: 8, padding: 10 }}>
              <Field label={t('fin.inv.line.description')} value={l.description} onChangeText={(v) => setLines(lines.map((ll, j) => j === i ? { ...ll, description: v } : ll))} />
              <Field label={t('fin.inv.line.price')} value={String(l.unit_price)} onChangeText={(v) => setLines(lines.map((ll, j) => j === i ? { ...ll, unit_price: v } : ll))} keyboardType="decimal-pad" />
            </Card>
          ))}
          <Btn label={t('fin.inv.add_line')} onPress={() => setLines([...lines, { description: '', quantity: 1, unit_price: '' }])} />
        </Section>
        <Btn label={t('fin.cn.save')} loading={saving} onPress={save} />
      </View>
    </Sheet>
  );
}

// ─── Instalments ──────────────────────────────────────────────────────────────

function InstalmentsList({ scope, level, toast }) {
  const [status, setStatus] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const q = { ...scope, status: status || undefined };
  const list = useLoad(() => api.get('/finance/instalments', q), [JSON.stringify(q)]);

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <MenuField label={t('fin.inst_plan.filter_status')} value={status ?? ''} onChange={(v) => setStatus(v || null)}
          options={[null,'active','completed','cancelled','defaulted'].map((v) => ({ value: v ?? '', label: v ? t(`fin.inst_plan.status.${v}`) : t('fin.any') }))} />
        {atLeast(level, 'accountant') ? <Btn label={t('fin.inst_plan.new')} onPress={() => setShowNew(true)} /> : null}
      </View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (
        !(list.data?.instalments?.length) ? <Empty emoji="📅" title={t('fin.inst_plan.empty')} sub={t('fin.inst_plan.empty_sub')} /> : (
          list.data.instalments.map((s) => (
            <Row key={s.id}
              title={s.customer_name ?? t('fin.inst_plan.no_customer')}
              sub={`${t(`fin.inst_plan.schedule.${s.schedule_type}`)} · ${t('fin.inst_plan.starts')} ${s.start_date}`}
              right={
                <View style={{ alignItems: 'flex-end', gap: 3 }}>
                  <T weight="800">{money(s.total_amount * 100, s.currency)}</T>
                  <Tag label={t(`fin.inst_plan.status.${s.status}`)} tone={INST_STATUS_COLORS[s.status]} />
                  {s.overdue_count > 0 ? <Tag label={t('fin.inst_plan.overdue_n', { n: s.overdue_count })} tone="alert" /> : null}
                </View>
              }
            />
          ))
        )
      )}
      {showNew ? <NewInstalmentSheet scope={scope} onClose={() => { setShowNew(false); list.reload(); }} toast={toast} /> : null}
    </View>
  );
}

function NewInstalmentSheet({ scope, onClose, toast }) {
  const [currency, setCurrency] = useState('USD');
  const [schedule, setSchedule] = useState('monthly');
  const [startDate, setStartDate] = useState('');
  const [items, setItems] = useState([{ due_date: '', amount: '' }, { due_date: '', amount: '' }]);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const validItems = items.filter((x) => x.due_date && Number(x.amount) > 0);
    if (validItems.length < 2) { toast(t('fin.inst_plan.error.min_items'), 'error'); return; }
    if (!startDate) { toast(t('fin.inst_plan.error.start_required'), 'error'); return; }
    setSaving(true);
    try {
      await api.post('/finance/instalments', {
        ...scope, currency, schedule_type: schedule, start_date: startDate,
        items: validItems.map((x) => ({ due_date: x.due_date, amount: Number(x.amount) })),
      });
      toast(t('fin.inst_plan.created_ok'));
      onClose();
    } catch (e) { toast(e.message, 'error'); }
    setSaving(false);
  };

  return (
    <Sheet title={t('fin.inst_plan.new')} onClose={onClose}>
      <View style={{ gap: 14 }}>
        <MenuField label={t('fin.inv.currency')} value={currency} onChange={setCurrency} options={['USD','GBP','EUR','INR','AUD','AED','SGD'].map((v) => ({ value: v, label: v }))} />
        <MenuField label={t('fin.inst_plan.schedule')} value={schedule} onChange={setSchedule}
          options={['weekly','fortnightly','monthly','custom'].map((v) => ({ value: v, label: t(`fin.inst_plan.schedule.${v}`) }))} />
        <Field label={t('fin.inst_plan.start_date')} value={startDate} onChangeText={setStartDate} placeholder="YYYY-MM-DD" />
        <Section title={t('fin.inst_plan.items')}>
          {items.map((item, i) => (
            <Card key={i} style={{ flexDirection: 'row', gap: 8, padding: 10 }}>
              <Field label={t('fin.inst_plan.item.due')} value={item.due_date} onChangeText={(v) => setItems(items.map((x, j) => j === i ? { ...x, due_date: v } : x))} placeholder="YYYY-MM-DD" style={{ flex: 1 }} />
              <Field label={t('fin.inst_plan.item.amount')} value={item.amount} onChangeText={(v) => setItems(items.map((x, j) => j === i ? { ...x, amount: v } : x))} keyboardType="decimal-pad" style={{ flex: 1 }} />
            </Card>
          ))}
          <Btn label={t('fin.inst_plan.add_item')} onPress={() => setItems([...items, { due_date: '', amount: '' }])} />
        </Section>
        <Btn label={t('fin.inst_plan.save')} loading={saving} onPress={save} />
      </View>
    </Sheet>
  );
}

// ─── Deposits ─────────────────────────────────────────────────────────────────

function DepositsList({ scope, level, toast }) {
  const [showNew, setShowNew] = useState(false);
  const list = useLoad(() => api.get('/finance/deposits', scope), [JSON.stringify(scope)]);

  return (
    <View style={{ gap: 12 }}>
      {atLeast(level, 'accountant') ? (
        <Btn label={t('fin.deposit.new')} onPress={() => setShowNew(true)} />
      ) : null}
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (
        !(list.data?.deposits?.length) ? <Empty emoji="🔒" title={t('fin.deposit.empty')} sub={t('fin.deposit.empty_sub')} /> : (
          list.data.deposits.map((d) => (
            <Row key={d.id}
              title={d.customer_name ?? d.purpose ?? t('fin.deposit.unnamed')}
              sub={`${d.currency} · ${d.reference ?? ''}`}
              right={
                <View style={{ alignItems: 'flex-end', gap: 3 }}>
                  <T weight="800">{money(d.amount * 100, d.currency)}</T>
                  <Tag label={t(`fin.deposit.status.${d.status}`)} tone={DEP_STATUS_COLORS[d.status]} />
                  {d.release_due_at ? <T size={11} color={c.mute}>{t('fin.deposit.release_by')} {d.release_due_at}</T> : null}
                </View>
              }
            />
          ))
        )
      )}
      {showNew ? <NewDepositSheet scope={scope} onClose={() => { setShowNew(false); list.reload(); }} toast={toast} /> : null}
    </View>
  );
}

function NewDepositSheet({ scope, onClose, toast }) {
  const [currency, setCurrency] = useState('USD');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [reference, setReference] = useState('');
  const [releaseDue, setReleaseDue] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!amount || Number(amount) <= 0) { toast(t('fin.deposit.error.amount'), 'error'); return; }
    setSaving(true);
    try {
      await api.post('/finance/deposits', { ...scope, currency, amount: Number(amount), purpose: purpose || undefined, reference: reference || undefined, release_due_at: releaseDue || undefined });
      toast(t('fin.deposit.created_ok'));
      onClose();
    } catch (e) { toast(e.message, 'error'); }
    setSaving(false);
  };

  return (
    <Sheet title={t('fin.deposit.new')} onClose={onClose}>
      <View style={{ gap: 14 }}>
        <MenuField label={t('fin.inv.currency')} value={currency} onChange={setCurrency} options={['USD','GBP','EUR','INR','AUD','AED','SGD'].map((v) => ({ value: v, label: v }))} />
        <Field label={t('fin.deposit.amount')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        <Field label={t('fin.deposit.purpose')} value={purpose} onChangeText={setPurpose} placeholder={t('fin.deposit.purpose_hint')} />
        <Field label={t('fin.deposit.reference')} value={reference} onChangeText={setReference} placeholder={t('fin.deposit.reference_hint')} />
        <Field label={t('fin.deposit.release_by')} value={releaseDue} onChangeText={setReleaseDue} placeholder="YYYY-MM-DD" />
        <Btn label={t('fin.deposit.save')} loading={saving} onPress={save} />
      </View>
    </Sheet>
  );
}
