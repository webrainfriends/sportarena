// Import people and teams (#514): bring a roster across from TeamSnap, SportsEngine or a spreadsheet, safely. One path for every source:
// source -> file -> columns -> check (dry run) -> import -> report. Nothing is created until the person has seen the check and approved it,
// people are invited (never added), and an import that went wrong can be rolled back. The API decides every rule; this screen only shows the
// answers: mapping and review work side by side on tablet and desktop, one column on a phone.
import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, Seg, T, Tag } from '../ui';
import { HScroll, Stepper } from '../pickers';
import { MenuField } from '../menu-field';
import { SportSelect } from '../sportpicker';
import { saveText } from '../evidence';
import { explain } from '../access';
import { c, when } from '../theme';

const STEPS = ['Source', 'File', 'Columns', 'Check', 'Import', 'Report'];
const SOURCE_ICON = { teamsnap: '🟧', sportsengine: '🟦', excel: '📊' };
const stepOf = (p) => (!p ? 0 : p.status === 'mapping' ? 2 : p.status === 'dry_run' ? 3 : p.status === 'approved' ? 4 : 5);
const OUTCOME = { valid: ['Ready', c.limeSoft], warning: ['Ready, check', c.sunSoft], rejected: ['Needs fixing', c.pinkSoft], duplicate: ['Duplicate', c.violetSoft], conflict: ['Who is this?', c.orangeSoft], skipped: ['Skipped', c.violetSoft], pending: ['Not checked', c.violetSoft] };
const ROLE_OPTIONS = [['player', 'Player'], ['captain', 'Captain'], ['coach', 'Coach'], ['manager', 'Manager'], ['physio', 'Physio']];
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const MAX_FILE = 10 * 2 ** 20;

/** Pick a spreadsheet on this device: the browser's file dialog on web, the Files picker in the app. */
async function chooseFile() {
  if (Platform.OS === 'web') {
    return new Promise((resolve) => {
      const el = document.createElement('input');
      el.type = 'file'; el.accept = '.csv,.tsv,.txt,.xlsx,.docx';
      el.onchange = () => resolve(el.files?.[0] ? { blob: el.files[0], name: el.files[0].name } : null);
      el.click();
    });
  }
  const DocumentPicker = await import('expo-document-picker');
  const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: ['text/csv', 'text/comma-separated-values', 'text/plain', 'text/tab-separated-values', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  return { blob: await (await fetch(a.uri)).blob(), name: a.name };
}

function Tile({ label, value, color = c.paper, on, onPress }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} accessibilityState={{ selected: !!on }}
      style={{ flexGrow: 1, flexBasis: 96, minHeight: 64, backgroundColor: color, borderRadius: 14, borderWidth: on ? 2 : 1, borderColor: on ? c.violet : c.line, padding: 10, justifyContent: 'center' }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{value}</T>
      <T size={12} weight="700" color={c.mute} numberOfLines={1}>{label}</T>
    </Pressable>
  );
}

