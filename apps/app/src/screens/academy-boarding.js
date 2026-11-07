// Academy Residential & Boarding Operations screen (issue #789).
// Sections: OccupancyGrid, ApplicationsBoard, LeaveCalendar, CurfewDesk,
//           DutyBoard, WelfareLog, IncidentDesk, MealPlanner, BoardingCharges, BoardingSettings.
// Boarding tab only renders when org.boarding_enabled from dashboard.
// No web-only APIs; all layout adapts phone → tablet → desktop.
import React, { useState, useCallback } from 'react';
import { View, ScrollView, TouchableOpacity, RefreshControl, Switch } from 'react-native';
import { useLayout } from '../layout';
import { useLoad } from '../hooks';
import { api } from '../api';
import { t } from '../i18n';
import { theme } from '../theme';
import { Text, Badge, Spinner, Empty, Card, Chip, Row, Spacer, Button, TextInput, Select, DatePicker, TimePicker, Sheet, Banner, Divider } from '../ui';
import { ModuleNav } from './academy-ui';

// ── Helpers ───────────────────────────────────────────────────────────────────
const BED_COLOR = { available: theme.colors.success, occupied: theme.colors.primary, maintenance: theme.colors.warning, reserved: theme.colors.info, decommissioned: theme.colors.muted };
const APP_STATUS_COLOR = { submitted: theme.colors.info, under_review: theme.colors.warning, offered: theme.colors.primary, waitlisted: theme.colors.muted, declined: theme.colors.danger, awaiting_acceptance: theme.colors.warning, allocated: theme.colors.success, withdrawn: theme.colors.muted, vacated: theme.colors.muted };
const LEAVE_STATUS_COLOR = { pending: theme.colors.warning, guardian_approved: theme.colors.info, staff_approved: theme.colors.success, active: theme.colors.success, overdue: theme.colors.danger, returned: theme.colors.muted, denied: theme.colors.danger, cancelled: theme.colors.muted };
const CURFEW_STATUS_COLOR = { checked_in: theme.colors.success, on_leave: theme.colors.info, overdue: theme.colors.danger };
const SEVERITY_COLOR = { low: theme.colors.success, medium: theme.colors.warning, high: theme.colors.danger, critical: theme.colors.danger };
const DIETARY_ICON = { halal: '☪️', kosher: '✡️', vegetarian: '🥗', vegan: '🌱', nut_free: '🥜', gluten_free: '🌾', dairy_free: '🥛', egg_free: '🥚', shellfish_free: '🦐', low_sugar: '🍬', other: '⚠️' };

function StatusDot({ color, size = 10 }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, marginRight: 4 }} />;
}

