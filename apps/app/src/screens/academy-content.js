// Academy Content (#804): license the academy's approved methodology, curricula, drills and micro-courses to other organisations, and use what the
// academy has licensed. The server owns every rule (eligibility, territory, seats, entitlement, youth footage); this module only shows what the role
// may use. Packs reference the Curriculum module's published versions (nothing is copied); money goes through the normal checkout.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';
import { moneyIn } from '../vtime';
import { MenuField } from '../menu-field';
import { Block, Fact, Meter, Split, Timeline, when } from './academy-ui';
import { Eyebrow, Hero, Panel, WrapTabs, lbl } from './academy-curriculum-ui';
import { PackWorkspace, PackForm, ItemReader } from './academy-content-pack';
import { PaySheet } from '../PaySheet';

export const STAGE_TONE = { active: c.lime, grace: c.sunSoft, proposed: c.cyanSoft, requested: c.cyanSoft, awaiting_payment: c.sunSoft, suspended: c.orangeSoft, revoked: c.orangeSoft, expired: undefined, declined: undefined, withdrawn: undefined };
export const StageTag = ({ state }) => <Tag label={t(`cl.stage.${state}`)} color={STAGE_TONE[state]} />;
const cc = (m, cur) => moneyIn(Number(m ?? 0), cur);
const bar = (v, max) => `${Math.max(v ? 4 : 0, Math.round((v / Math.max(1, max)) * 100))}%`;

