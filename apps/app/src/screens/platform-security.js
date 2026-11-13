// Platform security (#632) — platform admin only. Encryption keys (which key protects how many stored values, rotate to the active key) and the
// tamper-evident audit log (verify the chain, export it). Everything here is the same REST API agents use over MCP; the server refuses anyone who
// is not the platform admin, and the entry point is hidden for every other role. Counts only: no key material and no stored values are ever shown.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { saveText } from '../evidence';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { t } from '../i18n';
import { docLimitRange, setKnownUploadLimits, useUploadLimit } from '../upload-limits';
import { Pressable } from 'react-native';
import { c } from '../theme';

const PAGE = 1000;
const MAX_PAGES = 20;
const label = (s) => String(s ?? '').replace(/_/g, ' ');
const when = (d) => (d ? new Date(d).toLocaleString() : '');
const wrap = { flexDirection: 'row', flexWrap: 'wrap', gap: 8 };
const RUN_TONE = { running: c.sunSoft, done: c.limeSoft, failed: c.redSoft };

function useAct(reload) {
  const { toast } = useSession();
  return async (fn, ok) => { try { const r = await fn(); toast(ok ?? 'Done'); reload?.(); return r; } catch (e) { toast(e.message); return null; } };
}
const Block = ({ state, children }) => (state.loading && !state.data ? <Loading /> : state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : children);

// ------------------------------------------------------------------ keys
function KeysTab() {
  const state = useLoad(() => api.get('/platform/security/keys'));
  const act = useAct(state.reload);
  const L = useLayout();
  const [open, setOpen] = useState(null);
  const running = state.data?.runs?.some((r) => r.status === 'running');
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => state.reload(), 3000);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = state.data;
  return (
    <Block state={state}>
      {d ? (
        <View style={{ flexDirection: L.tablet ? 'row' : 'column', gap: 16, alignItems: 'flex-start' }}>
          <View style={[{ gap: 12, alignSelf: 'stretch' }, L.tablet ? { flex: 1 } : null]}>
            <Section title="Encryption keys" color={c.pink}>
              <View style={wrap}><Tag label={d.provider === 'aws-kms' ? 'AWS KMS' : 'Environment key (development)'} color={c.cyanSoft} /><Tag label={`Writing with ${d.active_key}`} color={c.limeSoft} /></View>
              {d.keys.map((k) => (
                <Row key={k.key_id} title={k.key_id} sub={`${k.values.toLocaleString()} stored value${k.values === 1 ? '' : 's'} protected`}
                  right={<Tag label={k.active ? 'Active' : k.retirable ? 'Can be retired' : 'Still protects values'} color={k.active ? c.limeSoft : k.retirable ? c.cyanSoft : c.sunSoft} />} />
              ))}
              {d.unreadable_values ? <T size={13} color={c.mute}>{d.unreadable_values} value{d.unreadable_values === 1 ? '' : 's'} are not in a known format and are left alone.</T> : null}
              {d.columns_without_primary_key.length ? <T size={13} color={c.mute}>{d.columns_without_primary_key.length} column{d.columns_without_primary_key.length === 1 ? '' : 's'} cannot be re-encrypted automatically (no primary key to page by).</T> : null}
            </Section>
          </View>
          <View style={[{ gap: 12, alignSelf: 'stretch' }, L.tablet ? { flex: 1 } : null]}>
            <Section title="Rotate" color={c.cyan}>
              <T size={13} color={c.mute}>New values are written with {d.active_key}. Re-encrypting rewrites the older values under it. Nothing is deleted; a value that cannot be mapped is left exactly as it is and listed below. An older key can be retired only when it protects no value.</T>
              <Btn title={`Re-encrypt under ${d.active_key}`} disabled={running} loading={false} onPress={() => act(() => api.post('/platform/security/keys/rotations'), 'Rotation started — it continues in the background')} accessibilityLabel={`Re-encrypt stored values under ${d.active_key}`} />
              {running ? <T size={13} color={c.mute}>A run is in progress. This page refreshes itself.</T> : null}
            </Section>
            <Section title="Runs" color={c.violet}>
              {d.runs.length === 0 ? <Empty emoji="🔑" title="No rotation yet" sub="Runs appear here with what was re-encrypted and what needs attention." /> : null}
              {d.runs.map((r) => (
                <Row key={r.id} title={`To ${r.target_key} · ${when(r.started_at)}`}
                  sub={`${r.summary.reencrypted.toLocaleString()} re-encrypted · ${r.summary.unmapped.toLocaleString()} unmapped · ${r.summary.blocked.length} blocked`}
                  right={<Tag label={label(r.status)} color={RUN_TONE[r.status] ?? c.violetSoft} />} onPress={() => setOpen(r)} />
              ))}
            </Section>
          </View>
        </View>
      ) : null}
      <Sheet visible={!!open} onClose={() => setOpen(null)} title={open ? `Run to ${open.target_key}` : ''}>
        {open ? (
          <View style={{ gap: 10 }}>
            <View style={wrap}><Tag label={label(open.status)} color={RUN_TONE[open.status] ?? c.violetSoft} /><Tag label={`${open.summary.columns_done}/${open.summary.columns} columns done`} /></View>
            {open.error ? <T size={13} color={c.red}>{open.error}</T> : null}
            {open.columns.length === 0 ? <T size={13} color={c.mute}>Every column is fully re-encrypted.</T> : open.columns.map((x) => (
              <Row key={x.column} title={x.column} sub={x.blocked ? `Blocked: ${x.blocked}` : `${x.reencrypted} re-encrypted${x.unmapped ? ` · ${x.unmapped} unmapped (left as is)` : ''}`} right={<Tag label={x.blocked ? 'Blocked' : x.done ? 'Done' : 'Open'} color={x.blocked ? c.redSoft : c.sunSoft} />} />
            ))}
          </View>
        ) : null}
      </Sheet>
    </Block>
  );
}

