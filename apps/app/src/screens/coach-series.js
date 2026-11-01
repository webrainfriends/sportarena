// Manage one booked coaching series: the block price, pay once, skip or pause dates, move a date, cancel what is left.
// All rules (pro-rata refunds, who may change what) are enforced by the API; this only shows the exact numbers it returns.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, ErrorBox, Loading, Sheet, T } from '../ui';
import { DateField, DateRangeField, TimeField } from '../pickers';
import { PaySheet, StatusPill } from './marketplace';
import { Confirm } from './coaching';
import { t } from '../i18n';
import { c } from '../theme';
import { dateTimeIn, moneyIn, todayIn } from '../vtime';

const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const live = (d) => ['requested', 'confirmed'].includes(d.status) && new Date(d.starts_at) > new Date();

export function SeriesSheet({ id, who, onClose, onChanged }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/hires/series/${id}`), [id]);
  const [pick, setPick] = useState([]), [range, setRange] = useState({}), [move, setMove] = useState(null), [pay, setPay] = useState(false);
  const [ask, setAsk] = useState(null), [busy, setBusy] = useState(false);
  const s = q.data;
  const today = todayIn(deviceTz);
  const changed = async () => { setPick([]); setRange({}); setMove(null); setAsk(null); await q.reload(); await onChanged?.(); };
  const run = async (fn, done) => { setBusy(true); try { await fn(); toast(done); await changed(); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  /** Ask the API what a change would refund, then confirm with that exact amount. */
  const preview = async (kind, body) => {
    try {
      const r = await api.post(`/hires/series/${id}/${kind}`, { ...body, preview: true });
      setAsk({ kind, body, refund: r.refund_cents, n: (r.skipped ?? r.cancelled).length });
    } catch (e) { toast(e.message); }
  };
  const upcoming = s ? s.dates.filter(live) : [];
  const unpaid = upcoming.filter((d) => d.payment_status === 'unpaid').reduce((n, d) => n + Number(d.total_cents) - Number(d.loyalty_credit_cents), 0);
  return (
    <Sheet visible onClose={onClose} title={t('series.title')}>
      {q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : !s ? <Loading /> : (
        <>
          <T weight="800" size={16}>{who === 'coach' ? s.hirer_name : s.coach_name}</T>
          <Card color={c.pinkSoft} pad={14}>
            {s.discount_cents > 0 ? (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={13} color={c.mute}>{t('series.listTotal')}</T><T size={13} color={c.mute}>{moneyIn(s.list_total_cents, s.currency)}</T></View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={13} color={c.mint}>{t('series.discountLine', { pct: s.discount_pct })}</T><T size={13} color={c.mint}>−{moneyIn(s.discount_cents, s.currency)}</T></View>
              </>
            ) : null}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">{t('series.total')}</T><T weight="800" size={16}>{moneyIn(s.total_cents, s.currency)}</T></View>
            <T size={12} color={c.mute}>{t('series.upcoming', { n: s.upcoming })}</T>
          </Card>
          {s.status === 'paused' ? <Card color={c.sunSoft} pad={12}><T weight="800">{t('series.paused')}</T><T size={12} color={c.mute}>{t('series.pausedNote')}</T></Card> : null}
          {who !== 'coach' && s.pay_hire_id && unpaid > 0 ? <Btn title={t('series.payBlock', { amount: moneyIn(unpaid, s.currency) })} onPress={() => setPay(true)} /> : null}

          {s.dates.map((d) => {
            const on = pick.includes(d.id), can = live(d);
            return (
              <Card key={d.id} pad={12} color={on ? c.sunSoft : undefined}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <View style={{ flex: 1, minWidth: 160 }}>
                    <T weight="700">{dateTimeIn(d.starts_at, deviceTz)}</T>
                    <T size={12} color={c.mute}>{moneyIn(d.total_cents, s.currency)}{d.rescheduled_from ? ` · ${t('series.movedTag')}` : ''}</T>
                  </View>
                  <StatusPill s={d.series_state === 'skipped' ? 'cancelled' : d.series_state === 'paused' && live(d) ? 'on_hold' : d.status} />
                  {d.payment_status === 'paid' ? <StatusPill s="paid" /> : null}
                </View>
                {can ? (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <Chip label={on ? `✓ ${t('series.skipOne')}` : t('series.skipOne')} active={on} onPress={() => setPick(on ? pick.filter((x) => x !== d.id) : [...pick, d.id])} />
                    <Chip label={t('series.move')} active={move?.id === d.id} onPress={() => setMove(move?.id === d.id ? null : { id: d.id, date: d.starts_at.slice(0, 10), start: d.starts_at.slice(11, 16) })} />
                  </View>
                ) : null}
                {move?.id === d.id ? (
                  <View style={{ gap: 8, marginTop: 8 }}>
                    <DateField label={t('series.newDate')} value={move.date} onChange={(v) => setMove({ ...move, date: v })} min={today} />
                    <TimeField label={t('series.newTime')} value={move.start} onChange={(v) => setMove({ ...move, start: v })} step={15} />
                    <Btn small title={t('series.moveDo')} loading={busy} onPress={() => run(() => api.post(`/hires/series/${id}/reschedule`, { hire_id: d.id, date: move.date, start: move.start }), t('series.movedTag'))} />
                  </View>
                ) : null}
              </Card>
            );
          })}

          {upcoming.length ? (
            <>
              <T size={12} color={c.mute}>{t('series.skipPick')}</T>
              {pick.length ? <Btn title={t('series.skipDo', { n: pick.length })} color={c.paper} ink={c.ink} onPress={() => preview('skip', { hire_ids: pick })} /> : null}
              <DateRangeField label={t('series.pauseRange')} from={range.from} to={range.to} min={today} onChange={(r) => setRange(r)} optional />
              {range.from && range.to ? <Btn title={t('series.skip')} color={c.paper} ink={c.ink} onPress={() => preview('skip', { from: range.from, to: range.to })} /> : null}
              {s.status === 'paused'
                ? <Btn title={t('series.resume')} loading={busy} onPress={() => run(async () => { const r = await api.post(`/hires/series/${id}/resume`, {}); if (r.problems.length) toast(t('series.resumeProblems', { n: r.problems.length })); }, t('series.resume'))} />
                : s.status === 'active' ? <Btn title={t('series.pause')} color={c.paper} ink={c.ink} onPress={() => setAsk({ kind: 'pause', body: {}, refund: 0, n: upcoming.length })} /> : null}
              <Btn title={t('series.cancelRest')} color={c.paper} ink={c.red} onPress={() => preview('cancel', {})} />
            </>
          ) : null}
        </>
      )}
      {pay && s ? <PaySheet target={{ type: 'coach_hire', id: s.pay_hire_id, amount: unpaid, label: `${t('series.title')} · ${s.coach_name}` }} onClose={() => setPay(false)} onDone={changed} /> : null}
      <Confirm visible={!!ask} title={ask?.kind === 'cancel' ? t('series.cancelRest') : ask?.kind === 'pause' ? t('series.pause') : t('series.skipDo', { n: ask?.n ?? 0 })} yes={ask?.kind === 'cancel' ? t('series.cancelRest') : ask?.kind === 'pause' ? t('series.pause') : t('series.skip')} danger={ask?.kind !== 'pause'} askReason={ask?.kind === 'pause' ? undefined : t('series.cancelConfirm')} onClose={() => setAsk(null)}
        body={ask?.kind === 'pause' ? t('series.pauseConfirm') : ask ? `${ask.kind === 'cancel' ? `${t('series.cancelConfirm')}\n` : ''}${ask.refund > 0 ? t('series.refund', { amount: moneyIn(ask.refund, s?.currency) }) : t('series.noRefund')}` : ''}
        onYes={(reason) => run(() => api.post(`/hires/series/${id}/${ask.kind}`, { ...ask.body, ...(reason ? { reason } : {}) }), ask.kind === 'cancel' ? t('series.cancelRest') : ask.kind === 'pause' ? t('series.paused') : t('series.skip'))} />
    </Sheet>
  );
}
