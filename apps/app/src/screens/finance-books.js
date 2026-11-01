// Finance console tabs for the organisation control plane (#593): receivables and payables with ageing and upcoming cash, settlement status,
// and finance access with the audit history. Every number comes from the finance API (the canonical ledger); nothing is computed here.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { t } from '../i18n';
import { Btn, Chip, Empty, ErrorBox, Loading, Row, Section, T, Tag } from '../ui';
import { MenuField } from '../menu-field';
import { EntityPicker } from '../entity-picker';
import { c, day } from '../theme';
import { Kpi, Split } from './academy-ui';
import { Detail, atLeast, modLabel, money, statusLabel } from './finance-parts';

const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'];
const LEVELS = ['viewer', 'accountant', 'controller'];
const SETTLE_TONE = { in_progress: c.sunSoft, paid: c.lime, failed: c.orangeSoft, reversed: c.violetSoft, on_hold: c.orangeSoft, cancelled: c.violetSoft };
// the dimensions an obligation query understands; the period dates belong to the transactions list, not to what is still owed
const pick = (q) => Object.fromEntries(['organisation_id', 'currency', 'module', 'season_ids', 'event_ids', 'team_ids', 'workspace_ids', 'categories'].filter((k) => q[k] != null).map((k) => [k, q[k]]));

/** Open receivables (direction "in") or payables ("out"): ageing buckets per currency, then the items behind them, soonest due first. */
export function Obligations({ direction, q, scope, cur }) {
  const params = { ...pick(q), direction };
  const key = JSON.stringify(params);
  const [bucket, setBucket] = useState(null);
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [state, setState] = useState({ loading: true, error: null });
  const [openId, setOpenId] = useState(null);
  const age = useLoad(() => api.get('/finance/ageing', pick(q)), [key]);
  const load = async (offset) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const got = await api.get('/finance/obligations', { ...params, ...(bucket ? { bucket } : {}), limit: 25, offset });
      setRows((prev) => (offset ? [...prev, ...got] : got)); setMore(got.length === 25); setState({ loading: false, error: null });
    } catch (e) { setState({ loading: false, error: e }); }
  };
  useEffect(() => { load(0); }, [key, bucket]); // eslint-disable-line react-hooks/exhaustive-deps
  const side = direction === 'in' ? 'receivable' : 'payable';
  const groups = (age.data?.currencies ?? []).filter((x) => x[side].total > 0 && (!cur || x.currency === cur));
  return (
    <Split
      open={!!openId} onClose={() => setOpenId(null)} detailTitle={t('fin.tx_detail')}
      detail={openId ? <Detail id={openId} scope={scope} /> : null}
      list={(
        <View style={{ gap: 12 }}>
          <T color={c.mute} size={13}>{t('fin.ageing_note')}</T>
          {age.error ? <ErrorBox error={age.error} onRetry={age.reload} /> : null}
          {groups.map((g) => (
            <Section key={g.currency} title={[t('fin.ageing'), g.currency].join(' · ')} color={c.violet}>
              <T weight="800" size={18} style={{ fontVariant: ['tabular-nums'] }}>{t('fin.outstanding_total', { amount: money(g[side].total, g.currency) })}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {BUCKETS.map((b) => (
                  <Kpi key={b} label={t(`fin.bucket.${b}`)} value={money(g[side].buckets[b], g.currency)} tone={b === 'd90_plus' && g[side].buckets[b] ? 'alert' : undefined} onPress={() => setBucket(bucket === b ? null : b)} />
                ))}
              </View>
            </Section>
          ))}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Chip label={t('fin.all_buckets')} active={!bucket} onPress={() => setBucket(null)} />
            {BUCKETS.map((b) => <Chip key={b} label={t(`fin.bucket.${b}`)} active={bucket === b} onPress={() => setBucket(b)} />)}
          </View>
          <T weight="800">{t('fin.upcoming')}</T>
          {state.error ? <ErrorBox error={state.error} onRetry={() => load(0)} /> : state.loading && !rows.length ? <Loading /> : !rows.length ? (
            <Empty emoji={direction === 'in' ? '📥' : '📤'} title={direction === 'in' ? t('fin.nothing_to_you') : t('fin.nothing_you_owe')} />
          ) : rows.filter((r) => !cur || r.currency === cur).map((r) => (
            <Row key={r.id} onPress={() => setOpenId(r.id)} title={[modLabel(r.module), direction === 'in' ? r.payer : r.payee ?? r.payer].filter(Boolean).join(' · ')}
              sub={[r.overdue ? t('fin.days_overdue', { n: r.days_overdue }) : r.days_overdue === 0 && day(r.due_on) === day(new Date()) ? t('fin.due_today') : t('fin.due_on', { date: day(r.due_on) }), r.outstanding_minor !== r.gross_minor ? t('fin.owed_label', { amount: money(r.outstanding_minor, r.currency), gross: money(r.gross_minor, r.currency) }) : null].filter(Boolean).join(' · ')}
              right={<><T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{money(r.outstanding_minor, r.currency)}</T>{r.overdue ? <Tag label={t(`fin.bucket.${r.bucket}`)} color={c.orangeSoft} /> : null}</>} />
          ))}
          {more ? <Btn small title={t('fin.show_more')} color={c.paper} ink={c.ink} loading={state.loading} onPress={() => load(rows.length)} style={{ alignSelf: 'flex-start' }} /> : null}
        </View>
      )}
    />
  );
}

