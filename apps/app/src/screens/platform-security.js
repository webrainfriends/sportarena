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
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
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

export function PlatformSecurity() {
  const { user } = useSession();
  const [tab, setTab] = useState('keys');
  if (!user?.roles?.includes('platform_admin')) return <Screen><Empty emoji="🔒" title="Not available" sub="This area is for the platform admin." /></Screen>;
  return (
    <Screen wide>
      <H1>Keys & audit</H1>
      <T color={c.mute} style={{ marginBottom: 12 }}>Encryption keys and the tamper-evident audit log.</T>
      <Seg options={[{ value: 'keys', label: 'Keys' }, { value: 'audit', label: 'Audit log' }]} value={tab} onChange={setTab} />
      <View style={{ height: 12 }} />
      {tab === 'keys' ? <KeysTab /> : <AuditTab />}
    </Screen>
  );
}