// ------------------------------------------------------------------ audit log
function AuditTab() {
  const state = useLoad(() => api.post('/platform/security/audit-chain/verify'));
  const act = useAct(state.reload);
  const [cursor, setCursor] = useState(0);
  const d = state.data;
  const exportNext = () => act(async () => {
    let since = cursor; const lines = []; let head = null; let more = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const p = await api.get(`/platform/security/audit-log?limit=${PAGE}&since_seq=${since}`);
      head = p.head; lines.push(...p.rows.map((r) => JSON.stringify(r)));
      if (!p.next_since_seq) { more = null; break; }
      since = p.next_since_seq; more = since;
    }
    if (!lines.length) throw new Error('Nothing new to export');
    await saveText(`audit-log-${cursor + 1}-${since || head.seq}.jsonl`, `${JSON.stringify({ head })}\n${lines.join('\n')}\n`, 'application/x-ndjson');
    setCursor(more ?? head.seq);
    return lines.length;
  }, 'Audit log exported');
  return (
    <Block state={state}>
      {d ? (
        <View style={{ gap: 12 }}>
          <Section title="Chain" color={c.pink}>
            <Card color={d.intact ? c.limeSoft : c.redSoft}>
              <T weight="800" size={17}>{d.intact ? 'The audit log is intact' : 'The audit log does not verify'}</T>
              <T size={13} color={c.mute} style={{ marginTop: 4 }}>
                {d.intact ? 'Every sealed row links to the one before it, and the newest row matches the recorded head.'
                  : d.first_break ? `The first row that does not verify is number ${d.first_break}. Keep a copy of the log and investigate before anything else.` : 'The newest sealed row does not match the recorded head: a row was removed from the end.'}
              </T>
            </Card>
            <View style={wrap}>
              <Tag label={`${d.sealed_rows.toLocaleString()} sealed`} color={c.cyanSoft} />
              <Tag label={`${d.pending_rows.toLocaleString()} waiting to be sealed`} color={d.pending_rows ? c.sunSoft : c.violetSoft} />
              <Tag label={`Head #${d.head.seq.toLocaleString()}`} />
            </View>
            {d.head.hash ? <View><T size={12} color={c.mute}>Head hash (keep a copy outside the database)</T><T size={12} selectable style={{ fontFamily: 'monospace' }}>{d.head.hash}</T></View> : null}
            <Btn title="Verify again" color={c.violet} onPress={() => state.reload()} accessibilityLabel="Verify the audit chain again" />
          </Section>
          <Section title="Export" color={c.cyan}>
            <T size={13} color={c.mute}>A file of every audit row after #{cursor.toLocaleString()} with its hash and the previous hash, for an auditor or an offline copy. The log records who did what and when, never the values.</T>
            <Btn title={`Export from #${(cursor + 1).toLocaleString()}`} onPress={exportNext} accessibilityLabel="Export the audit log" />
          </Section>
        </View>
      ) : null}
    </Block>
  );
}