// ------------------------------------------------------------------------------------------------ overview
function Overview({ o, go }) {
  const ov = useLoad(() => api.get(`/organisations/${o.id}/academy/content/overview`), [o.id]);
  if (ov.error) return <ErrorBox error={ov.error} onRetry={ov.reload} />;
  if (!ov.data) return <Loading />;
  const { kpis: k, revenue, by_pack: bp, trend, expiring } = ov.data;
  const max = Math.max(1, ...trend.map((d) => d.opened));
  const none = !k.published && !k.drafts;
  return (
    <View style={{ gap: 14 }}>
      <Hero title={t('cl.overview.title')} sub={t('cl.overview.sub')}
        stats={[{ label: t('cl.kpi.licences'), value: k.active_licences, sub: t('cl.kpi.licensees', { n: k.licensees }) },
          { label: t('cl.kpi.seats'), value: `${k.seats_used}/${k.seats_licensed}`, sub: k.seats_licensed ? t('cl.kpi.seats_pct', { n: Math.round((k.seats_used / k.seats_licensed) * 100) }) : t('cl.kpi.none_yet') },
          { label: t('cl.kpi.renewals'), value: k.renewals_30, sub: t('cl.kpi.renewals_90', { n: k.renewals_90 }) },
          { label: t('cl.kpi.completion'), value: k.completion_pct == null ? '–' : `${k.completion_pct}%`, sub: t('cl.kpi.completion_sub') }]} />
      {none ? <Empty emoji="📦" title={t('cl.empty.packs')} sub={t('cl.empty.packs_sub')} /> : null}
      {(k.requests || k.suspended || k.in_grace || k.open_cases) ? (
        <Panel>
          <Eyebrow>{t('cl.alerts')}</Eyebrow>
          {[['requests', k.requests, 'licences'], ['suspended', k.suspended, 'licences'], ['in_grace', k.in_grace, 'licences'], ['open_cases', k.open_cases, 'cases']].filter(([, n]) => n).map(([key, n, to]) => (
            <Pressable key={key} accessibilityRole="button" accessibilityLabel={t(`cl.alert.${key}`, { n })} onPress={() => go(to)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Tag label={String(n)} color={key === 'requests' ? c.cyanSoft : c.orangeSoft} /><T weight="700" style={{ flex: 1 }}>{t(`cl.alert.${key}`, { n })}</T><T color={c.mute}>›</T>
            </Pressable>
          ))}
        </Panel>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
        <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
          <Eyebrow>{t('cl.revenue')}</Eyebrow>
          {revenue.length ? revenue.map((r) => <T key={r.currency} size={26} weight="800" style={{ letterSpacing: -1 }}>{cc(r.total_minor, r.currency)}</T>) : <T color={c.mute}>{t('cl.revenue_none')}</T>}
          {bp.length ? bp.map((p) => (
            <View key={p.id} style={{ gap: 3 }} accessible accessibilityLabel={lbl`${p.title}: ${cc(p.revenue_minor, p.currency)}, ${t('cl.kpi.licences')} ${p.licences}`}>
              <View style={{ flexDirection: 'row', gap: 8 }}><T size={13} weight="700" style={{ flex: 1 }} numberOfLines={1}>{p.title}</T><T size={13} weight="800">{cc(p.revenue_minor, p.currency)}</T></View>
              <View style={{ height: 8, borderRadius: 5, backgroundColor: c.violetSoft }}><View style={{ height: 8, borderRadius: 5, width: bar(Number(p.revenue_minor), Math.max(...bp.map((x) => Number(x.revenue_minor)))), backgroundColor: c.cyan }} /></View>
            </View>
          )) : null}
        </Panel>
        <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
          <Eyebrow>{t('cl.consumption')}</Eyebrow>
          {trend.length ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 96 }} accessible accessibilityLabel={t('cl.consumption_a11y', { n: trend.reduce((s, d) => s + d.opened, 0) })}>
              {trend.map((d) => <View key={d.day} style={{ flex: 1, height: Math.max(4, Math.round((d.opened / max) * 90)), borderRadius: 3, backgroundColor: c.lime }} />)}
            </View>
          ) : <T color={c.mute}>{t('cl.consumption_none')}</T>}
          <T size={12} color={c.mute}>{t('cl.consumption_note')}</T>
        </Panel>
      </View>
      <Panel>
        <Eyebrow>{t('cl.expiring')}</Eyebrow>
        {expiring.length ? expiring.map((e) => <Row key={e.id} title={lbl`${e.licensee_name} · ${e.title}`} sub={t('cl.ends', { date: when(e.effective_to), n: e.seats })} onPress={() => go('licences', e.id)} />) : <T color={c.mute}>{t('cl.expiring_none')}</T>}
      </Panel>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ packs (publisher)
function Packs({ o, toast }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/content/packs`), [o.id]);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const sel = list.data.find((p) => p.id === open);
  const detail = sel ? <PackWorkspace o={o} pack={sel} toast={toast} onChange={list.reload} /> : null;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}><Eyebrow>{t('cl.packs')}</Eyebrow><View style={{ flex: 1 }} /><Btn small title={t('cl.new_pack')} onPress={() => setAdding(true)} /></View>
      <Split open={!!sel} onClose={() => setOpen(null)} detailTitle={sel?.title} detail={detail}
        list={list.data.length ? (
          <View style={{ gap: 8 }}>
            {list.data.map((p) => (
              <Card key={p.id} onPress={() => setOpen(p.id)} accessibilityLabel={`${p.title}, ${t(`cl.pack.${p.status}`)}`}>
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <T weight="800" size={16} style={{ flex: 1 }}>{p.title}</T>
                    <Tag label={t(`cl.pack.${p.status}`)} color={p.status === 'published' ? c.lime : p.status === 'retired' ? c.orangeSoft : c.sunSoft} />
                  </View>
                  <T size={12} color={c.mute}>{[p.sport, p.level_key, p.age_min != null ? t('cl.ages', { a: p.age_min, b: p.age_max ?? '+' }) : null, p.current_version ? `v${p.current_version}` : t('cl.unpublished')].filter(Boolean).join(' · ')}</T>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    <Tag label={t('cl.n_items', { n: p.items })} /><Tag label={t('cl.n_licences', { n: p.live_licences })} color={c.cyanSoft} /><Tag label={t('cl.n_seats', { n: p.licensed_seats })} />
                    {p.rating ? <Tag label={lbl`★ ${p.rating}`} color={c.sunSoft} /> : null}<Tag label={t(`cl.elig.${p.eligibility}`)} /><Tag label={p.price_minor ? cc(p.price_minor, p.currency) : t('cl.free')} />
                  </View>
                </View>
              </Card>
            ))}
          </View>
        ) : <Empty emoji="📦" title={t('cl.empty.packs')} sub={t('cl.empty.packs_sub')} />} />
      <PackForm visible={adding} o={o} onClose={() => setAdding(false)} toast={toast} onSaved={(p) => { list.reload(); setOpen(p.id); }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ licences (both sides)
function Licences({ o, side, toast, focus }) {
  const [stage, setStage] = useState('');
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/content/licences`, { side, ...(stage ? { stage } : {}) }), [o.id, side, stage]);
  const [open, setOpen] = useState(focus ?? null);
  const [terms, setTerms] = useState(null);
  const [paying, setPaying] = useState(null);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const stages = ['', 'requested', 'proposed', 'awaiting_payment', 'active', 'suspended', 'expired', 'revoked'].map((v) => ({ value: v, label: v ? t(`cl.stage.${v}`) : t('cl.all') }));
  const sel = list.data.find((l) => l.id === open);
  return (
    <View style={{ gap: 12 }}>
      <MenuField label={t('cl.filter_stage')} value={stage} onChange={setStage} options={stages} />
      <Split open={!!sel} onClose={() => setOpen(null)} detailTitle={sel ? `${sel.pack_title}` : ''}
        detail={sel ? <LicenceDetail l={sel} side={side} toast={toast} onChange={list.reload} onTerms={() => setTerms(sel)} onPay={() => setPaying(sel)} /> : null}
        list={list.data.length ? (
          <View style={{ gap: 8 }}>
            {list.data.map((l) => (
              <Card key={l.id} onPress={() => setOpen(l.id)} accessibilityLabel={`${l.pack_title}, ${side === 'publisher' ? l.licensee_name : l.publisher_name}, ${t(`cl.stage.${l.state}`)}`}>
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" style={{ flex: 1 }}>{l.pack_title}</T><StageTag state={l.state} /></View>
                  <T size={12} color={c.mute}>{side === 'publisher' ? l.licensee_name : l.publisher_name}{l.effective_to ? ` · ${t('cl.until', { date: when(l.effective_to) })}` : ''}</T>
                  <Meter filled={l.seats_used} capacity={l.seats} compact />
                </View>
              </Card>
            ))}
          </View>
        ) : <Empty emoji="🪪" title={t(`cl.empty.licences_${side}`)} sub={t(`cl.empty.licences_${side}_sub`)} />} />
      <ProposeSheet l={terms} onClose={() => setTerms(null)} toast={toast} onSaved={() => { list.reload(); }} />
      {paying ? <PaySheet target={{ type: 'content_licence', id: paying.id, label: `${paying.pack_title} · ${paying.licensee_name}`, amount: Number(paying.price_minor), currency: paying.currency }} onClose={() => setPaying(null)} onDone={() => { setPaying(null); list.reload(); }} /> : null}
    </View>
  );
}