export function Migrate({ organisation_id, id: resume }) {
  const { toast } = useSession();
  const { tablet } = useLayout();
  const [orgId, setOrgId] = useState(organisation_id ?? null);
  const [project, setProject] = useState(null);
  const [source, setSource] = useState(null);
  const [file, setFile] = useState(null);
  const [opts, setOpts] = useState({ date_format: 'DD/MM/YYYY', default_role: 'player', sport: null });
  const [draft, setDraft] = useState({});
  const [filter, setFilter] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const info = useLoad(() => api.get('/migrations/sources'), []);
  const orgs = useLoad(() => api.get('/organisations'), []);
  const admin = (orgs.data ?? []).filter((o) => ['owner', 'admin'].includes(o.my_role) && o.my_status === 'active');
  const past = useLoad(() => (orgId ? api.get(`/organisations/${orgId}/migrations`) : Promise.resolve([])), [orgId, project?.status]);
  const rows = useLoad(() => (project && ['dry_run', 'reconciliation', 'completed', 'approved'].includes(project.status) ? api.get(`/migrations/${project.id}/rows`, { status: filter ?? undefined, limit: 100 }) : Promise.resolve([])), [project?.id, project?.status, filter, project?.summary?.total]);
  const report = useLoad(() => (project && stepOf(project) >= 4 ? api.get(`/migrations/${project.id}/report`) : Promise.resolve(null)), [project?.id, project?.status]);
  const teamAssets = useLoad(() => (orgId ? api.get(`/organisations/${orgId}/assets`, { kind: 'team', limit: 100 }).catch(() => []) : Promise.resolve([])), [orgId]);

  useEffect(() => { if (!orgId && admin.length === 1) setOrgId(admin[0].id); }, [admin.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (resume) api.get(`/migrations/${resume}`).then((p) => { setOrgId(p.organisation_id); setProject(p); }).catch((e) => setErr(explain(e))); }, [resume]);
  useEffect(() => { if (project) setDraft(project.mapping ?? {}); }, [project?.id, project?.mapping_version]); // eslint-disable-line react-hooks/exhaustive-deps

  const sources = info.data?.sources ?? [];
  const fields = info.data?.domains?.[0]?.fields ?? [];
  const run = async (key, fn) => { setErr(null); setBusy(key); try { await fn(); } catch (e) { setErr(explain(e)); } finally { setBusy(null); } };
  const step = stepOf(project);
  const shown = project ? step : file ? 1 : 0;

  const template = () => run('tpl', async () => { const t = await api.get('/migrations/template', { source }); await saveText(t.filename, t.csv); });
  const pick = () => run('pick', async () => {
    const f = await chooseFile();
    if (!f) return;
    if (f.blob.size > MAX_FILE) throw new Error('That file is over 10 MB. Split it by team or season.');
    const r = await api.upload('/migrations/extract', f.blob);
    setFile({ name: f.name, csv: r.csv, rows: r.rows, kind: r.kind });
  });
  const create = () => run('create', async () => {
    const p = await api.post(`/organisations/${orgId}/migrations`, { source, csv: file.csv, file_name: file.name, sport: opts.sport ?? undefined, options: { date_format: opts.date_format, default_role: opts.default_role, ...(opts.default_team_id ? { default_team_id: opts.default_team_id } : {}) } });
    setProject(p);
  });
  const check = () => run('check', async () => {
    const diff = Object.fromEntries(fields.map((f) => [f.key, draft[f.key] ?? null]).filter(([k, v]) => (project.mapping[k] ?? null) !== v));
    if (Object.keys(diff).length || project.options.date_format !== opts.date_format || project.options.default_role !== opts.default_role || (opts.sport && !project.sport_id) || opts.default_team_id !== project.options.default_team_id) {
      await api.patch(`/migrations/${project.id}`, { mapping: diff, options: { date_format: opts.date_format, default_role: opts.default_role, ...(opts.default_team_id ? { default_team_id: opts.default_team_id } : {}) }, ...(opts.sport ? { sport: opts.sport } : {}) });
    }
    setFilter(null);
    setProject(await api.post(`/migrations/${project.id}/check`));
  });
  const review = (row, decision) => run(`r${row.id}`, async () => { await api.post(`/migrations/${project.id}/rows/${row.id}/review`, { decision }); setProject(await api.post(`/migrations/${project.id}/check`)); });
  const approve = () => run('approve', async () => setProject(await api.post(`/migrations/${project.id}/approve`)));
  const doRun = () => run('run', async () => { const r = await api.post(`/migrations/${project.id}/run`); setProject(r.project); toast('Import finished'); });
  const rollback = () => run('rollback', async () => { const r = await api.post(`/migrations/${project.id}/rollback`); setProject(await api.get(`/migrations/${project.id}`)); toast(`Withdrew ${r.withdrawn} invitation${r.withdrawn === 1 ? '' : 's'}${r.kept_because_accepted ? ` · kept ${r.kept_because_accepted} already accepted` : ''}`); });
  const problems = () => run('csv', async () => {
    const all = await api.get(`/migrations/${project.id}/report`);
    const lines = [['row', 'outcome', 'name', 'email', 'problem'], ...all.unresolved.map((u) => [u.row, u.outcome, u.name ?? '', u.email ?? '', u.reasons.join(' | ')])];
    await saveText('gotmygame-import-problems.csv', lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n');
  });
  const restart = () => { setProject(null); setFile(null); setSource(null); setFilter(null); };

  const sum = project?.summary;
  const head = (
    <>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>MIGRATION</T>
      <H1 style={{ fontSize: 28 }}>Bring your people across</H1>
      <T size={14} color={c.mute} style={{ marginTop: 4 }}>Import a roster from TeamSnap, SportsEngine or a spreadsheet. You see every row before anything is saved, people are invited rather than added, and you can roll it back.</T>
      <Stepper steps={STEPS} current={shown} onJump={(i) => { if (!project && i === 0) setFile(null); }} />
      {err ? <View accessibilityRole="alert" accessibilityLiveRegion="polite"><T color={c.red} weight="700" style={{ marginBottom: 8 }}>{err}</T></View> : null}
    </>
  );
  if (info.loading && !info.data) return <Screen wide>{head}<Loading /></Screen>;
  if (info.error) return <Screen wide>{head}<ErrorBox error={info.error} onRetry={info.reload} /></Screen>;

  // ------------------------------------------------------------------ 1 source (and which organisation)
  if (!project && !file) {
    return (
      <Screen wide>
        {head}
        {orgs.data && !admin.length ? <Empty emoji="🏢" title="You need an organisation first" sub="Imports go into a club, academy or school workspace you own or administer. Create one under My organisations, then come back." /> : (
          <>
            {admin.length > 1 ? <Card style={{ marginBottom: 12 }}><MenuField label="Into which organisation" value={orgId} onChange={setOrgId} options={admin.map((o) => ({ value: o.id, label: o.name, sub: o.kind }))} placeholder="Choose an organisation" /></Card> : admin[0] ? <T size={13} weight="700" color={c.mute} style={{ marginBottom: 8 }}>Into {admin[0].name}</T> : null}
            <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, flexWrap: 'wrap' }}>
              {sources.map((s) => (
                <Card key={s.key} onPress={() => setSource(s.key)} accessibilityLabel={`${s.label}. ${s.hint}`} color={source === s.key ? c.violetSoft : c.paper} style={{ flex: tablet ? 1 : undefined, flexBasis: tablet ? 220 : undefined, borderWidth: source === s.key ? 2 : 0, borderColor: c.violet }}>
                  <T size={28}>{SOURCE_ICON[s.key]}</T>
                  <T weight="800" size={16} style={{ marginTop: 6 }}>{s.label}</T>
                  <T size={12.5} color={c.mute} style={{ marginTop: 4, lineHeight: 18 }}>{s.hint}</T>
                </Card>
              ))}
            </View>
            {source ? (
              <Card style={{ marginTop: 12 }}>
                <T weight="800" size={13}>Your file</T>
                <T size={12.5} color={c.mute} style={{ marginTop: 4, lineHeight: 18 }}>Excel (.xlsx), CSV or tab-separated, first row = column names, up to {info.data.max_rows} rows. Up to 10 MB.</T>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <Btn title="Choose file" onPress={pick} loading={busy === 'pick'} disabled={!orgId} accessibilityLabel="Choose a spreadsheet file from this device" />
                  <Btn title="Download template" color={c.paper} ink={c.ink} onPress={template} loading={busy === 'tpl'} />
                </View>
                {!orgId ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>Choose the organisation first.</T> : null}
              </Card>
            ) : null}
            <T size={11.5} color={c.mute} style={{ marginTop: 12, lineHeight: 17 }}>Not imported by design: clinical records, credentials, payments, contracts, and guardian links or consents. A young person must come with a guardian email, and still needs their guardian's consent in the app.</T>
            {past.data?.length ? (
              <View style={{ marginTop: 16, gap: 8 }}>
                <T weight="800" size={13}>Earlier imports</T>
                {past.data.map((p) => (
                  <Card key={p.id} onPress={() => api.get(`/migrations/${p.id}`).then(setProject).catch((e) => setErr(explain(e)))} pad={12} accessibilityLabel={`${p.file_name ?? 'Import'}, ${p.status}. Open`}>
                    <T weight="700">{p.file_name ?? 'Import'} · {sources.find((s) => s.key === p.source)?.label ?? p.source}</T>
                    <T size={12} color={c.mute}>{p.source_rows} rows · {p.status.replace(/_/g, ' ')} · {when(p.created_at)}</T>
                  </Card>
                ))}
              </View>
            ) : null}
          </>
        )}
      </Screen>
    );
  }

  // ------------------------------------------------------------------ 2 file options
  if (!project) {
    return (
      <Screen wide>
        {head}
        <Card>
          <T weight="800">{file.name}</T>
          <T size={13} color={c.mute} style={{ marginTop: 2 }}>{file.rows} row{file.rows === 1 ? '' : 's'} found · {sources.find((s) => s.key === source)?.label}</T>
          <View style={{ marginTop: 14, gap: 14 }}>
            <MenuField label="How are dates written in this file?" value={opts.date_format} onChange={(v) => setOpts({ ...opts, date_format: v })} options={info.data.date_formats} hint="Never guessed: 04/05/2012 means different days in different countries." />
            <View style={{ gap: 6 }}>
              <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>ROLE WHEN THE FILE DOES NOT SAY</T>
              <HScroll>{ROLE_OPTIONS.map(([v, l]) => <Chip key={v} label={l} active={opts.default_role === v} onPress={() => setOpts({ ...opts, default_role: v })} />)}</HScroll>
            </View>
            <SportSelect label="Sport for new teams" optional value={opts.sport} onChange={(v) => setOpts({ ...opts, sport: v })} />
            <T size={12} color={c.mute} style={{ marginTop: -8 }}>Needed only when the file names teams that do not exist yet.</T>
            {(teamAssets.data ?? []).length ? <MenuField label="Put people with no team on" value={opts.default_team_id ?? ''} onChange={(v) => setOpts({ ...opts, default_team_id: v || undefined })} options={[{ value: '', label: 'No team' }, ...(teamAssets.data ?? []).map((t) => ({ value: t.id, label: t.name }))]} /> : null}
          </View>
        </Card>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <Btn title="Choose another file" color={c.paper} ink={c.ink} onPress={() => setFile(null)} style={{ flex: 1 }} />
          <Btn title="Next: match columns" onPress={create} loading={busy === 'create'} style={{ flex: 1 }} />
        </View>
      </Screen>
    );
  }

  // ------------------------------------------------------------------ 3 columns
  if (step === 2) {
    const a = project.analysis;
    const headers = a.headers ?? [];
    const options = [{ value: '', label: 'Not in my file' }, ...headers.map((h) => ({ value: h, label: h }))];
    const missing = ['email'].filter((k) => !draft[k]).concat(!draft.first_name && !draft.full_name ? ['first_name'] : []);
    return (
      <Screen wide>
        {head}
        <T weight="800" size={16}>Match your columns</T>
        <T size={13} color={c.mute} style={{ marginTop: 4, lineHeight: 19 }}>We matched the columns by the names {sources.find((s) => s.key === project.source)?.label ?? 'this source'} usually uses. Check each one and change any that are wrong. People are matched on email only, never on a name.</T>
        {a.ambiguous?.length ? <Card color={c.sunSoft} style={{ marginTop: 10 }}><T weight="700" size={13}>More than one column could fit: {a.ambiguous.map((x) => `${fields.find((f) => f.key === x.field)?.label} (${x.candidates.join(', ')})`).join('; ')}. Check these.</T></Card> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
          {fields.map((f) => (
            <View key={f.key} style={{ width: tablet ? '48.5%' : '100%' }}>
              <MenuField label={`${f.label}${f.required ? ' *' : ''}`} value={draft[f.key] ?? ''} onChange={(v) => setDraft({ ...draft, [f.key]: v || null })} options={options} hint={f.hint} placeholder="Not in my file" />
            </View>
          ))}
        </View>
        {a.unmapped_columns?.length ? <T size={12} color={c.mute} style={{ marginTop: 12 }}>Not used: {a.unmapped_columns.join(', ')}</T> : null}
        <Card style={{ marginTop: 12 }}>
          <View style={{ gap: 12 }}>
            <MenuField label="Date format" value={opts.date_format} onChange={(v) => setOpts({ ...opts, date_format: v })} options={info.data.date_formats} />
            <SportSelect label="Sport for new teams" optional value={opts.sport} onChange={(v) => setOpts({ ...opts, sport: v })} />
          </View>
        </Card>
        {missing.length ? <T size={12.5} color={c.red} weight="700" style={{ marginTop: 10 }}>Still to match: {missing.map((k) => (k === 'email' ? 'Email' : 'a name column')).join(' and ')}.</T> : null}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <Btn title="Start again" color={c.paper} ink={c.ink} onPress={restart} style={{ flex: 1 }} />
          <Btn title="Check my file" onPress={check} loading={busy === 'check'} disabled={!!missing.length} style={{ flex: 1 }} />
        </View>
      </Screen>
    );
  }

  // ------------------------------------------------------------------ 4 check (dry run)
  if (step === 3) {
    const conflicts = sum?.conflict ?? 0;
    return (
      <Screen wide>
        {head}
        <T weight="800" size={16}>Here is what will happen</T>
        <T size={13} color={c.mute} style={{ marginTop: 4 }}>Nothing is saved yet. This is the same check the import uses.</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <Tile label="Ready" value={sum.importable} color={c.limeSoft} on={filter === 'valid'} onPress={() => setFilter(filter === 'valid' ? null : 'valid')} />
          <Tile label="Needs fixing" value={sum.rejected} color={sum.rejected ? c.pinkSoft : c.paper} on={filter === 'rejected'} onPress={() => setFilter(filter === 'rejected' ? null : 'rejected')} />
          <Tile label="Who is this?" value={sum.conflict} color={sum.conflict ? c.orangeSoft : c.paper} on={filter === 'conflict'} onPress={() => setFilter(filter === 'conflict' ? null : 'conflict')} />
          <Tile label="Duplicates" value={sum.duplicate} on={filter === 'duplicate'} onPress={() => setFilter(filter === 'duplicate' ? null : 'duplicate')} />
          <Tile label="Skipped" value={sum.skipped} on={filter === 'skipped'} onPress={() => setFilter(filter === 'skipped' ? null : 'skipped')} />
        </View>
        {sum.needs_sport ? (
          <Card style={{ marginTop: 12 }}>
            <T weight="700" size={13}>{sum.needs_sport} row{sum.needs_sport === 1 ? ' names' : 's name'} a team that does not exist yet. Choose the sport and the team{sum.needs_sport === 1 ? '' : 's'} will be created when you import.</T>
            <View style={{ marginTop: 10 }}><SportSelect label="Sport for new teams" value={opts.sport} onChange={(v) => setOpts({ ...opts, sport: v })} /></View>
            <Btn small title="Use this sport and check again" onPress={check} loading={busy === 'check'} disabled={!opts.sport} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
          </Card>
        ) : null}
        {conflicts ? <Card color={c.orangeSoft} style={{ marginTop: 12 }}><T weight="700" size={13}>{conflicts} row{conflicts === 1 ? ' uses' : 's use'} an email that already belongs to someone with a different name. Confirm only if it is the same person; otherwise skip the row.</T></Card> : null}
        <View style={{ marginTop: 12, gap: 8 }}>
          {rows.loading && !rows.data ? <Loading /> : (rows.data ?? []).length ? rows.data.map((r) => {
            const [label, tone] = OUTCOME[r.check_status] ?? OUTCOME.pending;
            return (
              <Card key={r.id} pad={12} accessibilityLabel={`Row ${r.row_no}, ${label}`}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Tag label={`Row ${r.row_no}`} />
                  <T weight="700" style={{ flexShrink: 1 }}>{r.person?.name || 'No name'}</T>
                  <Tag label={label} color={tone} />
                </View>
                <T size={12} color={c.mute} style={{ marginTop: 4 }}>{[r.person?.email, r.person?.team, r.person?.role].filter(Boolean).join(' · ')}</T>
                {r.reasons.filter((x) => x.level !== 'info').map((x, i) => <T key={i} size={12.5} color={x.level === 'error' ? c.red : c.ink} style={{ marginTop: 3 }}>{x.message}</T>)}
                {r.check_status === 'conflict' ? (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                    <Btn small title="Same person" onPress={() => review(r, 'confirmed')} loading={busy === `r${r.id}`} accessibilityLabel={`Row ${r.row_no} is the same person as the account`} />
                    <Btn small title="Skip this row" color={c.paper} ink={c.ink} onPress={() => review(r, 'skipped')} />
                  </View>
                ) : null}
              </Card>
            );
          }) : <T size={13} color={c.mute}>{filter ? 'No rows in this group.' : 'Pick a group above to look at its rows.'}</T>}
        </View>
        <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 10, marginTop: 16 }}>
          <Btn title="Back to columns" color={c.paper} ink={c.ink} onPress={() => run('back', async () => setProject(await api.patch(`/migrations/${project.id}`, { options: {} })))} style={{ flex: 1 }} />
          {sum.rejected + sum.duplicate + sum.skipped ? <Btn title="Download problems" color={c.paper} ink={c.ink} onPress={problems} loading={busy === 'csv'} style={{ flex: 1 }} /> : null}
          <Btn title={`Approve ${sum.importable} row${sum.importable === 1 ? '' : 's'}`} onPress={approve} loading={busy === 'approve'} disabled={!!conflicts || !sum.importable} style={{ flex: 1 }} accessibilityLabel="Approve the checked rows for import" />
        </View>
        {sum.rejected ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>Rows that need fixing are left out. Fix them in your file and import it again: people already imported are not invited twice.</T> : null}
      </Screen>
    );
  }

  // ------------------------------------------------------------------ 5 import / 6 report
  const r = report.data;
  const done = ['completed', 'reconciliation', 'rolled_back_partially'].includes(project.status);
  return (
    <Screen wide>
      {head}
      {!done ? (
        <Card>
          <T weight="800" size={16}>Ready to import</T>
          <T size={13} color={c.mute} style={{ marginTop: 4, lineHeight: 19 }}>{project.summary?.importable ?? r?.validation?.importable ?? 0} approved rows. People already on Gotmygame are invited to their team. Everyone else is invited when they register with the same email. Nobody is added until they accept.</T>
          <Btn title="Import now" onPress={doRun} loading={busy === 'run'} style={{ marginTop: 12 }} />
        </Card>
      ) : null}
      {r ? (
        <View style={{ marginTop: 12, gap: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Tile label="Invited" value={r.result.invited} color={c.limeSoft} />
            <Tile label="Waiting to sign up" value={r.result.awaiting_signup} />
            <Tile label="Waiting for guardian" value={r.result.awaiting_consent} color={r.result.awaiting_consent ? c.sunSoft : c.paper} />
            <Tile label="Already on team" value={r.result.already_member} />
            <Tile label="Failed" value={r.result.failed} color={r.result.failed ? c.pinkSoft : c.paper} />
          </View>
          <Card>
            <T weight="800" size={14}>Reconciliation</T>
            <T size={13} style={{ marginTop: 6 }}>{r.source_rows} rows in the file · {r.validation.importable} imported · {r.validation.rejected} rejected · {r.validation.duplicate} duplicates · {r.validation.skipped} skipped</T>
            {r.teams_created.length ? <T size={13} style={{ marginTop: 4 }}>Teams created: {r.teams_created.map((t) => t.name).join(', ')}</T> : null}
            {r.notes.map((n) => <T key={n} size={12} color={c.mute} style={{ marginTop: 6, lineHeight: 17 }}>{n}</T>)}
          </Card>
          {r.unresolved.length ? (
            <Card>
              <T weight="800" size={14}>Still to resolve ({r.unresolved.length})</T>
              {r.unresolved.slice(0, 30).map((u) => <T key={`${u.row}${u.outcome}`} size={12.5} style={{ marginTop: 6 }}>Row {u.row} · {u.name || 'no name'}{u.email ? ` · ${u.email}` : ''} · {u.outcome.replace(/_/g, ' ')}{u.reasons.length ? ` — ${u.reasons.join('; ')}` : ''}</T>)}
              {r.unresolved.length > 30 ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>…and {r.unresolved.length - 30} more in the download.</T> : null}
            </Card>
          ) : null}
          <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 10 }}>
            <Btn title="Download report" color={c.paper} ink={c.ink} onPress={problems} loading={busy === 'csv'} style={{ flex: 1 }} />
            {done && project.status !== 'rolled_back_partially' && (r.result.awaiting_signup || r.result.awaiting_consent || r.result.failed) ? <Btn title="Retry waiting rows" color={c.paper} ink={c.ink} onPress={doRun} loading={busy === 'run'} style={{ flex: 1 }} /> : null}
            {done && project.status !== 'rolled_back_partially' ? <Btn title="Roll back" color={c.paper} ink={c.red} onPress={rollback} loading={busy === 'rollback'} style={{ flex: 1 }} accessibilityLabel="Roll back this import: withdraw invitations nobody has answered" /> : null}
            <Btn title="Import another file" onPress={restart} style={{ flex: 1 }} />
          </View>
          {project.status === 'rolled_back_partially' ? <T size={12.5} color={c.mute}>Rolled back. Invitations nobody had answered were withdrawn; anyone who already accepted was kept. Nothing was deleted.</T> : null}
        </View>
      ) : <Loading />}
    </Screen>
  );
}