/** Settlement status of payouts to the organisation. */
export function Settlements({ q, scope }) {
  const params = { ...scope, from: q.from, to: q.to, currency: q.currency };
  const data = useLoad(() => api.get('/finance/settlements', { ...params, limit: 50 }), [JSON.stringify(params)]);
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const { items, totals } = data.data;
  return (
    <View style={{ gap: 10 }}>
      <T color={c.mute} size={13}>{t('fin.settle.intro')}</T>
      {totals.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {totals.map((x) => <Kpi key={`${x.currency}-${x.status}`} label={[statusLabel(x.status), x.currency].join(' · ')} value={money(x.gross_minor, x.currency)} sub={String(x.items)} />)}
        </View>
      ) : null}
      {!items.length ? <Empty emoji="🏦" title={t('fin.settle.empty')} /> : items.map((r) => (
        <Row key={r.id} title={`${modLabel(r.module)}${r.payee ? ` · ${r.payee}` : ''}`}
          sub={[t('fin.settle.net', { amount: money(r.net_minor, r.currency) }), r.provider, r.provider_ref, day(r.occurred_at)].filter(Boolean).join(' · ')}
          right={<><T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{money(r.gross_minor, r.currency)}</T><Tag label={t(`fin.settle.${r.state}`)} color={SETTLE_TONE[r.state]} /></>} />
      ))}
    </View>
  );
}

const auditTitle = (a) => {
  const k = `fin.audit.${a.action}`;
  if (a.action.startsWith('status_')) return t('fin.audit.status', { status: a.action.slice(7) });
  const v = t(k);
  return v === k ? t('fin.audit.other') : v;
};

/** Who can see the books (levels), who was given access, and the audit history. */
export function AccessAudit({ scope, whole, level, toast, onChanged }) {
  const org = scope.organisation_id;
  const access = useLoad(() => (whole ? Promise.resolve(null) : api.get('/finance/access', { organisation_id: org })), [org, whole]);
  const canSee = !whole && atLeast(level, 'accountant');
  const trail = useLoad(() => (canSee ? api.get('/finance/audit', { organisation_id: org, limit: 50 }) : Promise.resolve([])), [org, whole, level]);
  const [person, setPerson] = useState([]);
  const [lvl, setLvl] = useState('viewer');
  const [busy, setBusy] = useState(false);
  const levelOpts = LEVELS.map((value) => ({ value, label: t(`fin.level.${value}`), sub: t(`fin.level.${value}_sub`) }));
  const save = async (userId, level2, done) => {
    setBusy(true);
    try { await api.post('/finance/access', { organisation_id: org, user_id: userId, level: level2 }); toast(done); setPerson([]); access.reload(); trail.reload(); onChanged?.(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  if (whole) return <Empty emoji="🏛️" title={t('fin.access.title')} sub={t('fin.access.intro')} />;
  if (access.error) return <ErrorBox error={access.error} onRetry={access.reload} />;
  if (!access.data) return <Loading />;
  const a = access.data;
  return (
    <View style={{ gap: 14 }}>
      <Section title={t('fin.access.title')} color={c.violet}>
        <T color={c.mute} size={13}>{t('fin.access.intro')}</T>
        <Tag label={t('fin.access.mine', { level: t(`fin.level.${a.my_level}`) })} color={c.limeSoft} />
        <T weight="800">{t('fin.access.members')}</T>
        {a.members.map((m) => <Row key={m.user_id} title={m.display_name} sub={t(`fin.level.${m.level}_sub`)} right={<Tag label={t(`fin.level.${m.level}`)} color={c.violetSoft} />} />)}
        <T weight="800">{t('fin.access.grants')}</T>
        {!a.grants.length ? <T size={13} color={c.mute}>{t('fin.access.none')}</T> : a.grants.map((g) => (
          <Row key={g.id} title={g.display_name} sub={t(`fin.level.${g.level}_sub`)}
            right={<><Tag label={t(`fin.level.${g.level}`)} color={c.violetSoft} />{atLeast(a.my_level, 'controller') ? <Btn small title={t('fin.access.revoke')} color={c.paper} ink={c.ink} loading={busy} onPress={() => save(g.user_id, 'none', t('fin.access.revoked'))} /> : null}</>} />
        ))}
        {atLeast(a.my_level, 'controller') ? (
          <View style={{ gap: 10 }}>
            <T weight="800">{t('fin.access.add')}</T>
            <EntityPicker kind="person" label={t('fin.access.person')} value={person} onChange={setPerson} />
            <MenuField label={t('fin.access.level')} value={lvl} onChange={setLvl} options={levelOpts} />
            <Btn title={t('fin.access.save')} disabled={!person.length} loading={busy} onPress={() => save(person[0].id, lvl, t('fin.access.saved'))} />
          </View>
        ) : null}
      </Section>
      {canSee ? (
        <Section title={t('fin.audit.title')} color={c.violet}>
          {trail.error ? <ErrorBox error={trail.error} onRetry={trail.reload} /> : !trail.data ? <Loading /> : !trail.data.length ? <T size={13} color={c.mute}>{t('fin.audit.empty')}</T> : trail.data.map((h) => (
            <Row key={`${h.source}-${h.ref}`} title={auditTitle(h)} sub={[h.actor ? t('fin.audit.by', { actor: h.actor }) : null, day(h.at)].filter(Boolean).join(' · ')} />
          ))}
        </Section>
      ) : null}
    </View>
  );
}