// ══════════════════════════════════════════════════════════════════════════════
// OCCUPANCY GRID
// ══════════════════════════════════════════════════════════════════════════════
export function OccupancyGrid({ o, toast }) {
  const { tablet } = useLayout();
  const [building, setBuilding] = useState(null);
  const [selectedOccupant, setSelectedOccupant] = useState(null);
  const grid = useLoad(() => api.get(`/organisations/${o.id}/boarding/grid${building ? `?building_id=${building}` : ''}`), [o.id, building]);
  const buildings = grid.data?.buildings ?? [];

  if (grid.loading) return <Spinner />;
  if (!buildings.length) return <Empty emoji="🏢" title={t('brd.grid.empty')} subtitle={t('brd.grid.emptySub')} />;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      {/* Building tabs */}
      <Row wrap>
        <Chip selected={!building} onPress={() => setBuilding(null)} label={t('brd.grid.allBuildings')} />
        {buildings.map((b) => <Chip key={b.id} selected={building === b.id} onPress={() => setBuilding(b.id)} label={b.name} />)}
      </Row>
      {buildings.map((b) => (
        <Card key={b.id} style={{ gap: 12 }}>
          <Row>
            <Text style={{ fontWeight: '700', fontSize: 16 }}>{b.name}</Text>
            <Spacer />
            <Badge label={`${b.occupied_beds}/${b.bed_count} ${t('brd.grid.occupied')}`} color={b.occupied_beds === b.bed_count ? theme.colors.danger : theme.colors.success} />
          </Row>
          {b.rooms.map((r) => (
            <View key={r.id} style={{ gap: 8 }}>
              <Text style={{ fontSize: 13, color: theme.colors.muted }}>
                {t('brd.grid.floor', { n: r.floor })} · {t('brd.grid.room')} {r.number} · {r.room_type}
              </Text>
              <Row wrap style={{ gap: 8 }}>
                {r.beds.map((bed) => (
                  <TouchableOpacity
                    key={bed.id}
                    accessible
                    accessibilityLabel={`${t('brd.grid.bed')} ${bed.position}: ${bed.occupant_name ?? t('brd.grid.vacant')}`}
                    onPress={() => bed.occupant_user_id ? setSelectedOccupant(bed) : null}
                    style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: BED_COLOR[bed.occupancy_id ? 'occupied' : (bed.status ?? 'available')], minWidth: tablet ? 100 : 80, alignItems: 'center' }}
                  >
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{bed.position}</Text>
                    {bed.occupant_name ? <Text style={{ color: '#fff', fontSize: 11 }} numberOfLines={1}>{bed.occupant_name}</Text> : null}
                    {bed.leave_status ? <StatusDot color={LEAVE_STATUS_COLOR[bed.leave_status] ?? theme.colors.muted} /> : null}
                  </TouchableOpacity>
                ))}
              </Row>
            </View>
          ))}
        </Card>
      ))}
      {/* Occupant detail sheet */}
      {selectedOccupant ? (
        <Sheet title={selectedOccupant.occupant_name ?? t('brd.grid.occupant')} onClose={() => setSelectedOccupant(null)}>
          <Row><Text style={{ color: theme.colors.muted }}>{t('brd.grid.since')}</Text><Text>{selectedOccupant.occ_from}</Text></Row>
          {selectedOccupant.leave_status ? <Row><StatusDot color={LEAVE_STATUS_COLOR[selectedOccupant.leave_status]} /><Text>{selectedOccupant.leave_status}</Text></Row> : null}
        </Sheet>
      ) : null}
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// APPLICATIONS BOARD (Kanban)
// ══════════════════════════════════════════════════════════════════════════════
const APP_STAGES = ['submitted','under_review','offered','awaiting_acceptance','allocated','waitlisted','declined','vacated'];