function LicenceDetail({ l, side, toast, onChange, onTerms, onPay }) {
  const d = useLoad(() => api.get(`/academy/content/licences/${l.id}`), [l.id, l.row_version]);
  const [seat, setSeat] = useState(false);
  const [why, setWhy] = useState(null);
  const run = async (fn, ok) => { try { await fn(); toast(ok); onChange(); d.reload(); } catch (e) { toast(explain(e)); } };
  const members = useLoad(() => (side === 'licensee' && l.state === 'active' ? api.get(`/organisations/${l.licensee_org_id}/members`).catch(() => []) : Promise.resolve([])), [l.id, l.state]);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data, pub = side === 'publisher';
  const held = new Set(x.seat_holders.map((s) => s.user_id));
  const pool = (Array.isArray(members.data) ? members.data : []).filter((m) => ['coach', 'staff', 'admin', 'owner'].includes(m.org_role) && !held.has(m.id));
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><StageTag state={x.state} /><Tag label={t(x.territory_mode === 'worldwide' ? 'cl.worldwide' : `cl.terr.${x.territory_mode}`, { list: x.countries.join(', ') })} />{x.offline_allowed ? <Tag label={t('cl.offline_yes')} color={c.cyanSoft} /> : null}{x.auto_renew ? <Tag label={t('cl.auto_renew')} /> : null}</View>
      <Block title={t('cl.terms')}>
        <Fact k={t('cl.f.parties')} v={`${x.publisher_name} → ${x.licensee_name}`} />
        <Fact k={t('cl.f.window')} v={x.effective_from ? `${when(x.effective_from)} – ${when(x.effective_to)}` : null} />
        <Fact k={t('cl.f.price')} v={Number(x.price_minor) ? cc(x.price_minor, x.currency) : t('cl.free')} />
        <Fact k={t('cl.f.seats')} v={`${x.seats_used} / ${x.seats}`} />
        <Fact k={t('cl.f.version')} v={x.pinned_version ? t('cl.pinned', { n: x.pinned_version }) : t('cl.follows_latest')} />
        <Fact k={t('cl.f.grace')} v={t('cl.days', { n: x.grace_days })} />
        <Fact k={t('cl.f.reason')} v={x.reason_code ? t(`cl.reason.${x.reason_code}`) : null} />
        <Fact k={t('cl.f.note')} v={x.note} />
      </Block>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {pub && ['requested', 'proposed'].includes(x.state) ? <Btn small title={t(x.state === 'requested' ? 'cl.set_terms' : 'cl.revise_terms')} onPress={onTerms} /> : null}
        {pub && x.state === 'active' ? <Btn small title={t('cl.renew')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`/academy/content/licences/${x.id}/renew`, {}), t('cl.renewal_offered'))} /> : null}
        {pub && x.state === 'active' ? <Btn small title={t('cl.suspend')} color={c.paper} ink={c.ink} onPress={() => setWhy('suspend')} /> : null}
        {pub && x.state === 'suspended' ? <Btn small title={t('cl.reinstate')} onPress={() => run(() => api.post(`/academy/content/licences/${x.id}/manage`, { action: 'reinstate' }), t('cl.reinstated'))} /> : null}
        {pub && ['active', 'grace', 'suspended'].includes(x.state) ? <Btn small title={t('cl.revoke')} color={c.orange} onPress={() => setWhy('revoke')} /> : null}
        {pub && ['requested', 'proposed', 'awaiting_payment'].includes(x.state) ? <Btn small title={t('cl.withdraw_offer')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`/academy/content/licences/${x.id}/manage`, { action: 'withdraw_offer' }), t('cl.withdrawn'))} /> : null}
        {!pub && x.state === 'proposed' ? <><Btn small title={t('cl.accept')} onPress={() => run(() => api.post(`/academy/content/licences/${x.id}/respond`, { action: 'accept' }), t('cl.accepted'))} /><Btn small title={t('cl.decline')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`/academy/content/licences/${x.id}/respond`, { action: 'decline' }), t('cl.declined'))} /></> : null}
        {!pub && x.state === 'awaiting_payment' ? <Btn small title={t('cl.pay_now', { amount: cc(x.price_minor, x.currency) })} onPress={onPay} /> : null}
        {!pub && ['requested', 'proposed'].includes(x.state) ? <Btn small title={t('cl.withdraw_request')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`/academy/content/licences/${x.id}/respond`, { action: 'withdraw' }), t('cl.withdrawn'))} /> : null}
      </View>
      {x.state === 'active' && !pub ? <Btn small title={t('cl.assign_seat')} color={c.paper} ink={c.ink} onPress={() => setSeat(true)} /> : null}
      <Block title={t('cl.seat_holders', { n: x.seat_holders.length })}>
        {x.seat_holders.length ? x.seat_holders.map((s) => (
          <Row key={s.user_id} title={s.display_name} sub={t('cl.seat_usage', { n: s.opens, last: s.last_seen ? when(s.last_seen) : '–' })}
            right={!pub && x.state === 'active' ? <Btn small title={t('cl.release')} color={c.paper} ink={c.ink} onPress={() => run(() => api.del(`/academy/content/licences/${x.id}/seats/${s.user_id}`), t('cl.released'))} /> : undefined} />
        )) : <T color={c.mute}>{t('cl.no_seats')}</T>}
      </Block>
      <Block title={t('cl.history')}><Timeline items={x.events.map((e) => ({ title: t(`cl.event.${e.action}`), sub: `${when(e.at)}${e.actor ? ` · ${e.actor}` : ''}` }))} /></Block>
      <FormSheet visible={seat} onClose={() => setSeat(false)} title={t('cl.assign_seat')} submitLabel={t('cl.assign')}
        fields={[{ key: 'user_id', label: t('cl.f.person'), type: 'chips', options: pool.map((m) => ({ value: m.id, label: m.display_name, sub: m.org_role })) }]}
        onSubmit={async (v) => { await api.post(`/academy/content/licences/${x.id}/seats`, { user_id: v.user_id }); onChange(); d.reload(); return t('cl.seat_assigned'); }} />
      <FormSheet visible={!!why} onClose={() => setWhy(null)} title={why ? t(`cl.${why}`) : ''} submitLabel={why ? t(`cl.${why}`) : ''}
        fields={[{ key: 'reason_code', label: t('cl.f.reason'), type: 'chips', options: ['non_payment', 'breach', 'rights_dispute', 'safeguarding', 'requested_by_licensee', 'end_of_term', 'other'].map((v) => ({ value: v, label: t(`cl.reason.${v}`) })) }, { key: 'note', label: t('cl.f.note'), type: 'multiline', optional: true, hint: t('cl.revoke_hint') }]}
        onSubmit={async (v) => { await api.post(`/academy/content/licences/${x.id}/manage`, { action: why, reason_code: v.reason_code, note: v.note || undefined }); setWhy(null); onChange(); d.reload(); return t('cl.updated'); }} />
    </View>
  );
}

