// PS-18 — Adaptive sports equipment: inventory, fitting, hire and service (#848).
// Eight screen components covering Explore, Hub (venue/academy fleet), loan flow,
// fitting appointments, service records, athlete My Loans, supplier catalogue and
// event readiness. All data lives in the adaptive-equipment capability (API-first);
// this file is pure presentation. No diagnoses or classification data are shown here.
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, Field, HScroll, Loading, Seg, Sheet, T, Tag } from '../ui';
import { MenuField, MultiMenuField } from '../menu-field';
import { c, when } from '../theme';
import { t } from '../i18n';

// ─── shared helpers ──────────────────────────────────────────────────────────

const statusColor = (s) =>
  s === 'available' ? c.mint : s === 'on_loan' ? c.sun : s === 'in_service' ? c.orange : c.red;
const statusSoft = (s) =>
  s === 'available' ? c.mintSoft : s === 'on_loan' ? c.sunSoft : s === 'in_service' ? c.orangeSoft : c.redSoft;
const readinessColor = (r) =>
  r === 'ready' ? c.mint : r === 'needs_service' ? c.sun : c.red;

const conditionColor = (cond) =>
  cond === 'excellent' ? c.mint : cond === 'good' ? c.lime : cond === 'fair' ? c.sun : c.red;

function ProgressDots({ total, current }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', paddingVertical: 8 }}>
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={{
            width: i === current ? 20 : 8, height: 8, borderRadius: 4,
            backgroundColor: i === current ? c.pink : i < current ? c.pinkSoft : c.line,
          }}
        />
      ))}
    </View>
  );
}

function MetricTile({ label, value, color }) {
  return (
    <Card pad={12} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
      <T size={24} weight="800" color={color ?? c.ink}>{value ?? '—'}</T>
      <T size={11} color={c.mute} style={{ textAlign: 'center' }}>{label}</T>
    </Card>
  );
}

/** Left-accent asset card used in Explore and Hub. */
function AssetCard({ asset, onLoan, onView, isTablet }) {
  return (
    <Card pad={0} style={{ overflow: 'hidden', flex: isTablet ? 1 : undefined }}>
      <View style={{ flexDirection: 'row' }}>
        <View style={{ width: 5, backgroundColor: c.pink, borderRadius: 0 }} />
        <View style={{ flex: 1, padding: 14, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1, gap: 3 }}>
              <T size={15} weight="800" numberOfLines={2}>{asset.name}</T>
              <T size={12} color={c.mute}>{asset.org_name ?? asset.venue_name ?? ''}</T>
            </View>
            <Tag label={t(`adaptiveEquip.status.${asset.status}`)} color={statusColor(asset.status)} />
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
            <Tag label={t(`adaptiveEquip.type.${asset.type}`)} color={c.violetSoft} />
            {(asset.sport_codes ?? []).map((s) => (
              <Tag key={s} label={s} color={c.cyanSoft} />
            ))}
            {asset.size_family ? <Tag label={asset.size_family} color={c.violetSoft} /> : null}
          </View>
          {asset.serial_number ? (
            <T size={11} color={c.mute}>{t('adaptiveEquip.serial')} {asset.serial_number.slice(0, 10)}…</T>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 2 }}>
            {onLoan && asset.status === 'available' ? (
              <Btn small label={t('adaptiveEquip.loan.requestCta')} onPress={() => onLoan(asset)} />
            ) : null}
            {onView ? (
              <Btn small label={t('common.view')} color={c.violetSoft} onPress={() => onView(asset)} />
            ) : null}
          </View>
        </View>
      </View>
    </Card>
  );
}

// ─── 1. AdaptiveEquipmentExplore ─────────────────────────────────────────────