// ------------------------------------------------------------------ uploads
const QUICK = [5, 10, 25, 50];
/** The one document size limit every upload field in the system obeys. The server enforces it; the apps read the same number. */
function UploadsTab() {
  const lim = useUploadLimit();
  const { toast } = useSession();
  const { min, max } = docLimitRange();
  const [mb, setMb] = useState(lim.document_max_mb);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setMb(lim.document_max_mb); }, [lim.document_max_mb]);
  const clamp = (n) => Math.min(max, Math.max(min, n));
  const save = async () => {
    setBusy(true);
    try { const r = await api.patch('/admin/upload-limits', { document_max_mb: mb }); setKnownUploadLimits(r); toast(t('upload.saved', { mb: r.document_max_mb })); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const step = (label, text, delta, off) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: off }} disabled={off} onPress={() => setMb((v) => clamp(v + delta))}
      style={{ width: 48, height: 48, borderRadius: 24, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center', opacity: off ? 0.4 : 1 }}>
      <T size={24} weight="700">{text}</T>
    </Pressable>
  );
  return (
    <Card>
      <T weight="700" size={17}>{t('upload.title')}</T>
      <T size={13} color={c.mute} style={{ marginTop: 6, lineHeight: 19 }}>{t('upload.help')}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20, marginTop: 18 }}>
        {step(t('upload.less'), '−', -1, mb <= min)}
        <View accessibilityRole="adjustable" accessibilityLabel={t('upload.title')} accessibilityValue={{ min, max, now: mb, text: t('upload.mb', { mb }) }} style={{ minWidth: 120, alignItems: 'center' }}>
          <T size={34} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{t('upload.mb', { mb })}</T>
        </View>
        {step(t('upload.more'), '+', 1, mb >= max)}
      </View>
      <T size={12} color={c.mute} style={{ textAlign: 'center', marginTop: 6 }}>{t('upload.range', { min, max })}</T>
      <View style={{ ...wrap, justifyContent: 'center', marginTop: 14 }}>
        {QUICK.map((q) => <Chip key={q} label={t('upload.mb', { mb: q })} active={mb === q} onPress={() => setMb(q)} />)}
      </View>
      <View style={{ marginTop: 18 }}><Btn title={t('upload.save')} onPress={save} loading={busy} disabled={mb === lim.document_max_mb} /></View>
    </Card>
  );
}

// ------------------------------------------------------------------ access events
const SEV_COLOR = { critical: c.red, high: c.orange, medium: c.sun, low: c.lime };
const SEV_SOFT  = { critical: c.redSoft, high: c.orangeSoft, medium: c.sunSoft, low: c.limeSoft };