function ProposeSheet({ l, onClose, toast, onSaved }) {
  const pack = useLoad(() => (l ? api.get(`/academy/content/packs/${l.pack_id}`) : Promise.resolve(null)), [l?.pack_id]);
  const p = pack.data;
  const vers = (p?.versions ?? []).filter((v) => ['published', 'superseded'].includes(v.status));
  return (
    <FormSheet visible={!!l} onClose={onClose} title={t('cl.set_terms')} submitLabel={t('cl.send_offer')}
      initial={l ? { seats: l.seats, term_months: p?.term_months ?? 12, price_minor: Number(l.price_minor) || (p ? p.price_minor * l.seats : 0), offline_allowed: !!(l.offline_allowed && p?.offline_allowed), grace_days: l.grace_days, auto_renew: !!l.auto_renew } : {}}
      fields={[
        { key: 'seats', label: t('cl.f.seats'), type: 'stepper', min: 1, max: p?.max_seats ?? 1000, step: 1 },
        { key: 'effective_from', label: t('cl.f.starts'), type: 'date', optional: true },
        { key: 'term_months', label: t('cl.f.term'), type: 'stepper', min: 1, max: 60, step: 1, suffix: t('cl.months') },
        { key: 'price_minor', label: t('cl.f.total_price'), type: 'money', currency: l?.currency ?? 'USD', hint: t('cl.price_hint') },
        { key: 'pinned_version', label: t('cl.f.version'), type: 'chips', optional: true, options: vers.map((v) => ({ value: v.version, label: `v${v.version}` })), hint: t('cl.pin_hint') },
        { key: 'grace_days', label: t('cl.f.grace'), type: 'stepper', min: 0, max: 90, step: 1, suffix: t('cl.days_suffix') },
        ...(p?.offline_allowed ? [{ key: 'offline_allowed', label: t('cl.f.offline'), type: 'switch', hint: t('cl.offline_hint', { n: p.offline_max_days }) }] : []),
        { key: 'auto_renew', label: t('cl.auto_renew'), type: 'switch' },
        { key: 'note', label: t('cl.f.note'), type: 'multiline', optional: true },
      ]}
      onSubmit={async (v) => { const r = await api.post(`/academy/content/packs/${l.pack_id}/licences`, { licensee_org_id: l.licensee_org_id, seats: v.seats, term_months: v.term_months, price_minor: v.price_minor, effective_from: v.effective_from || undefined, pinned_version: v.pinned_version || undefined, grace_days: v.grace_days, offline_allowed: !!v.offline_allowed, auto_renew: !!v.auto_renew, note: v.note || undefined }); onSaved(r); return t('cl.offer_sent'); }} />
  );
}