export function AdaptiveEquipmentExplore() {
  const { width } = useLayout();
  const isTablet = width >= 768;
  const [sportFilter, setSportFilter] = useState(null);
  const [typeFilter, setTypeFilter] = useState(null);
  const [q, setQ] = useState('');
  const [loanAsset, setLoanAsset] = useState(null);

  const [catalogue, catErr] = useLoad(() => api.get('/adaptive-equipment/catalogue'));

  const params = useMemo(() => {
    const p = {};
    if (sportFilter) p.sport_code = sportFilter;
    if (typeFilter) p.type = typeFilter;
    if (q.trim()) p.q = q.trim();
    p.status = 'available';
    return p;
  }, [sportFilter, typeFilter, q]);

  const [assets, assetsErr, reload] = useLoad(() => api.get('/adaptive-equipment/assets', { params }), [params]);

  const summary = useMemo(() => {
    if (!assets?.items) return null;
    const avail = assets.items.filter((a) => a.status === 'available').length;
    const loan = assets.items.filter((a) => a.status === 'on_loan').length;
    return t('adaptiveEquip.explore.summary', { avail, loan });
  }, [assets]);

  const renderItem = useCallback(({ item }) => (
    <AssetCard
      asset={item}
      onLoan={setLoanAsset}
      isTablet={isTablet}
    />
  ), [isTablet]);

  if (catErr || assetsErr) return <ErrorBox error={catErr ?? assetsErr} />;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
        <T size={22} weight="800">{t('adaptiveEquip.explore.title')}</T>

        {/* sport filter */}
        {catalogue?.sports?.length ? (
          <HScroll>
            <Chip
              label={t('common.all')}
              selected={!sportFilter}
              onPress={() => setSportFilter(null)}
            />
            {catalogue.sports.map((s) => (
              <Chip
                key={s.code}
                label={s.name}
                selected={sportFilter === s.code}
                onPress={() => setSportFilter(sportFilter === s.code ? null : s.code)}
              />
            ))}
          </HScroll>
        ) : null}

        {/* type filter */}
        {catalogue?.asset_types?.length ? (
          <HScroll>
            {catalogue.asset_types.map((tp) => (
              <Chip
                key={tp.key}
                label={t(`adaptiveEquip.type.${tp.key}`)}
                selected={typeFilter === tp.key}
                onPress={() => setTypeFilter(typeFilter === tp.key ? null : tp.key)}
              />
            ))}
          </HScroll>
        ) : null}

        <Field
          label={t('common.search')}
          value={q}
          onChange={setQ}
          placeholder={t('adaptiveEquip.explore.searchPlaceholder')}
        />

        {summary ? <T size={12} color={c.mute}>{summary}</T> : null}
      </View>

      {!assets ? (
        <Loading />
      ) : assets.items?.length === 0 ? (
        <Empty message={t('adaptiveEquip.explore.empty')} />
      ) : (
        <FlatList
          data={assets.items}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={isTablet ? 2 : 1}
          key={isTablet ? 'tablet' : 'phone'}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          columnWrapperStyle={isTablet ? { gap: 10 } : undefined}
        />
      )}

      <Sheet visible={!!loanAsset} onClose={() => setLoanAsset(null)}>
        {loanAsset ? (
          <AdaptiveLoanFlow
            asset={loanAsset}
            onClose={() => setLoanAsset(null)}
            onDone={() => { setLoanAsset(null); reload(); }}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

// ─── 2. AdaptiveEquipmentHub ──────────────────────────────────────────────────

export function AdaptiveEquipmentHub({ orgId, venueId }) {
  const { width } = useLayout();
  const isTablet = width >= 768;
  const { toast } = useSession();
  const [tab, setTab] = useState('fleet');
  const [statusFilter, setStatusFilter] = useState(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [serviceAsset, setServiceAsset] = useState(null);

  const params = useMemo(() => {
    const p = {};
    if (orgId) p.org_id = orgId;
    if (venueId) p.venue_id = venueId;
    if (statusFilter) p.status = statusFilter;
    return p;
  }, [orgId, venueId, statusFilter]);

  const [assets, assetsErr, reloadAssets] = useLoad(() => api.get('/adaptive-equipment/assets', { params }), [params]);
  const [readiness, readinessErr] = useLoad(
    () => venueId ? api.get(`/venues/${venueId}/adaptive-equipment/readiness`) : Promise.resolve(null),
    [venueId],
  );

  const metrics = useMemo(() => {
    if (!assets?.items) return {};
    const items = assets.items;
    return {
      total: items.length,
      available: items.filter((a) => a.status === 'available').length,
      on_loan: items.filter((a) => a.status === 'on_loan').length,
      overdue: (readiness?.assets ?? []).filter((a) => a.service_overdue).length,
    };
  }, [assets, readiness]);

  const tabs = [
    { value: 'fleet', label: t('adaptiveEquip.hub.tabFleet') },
    { value: 'service', label: t('adaptiveEquip.hub.tabService') },
    { value: 'allocations', label: t('adaptiveEquip.hub.tabAllocations') },
  ];

  const statusFilters = [
    { key: null, label: t('common.all') },
    { key: 'available', label: t('adaptiveEquip.status.available') },
    { key: 'on_loan', label: t('adaptiveEquip.status.on_loan') },
    { key: 'in_service', label: t('adaptiveEquip.status.in_service') },
  ];

  if (assetsErr) return <ErrorBox error={assetsErr} />;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
        <T size={22} weight="800">{t('adaptiveEquip.hub.title')}</T>
        <Seg options={tabs} value={tab} onChange={setTab} />
      </View>

      {tab === 'fleet' ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          {/* metric strip */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <MetricTile label={t('adaptiveEquip.hub.metricTotal')} value={metrics.total} />
            <MetricTile label={t('adaptiveEquip.hub.metricAvailable')} value={metrics.available} color={c.mint} />
            <MetricTile label={t('adaptiveEquip.hub.metricOnLoan')} value={metrics.on_loan} color={c.sun} />
            <MetricTile label={t('adaptiveEquip.hub.metricOverdue')} value={metrics.overdue} color={metrics.overdue > 0 ? c.red : c.mint} />
          </View>

          {/* status filter chips */}
          <HScroll>
            {statusFilters.map(({ key, label }) => (
              <Chip
                key={String(key)}
                label={label}
                selected={statusFilter === key}
                onPress={() => setStatusFilter(statusFilter === key ? null : key)}
              />
            ))}
          </HScroll>

          {!assets ? <Loading /> : assets.items?.length === 0 ? (
            <Empty message={t('adaptiveEquip.hub.emptyFleet')} />
          ) : (
            <View style={{ gap: 8 }}>
              {assets.items.map((asset) => {
                const r = readiness?.assets?.find((ra) => ra.id === asset.id);
                const rStatus = r?.service_overdue ? 'overdue' : r?.has_conflict ? 'conflict' : 'ready';
                return (
                  <Card key={asset.id} pad={12}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={{
                        width: 10, height: 10, borderRadius: 5,
                        backgroundColor: readinessColor(rStatus),
                      }} />
                      <View style={{ flex: 1, gap: 3 }}>
                        <T size={14} weight="700" numberOfLines={1}>{asset.name}</T>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                          <Tag label={t(`adaptiveEquip.type.${asset.type}`)} color={c.violetSoft} />
                          {(asset.sport_codes ?? []).map((s) => <Tag key={s} label={s} color={c.cyanSoft} />)}
                          <Tag label={t(`adaptiveEquip.status.${asset.status}`)} color={statusColor(asset.status)} />
                        </View>
                        {r?.next_service_due ? (
                          <T size={11} color={r.service_overdue ? c.red : c.mute}>
                            {t('adaptiveEquip.hub.nextService')} {when(r.next_service_due)}
                          </T>
                        ) : null}
                        {asset.serial_number ? (
                          <T size={11} color={c.mute}>{asset.serial_number}</T>
                        ) : null}
                      </View>
                      <View style={{ gap: 6 }}>
                        <Btn small label={t('adaptiveEquip.hub.serviceBtn')} color={c.violetSoft} onPress={() => setServiceAsset(asset)} />
                      </View>
                    </View>
                  </Card>
                );
              })}
            </View>
          )}

          <Btn
            label={t('adaptiveEquip.hub.registerAsset')}
            onPress={() => setRegisterOpen(true)}
          />
        </ScrollView>
      ) : tab === 'service' ? (
        <HubServiceCalendar orgId={orgId} venueId={venueId} />
      ) : (
        <HubAllocations orgId={orgId} venueId={venueId} onReload={reloadAssets} />
      )}

      <Sheet visible={registerOpen} onClose={() => setRegisterOpen(false)}>
        <RegisterAssetForm
          orgId={orgId}
          venueId={venueId}
          onClose={() => setRegisterOpen(false)}
          onDone={() => { setRegisterOpen(false); reloadAssets(); toast(t('adaptiveEquip.hub.registered')); }}
        />
      </Sheet>

      <Sheet visible={!!serviceAsset} onClose={() => setServiceAsset(null)}>
        {serviceAsset ? (
          <AssetServiceSheet
            assetId={serviceAsset.id}
            onClose={() => { setServiceAsset(null); reloadAssets(); }}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

function HubServiceCalendar({ orgId, venueId }) {
  const params = useMemo(() => {
    const p = {};
    if (orgId) p.org_id = orgId;
    if (venueId) p.venue_id = venueId;
    return p;
  }, [orgId, venueId]);
  const [data, err] = useLoad(() => api.get('/adaptive-equipment/assets', { params }), [params]);
  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  if (!data.items?.length) return <Empty message={t('adaptiveEquip.hub.emptyService')} />;
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
      {data.items.map((asset) =>
        (asset.service_records ?? []).map((sr) => (
          <Card key={sr.id} pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <T size={14} weight="700">{asset.name}</T>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Tag label={t(`adaptiveEquip.serviceType.${sr.service_type}`)} color={c.cyanSoft} />
                  <Tag label={sr.pass_fail ?? '—'} color={sr.pass_fail === 'pass' ? c.mint : sr.pass_fail === 'fail' ? c.red : c.sunSoft} />
                </View>
                <T size={12} color={c.mute}>{when(sr.performed_at ?? sr.next_due)}</T>
              </View>
              {sr.next_due ? (
                <T size={11} color={c.mute}>{t('adaptiveEquip.hub.due')} {when(sr.next_due)}</T>
              ) : null}
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

function HubAllocations({ orgId, venueId, onReload }) {
  const { toast } = useSession();
  const params = useMemo(() => {
    const p = {};
    if (orgId) p.org_id = orgId;
    if (venueId) p.venue_id = venueId;
    return p;
  }, [orgId, venueId]);
  const [data, err, reload] = useLoad(() => api.get('/adaptive-equipment/assets', { params }), [params]);

  const cancel = async (allocId) => {
    try {
      await api.post(`/adaptive-equipment/event-allocations/${allocId}/cancel`);
      toast(t('adaptiveEquip.hub.allocationCancelled'));
      reload();
      onReload?.();
    } catch (e) { toast(e.message); }
  };

  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const allocations = (data.items ?? []).flatMap((a) => (a.event_allocations ?? []).map((ea) => ({ ...ea, asset_name: a.name })));
  if (!allocations.length) return <Empty message={t('adaptiveEquip.hub.emptyAllocations')} />;
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
      {allocations.sort((a, b) => new Date(a.start_dt) - new Date(b.start_dt)).map((ea) => (
        <Card key={ea.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <T size={14} weight="700">{ea.asset_name}</T>
              <T size={12} color={c.mute}>{when(ea.start_dt)} – {when(ea.end_dt)}</T>
              {ea.notes ? <T size={12} color={c.mute}>{ea.notes}</T> : null}
            </View>
            <Btn small label={t('common.cancel')} color={c.redSoft} onPress={() => cancel(ea.id)} />
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

function RegisterAssetForm({ orgId, venueId, onClose, onDone }) {
  const [form, setForm] = useState({ type: '', name: '', sport_codes: [], size_family: '', serial_number: '', purchase_value_cents: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [catalogue] = useLoad(() => api.get('/adaptive-equipment/catalogue'));

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const payload = { ...form, org_id: orgId, venue_id: venueId };
      if (form.purchase_value_cents) payload.purchase_value_cents = Math.round(parseFloat(form.purchase_value_cents) * 100);
      await api.post('/adaptive-equipment/assets', payload);
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const typeOptions = (catalogue?.asset_types ?? []).map((tp) => ({ value: tp.key, label: t(`adaptiveEquip.type.${tp.key}`) }));
  const sportOptions = (catalogue?.sports ?? []).map((s) => ({ value: s.code, label: s.name }));

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
      <T size={18} weight="800">{t('adaptiveEquip.hub.registerTitle')}</T>
      <MenuField label={t('adaptiveEquip.field.type')} value={form.type} onChange={set('type')} options={typeOptions} />
      <Field label={t('adaptiveEquip.field.name')} value={form.name} onChange={set('name')} />
      <MultiMenuField label={t('adaptiveEquip.field.sports')} value={form.sport_codes} onChange={set('sport_codes')} options={sportOptions} />
      <Field label={t('adaptiveEquip.field.sizeFamily')} value={form.size_family} onChange={set('size_family')} />
      <Field label={t('adaptiveEquip.field.serialNumber')} value={form.serial_number} onChange={set('serial_number')} />
      <Field label={t('adaptiveEquip.field.purchaseValue')} value={form.purchase_value_cents} onChange={set('purchase_value_cents')} />
      {err ? <T size={13} color={c.red}>{err}</T> : null}
      <Btn label={t('adaptiveEquip.hub.registerSubmit')} onPress={submit} busy={busy} />
    </ScrollView>
  );
}

// ─── 3. AdaptiveLoanFlow ──────────────────────────────────────────────────────

export function AdaptiveLoanFlow({ asset, onClose, onDone }) {
  const { toast } = useSession();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ start_date: '', end_date: '', purpose: 'session', notes: '', deposit_waived: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(false);

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const purposes = ['session', 'event', 'trial', 'personal'];

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/adaptive-equipment/loans', {
        asset_id: asset.id,
        start_date: form.start_date,
        end_date: form.end_date,
        purpose: form.purpose,
        notes: form.notes || undefined,
        deposit_waived: form.deposit_waived,
      });
      setDone(true);
      toast(t('adaptiveEquip.loan.submitted'));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <View style={{ padding: 24, alignItems: 'center', gap: 16 }}>
        <T size={40}>✅</T>
        <T size={18} weight="800" style={{ textAlign: 'center' }}>{t('adaptiveEquip.loan.successTitle')}</T>
        <T size={14} color={c.mute} style={{ textAlign: 'center' }}>{t('adaptiveEquip.loan.successBody')}</T>
        <Btn label={t('common.done')} onPress={onDone} />
      </View>
    );
  }

  return (
    <View style={{ padding: 20, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable onPress={onClose} style={{ minHeight: 44, minWidth: 44, justifyContent: 'center' }} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <T size={22} color={c.mute}>✕</T>
        </Pressable>
        <View style={{ flex: 1 }}>
          <ProgressDots total={4} current={step} />
        </View>
      </View>

      <T size={17} weight="800">
        {[
          t('adaptiveEquip.loan.step1Title'),
          t('adaptiveEquip.loan.step2Title'),
          t('adaptiveEquip.loan.step3Title'),
          t('adaptiveEquip.loan.step4Title'),
        ][step]}
      </T>

      {step === 0 && (
        <View style={{ gap: 12 }}>
          <Card pad={14}>
            <View style={{ gap: 6 }}>
              <T size={16} weight="800">{asset.name}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                <Tag label={t(`adaptiveEquip.type.${asset.type}`)} color={c.violetSoft} />
                {(asset.sport_codes ?? []).map((s) => <Tag key={s} label={s} color={c.cyanSoft} />)}
                {asset.size_family ? <Tag label={asset.size_family} /> : null}
              </View>
            </View>
          </Card>
          <Card pad={12} color={c.sunSoft} style={{ borderLeftWidth: 4, borderLeftColor: c.sun }}>
            <T size={13} color={c.sun} weight="700">{t('adaptiveEquip.loan.compatibilityNotice')}</T>
            <T size={12} color={c.sun}>{t('adaptiveEquip.loan.compatibilityBody')}</T>
          </Card>
          <Btn label={t('adaptiveEquip.loan.confirmContinue')} onPress={() => setStep(1)} />
        </View>
      )}

      {step === 1 && (
        <View style={{ gap: 12 }}>
          <Field label={t('adaptiveEquip.loan.startDate')} value={form.start_date} onChange={set('start_date')} placeholder="YYYY-MM-DD" />
          <Field label={t('adaptiveEquip.loan.endDate')} value={form.end_date} onChange={set('end_date')} placeholder="YYYY-MM-DD" />
          <T size={13} weight="600" color={c.ink}>{t('adaptiveEquip.loan.purposeLabel')}</T>
          <HScroll>
            {purposes.map((p) => (
              <Chip
                key={p}
                label={t(`adaptiveEquip.purpose.${p}`)}
                selected={form.purpose === p}
                onPress={() => set('purpose')(p)}
              />
            ))}
          </HScroll>
          <Field label={t('adaptiveEquip.loan.notes')} value={form.notes} onChange={set('notes')} placeholder={t('adaptiveEquip.loan.notesPlaceholder')} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small label={t('common.back')} color={c.violetSoft} onPress={() => setStep(0)} />
            <View style={{ flex: 1 }}>
              <Btn label={t('common.next')} onPress={() => setStep(2)} />
            </View>
          </View>
        </View>
      )}

      {step === 2 && (
        <View style={{ gap: 12 }}>
          {asset.deposit_cents ? (
            <Card pad={14}>
              <View style={{ gap: 4 }}>
                <T size={13} color={c.mute}>{t('adaptiveEquip.loan.depositRequired')}</T>
                <T size={22} weight="800">{asset.deposit_display ?? '—'}</T>
              </View>
            </Card>
          ) : (
            <Card pad={12} color={c.mintSoft}>
              <T size={13} color={c.mint}>{t('adaptiveEquip.loan.noDeposit')}</T>
            </Card>
          )}
          <T size={12} color={c.mute}>{t('adaptiveEquip.loan.depositNote')}</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small label={t('common.back')} color={c.violetSoft} onPress={() => setStep(1)} />
            <View style={{ flex: 1 }}>
              <Btn label={t('common.next')} onPress={() => setStep(3)} />
            </View>
          </View>
        </View>
      )}

      {step === 3 && (
        <View style={{ gap: 12 }}>
          <Card pad={14}>
            <View style={{ gap: 6 }}>
              <T size={13} color={c.mute}>{t('adaptiveEquip.loan.summaryAsset')}</T>
              <T size={15} weight="700">{asset.name}</T>
              <T size={13} color={c.mute}>{form.start_date} → {form.end_date}</T>
              <Tag label={t(`adaptiveEquip.purpose.${form.purpose}`)} color={c.violetSoft} />
            </View>
          </Card>
          {err ? <T size={13} color={c.red}>{err}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small label={t('common.back')} color={c.violetSoft} onPress={() => setStep(2)} />
            <View style={{ flex: 1 }}>
              <Btn label={t('adaptiveEquip.loan.submitRequest')} onPress={submit} busy={busy} />
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

// ─── 4. FittingAppointmentFlow ────────────────────────────────────────────────

export function FittingAppointmentFlow({ assetId, onClose }) {
  const { toast } = useSession();
  const [step, setStep] = useState(0);
  const [clinician, setClinician] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(false);

  const [clinicians, clinErr] = useLoad(() => api.get('/marketplace/search', { params: { family: 'adaptive_fitting' } }));

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const calDays = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const slots = ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00'];

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const slotDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(selectedDate).padStart(2, '0')}`;
      await api.post('/adaptive-equipment/fittings', {
        asset_id: assetId,
        clinician_id: clinician.id,
        preferred_slot: `${slotDate}T${selectedTime}:00`,
        notes: notes || undefined,
      });
      setDone(true);
      toast(t('adaptiveEquip.fitting.submitted'));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <View style={{ padding: 24, alignItems: 'center', gap: 16 }}>
        <T size={40}>📅</T>
        <T size={18} weight="800" style={{ textAlign: 'center' }}>{t('adaptiveEquip.fitting.successTitle')}</T>
        <Btn label={t('common.done')} onPress={onClose} />
      </View>
    );
  }

  return (
    <View style={{ padding: 20, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable onPress={onClose} style={{ minHeight: 44, minWidth: 44, justifyContent: 'center' }} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <T size={22} color={c.mute}>✕</T>
        </Pressable>
        <View style={{ flex: 1 }}>
          <ProgressDots total={3} current={step} />
        </View>
      </View>

      <T size={17} weight="800">
        {[t('adaptiveEquip.fitting.step1Title'), t('adaptiveEquip.fitting.step2Title'), t('adaptiveEquip.fitting.step3Title')][step]}
      </T>

      {step === 0 && (
        <View style={{ gap: 10 }}>
          {clinErr ? <ErrorBox error={clinErr} /> : !clinicians ? <Loading /> : (
            (clinicians.results ?? []).map((cl) => (
              <Pressable
                key={cl.id}
                onPress={() => { setClinician(cl); setStep(1); }}
                style={{ minHeight: 44 }}
                accessibilityRole="button"
                accessibilityLabel={cl.name}
              >
                <Card pad={12} color={clinician?.id === cl.id ? c.pinkSoft : c.paper}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{
                      width: 42, height: 42, borderRadius: 21,
                      backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center',
                    }}>
                      <T size={18}>{cl.name?.[0] ?? '?'}</T>
                    </View>
                    <View style={{ flex: 1, gap: 3 }}>
                      <T size={14} weight="700">{cl.name}</T>
                      {cl.specialisation ? <T size={12} color={c.mute}>{cl.specialisation}</T> : null}
                    </View>
                    {cl.credential_verified ? <Tag label={t('adaptiveEquip.fitting.verified')} color={c.mintSoft} /> : null}
                  </View>
                </Card>
              </Pressable>
            ))
          )}
        </View>
      )}

      {step === 1 && (
        <View style={{ gap: 12 }}>
          {clinician ? (
            <Card pad={10} color={c.violetSoft}>
              <T size={13} weight="700">{clinician.name}</T>
            </Card>
          ) : null}
          <T size={13} weight="600">{t('adaptiveEquip.fitting.pickDate')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {calDays.map((d) => {
              const past = d < now.getDate();
              return (
                <Pressable
                  key={d}
                  onPress={() => !past && setSelectedDate(d)}
                  disabled={past}
                  style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' }}
                  accessibilityRole="button"
                  accessibilityLabel={String(d)}
                >
                  <View style={{
                    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: selectedDate === d ? c.pink : past ? c.line : c.paper,
                  }}>
                    <T size={13} weight="600" color={selectedDate === d ? '#fff' : past ? c.mute : c.ink}>{d}</T>
                  </View>
                </Pressable>
              );
            })}
          </View>
          {selectedDate ? (
            <>
              <T size={13} weight="600">{t('adaptiveEquip.fitting.pickTime')}</T>
              <HScroll>
                {slots.map((s) => (
                  <Chip
                    key={s}
                    label={s}
                    selected={selectedTime === s}
                    onPress={() => setSelectedTime(s)}
                  />
                ))}
              </HScroll>
            </>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small label={t('common.back')} color={c.violetSoft} onPress={() => setStep(0)} />
            <View style={{ flex: 1 }}>
              <Btn label={t('adaptiveEquip.fitting.confirmSlot')} onPress={() => setStep(2)} />
            </View>
          </View>
        </View>
      )}

      {step === 2 && (
        <View style={{ gap: 12 }}>
          <Card pad={14}>
            <View style={{ gap: 6 }}>
              <T size={13} color={c.mute}>{t('adaptiveEquip.fitting.summaryLabel')}</T>
              {clinician ? <T size={14} weight="700">{clinician.name}</T> : null}
              {selectedDate && selectedTime ? (
                <T size={13} color={c.mute}>
                  {`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(selectedDate).padStart(2, '0')}`} {selectedTime}
                </T>
              ) : null}
            </View>
          </Card>
          <Field label={t('adaptiveEquip.fitting.notes')} value={notes} onChange={setNotes} />
          {err ? <T size={13} color={c.red}>{err}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small label={t('common.back')} color={c.violetSoft} onPress={() => setStep(1)} />
            <View style={{ flex: 1 }}>
              <Btn label={t('adaptiveEquip.fitting.submit')} onPress={submit} busy={busy} />
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

// ─── 5. AssetServiceSheet ─────────────────────────────────────────────────────

export function AssetServiceSheet({ assetId, onClose }) {
  const { toast } = useSession();
  const [tab, setTab] = useState('log');
  const [form, setForm] = useState({ service_type: 'routine', technician: '', performed_at: '', next_due: '', pass_fail: 'pass', findings: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [history, histErr, reloadHist] = useLoad(() => api.get(`/adaptive-equipment/assets/${assetId}/service`));

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const serviceTypes = ['routine', 'safety', 'repair', 'recall', 'pre_event'];
  const passFailOpts = ['pass', 'fail', 'conditional'];

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/adaptive-equipment/assets/${assetId}/service`, form);
      toast(t('adaptiveEquip.service.saved'));
      reloadHist();
      setTab('history');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const tabs = [
    { value: 'log', label: t('adaptiveEquip.service.tabLog') },
    { value: 'history', label: t('adaptiveEquip.service.tabHistory') },
  ];

  return (
    <View style={{ padding: 20, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <T size={18} weight="800" style={{ flex: 1 }}>{t('adaptiveEquip.service.title')}</T>
        <Pressable onPress={onClose} style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <T size={22} color={c.mute}>✕</T>
        </Pressable>
      </View>
      <Seg options={tabs} value={tab} onChange={setTab} />

      {tab === 'log' ? (
        <ScrollView contentContainerStyle={{ gap: 12 }}>
          <MenuField
            label={t('adaptiveEquip.service.type')}
            value={form.service_type}
            onChange={set('service_type')}
            options={serviceTypes.map((k) => ({ value: k, label: t(`adaptiveEquip.serviceType.${k}`) }))}
          />
          <Field label={t('adaptiveEquip.service.technician')} value={form.technician} onChange={set('technician')} />
          <Field label={t('adaptiveEquip.service.performedAt')} value={form.performed_at} onChange={set('performed_at')} placeholder="YYYY-MM-DD" />
          <Field label={t('adaptiveEquip.service.nextDue')} value={form.next_due} onChange={set('next_due')} placeholder="YYYY-MM-DD" />
          <T size={13} weight="600">{t('adaptiveEquip.service.passFail')}</T>
          <HScroll>
            {passFailOpts.map((o) => (
              <Chip
                key={o}
                label={t(`adaptiveEquip.service.${o}`)}
                selected={form.pass_fail === o}
                onPress={() => set('pass_fail')(o)}
              />
            ))}
          </HScroll>
          <Field label={t('adaptiveEquip.service.findings')} value={form.findings} onChange={set('findings')} />
          {err ? <T size={13} color={c.red}>{err}</T> : null}
          <Btn label={t('adaptiveEquip.service.submit')} onPress={submit} busy={busy} />
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ gap: 10 }}>
          {histErr ? <ErrorBox error={histErr} /> : !history ? <Loading /> : !history.records?.length ? (
            <Empty message={t('adaptiveEquip.service.emptyHistory')} />
          ) : history.records.map((sr) => (
            <Card key={sr.id} pad={12}>
              <View style={{ gap: 5 }}>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  <Tag label={t(`adaptiveEquip.serviceType.${sr.service_type}`)} color={c.cyanSoft} />
                  <Tag
                    label={t(`adaptiveEquip.service.${sr.pass_fail ?? 'pass'}`)}
                    color={sr.pass_fail === 'pass' ? c.mintSoft : sr.pass_fail === 'fail' ? c.redSoft : c.sunSoft}
                  />
                </View>
                <T size={13} color={c.mute}>{sr.technician}</T>
                <T size={12} color={c.mute}>{when(sr.performed_at)}</T>
              </View>
            </Card>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ─── 6. MyAdaptiveLoans ───────────────────────────────────────────────────────

export function MyAdaptiveLoans() {
  const { toast, user } = useSession();
  const [tab, setTab] = useState('active');
  const [incidentLoan, setIncidentLoan] = useState(null);
  const [incidentForm, setIncidentForm] = useState({ severity: 'minor', description: '', photos_ok: false });
  const [incidentBusy, setIncidentBusy] = useState(false);

  const [loans, loansErr, reload] = useLoad(() => api.get('/me/adaptive-equipment/loans'));

  const active = useMemo(() => (loans?.items ?? []).filter((l) => ['requested', 'confirmed', 'active'].includes(l.status)), [loans]);
  const past = useMemo(() => (loans?.items ?? []).filter((l) => ['returned', 'cancelled'].includes(l.status)), [loans]);
  const incidents = useMemo(() => (loans?.items ?? []).flatMap((l) => (l.incidents ?? []).map((inc) => ({ ...inc, asset_name: l.asset_name }))), [loans]);

  const returnDueColor = (l) => {
    if (!l.end_date) return c.mute;
    const days = Math.ceil((new Date(l.end_date) - Date.now()) / 86400000);
    if (days < 0) return c.red;
    if (days <= 7) return c.sun;
    return c.mint;
  };

  const submitIncident = async () => {
    setIncidentBusy(true);
    try {
      await api.post(`/adaptive-equipment/loans/${incidentLoan.id}/incident`, incidentForm);
      toast(t('adaptiveEquip.incident.submitted'));
      setIncidentLoan(null);
      reload();
    } catch (e) { toast(e.message); } finally { setIncidentBusy(false); }
  };

  const tabs = [
    { value: 'active', label: t('adaptiveEquip.myLoans.tabActive') },
    { value: 'past', label: t('adaptiveEquip.myLoans.tabPast') },
    { value: 'incidents', label: t('adaptiveEquip.myLoans.tabIncidents') },
  ];

  if (loansErr) return <ErrorBox error={loansErr} />;

  const LoanCard = ({ loan, showReturn = true }) => (
    <Card pad={14}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <T size={15} weight="800">{loan.asset_name}</T>
            <T size={12} color={c.mute}>{t(`adaptiveEquip.type.${loan.asset_type}`)}</T>
          </View>
          <Tag label={t(`adaptiveEquip.status.${loan.status}`)} color={statusColor(loan.status)} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Tag label={`${loan.start_date} → ${loan.end_date}`} color={c.violetSoft} />
          {showReturn && loan.end_date ? (
            <Tag
              label={t('adaptiveEquip.myLoans.returnDue', { date: loan.end_date })}
              color={returnDueColor(loan)}
            />
          ) : null}
          {loan.deposit_paid_at ? <Tag label={t('adaptiveEquip.myLoans.depositPaid')} color={c.mintSoft} /> : null}
          {!showReturn && loan.condition_at_return ? (
            <Tag label={t(`adaptiveEquip.condition.${loan.condition_at_return}`)} color={conditionColor(loan.condition_at_return)} />
          ) : null}
        </View>
        {showReturn && loan.status !== 'returned' ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small label={t('adaptiveEquip.incident.reportBtn')} color={c.sunSoft} onPress={() => setIncidentLoan(loan)} />
          </View>
        ) : null}
      </View>
    </Card>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
        <T size={22} weight="800">{t('adaptiveEquip.myLoans.title')}</T>
        <Seg options={tabs} value={tab} onChange={setTab} />
      </View>

      {!loans ? <Loading /> : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
          {tab === 'active' && (
            active.length === 0 ? <Empty message={t('adaptiveEquip.myLoans.emptyActive')} /> :
              active.map((l) => <LoanCard key={l.id} loan={l} showReturn />)
          )}
          {tab === 'past' && (
            past.length === 0 ? <Empty message={t('adaptiveEquip.myLoans.emptyPast')} /> :
              past.map((l) => <LoanCard key={l.id} loan={l} showReturn={false} />)
          )}
          {tab === 'incidents' && (
            incidents.length === 0 ? <Empty message={t('adaptiveEquip.myLoans.emptyIncidents')} /> :
              incidents.map((inc) => (
                <Card key={inc.id} pad={12}>
                  <View style={{ gap: 5 }}>
                    <T size={14} weight="700">{inc.asset_name}</T>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <Tag
                        label={t(`adaptiveEquip.incident.severity.${inc.severity}`)}
                        color={inc.severity === 'total_loss' || inc.severity === 'major' ? c.redSoft : inc.severity === 'moderate' ? c.sunSoft : c.violetSoft}
                      />
                      <Tag
                        label={t(`adaptiveEquip.incident.decision.${inc.decision ?? 'open'}`)}
                        color={inc.decision ? c.mintSoft : c.sunSoft}
                      />
                    </View>
                    <T size={12} color={c.mute}>{when(inc.created_at)}</T>
                  </View>
                </Card>
              ))
          )}
        </ScrollView>
      )}

      <Sheet visible={!!incidentLoan} onClose={() => setIncidentLoan(null)}>
        {incidentLoan ? (
          <View style={{ padding: 20, gap: 14 }}>
            <T size={18} weight="800">{t('adaptiveEquip.incident.title')}</T>
            <T size={13} color={c.mute}>{incidentLoan.asset_name}</T>
            <T size={13} weight="600">{t('adaptiveEquip.incident.severityLabel')}</T>
            <HScroll>
              {['minor', 'moderate', 'major', 'total_loss'].map((s) => (
                <Chip
                  key={s}
                  label={t(`adaptiveEquip.incident.severity.${s}`)}
                  selected={incidentForm.severity === s}
                  onPress={() => setIncidentForm((f) => ({ ...f, severity: s }))}
                />
              ))}
            </HScroll>
            <Field
              label={t('adaptiveEquip.incident.description')}
              value={incidentForm.description}
              onChange={(v) => setIncidentForm((f) => ({ ...f, description: v }))}
            />
            <Btn label={t('adaptiveEquip.incident.submit')} onPress={submitIncident} busy={incidentBusy} />
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}

// ─── 7. SupplierAssetCatalogue ────────────────────────────────────────────────

export function SupplierAssetCatalogue({ supplierId }) {
  const { toast } = useSession();
  const [tab, setTab] = useState('catalogue');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [serviceOpen, setServiceOpen] = useState(null);

  const [assets, assetsErr, reload] = useLoad(
    () => api.get('/adaptive-equipment/assets', { params: { supplier_id: supplierId } }),
    [supplierId],
  );
  const [orders, ordersErr] = useLoad(
    () => api.get('/supply-orders', { params: { category: 'equipment' } }),
  );
  const [fittings, fittingsErr] = useLoad(
    () => api.get('/adaptive-equipment/fittings', { params: { supplier_id: supplierId } }),
    [supplierId],
  );

  const tabs = [
    { value: 'catalogue', label: t('adaptiveEquip.supplier.tabCatalogue') },
    { value: 'procurement', label: t('adaptiveEquip.supplier.tabProcurement') },
    { value: 'fittings', label: t('adaptiveEquip.supplier.tabFittings') },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
        <T size={22} weight="800">{t('adaptiveEquip.supplier.title')}</T>
        <Seg options={tabs} value={tab} onChange={setTab} />
      </View>

      {tab === 'catalogue' && (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
          {assetsErr ? <ErrorBox error={assetsErr} /> : !assets ? <Loading /> : (
            (assets.items ?? []).length === 0 ? (
              <Empty message={t('adaptiveEquip.supplier.emptyCatalogue')} />
            ) : (
              (assets.items ?? []).map((asset) => (
                <Card key={asset.id} pad={12}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ flex: 1, gap: 4 }}>
                      <T size={14} weight="700">{asset.name}</T>
                      <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap' }}>
                        <Tag label={t(`adaptiveEquip.type.${asset.type}`)} color={c.violetSoft} />
                        <Tag label={t(`adaptiveEquip.status.${asset.status}`)} color={statusColor(asset.status)} />
                      </View>
                    </View>
                    <Btn small label={t('adaptiveEquip.service.tabLog')} onPress={() => setServiceOpen(asset.id)} color={c.violetSoft} />
                  </View>
                </Card>
              ))
            )
          )}
          <Btn label={t('adaptiveEquip.hub.registerAsset')} onPress={() => setRegisterOpen(true)} />
        </ScrollView>
      )}

      {tab === 'procurement' && (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
          {ordersErr ? <ErrorBox error={ordersErr} /> : !orders ? <Loading /> : (
            (orders.items ?? []).length === 0 ? (
              <Empty message={t('adaptiveEquip.supplier.emptyProcurement')} />
            ) : (
              (orders.items ?? []).map((o) => (
                <Card key={o.id} pad={12}>
                  <View style={{ gap: 4 }}>
                    <T size={14} weight="700">{o.item_name}</T>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <Tag label={o.status} color={o.status === 'received' ? c.mintSoft : c.sunSoft} />
                      <Tag label={`×${o.quantity}`} color={c.violetSoft} />
                    </View>
                    <T size={12} color={c.mute}>{when(o.created_at)}</T>
                  </View>
                </Card>
              ))
            )
          )}
        </ScrollView>
      )}

      {tab === 'fittings' && (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
          {fittingsErr ? <ErrorBox error={fittingsErr} /> : !fittings ? <Loading /> : (
            (fittings.items ?? []).length === 0 ? (
              <Empty message={t('adaptiveEquip.supplier.emptyFittings')} />
            ) : (
              (fittings.items ?? []).map((fit) => (
                <Card key={fit.id} pad={12}>
                  <View style={{ gap: 4 }}>
                    <T size={14} weight="700">{fit.athlete_name ?? t('adaptiveEquip.fitting.athlete')}</T>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <Tag label={t(`adaptiveEquip.fitting.statusLabel.${fit.status}`)} color={fit.status === 'completed' ? c.mintSoft : c.sunSoft} />
                    </View>
                    <T size={12} color={c.mute}>{when(fit.slot_start)}</T>
                  </View>
                </Card>
              ))
            )
          )}
        </ScrollView>
      )}

      <Sheet visible={registerOpen} onClose={() => setRegisterOpen(false)}>
        <RegisterAssetForm
          onClose={() => setRegisterOpen(false)}
          onDone={() => { setRegisterOpen(false); reload(); toast(t('adaptiveEquip.hub.registered')); }}
        />
      </Sheet>

      <Sheet visible={!!serviceOpen} onClose={() => setServiceOpen(null)}>
        {serviceOpen ? (
          <AssetServiceSheet assetId={serviceOpen} onClose={() => setServiceOpen(null)} />
        ) : null}
      </Sheet>
    </View>
  );
}

// ─── 8. AdaptiveEventReadiness ────────────────────────────────────────────────

export function AdaptiveEventReadiness({ eventId }) {
  const { toast } = useSession();
  const [allocBusy, setAllocBusy] = useState(null);

  const [data, err, reload] = useLoad(
    () => api.get(`/events/${eventId}/adaptive-equipment`),
    [eventId],
  );

  const allocate = async (assetId) => {
    setAllocBusy(assetId);
    try {
      await api.post(`/adaptive-equipment/assets/${assetId}/event-allocations`, { event_id: eventId });
      toast(t('adaptiveEquip.event.allocated'));
      reload();
    } catch (e) { toast(e.message); } finally { setAllocBusy(null); }
  };

  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading />;

  const items = data.assets ?? [];
  const ready = items.filter((a) => a.readiness === 'ready').length;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <T size={20} weight="800">{t('adaptiveEquip.event.title')}</T>

        {/* progress bar */}
        {items.length > 0 ? (
          <View style={{ gap: 6 }}>
            <View style={{ height: 10, borderRadius: 5, backgroundColor: c.line, overflow: 'hidden' }}>
              <View style={{
                height: 10, borderRadius: 5, backgroundColor: ready === items.length ? c.mint : c.sun,
                width: `${Math.round((ready / items.length) * 100)}%`,
              }} />
            </View>
            <T size={12} color={c.mute}>
              {t('adaptiveEquip.event.readySummary', { ready, total: items.length })}
            </T>
          </View>
        ) : null}

        {items.length === 0 ? (
          <Empty message={t('adaptiveEquip.event.empty')} />
        ) : (
          items.map((asset) => (
            <Card key={asset.id} pad={12}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <T size={14} weight="700">{asset.name}</T>
                  <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap' }}>
                    <Tag label={t(`adaptiveEquip.type.${asset.type}`)} color={c.violetSoft} />
                    <Tag
                      label={t(`adaptiveEquip.readiness.${asset.readiness}`)}
                      color={readinessColor(asset.readiness)}
                    />
                  </View>
                  {asset.next_service_due ? (
                    <T size={11} color={asset.service_overdue ? c.red : c.mute}>
                      {t('adaptiveEquip.hub.nextService')} {when(asset.next_service_due)}
                    </T>
                  ) : null}
                </View>
                {!asset.allocated ? (
                  <Btn
                    small
                    label={t('adaptiveEquip.event.allocateBtn')}
                    onPress={() => allocate(asset.id)}
                    busy={allocBusy === asset.id}
                  />
                ) : (
                  <Tag label={t('adaptiveEquip.event.allocated')} color={c.mintSoft} />
                )}
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </View>
  );
}
