// Federation & Assignor Organisation Command Center (REF-R12, Issue #1004).
// 7-tab back-office for managing an org's referee workforce pool.
// Tabs: Command · Roster · Workload · Eligibility · Unfilled · Assignors · Comms
import React, { useState, useCallback } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, ErrorBox, Field, Loading, Row, Section, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { explain } from '../access';
import { MenuField } from '../menu-field';
import { t } from '../i18n';

// ── theme helpers ─────────────────────────────────────────────────────────────
const BAND_COLOR = { ok: c.lime, expiring: c.sun, expired: c.red, none: c.mute };
const STATUS_COLOR = { active: c.lime, invited: c.sun, suspended: c.orange, removed: c.mute };
const seg = (selected) => ({ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: selected ? c.pink : c.paper, minHeight: 36 });
const segText = (selected) => ({ color: selected ? '#fff' : c.ink, weight: selected ? '700' : '400' });

// ── small shared components ───────────────────────────────────────────────────
function Chip({ label, color = c.pinkSoft, ink = c.pink }) {
  return (
    <View style={{ backgroundColor: color, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 }}>
      <T size={11} weight="700" style={{ color: ink }}>{label}</T>
    </View>
  );
}

function MetricTile({ label, value, color = c.ink, sub }) {
  return (
    <View style={{ flex: 1, minWidth: 80, backgroundColor: c.paper, borderRadius: 14, padding: 14, gap: 2 }}>
      <T size={24} weight="800" style={{ color }}>{value ?? '—'}</T>
      <T size={12} weight="700" color={c.ink}>{label}</T>
      {sub ? <T size={11} color={c.mute}>{sub}</T> : null}
    </View>
  );
}

function AvatarCircle({ name, url, size = 36 }) {
  if (url) return <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', backgroundColor: c.line }}><T>{' '}</T></View>;
  const initials = (name ?? '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
      <T size={size * 0.38} weight="800" style={{ color: c.pink }}>{initials}</T>
    </View>
  );
}

// ── Tab 1: Command overview ───────────────────────────────────────────────────
function CommandTab({ orgId, setTab, push }) {
  const data = useLoad(() => api.get(`/organisations/${orgId}/officials/command`), [orgId]);
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const d = data.data;
  return (
    <ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <MetricTile label={t('orgOff.metric.active')} value={d.counts.active} color={c.lime} />
        <MetricTile label={t('orgOff.metric.invited')} value={d.counts.invited} color={c.sun} />
        <MetricTile label={t('orgOff.metric.suspended')} value={d.counts.suspended} color={c.orange} />
        <MetricTile label={t('orgOff.metric.assignors')} value={d.counts.assignors} color={c.pink} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <MetricTile label={t('orgOff.metric.elig_warnings')} value={d.counts.elig_warnings} color={d.counts.elig_warnings ? c.red : c.lime} sub={t('orgOff.metric.elig_sub')} />
        <MetricTile label={t('orgOff.metric.unfilled')} value={d.counts.unfilled} color={d.counts.unfilled ? c.orange : c.lime} sub={t('orgOff.metric.unfilled_sub')} />
      </View>
      {d.elig_warnings.length > 0 ? (
        <Section title={t('orgOff.section.elig_alerts')} color={c.red}>
          {d.elig_warnings.map((w) => (
            <Row key={w.roster_id} title={w.display_name}
              sub={`${w.sport_name ?? t('orgOff.all_sports')} · ${t(`orgOff.band.${w.elig_band}`)}`}
              left={<AvatarCircle name={w.display_name} url={w.avatar_url} />}
              right={<Chip label={t(`orgOff.band.${w.elig_band}`)} color={w.elig_band === 'expired' ? '#FEE2E2' : '#FEF3C7'} ink={w.elig_band === 'expired' ? c.red : c.sun} />}
              onPress={() => setTab('eligibility')} />
          ))}
          <Btn title={t('orgOff.action.view_all_elig')} color={c.paper} ink={c.red} onPress={() => setTab('eligibility')} />
        </Section>
      ) : null}
      {d.counts.unfilled > 0 ? (
        <Section title={t('orgOff.section.unfilled_alert')} color={c.orange}>
          <T size={13} color={c.mute}>{t('orgOff.section.unfilled_desc', { count: d.counts.unfilled })}</T>
          <Btn title={t('orgOff.action.view_unfilled')} color={c.paper} ink={c.orange} onPress={() => setTab('unfilled')} />
        </Section>
      ) : null}
      {d.workload_this_week.length > 0 ? (
        <Section title={t('orgOff.section.workload_week')} color={c.pink}>
          {d.workload_this_week.slice(0, 5).map((w) => (
            <Row key={w.user_id} title={w.display_name}
              sub={`${w.assignments} ${t('orgOff.metric.assignments_week')}`}
              left={<AvatarCircle name={w.display_name} url={w.avatar_url} />}
              right={<T size={16} weight="800" style={{ color: w.assignments > 3 ? c.orange : c.lime }}>{w.assignments}</T>}
            />
          ))}
          <Btn title={t('orgOff.action.view_workload')} color={c.paper} ink={c.pink} onPress={() => setTab('workload')} />
        </Section>
      ) : null}
      <ArrivalStatusSection orgId={orgId} push={push} />
    </ScrollView>
  );
}