function AccessEventsTab() {
  const [severity, setSeverity] = useState('');
  const state = useLoad(() => api.get('/security/access-denied-events', { limit: 50, ...(severity ? { severity } : {}) }), [severity]);
  const summary = useLoad(() => api.get('/security/tenant-isolation-summary'));
  const L = useLayout();
  return (
    <Block state={state}>
      {summary.data ? (
        <View style={{ flexDirection: L.tablet ? 'row' : 'column', gap: 10, marginBottom: 16 }}>
          {[
            { label: t('sec.idor_attempts'), value: summary.data.idor_attempts_24h, color: c.red },
            { label: t('sec.events_24h'), value: summary.data.total_access_denied_24h, color: c.orange },
            { label: 'Role boundary blocks', value: summary.data.role_boundary_blocks_24h, color: c.sun },
            { label: 'Revocations (24h)', value: summary.data.revocations_24h, color: c.pink },
          ].map((s) => (
            <View key={s.label} style={{ flex: 1, backgroundColor: c.paper, borderRadius: 14, padding: 14, gap: 4 }}>
              <T weight="800" size={28} color={s.color}>{s.value ?? 0}</T>
              <T size={11} weight="600" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{s.label}</T>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {['', 'critical', 'high', 'medium', 'low'].map((s) => (
          <Chip key={s || 'all'} label={s ? t(`sec.severity_${s}`) : 'All'} active={severity === s} onPress={() => setSeverity(s)} />
        ))}
      </View>
      {!state.data?.events?.length ? (
        <Empty emoji="✅" title="No access denied events" sub="All requests are passing authorisation checks." />
      ) : state.data.events.map((ev) => (
        <Card key={ev.id} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: SEV_COLOR[ev.severity] ?? c.mute, marginTop: 5 }} />
            <View style={{ flex: 1, gap: 3 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <T weight="700" size={13}>{ev.capability ?? ev.path ?? '—'}</T>
                <Tag label={ev.block_reason ?? 'Blocked'} color={SEV_SOFT[ev.severity] ?? c.pinkSoft} />
              </View>
              <T size={12} color={c.mute}>{[ev.actor_id ? `actor: ${ev.actor_id.slice(0, 8)}…` : null, ev.active_role, ev.mcp_call ? 'MCP' : 'REST', label(ev.error_code)].filter(Boolean).join(' · ')}</T>
              <T size={11} color={c.mute}>{when(ev.at)}</T>
            </View>
            <Tag label="Blocked" color={c.limeSoft} />
          </View>
        </Card>
      ))}
    </Block>
  );
}

// ------------------------------------------------------------------ permission matrix
function PermissionMatrixTab() {
  const state = useLoad(() => api.get('/security/permission-matrix'));
  const { toast } = useSession();
  const seed = async () => { try { await api.post('/security/permission-matrix/seed'); toast('Matrix seeded'); state.reload(); } catch (e) { toast(e.message); } };
  const PERM_ICON = { allow: '✓', deny: '✗', conditional: '⚠', na: '—' };
  const PERM_COLOR = { allow: c.lime, deny: c.red, conditional: c.sun, na: c.mute };
  const ROLES = ['athlete','coach','referee','physio','academy_admin','org_owner','sponsor_rep','platform_admin','guardian'];
  if (!state.data) return state.loading ? <Loading /> : <ErrorBox error={state.error} onRetry={state.reload} />;
  // Group by domain
  const byDomain = {};
  for (const e of state.data) {
    if (!byDomain[e.domain]) byDomain[e.domain] = { data_owner: e.data_owner, roles: {} };
    byDomain[e.domain].roles[e.role_key] = e;
  }
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <T size={12} color={c.mute} style={{ flex: 1 }}>✓ allow · ✗ deny · ⚠ conditional · — n/a. Negative cases run in CI.</T>
        <Btn small title="Re-seed" onPress={seed} />
      </View>
      {Object.entries(byDomain).map(([domain, { data_owner, roles }]) => (
        <Card key={domain} style={{ gap: 8 }}>
          <T weight="700" size={13}>{label(domain)}</T>
          <T size={11} color={c.mute}>{data_owner}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {ROLES.map((rk) => {
              const e = roles[rk];
              if (!e) return null;
              return (
                <View key={rk} style={{ backgroundColor: c.bg, borderRadius: 8, padding: 6, alignItems: 'center', minWidth: 64 }}>
                  <T size={16} color={PERM_COLOR[e.permission] ?? c.mute}>{PERM_ICON[e.permission] ?? '?'}</T>
                  <T size={10} color={c.mute} style={{ textAlign: 'center' }}>{label(rk)}</T>
                </View>
              );
            })}
          </View>
        </Card>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------ revocations
function RevocationsTab() {
  const state = useLoad(() => api.get('/security/revocation-log', { limit: 30 }));
  if (!state.data) return state.loading ? <Loading /> : <ErrorBox error={state.error} onRetry={state.reload} />;
  return !state.data.length
    ? <Empty emoji="✅" title="No revocations recorded" sub="Membership removals and grant expirations will appear here." />
    : state.data.map((r) => (
      <Card key={r.id} style={{ marginBottom: 8 }}>
        <Row
          title={r.user_display_name ?? r.user_id?.slice(0, 12) ?? '—'}
          sub={[r.org_name ?? r.org_id?.slice(0, 12) ?? 'No org', label(r.reason), when(r.at)].join(' · ')}
          right={<Tag label={`${r.notifications_cancelled} notifs cleared`} color={c.pinkSoft} />}
        />
      </Card>
    ));
}

export function PlatformSecurity() {
  const { user } = useSession();
  const [tab, setTab] = useState('keys');
  if (!user?.roles?.includes('platform_admin')) return <Screen><Empty emoji="🔒" title="Not available" sub="This area is for the platform admin." /></Screen>;
  return (
    <Screen wide>
      <H1>{t('sec.console.title')}</H1>
      <T color={c.mute} style={{ marginBottom: 12 }}>Encryption keys, audit log, access-denied telemetry, permission matrix and membership revocations.</T>
      <Seg
        options={[
          { value: 'keys', label: 'Keys' },
          { value: 'audit', label: 'Audit log' },
          { value: 'access', label: t('sec.access_denied') },
          { value: 'matrix', label: t('sec.permission_matrix') },
          { value: 'revocations', label: t('sec.revocations') },
          { value: 'uploads', label: t('upload.tab') },
        ]}
        value={tab}
        onChange={setTab}
      />
      <View style={{ height: 12 }} />
      {tab === 'keys' ? <KeysTab />
        : tab === 'audit' ? <AuditTab />
        : tab === 'access' ? <AccessEventsTab />
        : tab === 'matrix' ? <PermissionMatrixTab />
        : tab === 'revocations' ? <RevocationsTab />
        : <UploadsTab />}
    </Screen>
  );
}