export function ApplicationsBoard({ o, toast }) {
  const { tablet } = useLayout();
  const [openApp, setOpenApp] = useState(null);
  const [decision, setDecision] = useState(null);
  const [reviewNote, setReviewNote] = useState('');
  const apps = useLoad(() => api.get(`/organisations/${o.id}/boarding/applications?limit=200`), [o.id]);
  const all = apps.data?.rows ?? [];

  const decide = useCallback(async (appId, dec) => {
    try {
      await api.patch(`/organisations/${o.id}/boarding/applications/${appId}/review`, { decision: dec, review_note: reviewNote || undefined });
      toast?.(t('brd.apps.reviewSaved'));
      apps.reload();
      setDecision(null); setReviewNote('');
    } catch (e) { toast?.(e.message, 'error'); }
  }, [o.id, reviewNote, apps, toast]);

  if (apps.loading) return <Spinner />;

  if (!tablet) {
    // Phone: list view
    return (
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        {!all.length ? <Empty emoji="📥" title={t('brd.apps.empty')} /> : null}
        {all.map((a) => (
          <TouchableOpacity key={a.id} onPress={() => setOpenApp(a)} accessible accessibilityLabel={`${a.athlete_name} — ${a.status}`}>
            <Card style={{ gap: 4 }}>
              <Row><Text style={{ fontWeight: '600' }}>{a.athlete_name ?? t('brd.apps.restricted')}</Text><Spacer /><Chip label={a.status} color={APP_STATUS_COLOR[a.status]} /></Row>
              <Text style={{ fontSize: 12, color: theme.colors.muted }}>{a.created_at?.slice(0,10)}</Text>
              {a.offer_expires_at ? <Text style={{ fontSize: 12, color: theme.colors.warning }}>{t('brd.apps.expires', { d: a.offer_expires_at.slice(0,10) })}</Text> : null}
            </Card>
          </TouchableOpacity>
        ))}
        {openApp ? (
          <Sheet title={openApp.athlete_name ?? t('brd.apps.application')} onClose={() => setOpenApp(null)}>
            <Row><Text style={{ color: theme.colors.muted }}>{t('brd.apps.status')}</Text><Chip label={openApp.status} color={APP_STATUS_COLOR[openApp.status]} /></Row>
            <Row><Text style={{ color: theme.colors.muted }}>{t('brd.apps.priority')}</Text><Text>{openApp.priority}</Text></Row>
            {openApp.status === 'submitted' || openApp.status === 'under_review' || openApp.status === 'waitlisted' ? (
              <View style={{ gap: 8, marginTop: 12 }}>
                <TextInput label={t('brd.apps.reviewNote')} value={reviewNote} onChangeText={setReviewNote} multiline numberOfLines={3} />
                <Row style={{ gap: 8 }}>
                  <Button label={t('brd.apps.offer')} onPress={() => decide(openApp.id, 'offered')} color="primary" />
                  <Button label={t('brd.apps.waitlist')} onPress={() => decide(openApp.id, 'waitlisted')} color="secondary" />
                  <Button label={t('brd.apps.decline')} onPress={() => decide(openApp.id, 'declined')} color="danger" />
                </Row>
              </View>
            ) : null}
          </Sheet>
        ) : null}
      </ScrollView>
    );
  }

  // Tablet/desktop: Kanban columns
  const stages = APP_STAGES.filter((s) => ['submitted','under_review','offered','awaiting_acceptance','allocated'].includes(s));
  return (
    <ScrollView horizontal contentContainerStyle={{ padding: 16, gap: 12, flexDirection: 'row' }}>
      {stages.map((stage) => {
        const cards = all.filter((a) => a.status === stage);
        return (
          <View key={stage} style={{ width: 220, gap: 8 }}>
            <Row>
              <Text style={{ fontWeight: '700', fontSize: 13 }}>{t(`brd.apps.stage.${stage}`)}</Text>
              <Spacer />
              <Badge label={String(cards.length)} color={APP_STATUS_COLOR[stage]} />
            </Row>
            {cards.map((a) => (
              <TouchableOpacity key={a.id} onPress={() => setOpenApp(a)} accessible accessibilityLabel={`${a.athlete_name}, ${stage}`}>
                <Card style={{ gap: 4 }}>
                  <Text style={{ fontWeight: '600', fontSize: 13 }} numberOfLines={2}>{a.athlete_name ?? t('brd.apps.restricted')}</Text>
                  <Text style={{ fontSize: 11, color: theme.colors.muted }}>{a.created_at?.slice(0,10)}</Text>
                  {a.offer_expires_at ? <Text style={{ fontSize: 11, color: theme.colors.warning }}>⏱ {a.offer_expires_at.slice(0,10)}</Text> : null}
                </Card>
              </TouchableOpacity>
            ))}
          </View>
        );
      })}
      {openApp ? (
        <Sheet title={openApp.athlete_name ?? t('brd.apps.application')} onClose={() => setOpenApp(null)}>
          <Row><Text style={{ color: theme.colors.muted }}>{t('brd.apps.status')}</Text><Chip label={openApp.status} color={APP_STATUS_COLOR[openApp.status]} /></Row>
          {openApp.status === 'submitted' || openApp.status === 'under_review' || openApp.status === 'waitlisted' ? (
            <View style={{ gap: 8, marginTop: 12 }}>
              <TextInput label={t('brd.apps.reviewNote')} value={reviewNote} onChangeText={setReviewNote} multiline numberOfLines={3} />
              <Row style={{ gap: 8 }}>
                <Button label={t('brd.apps.offer')} onPress={() => decide(openApp.id, 'offered')} color="primary" />
                <Button label={t('brd.apps.waitlist')} onPress={() => decide(openApp.id, 'waitlisted')} color="secondary" />
                <Button label={t('brd.apps.decline')} onPress={() => decide(openApp.id, 'declined')} color="danger" />
              </Row>
            </View>
          ) : null}
        </Sheet>
      ) : null}
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CURFEW DESK
// ══════════════════════════════════════════════════════════════════════════════
export function CurfewDesk({ o, toast }) {
  const curfew = useLoad(() => api.get(`/organisations/${o.id}/boarding/curfew-status`), [o.id], { refreshInterval: 60000 });
  const [returning, setReturning] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const markReturned = useCallback(async (leaveId) => {
    if (!leaveId) return;
    try {
      await api.post(`/organisations/${o.id}/boarding/leave/${leaveId}/return`, {});
      toast?.(t('brd.curfew.returned'));
      curfew.reload();
      setReturning(null);
    } catch (e) { toast?.(e.message, 'error'); }
  }, [o.id, curfew, toast]);

  const onRefresh = async () => { setRefreshing(true); await curfew.reload(); setRefreshing(false); };
  const snap = curfew.data;
  if (curfew.loading && !snap) return <Spinner />;

  const summary = snap?.summary ?? {};
  const residents = snap?.residents ?? [];

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      {/* Summary strip */}
      <Row style={{ gap: 12 }}>
        <Card style={{ flex: 1, alignItems: 'center' }}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: theme.colors.success }}>{summary.checked_in ?? 0}</Text>
          <Text style={{ fontSize: 12 }}>{t('brd.curfew.checkedIn')}</Text>
        </Card>
        <Card style={{ flex: 1, alignItems: 'center' }}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: theme.colors.info }}>{summary.on_leave ?? 0}</Text>
          <Text style={{ fontSize: 12 }}>{t('brd.curfew.onLeave')}</Text>
        </Card>
        <Card style={{ flex: 1, alignItems: 'center' }}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: theme.colors.danger }}>{summary.overdue ?? 0}</Text>
          <Text style={{ fontSize: 12 }}>{t('brd.curfew.overdue')}</Text>
        </Card>
      </Row>
      <Text style={{ fontSize: 12, color: theme.colors.muted, textAlign: 'right' }}>
        {t('brd.curfew.asOf', { time: snap?.as_of ? new Date(snap.as_of).toLocaleTimeString() : '—' })}
      </Text>
      {/* Resident rows */}
      {residents.map((r) => (
        <Card key={r.occupancy_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderLeftWidth: 3, borderLeftColor: CURFEW_STATUS_COLOR[r.status] }}>
          <StatusDot color={CURFEW_STATUS_COLOR[r.status]} size={12} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '600' }}>{r.resident_name}</Text>
            <Text style={{ fontSize: 12, color: theme.colors.muted }}>{r.building_name} · {t('brd.grid.room')} {r.room_number}</Text>
            {r.status === 'on_leave' && r.leave_to ? <Text style={{ fontSize: 12, color: theme.colors.info }}>{t('brd.curfew.returnsBy', { d: r.leave_to.slice(0,10) })}</Text> : null}
            {r.curfew_time ? <Text style={{ fontSize: 12, color: theme.colors.muted }}>{t('brd.curfew.curfewAt', { time: r.curfew_time })}</Text> : null}
          </View>
          {r.status === 'overdue' || r.status === 'on_leave' ? (
            <Button label={t('brd.curfew.markReturned')} size="sm" onPress={() => setReturning(r)} color={r.status === 'overdue' ? 'danger' : 'secondary'} />
          ) : null}
        </Card>
      ))}
      {!residents.length ? <Empty emoji="🌙" title={t('brd.curfew.allPresent')} /> : null}
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DUTY BOARD
// ══════════════════════════════════════════════════════════════════════════════
export function DutyBoard({ o, toast }) {
  const today = new Date().toISOString().slice(0,10);
  const duty = useLoad(() => api.get(`/organisations/${o.id}/boarding/duty?duty_date=${today}&limit=50`), [o.id, today]);
  const welfare = useLoad(() => api.get(`/organisations/${o.id}/boarding/welfare-checks?check_date=${today}&limit=100`), [o.id, today]);
  const [logSheet, setLogSheet] = useState(null);
  const [logStatus, setLogStatus] = useState('all_present');
  const [logNote, setLogNote] = useState('');

  const acknowledge = useCallback(async (dutyId) => {
    try {
      await api.post(`/organisations/${o.id}/boarding/duty/${dutyId}/acknowledge`, {});
      toast?.(t('brd.duty.acknowledged'));
      duty.reload();
    } catch (e) { toast?.(e.message, 'error'); }
  }, [o.id, duty, toast]);

  const submitWelfareCheck = useCallback(async () => {
    try {
      await api.post(`/organisations/${o.id}/boarding/welfare-checks`, { duty_assignment_id: logSheet.id, status: logStatus, note: logNote || undefined });
      toast?.(t('brd.duty.welfareLogged'));
      welfare.reload(); setLogSheet(null); setLogNote('');
    } catch (e) { toast?.(e.message, 'error'); }
  }, [o.id, logSheet, logStatus, logNote, welfare, toast]);

  const shifts = duty.data?.rows ?? [];
  const checks = welfare.data ?? [];
  const hasGap = shifts.length === 0;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Text style={{ fontWeight: '700', fontSize: 16 }}>{t('brd.duty.today', { date: today })}</Text>
      {hasGap ? (
        <Banner icon="⚠️" color={theme.colors.danger} message={t('brd.duty.noShifts')} />
      ) : null}
      {shifts.map((s) => (
        <Card key={s.id} style={{ gap: 6, borderLeftWidth: 3, borderLeftColor: s.acknowledged_at ? theme.colors.success : theme.colors.warning }}>
          <Row>
            <Text style={{ fontWeight: '600' }}>{s.staff_name}</Text>
            <Spacer />
            <Chip label={s.role_code} />
          </Row>
          <Text style={{ fontSize: 13 }}>{s.building_name ?? t('brd.duty.allBuildings')} · {s.shift_start}–{s.shift_end}</Text>
          <Row style={{ gap: 8, marginTop: 4 }}>
            {!s.acknowledged_at ? (
              <Button label={t('brd.duty.acknowledge')} size="sm" onPress={() => acknowledge(s.id)} color="primary" />
            ) : (
              <Chip label={`✓ ${t('brd.duty.ackAt', { time: s.acknowledged_at.slice(11,16) })}`} color={theme.colors.success} />
            )}
            <Button label={t('brd.duty.logWelfare')} size="sm" onPress={() => setLogSheet(s)} color="secondary" />
          </Row>
        </Card>
      ))}
      <Divider />
      <Text style={{ fontWeight: '700' }}>{t('brd.duty.welfareLog')}</Text>
      {checks.map((c) => (
        <Row key={c.id} style={{ gap: 8 }}>
          <StatusDot color={c.status === 'concern' || c.status === 'absent' ? theme.colors.danger : theme.colors.success} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13 }}>{c.reporter_name} · {c.checked_at?.slice(11,16)}</Text>
            <Text style={{ fontSize: 12, color: theme.colors.muted }}>{c.resident_name ?? t('brd.duty.building')} — {c.status}</Text>
            {c.note ? <Text style={{ fontSize: 12, fontStyle: 'italic' }}>{c.note}</Text> : null}
          </View>
        </Row>
      ))}
      {!checks.length ? <Text style={{ color: theme.colors.muted, fontSize: 13 }}>{t('brd.duty.noChecks')}</Text> : null}
      {logSheet ? (
        <Sheet title={t('brd.duty.logWelfareFor', { name: logSheet.staff_name })} onClose={() => setLogSheet(null)}>
          <Select label={t('brd.duty.status')} value={logStatus} onChange={setLogStatus} options={['all_present','present','absent','concern','late_return','room_empty'].map((v) => ({ value: v, label: t(`brd.duty.welfareStatus.${v}`) }))} />
          <TextInput label={t('brd.duty.note')} value={logNote} onChangeText={setLogNote} multiline numberOfLines={3} />
          <Button label={t('brd.duty.submitCheck')} onPress={submitWelfareCheck} color="primary" />
        </Sheet>
      ) : null}
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// INCIDENT DESK
// ══════════════════════════════════════════════════════════════════════════════
export function IncidentDesk({ o, toast }) {
  const [create, setCreate] = useState(false);
  const [category, setCategory] = useState('welfare');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('low');
  const [safeguarding, setSafeguarding] = useState(false);
  const incidents = useLoad(() => api.get(`/organisations/${o.id}/boarding/incidents?limit=50`), [o.id]);
  const all = incidents.data?.rows ?? [];

  const submit = useCallback(async () => {
    try {
      await api.post(`/organisations/${o.id}/boarding/incidents`, { category, description, severity, safeguarding_flag: safeguarding });
      toast?.(t('brd.incidents.reported'));
      incidents.reload(); setCreate(false); setDescription(''); setSafeguarding(false);
    } catch (e) { toast?.(e.message, 'error'); }
  }, [o.id, category, description, severity, safeguarding, incidents, toast]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Row>
        <Text style={{ fontWeight: '700', fontSize: 16 }}>{t('brd.incidents.title')}</Text>
        <Spacer />
        <Button label={t('brd.incidents.report')} onPress={() => setCreate(true)} color="primary" size="sm" />
      </Row>
      {!all.length ? <Empty emoji="✅" title={t('brd.incidents.empty')} /> : null}
      {all.map((i) => (
        <Card key={i.id} style={{ gap: 4, borderLeftWidth: 3, borderLeftColor: SEVERITY_COLOR[i.severity] }}>
          {i.restricted ? (
            <Row><Text>🔒</Text><Text style={{ color: theme.colors.muted, fontSize: 13 }}>{t('brd.incidents.restricted')}</Text></Row>
          ) : (
            <>
              <Row>
                <Chip label={i.severity} color={SEVERITY_COLOR[i.severity]} />
                <Chip label={i.category} />
                <Chip label={i.status} />
              </Row>
              <Text style={{ fontSize: 13 }}>{i.description ?? t('brd.incidents.encrypted')}</Text>
              <Text style={{ fontSize: 12, color: theme.colors.muted }}>{i.reporter_name} · {i.created_at?.slice(0,10)}</Text>
              {i.building_name ? <Text style={{ fontSize: 12, color: theme.colors.muted }}>{i.building_name}</Text> : null}
            </>
          )}
        </Card>
      ))}
      {create ? (
        <Sheet title={t('brd.incidents.reportTitle')} onClose={() => setCreate(false)}>
          <Select label={t('brd.incidents.category')} value={category} onChange={setCategory} options={['welfare','maintenance','safety','fire','medical_liaison','other'].map((v) => ({ value: v, label: t(`brd.incidents.cat.${v}`) }))} />
          <Select label={t('brd.incidents.severity')} value={severity} onChange={setSeverity} options={['low','medium','high','critical'].map((v) => ({ value: v, label: t(`brd.incidents.sev.${v}`) }))} />
          <TextInput label={t('brd.incidents.description')} value={description} onChangeText={setDescription} multiline numberOfLines={5} />
          <Row style={{ gap: 8, alignItems: 'center' }}>
            <Switch value={safeguarding} onValueChange={setSafeguarding} accessibilityLabel={t('brd.incidents.safeguardingFlag')} />
            <Text>{t('brd.incidents.safeguardingFlag')}</Text>
          </Row>
          <Button label={t('brd.incidents.submit')} onPress={submit} color={safeguarding ? 'danger' : 'primary'} />
        </Sheet>
      ) : null}
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MEAL PLANNER
// ══════════════════════════════════════════════════════════════════════════════
export function MealPlanner({ o, toast }) {
  const flags = useLoad(() => api.get(`/organisations/${o.id}/boarding/meal-flags`), [o.id]);
  const rows = flags.data ?? [];
  const grouped = rows.reduce((acc, r) => { const k = r.resident_name; if (!acc[k]) acc[k] = { name: r.resident_name, building: r.building_name, room: r.room_number, flags: [] }; acc[k].flags.push(r.flag_key); return acc; }, {});

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Row>
        <Text style={{ fontWeight: '700', fontSize: 16 }}>{t('brd.meals.title')}</Text>
        <Spacer />
        {rows.length ? <Badge label={String(rows.length)} color={theme.colors.warning} /> : null}
      </Row>
      {!Object.keys(grouped).length ? (
        <Empty emoji="🍽️" title={t('brd.meals.empty')} subtitle={t('brd.meals.emptySub')} />
      ) : null}
      {Object.values(grouped).map((r) => (
        <Card key={r.name} style={{ gap: 6 }}>
          <Row>
            <Text style={{ fontWeight: '600' }}>{r.name}</Text>
            <Spacer />
            <Text style={{ fontSize: 12, color: theme.colors.muted }}>{r.building} · {t('brd.grid.room')} {r.room}</Text>
          </Row>
          <Row wrap style={{ gap: 6 }}>
            {r.flags.map((f) => (
              <Chip key={f} label={`${DIETARY_ICON[f] ?? '⚠️'} ${t(`brd.meals.flag.${f}`)}`} color={theme.colors.info} />
            ))}
          </Row>
        </Card>
      ))}
      <Text style={{ fontSize: 12, color: theme.colors.muted, marginTop: 8 }}>{t('brd.meals.flagNote')}</Text>
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// BOARDING CHARGES
// ══════════════════════════════════════════════════════════════════════════════
export function BoardingCharges({ o, toast }) {
  const summary = useLoad(() => api.get(`/organisations/${o.id}/boarding/charge-summary`), [o.id]);
  const charges = useLoad(() => api.get(`/organisations/${o.id}/boarding/charges?limit=50`), [o.id]);
  const rows = charges.data?.rows ?? [];
  const sumRows = summary.data ?? [];

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Text style={{ fontWeight: '700', fontSize: 16 }}>{t('brd.charges.title')}</Text>
      {/* Summary strip */}
      <Row style={{ gap: 10, flexWrap: 'wrap' }}>
        {sumRows.map((s) => (
          <Card key={`${s.currency}-${s.status}`} style={{ flex: 1, alignItems: 'center', minWidth: 100 }}>
            <Text style={{ fontWeight: '700', fontSize: 18 }}>{(s.total_minor / 100).toFixed(2)}</Text>
            <Text style={{ fontSize: 11 }}>{s.currency} · {s.status}</Text>
            <Badge label={String(s.charge_count)} color={s.status === 'overdue' ? theme.colors.danger : theme.colors.muted} />
          </Card>
        ))}
        {!sumRows.length ? <Text style={{ color: theme.colors.muted }}>{t('brd.charges.empty')}</Text> : null}
      </Row>
      {/* Individual charges */}
      {rows.map((c) => (
        <Card key={c.id} style={{ gap: 4 }}>
          <Row>
            <Text style={{ fontWeight: '600' }}>{c.resident_name}</Text>
            <Spacer />
            <Chip label={c.status} color={c.status === 'overdue' ? theme.colors.danger : c.status === 'paid' ? theme.colors.success : theme.colors.muted} />
          </Row>
          <Row>
            <Text style={{ fontSize: 13 }}>{c.charge_type} · {c.period_from} → {c.period_to}</Text>
            <Spacer />
            <Text style={{ fontWeight: '600' }}>{(c.amount_minor / 100).toFixed(2)} {c.currency}</Text>
          </Row>
          {c.description ? <Text style={{ fontSize: 12, color: theme.colors.muted }}>{c.description}</Text> : null}
        </Card>
      ))}
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// BOARDING SETTINGS
// ══════════════════════════════════════════════════════════════════════════════
export function BoardingSettings({ o, toast }) {
  const cfg = useLoad(() => api.get(`/organisations/${o.id}/boarding/config`), [o.id]);
  const buildings = useLoad(() => api.get(`/organisations/${o.id}/boarding/buildings`), [o.id]);
  const [enabled, setEnabled] = useState(null);
  const [saving, setSaving] = useState(false);

  const toggleEnabled = useCallback(async (val) => {
    setEnabled(val);
    setSaving(true);
    try {
      await api.patch(`/organisations/${o.id}/boarding/config`, { boarding_enabled: val });
      toast?.(val ? t('brd.settings.enabled') : t('brd.settings.disabled'));
      cfg.reload();
    } catch (e) { toast?.(e.message, 'error'); setEnabled(!val); } finally { setSaving(false); }
  }, [o.id, cfg, toast]);

  const c = cfg.data;
  const isEnabled = enabled !== null ? enabled : (c?.boarding_enabled ?? false);
  const bldgs = buildings.data ?? [];

  if (cfg.loading) return <Spinner />;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Text style={{ fontWeight: '700', fontSize: 16 }}>{t('brd.settings.title')}</Text>
      {/* Enable toggle */}
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '600' }}>{t('brd.settings.enable')}</Text>
            <Text style={{ fontSize: 13, color: theme.colors.muted }}>{t('brd.settings.enableDesc')}</Text>
          </View>
          <Switch value={isEnabled} onValueChange={toggleEnabled} disabled={saving} accessibilityLabel={t('brd.settings.enable')} />
        </Row>
      </Card>
      {isEnabled ? (
        <>
          {/* Defaults strip */}
          <Card style={{ gap: 8 }}>
            <Text style={{ fontWeight: '600' }}>{t('brd.settings.defaults')}</Text>
            <Row>
              <Text style={{ color: theme.colors.muted, flex: 1 }}>{t('brd.settings.genderPolicy')}</Text>
              <Chip label={c?.gender_policy ?? '—'} />
            </Row>
            <Row>
              <Text style={{ color: theme.colors.muted, flex: 1 }}>{t('brd.settings.weekdayCurfew')}</Text>
              <Text>{c?.default_weekday_curfew ?? '—'}</Text>
            </Row>
            <Row>
              <Text style={{ color: theme.colors.muted, flex: 1 }}>{t('brd.settings.weekendCurfew')}</Text>
              <Text>{c?.default_weekend_curfew ?? '—'}</Text>
            </Row>
            <Row>
              <Text style={{ color: theme.colors.muted, flex: 1 }}>{t('brd.settings.ageRange')}</Text>
              <Text>{c?.age_min ?? 0}–{c?.age_max ?? 25}</Text>
            </Row>
            <Row>
              <Text style={{ color: theme.colors.muted, flex: 1 }}>{t('brd.settings.maxLeaveHours')}</Text>
              <Text>{c?.max_leave_hours ?? 72} h</Text>
            </Row>
          </Card>
          {/* Buildings list */}
          <Text style={{ fontWeight: '700' }}>{t('brd.settings.buildings')}</Text>
          {bldgs.map((b) => (
            <Card key={b.id} style={{ gap: 4 }}>
              <Row>
                <Text style={{ fontWeight: '600' }}>{b.name}</Text>
                <Spacer />
                <Chip label={b.gender_policy} />
                <Chip label={b.status ?? 'active'} color={b.status === 'active' ? theme.colors.success : theme.colors.muted} />
              </Row>
              <Text style={{ fontSize: 12, color: theme.colors.muted }}>{b.room_count} {t('brd.settings.rooms')} · {b.bed_count} {t('brd.settings.beds')} · {b.occupied_beds} {t('brd.settings.occupied')}</Text>
            </Card>
          ))}
          {!bldgs.length ? <Empty emoji="🏢" title={t('brd.settings.noBuildings')} subtitle={t('brd.settings.addBuilding')} /> : null}
        </>
      ) : null}
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD STRIP (used by BoardingDesk header)
// ══════════════════════════════════════════════════════════════════════════════
function DashboardStrip({ o }) {
  const dash = useLoad(() => api.get(`/organisations/${o.id}/boarding/dashboard`), [o.id], { refreshInterval: 300000 });
  const d = dash.data;
  if (!d) return null;
  return (
    <Row style={{ gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
      <Card style={{ alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14 }}>
        <Text style={{ fontWeight: '700', fontSize: 18 }}>{d.occupancy?.fill_pct ?? 0}%</Text>
        <Text style={{ fontSize: 11, color: theme.colors.muted }}>{t('brd.dash.fill')}</Text>
      </Card>
      <Card style={{ alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14 }}>
        <Text style={{ fontWeight: '700', fontSize: 18, color: d.applications_pending > 0 ? theme.colors.warning : theme.colors.muted }}>{d.applications_pending}</Text>
        <Text style={{ fontSize: 11, color: theme.colors.muted }}>{t('brd.dash.pending')}</Text>
      </Card>
      <Card style={{ alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14 }}>
        <Text style={{ fontWeight: '700', fontSize: 18, color: d.curfew_overdue > 0 ? theme.colors.danger : theme.colors.success }}>{d.curfew_overdue}</Text>
        <Text style={{ fontSize: 11, color: theme.colors.muted }}>{t('brd.dash.overdue')}</Text>
      </Card>
      <Card style={{ alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14 }}>
        <Text style={{ fontWeight: '700', fontSize: 18, color: d.duty_today?.has_gap ? theme.colors.danger : theme.colors.success }}>{d.duty_today?.assigned ?? 0}</Text>
        <Text style={{ fontSize: 11, color: theme.colors.muted }}>{t('brd.dash.dutyToday')}</Text>
      </Card>
      {d.open_incidents > 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14 }}>
          <Text style={{ fontWeight: '700', fontSize: 18, color: theme.colors.danger }}>{d.open_incidents}</Text>
          <Text style={{ fontSize: 11, color: theme.colors.muted }}>{t('brd.dash.incidents')}</Text>
        </Card>
      ) : null}
    </Row>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// BOARDING DESK (top-level, used by academy.js tab)
// ══════════════════════════════════════════════════════════════════════════════
const BOARDING_TABS = [
  { key: 'grid', label: () => t('brd.tabs.grid'), icon: '🏢' },
  { key: 'apps', label: () => t('brd.tabs.apps'), icon: '📥' },
  { key: 'curfew', label: () => t('brd.tabs.curfew'), icon: '🌙' },
  { key: 'duty', label: () => t('brd.tabs.duty'), icon: '👮' },
  { key: 'incidents', label: () => t('brd.tabs.incidents'), icon: '⚠️' },
  { key: 'meals', label: () => t('brd.tabs.meals'), icon: '🍽️' },
  { key: 'charges', label: () => t('brd.tabs.charges'), icon: '💷' },
  { key: 'settings', label: () => t('brd.tabs.settings'), icon: '⚙️' },
];

export function BoardingDesk({ o, role, toast }) {
  const { tablet } = useLayout();
  const [tab, setTab] = useState('grid');
  const P = { o, role, toast };
  const items = BOARDING_TABS.map((t_) => ({ ...t_, label: t_.label() }));

  const body = tab === 'grid' ? <OccupancyGrid {...P} />
    : tab === 'apps' ? <ApplicationsBoard {...P} />
    : tab === 'curfew' ? <CurfewDesk {...P} />
    : tab === 'duty' ? <DutyBoard {...P} />
    : tab === 'incidents' ? <IncidentDesk {...P} />
    : tab === 'meals' ? <MealPlanner {...P} />
    : tab === 'charges' ? <BoardingCharges {...P} />
    : <BoardingSettings {...P} />;

  return (
    <View style={{ flex: 1 }}>
      <DashboardStrip o={o} />
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: tablet ? 20 : 0, alignItems: 'flex-start' }}>
        <ModuleNav items={items} value={tab} onChange={setTab} />
        <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', minWidth: 0, marginTop: tablet ? 0 : 12 }}>
          {body}
        </View>
      </View>
    </View>
  );
}