// ------------------------------------------------------------------------------------------------ marketplace (buyer)
function Market({ o, toast, go }) {
  const [f, setF] = useState({ sport: '', q: '' });
  const list = useLoad(() => api.get('/academy/content/marketplace', { org_id: o.id, ...(f.sport ? { sport: f.sport } : {}), ...(f.q ? { q: f.q } : {}) }), [o.id, f.sport, f.q]);
  const [open, setOpen] = useState(null);
  const [req, setReq] = useState(null);
  const sports = [...new Set((list.data ?? []).map((p) => p.sport))].sort().map((s) => ({ value: s, label: s }));
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const sel = list.data.find((p) => p.id === open);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <View style={{ flexGrow: 1, flexBasis: 220 }}><MenuField label={t('cl.f.sport')} value={f.sport} onChange={(v) => setF({ ...f, sport: v })} options={[{ value: '', label: t('cl.all') }, ...sports]} /></View>
      </View>
      <Split open={!!sel} onClose={() => setOpen(null)} detailTitle={sel?.title} detail={sel ? <MarketDetail o={o} pack={sel} onRequest={() => setReq(sel)} go={go} /> : null}
        list={list.data.length ? (
          <View style={{ gap: 8 }}>
            {list.data.map((p) => (
              <Card key={p.id} onPress={() => setOpen(p.id)} accessibilityLabel={lbl`${p.title}, ${p.publisher_name}`}>
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" size={16} style={{ flex: 1 }}>{p.title}</T>{p.my_stage ? <Tag label={t(`cl.stage.${p.my_stage}`)} color={STAGE_TONE[p.my_stage]} /> : null}</View>
                  <T size={12} color={c.mute}>{p.publisher_name} · {p.sport}{p.age_min != null ? ` · ${t('cl.ages', { a: p.age_min, b: p.age_max ?? '+' })}` : ''}</T>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    <Tag label={t('cl.n_items', { n: p.items })} />{p.cpd_hours ? <Tag label={t('cl.cpd', { n: p.cpd_hours })} /> : null}{p.rating ? <Tag label={lbl`★ ${p.rating}`} color={c.sunSoft} /> : null}
                    <Tag label={p.price_minor ? t('cl.per_seat', { amount: cc(p.price_minor, p.currency) }) : t('cl.free')} color={c.cyanSoft} />
                    {!p.eligible ? <Tag label={t('cl.not_eligible')} color={c.orangeSoft} /> : null}
                  </View>
                </View>
              </Card>
            ))}
          </View>
        ) : <Empty emoji="🧭" title={t('cl.empty.market')} sub={t('cl.empty.market_sub')} />} />
      <FormSheet visible={!!req} onClose={() => setReq(null)} title={t('cl.request_licence')} submitLabel={t('cl.send_request')} initial={{ seats: 1 }}
        fields={[{ key: 'seats', label: t('cl.f.seats'), type: 'stepper', min: 1, max: req?.max_seats ?? 500, step: 1 }, { key: 'note', label: t('cl.f.note_to_publisher'), type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/academy/content/packs/${req.id}/request`, { org_id: o.id, seats: v.seats, note: v.note || undefined }); list.reload(); go?.('mine'); return t('cl.request_sent'); }} />
    </View>
  );
}

function MarketDetail({ o, pack, onRequest }) {
  const d = useLoad(() => api.get(`/academy/content/packs/${pack.id}`, { org_id: o.id }), [pack.id]);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data;
  return (
    <View style={{ gap: 12 }}>
      <T color={c.mute}>{x.summary}</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Tag label={t(`cl.elig.${x.eligibility}`)} /><Tag label={t(x.territory_mode === 'worldwide' ? 'cl.worldwide' : `cl.terr.${x.territory_mode}`, { list: x.countries.join(', ') })} />{x.offline_allowed ? <Tag label={t('cl.offline_yes')} color={c.cyanSoft} /> : null}{x.languages.map((l) => <Tag key={l} label={l.toUpperCase()} />)}
      </View>
      <Block title={t('cl.syllabus')}>
        {x.items.map((i) => (
          <Row key={i.id} left={<T size={18}>{x.my_licence?.stage === 'active' ? '📖' : '🔒'}</T>} title={i.title} sub={`${t(`cl.kind.${i.kind}`)}${i.minutes ? ` · ${t('cl.min', { n: i.minutes })}` : ''}${i.youth_footage ? ` · ${t('cl.stream_only')}` : ''}`} />
        ))}
      </Block>
      {x.version?.objectives?.length ? <Block title={t('cl.objectives')}>{x.version.objectives.map((ob, i) => <T key={i} size={13}>• {ob.title}</T>)}</Block> : null}
      <Block title={t('cl.rights')}>
        <Fact k={t('cl.f.publisher')} v={x.publisher?.name} /><Fact k={t('cl.f.authors')} v={x.authors.map((a) => a.name).join(', ')} />
        <Fact k={t('cl.f.price')} v={x.price_minor ? t('cl.per_seat_term', { amount: cc(x.price_minor, x.currency), n: x.term_months }) : t('cl.free')} />
        <Fact k={t('cl.f.assessment')} v={x.version?.assessment?.kind && x.version.assessment.kind !== 'none' ? t(`cl.assess.${x.version.assessment.kind}`) : null} />
        <Fact k={t('cl.f.cpd')} v={x.version?.cpd_hours ? t('cl.hours', { n: x.version.cpd_hours }) : null} />
      </Block>
      {x.my_licence ? <Tag label={t(`cl.stage.${x.my_licence.stage}`)} color={STAGE_TONE[x.my_licence.stage]} /> : x.eligible ? <Btn title={t('cl.request_licence')} onPress={onRequest} /> : <Panel><T weight="700">{t('cl.not_eligible')}</T><T size={13} color={c.mute}>{x.ineligible_reason}</T></Panel>}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ cases
function Cases({ o, toast }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/content/cases`), [o.id]);
  const [res, setRes] = useState(null);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      {list.data.length ? list.data.map((k) => (
        <Card key={k.id}>
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>{k.pack_title}{k.item_title ? ` · ${k.item_title}` : ''}</T><Tag label={t(`cl.case.${k.kind}`)} color={['takedown', 'safeguarding'].includes(k.kind) ? c.orangeSoft : c.cyanSoft} /><Tag label={t(`cl.case_status.${k.status}`)} color={k.status === 'resolved' ? c.lime : c.sunSoft} /></View>
            <T size={13}>{k.note}</T>
            <T size={12} color={c.mute}>{k.raised_by_name} · {when(k.created_at)}</T>
            {k.resolution ? <T size={12} color={c.mute}>{t('cl.resolution')}: {k.resolution}</T> : null}
            {k.status !== 'resolved' ? <Btn small title={t('cl.resolve')} onPress={() => setRes(k)} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="🛟" title={t('cl.empty.cases')} sub={t('cl.empty.cases_sub')} />}
      <FormSheet visible={!!res} onClose={() => setRes(null)} title={t('cl.resolve')} submitLabel={t('cl.resolve')}
        initial={{ status: 'resolved', takedown: 'none' }}
        fields={[{ key: 'status', label: t('cl.f.status'), type: 'choice', options: [{ value: 'investigating', label: t('cl.case_status.investigating') }, { value: 'resolved', label: t('cl.case_status.resolved') }] },
          { key: 'resolution', label: t('cl.resolution'), type: 'multiline', optional: true },
          ...(res?.item_id ? [{ key: 'takedown', label: t('cl.takedown'), type: 'choice', options: [{ value: 'none', label: t('cl.takedown_none') }, { value: 'withdraw', label: t('cl.takedown_withdraw') }, { value: 'lift', label: t('cl.takedown_lift') }] },
            { key: 'takedown_reason', label: t('cl.takedown_reason'), type: 'chips', optional: true, show: (v) => v.takedown === 'withdraw', options: ['youth_safeguarding', 'rights_dispute', 'accuracy', 'other'].map((v) => ({ value: v, label: t(`cl.tk.${v}`) })) }] : [])]}
        onSubmit={async (v) => { await api.post(`/academy/content/cases/${res.id}/resolve`, { status: v.status, resolution: v.resolution || undefined, takedown: v.takedown ?? 'none', takedown_reason: v.takedown_reason || undefined }); list.reload(); return t('cl.updated'); }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ library (the coach)
function Library({ toast }) {
  const lib = useLoad(() => api.get('/me/academy/content'), []);
  const [read, setRead] = useState(null);
  if (lib.error) return <ErrorBox error={lib.error} onRetry={lib.reload} />;
  if (!lib.data) return <Loading />;
  if (!lib.data.length) return <Empty emoji="📚" title={t('cl.empty.library')} sub={t('cl.empty.library_sub')} />;
  return (
    <View style={{ gap: 12 }}>
      {lib.data.map((l) => (
        <Panel key={l.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" size={17} style={{ flex: 1 }}>{l.pack_title}</T><StageTag state={l.state} /></View>
          <T size={12} color={c.mute}>{l.publisher_name}{l.cpd_hours ? ` · ${t('cl.cpd', { n: l.cpd_hours })}` : ''}{l.effective_to ? ` · ${t('cl.until', { date: when(l.effective_to) })}` : ''}</T>
          {!l.locked ? <View style={{ gap: 3 }} accessible accessibilityLabel={t('cl.progress_a11y', { a: l.completed, b: l.items })}><View style={{ height: 8, borderRadius: 5, backgroundColor: c.violetSoft }}><View style={{ height: 8, borderRadius: 5, width: bar(l.completed, l.items), backgroundColor: c.lime }} /></View><T size={12} color={c.mute}>{t('cl.progress', { a: l.completed, b: l.items })}</T></View> : null}
          {l.state === 'grace' ? <Panel style={{ backgroundColor: c.sunSoft }}><T weight="700">{t('cl.grace_banner', { n: l.grace_days })}</T></Panel> : null}
          {l.locked ? <Panel style={{ backgroundColor: c.orangeSoft }}><T weight="800">{t('cl.locked')}</T><T size={13}>{t(`cl.locked_${l.state}`)}</T></Panel> : null}
          {l.syllabus.map((i) => (
            <Row key={i.id} left={<T size={18}>{l.locked || i.withdrawn ? '🔒' : i.youth_footage ? '🎥' : '📖'}</T>} title={i.title} sub={`${t(`cl.kind.${i.kind}`)}${i.minutes ? ` · ${t('cl.min', { n: i.minutes })}` : ''}${i.youth_footage ? ` · ${t('cl.stream_only')}` : ''}`}
              onPress={l.locked || i.withdrawn ? undefined : () => setRead({ licence: l, item: i })} />
          ))}
        </Panel>
      ))}
      <ItemReader sel={read} onClose={() => setRead(null)} toast={toast} onDone={lib.reload} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ the module
export function Content({ o, role, toast, focus }) {
  const publisher = ['owner', 'admin', 'staff', 'auditor'].includes(role), buyer = ['owner', 'admin'].includes(role);
  const sections = [
    ...(publisher ? [{ value: 'overview', label: t('cl.tab.overview') }, { value: 'packs', label: t('cl.tab.packs') }, { value: 'licences', label: t('cl.tab.licences') }, { value: 'cases', label: t('cl.tab.cases') }] : []),
    ...(buyer ? [{ value: 'market', label: t('cl.tab.market') }, { value: 'mine', label: t('cl.tab.mine') }] : []),
    { value: 'library', label: t('cl.tab.library') },
  ];
  const [tab, setTab] = useState(focus?.section ?? sections[0].value);
  const [pick, setPick] = useState(null);
  const go = (to, id) => { setPick(id ?? null); setTab(to); };
  return (
    <View style={{ gap: 14 }}>
      <WrapTabs options={sections} value={tab} onChange={(v) => go(v)} />
      {tab === 'overview' ? <Overview o={o} go={go} /> : tab === 'packs' ? <Packs o={o} toast={toast} /> : tab === 'licences' ? <Licences key={`p${pick}`} o={o} side="publisher" toast={toast} focus={pick} />
        : tab === 'cases' ? <Cases o={o} toast={toast} /> : tab === 'market' ? <Market o={o} toast={toast} go={go} /> : tab === 'mine' ? <Licences o={o} side="licensee" toast={toast} /> : <Library toast={toast} />}
    </View>
  );
}
