// Finance Stage 2 — offline receipts: cash, bank transfer, cheque, UPI (#564)
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { t } from '../i18n';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { DateRangeField } from '../pickers';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { money } from './academy-ui';
import { atLeast } from './finance-parts';

const STATUS_COLORS = { pending: 'warn', confirmed: 'ok', bounced: 'alert', reversed: 'mute' };
const METHOD_ICONS = { cash: '💵', bank_transfer: '🏦', cheque: '📄', upi: '📱', other: '💳' };

export function FinanceReceipts({ scope, level, toast }) {
  const [status, setStatus] = useState(null);
  const [method, setMethod] = useState(null);
  const [range, setRange] = useState({});
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState(null);
  const iso = (d) => (d ? String(d).slice(0, 10) : undefined);
  const q = { ...scope, status: status || undefined, method: method || undefined, from: iso(range.from), to: iso(range.to) };
  const list = useLoad(() => api.get('/finance/offline-receipts', q), [JSON.stringify(q)]);

  const statusOpts = [null,'pending','confirmed','bounced','reversed'].map((v) => ({ value: v ?? '', label: v ? t(`fin.rec.status.${v}`) : t('fin.any') }));
  const methodOpts = [null,'cash','bank_transfer','cheque','upi','other'].map((v) => ({ value: v ?? '', label: v ? t(`fin.rec.method.${v}`) : t('fin.any') }));

  return (
    <View style={{ gap: 12 }}>
      <DateRangeField label={t('fin.dates')} from={range.from} to={range.to} optional onChange={setRange} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <MenuField label={t('fin.rec.filter_status')} value={status ?? ''} onChange={(v) => setStatus(v || null)} options={statusOpts} />
        <MenuField label={t('fin.rec.filter_method')} value={method ?? ''} onChange={(v) => setMethod(v || null)} options={methodOpts} />
        {atLeast(level, 'accountant') ? <Btn label={t('fin.rec.new')} onPress={() => setShowNew(true)} /> : null}
      </View>

      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (
        !(list.data?.receipts?.length) ? <Empty emoji="🧾" title={t('fin.rec.empty')} sub={t('fin.rec.empty_sub')} /> : (
          <View style={{ gap: 6 }}>
            {list.data.receipts.map((r) => (
              <Row key={r.id}
                title={`${METHOD_ICONS[r.method] ?? '💳'} ${r.receipt_number}`}
                sub={[r.customer_name, r.invoice_number ? `${t('fin.rec.inv')} ${r.invoice_number}` : null, r.received_at?.slice(0, 10)].filter(Boolean).join(' · ')}
                right={
                  <View style={{ alignItems: 'flex-end', gap: 3 }}>
                    <T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{money(r.amount * 100, r.currency)}</T>
                    <Tag label={t(`fin.rec.status.${r.status}`)} tone={STATUS_COLORS[r.status]} />
                  </View>
                }
                onPress={() => setOpenId(r.id)}
              />
            ))}
          </View>
        )
      )}

      {openId ? <ReceiptDetail receiptId={openId} scope={scope} level={level} toast={toast} onClose={() => { setOpenId(null); list.reload(); }} /> : null}
      {showNew ? <NewReceiptSheet scope={scope} onClose={() => { setShowNew(false); list.reload(); }} toast={toast} /> : null}
    </View>
  );
}

function ReceiptDetail({ receiptId, scope, level, toast, onClose }) {
  const detail = useLoad(() => api.get(`/finance/offline-receipts/${receiptId}`, scope), [receiptId]);
  const rec = detail.data?.receipt;
  const [confirming, setConfirming] = useState(false);

  const confirm = async () => {
    setConfirming(true);
    try {
      await api.post(`/finance/offline-receipts/${receiptId}/confirm`, scope);
      toast(t('fin.rec.confirmed_ok'));
      detail.reload();
    } catch (e) { toast(e.message, 'error'); }
    setConfirming(false);
  };

  return (
    <Sheet title={rec ? rec.receipt_number : t('fin.rec.detail_title')} onClose={onClose}>
      {detail.loading ? <Loading /> : detail.error ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : !rec ? null : (
        <View style={{ gap: 14 }}>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Tag label={t(`fin.rec.status.${rec.status}`)} tone={STATUS_COLORS[rec.status]} />
            <Tag label={t(`fin.rec.method.${rec.method}`)} />
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <T size={28} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{money(rec.amount * 100, rec.currency)}</T>
          </View>
          {rec.reference ? <View style={{ gap: 4 }}><T size={12} color={c.mute} weight="600">{t('fin.rec.reference')}</T><T>{rec.reference}</T></View> : null}
          {rec.notes ? <View style={{ gap: 4 }}><T size={12} color={c.mute} weight="600">{t('fin.rec.notes')}</T><T>{rec.notes}</T></View> : null}
          <View style={{ gap: 4 }}>
            <T size={12} color={c.mute} weight="600">{t('fin.rec.received_at')}</T>
            <T>{rec.received_at?.slice(0, 10)}</T>
          </View>
          {rec.status === 'pending' && atLeast(level, 'accountant') ? (
            <Btn label={t('fin.rec.action.confirm')} loading={confirming} onPress={confirm} />
          ) : null}
        </View>
      )}
    </Sheet>
  );
}

function NewReceiptSheet({ scope, onClose, toast }) {
  const [currency, setCurrency] = useState('USD');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const methodOpts = ['cash','bank_transfer','cheque','upi','other'].map((v) => ({ value: v, label: t(`fin.rec.method.${v}`) }));

  const save = async () => {
    if (!amount || Number(amount) <= 0) { toast(t('fin.rec.error.amount'), 'error'); return; }
    setSaving(true);
    try {
      await api.post('/finance/offline-receipts', {
        ...scope, currency, amount: Number(amount), method,
        reference: reference || undefined,
        notes: notes || undefined,
      });
      toast(t('fin.rec.created_ok'));
      onClose();
    } catch (e) { toast(e.message, 'error'); }
    setSaving(false);
  };

  return (
    <Sheet title={t('fin.rec.new')} onClose={onClose}>
      <View style={{ gap: 14 }}>
        <MenuField label={t('fin.inv.currency')} value={currency} onChange={setCurrency}
          options={['USD','GBP','EUR','INR','AUD','AED','SGD','LKR','IDR'].map((v) => ({ value: v, label: v }))} />
        <Field label={t('fin.rec.amount')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        <MenuField label={t('fin.rec.method')} value={method} onChange={setMethod} options={methodOpts} />
        <Field label={t('fin.rec.reference')} value={reference} onChangeText={setReference} placeholder={t('fin.rec.reference_hint')} />
        <Field label={t('fin.rec.notes')} value={notes} onChangeText={setNotes} placeholder={t('fin.rec.notes_hint')} multiline />
        <Btn label={t('fin.rec.save')} loading={saving} onPress={save} />
      </View>
    </Sheet>
  );
}