// ── Arrival status chip for a crew member ────────────────────────────────────
function ArrivalChip({ status }) {
  const map = { checked_in: [c.lime, '#fff', '✓'], late: ['#7a1a1a', '#fff', '⚠'], pending: [c.sun, '#fff', '…'] };
  const [bg, ink, icon] = map[status] ?? [c.mute, '#fff', '?'];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, flexDirection: 'row', gap: 4, alignItems: 'center' }}>
      <T size={11} color={ink}>{icon}</T>
      <T size={11} weight="700" color={ink}>{t(`arrival.status_${status === 'checked_in' ? 'checked' : status === 'late' ? 'late' : 'pending'}`)}</T>
    </View>
  );
}

function ArrivalStatusSection({ orgId, push }) {
  const data = useLoad(() => api.get(`/organisations/${orgId}/officials/today-fixtures`), [orgId]);
  if (!data.data?.fixtures?.length) return null;
  return (
    <Section title={t('arrival.phase_title')} color={c.pink}>
      {data.data.fixtures.slice(0, 5).map((fx) => (
        <View key={fx.fixture_id} style={{ marginBottom: 10 }}>
          <T size={12} weight="700" color={c.mute} style={{ marginBottom: 4 }}>{fx.fixture_label} · {fx.scheduled_at ? new Date(fx.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {fx.crew.map((m) => (
              <Pressable key={m.official_id} onPress={() => push('OfficialsConsole', { id: fx.fixture_id })} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.paper, borderRadius: 10, padding: 8, minHeight: 44 }} accessibilityLabel={`${m.display_name} ${m.status}`}>
                <T size={12}>{m.display_name}</T>
                <T size={11} color={c.mute}>{m.role}</T>
                <ArrivalChip status={m.status} />
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </Section>
  );
}

// ── Tab 2: Roster ─────────────────────────────────────────────────────────────
function RosterTab({ orgId, push }) {
  const [status, setStatus] = useState('active');
  const [sportId, setSportId] = useState('');
  const [search, setSearch] = useState('');
  const [action, setAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const data = useLoad(() => api.get(`/organisations/${orgId}/officials/roster`, { status, ...(sportId ? { sport_id: sportId } : {}), limit: 100 }), [orgId, status, sportId]);
  const { tablet } = useLayout();
  const col = tablet ? { flex: 1, minWidth: 0 } : null;

  const filtered = (data.data ?? []).filter((r) => !search || r.display_name?.toLowerCase().includes(search.toLowerCase()));

  async function doAction(act, row) {
    setBusy(true);
    try {
      if (act === 'suspend') await api.post(`/org-official-roster/${row.roster_id}/suspend`, { reason: 'Suspended by admin' });
      else if (act === 'reinstate') await api.post(`/org-official-roster/${row.roster_id}/reinstate`, {});
      else if (act === 'remove') await api.post(`/org-official-roster/${row.roster_id}/remove`, { reason: 'Removed by admin' });
      data.reload();
      setAction(null);
    } catch (e) { } finally { setBusy(false); }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 12, gap: 8, backgroundColor: c.bg }}>
        <Field label={t('orgOff.roster.search')} value={search} onChangeText={setSearch} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {['all', 'active', 'invited', 'suspended'].map((s) => (
            <Pressable key={s} onPress={() => setStatus(s)} style={seg(status === s)} accessibilityRole="radio" accessibilityState={{ selected: status === s }} accessibilityLabel={t(`orgOff.status.${s}`)}>
              <T size={13} style={segText(status === s)}>{t(`orgOff.status.${s}`)}</T>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      {data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> : !data.data ? <Loading /> : !filtered.length ? (
        <Empty emoji="🏅" title={t('orgOff.roster.empty_title')} sub={t('orgOff.roster.empty_sub')} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
          <View style={{ flexDirection: tablet ? 'row' : 'column', flexWrap: 'wrap', gap: 8 }}>
            {filtered.map((row) => (
              <Pressable key={row.roster_id} style={[col, { backgroundColor: c.paper, borderRadius: 14, padding: 14, gap: 10, minWidth: tablet ? 320 : undefined }]}
                onPress={() => push('Person', { id: row.user_id })}
                onLongPress={() => setAction(row)}
                accessibilityLabel={`${row.display_name}, ${row.status}. Long press for actions.`}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  <AvatarCircle name={row.display_name} url={row.avatar_url} size={44} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T weight="700">{row.display_name}</T>
                    <T size={12} color={c.mute}>{row.sport_name ?? t('orgOff.all_sports')}</T>
                  </View>
                  <Chip label={t(`orgOff.status.${row.status}`)} color={STATUS_COLOR[row.status] + '30'} ink={STATUS_COLOR[row.status]} />
                </View>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {row.elig_band !== 'ok' && row.elig_band !== 'none' ? <Chip label={t(`orgOff.band.${row.elig_band}`)} color={row.elig_band === 'expired' ? '#FEE2E2' : '#FEF3C7'} ink={row.elig_band === 'expired' ? c.red : c.sun} /> : null}
                  {row.licence ? <Chip label={`${row.licence.grade ?? ''} ${row.licence.body_name ?? ''}`.trim()} color={c.pinkSoft} ink={c.pink} /> : null}
                  {row.assignments_this_week != null ? <Chip label={`${row.assignments_this_week} ${t('orgOff.metric.this_week')}`} color={c.bg} ink={c.mute} /> : null}
                </View>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}
      {action ? (
        <Sheet visible onClose={() => setAction(null)} title={action.display_name}>
          <T size={13} color={c.mute}>{`${t(`orgOff.status.${action.status}`)} · ${action.sport_name ?? t('orgOff.all_sports')}`}</T>
          {action.status === 'active' ? <Btn title={t('orgOff.action.suspend')} color={c.orange} onPress={() => doAction('suspend', action)} disabled={busy} /> : null}
          {action.status === 'suspended' ? <Btn title={t('orgOff.action.reinstate')} color={c.lime} onPress={() => doAction('reinstate', action)} disabled={busy} /> : null}
          {action.status !== 'removed' ? <Btn title={t('orgOff.action.remove')} color={c.red} onPress={() => doAction('remove', action)} disabled={busy} /> : null}
          <Btn title={t('orgOff.action.view_profile')} color={c.paper} ink={c.pink} onPress={() => { setAction(null); push('Person', { id: action.user_id }); }} />
        </Sheet>
      ) : null}
    </View>
  );
}

// ── Tab 3: Workload ───────────────────────────────────────────────────────────
function WorkloadTab({ orgId }) {
  const [days, setDays] = useState(14);
  const data = useLoad(() => api.get(`/organisations/${orgId}/officials/workload`, { days }), [orgId, days]);
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const grid = data.data;
  if (!grid.length) return <Empty emoji="📅" title={t('orgOff.workload.empty_title')} sub={t('orgOff.workload.empty_sub')} />;
  const allDays = [...new Set(grid.flatMap((r) => r.days.map((d) => d.day)))].sort();
  const cell = (official, day) => { const d = official.days.find((x) => x.day === day); return d?.cnt ?? 0; };
  const cellColor = (n, max) => { if (!n) return c.bg; if (max && n >= max) return '#FEE2E2'; if (n >= 2) return '#FEF3C7'; return '#DCFCE7'; };
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {[7, 14, 21, 28].map((d) => (
          <Pressable key={d} onPress={() => setDays(d)} style={seg(days === d)} accessibilityRole="radio" accessibilityState={{ selected: days === d }} accessibilityLabel={`${d} ${t('orgOff.workload.days')}`}>
            <T size={13} style={segText(days === d)}>{d} {t('orgOff.workload.days')}</T>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={{ flexDirection: 'row', marginStart: 140 }}>
            {allDays.map((d) => <View key={d} style={{ width: 36 }}><T size={9} color={c.mute} style={{ textAlign: 'center' }}>{d.slice(5, 10)}</T></View>)}
          </View>
          {grid.map((off) => (
            <View key={off.user_id} style={{ flexDirection: 'row', marginVertical: 2, alignItems: 'center' }}>
              <View style={{ width: 140, paddingEnd: 8 }}><T size={12} weight={off.over_cap ? '700' : '400'} style={{ color: off.over_cap ? c.red : c.ink }} numberOfLines={1}>{off.display_name}</T></View>
              {allDays.map((d) => {
                const n = cell(off, d);
                return <View key={d} style={{ width: 36, height: 28, borderRadius: 6, backgroundColor: cellColor(n, off.max_per_day), margin: 1, alignItems: 'center', justifyContent: 'center' }}>{n > 0 ? <T size={11} weight="700" style={{ color: n >= (off.max_per_day ?? 99) ? c.red : c.ink }}>{n}</T> : null}</View>;
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        {[{ color: '#DCFCE7', label: t('orgOff.workload.legend_ok') }, { color: '#FEF3C7', label: t('orgOff.workload.legend_busy') }, { color: '#FEE2E2', label: t('orgOff.workload.legend_cap') }].map(({ color, label }) => (
          <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: color }} />
            <T size={11} color={c.mute}>{label}</T>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ── Tab 4: Eligibility ────────────────────────────────────────────────────────
function EligibilityTab({ orgId }) {
  const data = useLoad(() => api.get(`/organisations/${orgId}/officials/eligibility`), [orgId]);
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const { expired, expiring, no_credential } = data.data;
  if (!expired.length && !expiring.length && !no_credential.length) {
    return <Empty emoji="✅" title={t('orgOff.elig.all_clear')} sub={t('orgOff.elig.all_clear_sub')} />;
  }
  const EligRow = ({ row, band }) => (
    <Row key={row.roster_id} title={row.display_name}
      sub={`${row.sport_name ?? t('orgOff.all_sports')} · ${row.cred?.licence?.expires_on ? `${t('orgOff.elig.expires')} ${row.cred.licence.expires_on}` : t('orgOff.elig.no_licence')}`}
      left={<AvatarCircle name={row.display_name} url={row.avatar_url} />}
      right={<Chip label={t(`orgOff.band.${band}`)} color={band === 'expired' ? '#FEE2E2' : band === 'expiring' ? '#FEF3C7' : c.bg} ink={band === 'expired' ? c.red : band === 'expiring' ? c.sun : c.mute} />}
    />
  );
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      {expired.length > 0 ? (
        <Section title={`${t('orgOff.band.expired')} (${expired.length})`} color={c.red}>
          {expired.map((r) => <EligRow key={r.roster_id} row={r} band="expired" />)}
        </Section>
      ) : null}
      {expiring.length > 0 ? (
        <Section title={`${t('orgOff.band.expiring')} (${expiring.length})`} color={c.sun}>
          {expiring.map((r) => <EligRow key={r.roster_id} row={r} band="expiring" />)}
        </Section>
      ) : null}
      {no_credential.length > 0 ? (
        <Section title={`${t('orgOff.band.none')} (${no_credential.length})`} color={c.mute}>
          {no_credential.map((r) => <EligRow key={r.roster_id} row={r} band="none" />)}
        </Section>
      ) : null}
    </ScrollView>
  );
}

// ── Tab 5: Unfilled Fixtures ───────────────────────────────────────────────────
function UnfilledTab({ orgId, push }) {
  const [daysAhead, setDaysAhead] = useState(21);
  const data = useLoad(() => api.get(`/organisations/${orgId}/officials/unfilled`, { days_ahead: daysAhead }), [orgId, daysAhead]);
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const rows = data.data;
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {[7, 14, 21, 42, 90].map((d) => (
          <Pressable key={d} onPress={() => setDaysAhead(d)} style={seg(daysAhead === d)} accessibilityRole="radio" accessibilityState={{ selected: daysAhead === d }} accessibilityLabel={`Next ${d} days`}>
            <T size={13} style={segText(daysAhead === d)}>{d} {t('orgOff.workload.days')}</T>
          </Pressable>
        ))}
      </ScrollView>
      {!rows.length ? <Empty emoji="✅" title={t('orgOff.unfilled.empty_title')} sub={t('orgOff.unfilled.empty_sub')} /> : (
        rows.map((f) => (
          <View key={f.id} style={{ backgroundColor: c.paper, borderRadius: 14, padding: 14, gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 4 }}>
                <T weight="700" size={15}>{f.home_name ? `${f.home_name} v ${f.away_name}` : f.event_name}</T>
                <T size={12} color={c.mute}>{[f.sport_emoji, f.sport_name, f.venue_name, f.scheduled_at ? new Date(f.scheduled_at).toLocaleDateString() : null].filter(Boolean).join(' · ')}</T>
              </View>
              <Btn small title={t('orgOff.action.assign')} color={c.pink} onPress={() => push('AssignmentBoard', { event_id: f.event_id, fixture_id: f.id })} accessibilityLabel={`${t('orgOff.action.assign')}: ${f.home_name ?? f.event_name}`} />
            </View>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {(f.roles_needed ?? []).map((role) => <Chip key={role} label={`${t('orgOff.role.needed')} ${role}`} color="#FEE2E2" ink={c.red} />)}
              {(f.roles_filled ?? []).map((role) => <Chip key={role} label={role} color="#DCFCE7" ink={c.lime} />)}
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

// ── Tab 6: Assignors ──────────────────────────────────────────────────────────
function AssignorsTab({ orgId }) {
  const data = useLoad(() => api.get(`/organisations/${orgId}/assignors`, { include_revoked: false }), [orgId]);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(false);

  async function revoke(id) {
    setBusy(true);
    try { await api.post(`/org-assignors/${id}/revoke`, {}); data.reload(); setSheet(null); }
    catch (e) { } finally { setBusy(false); }
  }

  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      {!data.data.length ? <Empty emoji="🔑" title={t('orgOff.assignors.empty_title')} sub={t('orgOff.assignors.empty_sub')} /> : (
        data.data.map((g) => (
          <Pressable key={g.id} style={{ backgroundColor: c.paper, borderRadius: 14, padding: 14, gap: 10 }} onPress={() => setSheet(g)} accessibilityLabel={`${g.display_name}, assignor. Tap for options.`}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <AvatarCircle name={g.display_name} url={g.avatar_url} size={40} />
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="700">{g.display_name}</T>
                <T size={12} color={c.mute}>{g.sport_name ?? t('orgOff.all_sports')}{g.jurisdiction ? ` · ${g.jurisdiction}` : ''}</T>
              </View>
              <Chip label={g.status === 'active' ? t('orgOff.assignors.active') : t('orgOff.assignors.revoked')} color={g.status === 'active' ? '#DCFCE7' : c.bg} ink={g.status === 'active' ? c.lime : c.mute} />
            </View>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {g.can_invite ? <Chip label={t('orgOff.assignors.can_invite')} color={c.pinkSoft} ink={c.pink} /> : null}
              {g.can_assign ? <Chip label={t('orgOff.assignors.can_assign')} color={c.pinkSoft} ink={c.pink} /> : null}
              {g.can_release ? <Chip label={t('orgOff.assignors.can_release')} color={c.pinkSoft} ink={c.pink} /> : null}
            </View>
          </Pressable>
        ))
      )}
      {sheet ? (
        <Sheet visible onClose={() => setSheet(null)} title={sheet.display_name}>
          <T size={13} color={c.mute}>{`${t('orgOff.assignors.since')} ${new Date(sheet.created_at).toLocaleDateString()}`}</T>
          <Btn title={t('orgOff.assignors.revoke')} color={c.red} disabled={busy} onPress={() => revoke(sheet.id)} />
        </Sheet>
      ) : null}
    </ScrollView>
  );
}

// ── Tab 7: Comms ──────────────────────────────────────────────────────────────
function CommsTab({ orgId }) {
  const data = useLoad(() => api.get(`/organisations/${orgId}/officials/messages`), [orgId]);
  const [compose, setCompose] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!subject.trim() || !body.trim()) return;
    setBusy(true);
    try {
      await api.post(`/organisations/${orgId}/officials/messages`, { subject: subject.trim(), body: body.trim() });
      data.reload();
      setCompose(false);
      setSubject('');
      setBody('');
    } catch (e) { } finally { setBusy(false); }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 12 }}>
        <Btn title={t('orgOff.comms.compose')} color={c.pink} onPress={() => setCompose(true)} />
      </View>
      {data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> : !data.data ? <Loading /> : !data.data.length ? (
        <Empty emoji="📨" title={t('orgOff.comms.empty_title')} sub={t('orgOff.comms.empty_sub')} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
          {data.data.map((msg) => (
            <View key={msg.id} style={{ backgroundColor: c.paper, borderRadius: 14, padding: 14, gap: 4 }}>
              <T weight="700">{msg.subject}</T>
              <T size={12} color={c.mute}>{[msg.sent_by_name, msg.sport_name ?? t('orgOff.all_sports'), `${msg.recipient_count} ${t('orgOff.comms.recipients')}`, new Date(msg.sent_at).toLocaleDateString()].filter(Boolean).join(' · ')}</T>
            </View>
          ))}
        </ScrollView>
      )}
      <Sheet visible={compose} onClose={() => setCompose(false)} title={t('orgOff.comms.compose')}>
        <Field label={t('orgOff.comms.subject')} value={subject} onChangeText={setSubject} />
        <Field label={t('orgOff.comms.body')} value={body} onChangeText={setBody} multiline />
        <Btn title={busy ? `${t('orgOff.comms.sending')}…` : t('orgOff.comms.send')} color={c.pink} disabled={busy || !subject.trim() || !body.trim()} onPress={send} />
      </Sheet>
    </View>
  );
}

// ── Root screen ───────────────────────────────────────────────────────────────
const TABS = ['command', 'roster', 'workload', 'eligibility', 'unfilled', 'assignors', 'comms'];

export function OrgOfficialsCommand({ route }) {
  const orgId = route?.params?.id;
  const [tab, setTab] = useState('command');
  const { push } = useNav();
  const { tablet } = useLayout();

  if (!orgId) return <Empty emoji="🏢" title="No organisation selected" sub="Return to the organisation and open Officials from the command centre." />;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 52, minHeight: 52, backgroundColor: c.paper, borderBottomWidth: 1, borderBottomColor: c.line }} contentContainerStyle={{ paddingHorizontal: 12, alignItems: 'center', gap: 6 }}>
        {TABS.map((key) => (
          <Pressable key={key} onPress={() => setTab(key)} style={seg(tab === key)} accessibilityRole="tab" accessibilityState={{ selected: tab === key }} accessibilityLabel={t(`orgOff.tab.${key}`)}>
            <T size={13} style={segText(tab === key)}>{t(`orgOff.tab.${key}`)}</T>
          </Pressable>
        ))}
      </ScrollView>
      <View style={{ flex: 1 }}>
        {tab === 'command' && <CommandTab orgId={orgId} setTab={setTab} push={push} />}
        {tab === 'roster' && <RosterTab orgId={orgId} push={push} />}
        {tab === 'workload' && <WorkloadTab orgId={orgId} />}
        {tab === 'eligibility' && <EligibilityTab orgId={orgId} />}
        {tab === 'unfilled' && <UnfilledTab orgId={orgId} push={push} />}
        {tab === 'assignors' && <AssignorsTab orgId={orgId} />}
        {tab === 'comms' && <CommsTab orgId={orgId} />}
      </View>
    </View>
  );
}
