import React, { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Section, Seg, T, Tag } from '../ui';
import { ConsentManager } from './provider';
import { c, day, when } from '../theme';

const MODE = { open: ['No general localisation rule', c.lime], safeguards: ['Transfer needs safeguards', c.sunSoft], restricted: ['State assessment before transfer', c.orangeSoft], localised: ['Stays in-country by default', c.pinkSoft] };
const KINDS = [
  ['access', '👁️', 'See my data', 'Ask what is held about you and why.'],
  ['correction', '✏️', 'Correct it', 'Something is wrong or out of date.'],
  ['restriction', '⏸️', 'Restrict sharing', 'Stop providers using your records.'],
  ['objection', '✋', 'Object to use', 'Object to how your data is used.'],
  ['erasure', '🗑️', 'Erase it', 'Ask for erasure. Records the law makes us keep are held, never shown to providers.'],
];
const STATUS = { open: ['Open', c.sunSoft], in_progress: ['In progress', c.cyanSoft], fulfilled: ['Done', c.lime], declined: ['Declined', c.pinkSoft], withdrawn: ['Withdrawn', c.violetSoft] };
const label = (v) => String(v).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const dueIn = (iso) => { const d = Math.ceil((new Date(iso) - Date.now()) / 864e5); return d < 0 ? `${-d} day${d === -1 ? '' : 's'} overdue` : d === 0 ? 'due today' : `${d} day${d === 1 ? '' : 's'} left`; };
const CHECK = { ok: ['✓', c.mint], warn: ['!', '#D97706'], fail: ['✕', c.red] };

function Fact({ icon, title, children }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <T size={18}>{icon}</T>
      <View style={{ flex: 1 }}><T weight="800" size={13}>{title}</T><T size={13} color={c.mute}>{children}</T></View>
    </View>
  );
}

/** The rules of one country in plain language: what to expect, how fast, where data may live. */
export function RegimeCard({ regime, you = 'you' }) {
  const [more, setMore] = useState(false);
  if (!regime) return null;
  const m = MODE[regime.transfer.mode];
  return (
    <Card color={c.mintSoft} pad={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T size={30}>{regime.flag}</T>
        <View style={{ flex: 1 }}><T weight="900" size={17}>{regime.name}</T><T size={12} color={c.mute}>Regulator: {regime.regulator}</T></View>
      </View>
      <View style={{ gap: 10, marginTop: 12 }}>
        <Fact icon="🔒" title="Consent">{regime.consent.note}</Fact>
        <Fact icon="⏱️" title="Your requests are answered within">{regime.access_days.label}</Fact>
        <Fact icon="🚨" title="If something goes wrong">{regime.breach.regulator}</Fact>
        <Fact icon="🗄️" title="How long records are kept">{regime.retention.adult_years} years{regime.retention.minor_until_age ? `, children until age ${regime.retention.minor_until_age}` : ''}. {regime.retention.note}</Fact>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T size={18}>🌍</T><Tag label={m[0]} color={m[1]} /></View>
        <T size={12} color={c.mute}>{regime.transfer.note}</T>
      </View>
      {more ? (
        <View style={{ gap: 10, marginTop: 12 }}>
          <Fact icon="🩺" title="Remote care">{regime.telehealth}</Fact>
          <Fact icon="🧒" title="Young people">{regime.minors}</Fact>
          <Fact icon="🏛️" title="Who is responsible">{regime.roles}</Fact>
          <Fact icon="📚" title="Laws">{regime.laws.join(' · ')}</Fact>
          <Fact icon="👩‍⚕️" title="Doctors’ regulator and association">{regime.medical_bodies.join(' · ')}</Fact>
          <Fact icon="🏃" title="Physiotherapists’ regulator and association">{regime.physio_bodies.join(' · ')}</Fact>
        </View>
      ) : null}
      <Btn small title={more ? 'Show less' : 'Laws, regulators and more'} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 10 }} onPress={() => setMore(!more)} />
      <T size={11} color={c.mute} style={{ marginTop: 8 }}>{regime.disclaimer}</T>
    </Card>
  );
}

/** Pick your country, read its notice, accept it. Used first-time and when a notice changes. */
function RegionSetup({ me, onDone }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/health/regimes'), []);
  const [pick, setPick] = useState(me.country), [busy, setBusy] = useState(false);
  const chosen = list.data?.find((r) => r.code === pick);
  const accept = async () => { setBusy(true); try { await api.post('/me/health/region', { country: pick, accept_notice: true }); toast('Saved — your rules are set'); onDone(); } catch (e) { toast('' + e.message); } setBusy(false); };
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>Health data is governed by the rules of a country. Choose the one that applies to you; we show what that means before you agree.</T>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{list.data.map((r) => <Chip key={r.code} label={`${r.flag} ${r.name}`} active={pick === r.code} onPress={() => setPick(r.code)} />)}</View>
      )}
      {chosen ? <>
        <RegimeCard regime={chosen} />
        <Btn title={me.country === pick && !me.needs_notice ? 'You accepted this notice' : `I have read the ${chosen.name} notice`} color={c.mint} ink={c.ink} loading={busy} disabled={me.country === pick && !me.needs_notice} onPress={accept} />
      </> : <Empty emoji="🌍" title="Pick a country" sub="Eleven countries are supported today." />}
    </View>
  );
}

function MyRules({ onChanged }) {
  const me = useLoad(() => api.get('/me/health/region'), []);
  const [edit, setEdit] = useState(false);
  if (me.loading && !me.data) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} onRetry={me.reload} />;
  const m = me.data;
  if (!m.country || m.needs_notice || edit) return <RegionSetup me={m} onDone={() => { setEdit(false); me.reload(); onChanged?.(); }} />;
  return (
    <View style={{ gap: 10 }}>
      <Card pad={12} color={c.lime}><T weight="900">✓ Your health data follows {m.regime.name} rules</T><T size={12} color={c.mute}>You accepted notice version {m.accepted_version}. We ask again whenever the rules we summarise change.</T></Card>
      <RegimeCard regime={m.regime} />
      <Btn small title="Change country" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setEdit(true)} />
    </View>
  );
}

const PAGE = 25;
function AccessLog() {
  const [limit, setLimit] = useState(PAGE);
  const log = useLoad(() => api.get('/me/health/access-log', { limit }), [limit]);
  return (
    <View style={{ gap: 8 }}>
      <T size={13} color={c.mute}>Every time a physio or doctor reads or writes your health data it is recorded here — who, what and when. Clinical content is never shown. Blocked attempts are listed too.</T>
      {log.loading && !log.data ? <Loading /> : log.error ? <ErrorBox error={log.error} onRetry={log.reload} /> : log.data.length ? <>
        {log.data.map((l) => (
          <Card key={l.id} pad={12}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><T weight="800">{l.what}</T><T size={12} color={c.mute}>{l.by}{l.role ? ` · ${label(l.role)}` : ''} · {when(l.at)}</T></View>
              <Tag label={l.outcome === 'blocked' ? 'Blocked' : 'Allowed'} color={l.outcome === 'blocked' ? c.pinkSoft : c.violetSoft} />
            </View>
          </Card>
        ))}
        {log.data.length >= limit ? <Btn small title="Show older" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setLimit(limit + PAGE)} /> : null}
      </> : <Empty emoji="🔍" title="No access yet" sub="When a clinician opens your records, it appears here." />}
    </View>
  );
}

async function saveCopy(data) {
  const text = JSON.stringify(data, null, 2), name = `gotmygame-health-data-${new Date().toISOString().slice(0, 10)}.json`;
  if (Platform.OS === 'web') { const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); } else await Share.share({ message: text, title: name });
}

function Rights() {
  const { toast } = useSession();
  const reqs = useLoad(() => api.get('/me/health/requests', { limit: 50 }), []);
  const [form, setForm] = useState(null), [busy, setBusy] = useState(false);
  const act = async (fn, msg) => { try { await fn(); toast(msg); reqs.reload(); } catch (e) { toast('' + e.message); } };
  const download = async () => { setBusy(true); try { await saveCopy(await api.get('/me/health/export')); toast('Your data was exported'); reqs.reload(); } catch (e) { toast('' + e.message); } setBusy(false); };
  const k = KINDS.find((x) => x[0] === form);
  return (
    <View style={{ gap: 10 }}>
      <Card pad={14} color={c.mintSoft}>
        <T weight="900">Your copy, instantly</T>
        <T size={12} color={c.mute}>Download everything we hold about your health as a file: appointments, records, problems, allergies, medicines, follow-ups and who you shared with. Each download is logged.</T>
        <Btn small title="⬇ Download my health data" color={c.mint} ink={c.ink} loading={busy} style={{ alignSelf: 'flex-start', marginTop: 10 }} onPress={download} />
      </Card>
      <Section title="Ask us to act" color={c.violet}>
        <View style={{ gap: 8 }}>{KINDS.map(([key, icon, title, sub]) => (
          <Card key={key} pad={12} onPress={() => setForm(key)}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}><T size={22}>{icon}</T><View style={{ flex: 1 }}><T weight="800">{title}</T><T size={12} color={c.mute}>{sub}</T></View><T color={c.mute}>›</T></View>
          </Card>
        ))}</View>
        <T size={12} color={c.mute}>We never delete a record we must keep. Restriction and erasure end every provider’s access at once and the record is held until its retention date, which we tell you.</T>
      </Section>
      <Section title="Your requests" color={c.cyan}>
        {reqs.loading && !reqs.data ? <Loading /> : reqs.error ? <ErrorBox error={reqs.error} onRetry={reqs.reload} /> : reqs.data.length ? reqs.data.map((r) => (
          <Card key={r.id} pad={12} color={r.overdue ? c.pinkSoft : c.paper}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1 }}><T weight="800">{KINDS.find((x) => x[0] === r.kind)?.[2] ?? 'Data export'}</T><T size={12} color={c.mute}>Sent {day(r.created_at)}{['open', 'in_progress'].includes(r.status) ? ` · ${dueIn(r.due_at)}` : ''}</T></View>
              <Tag label={STATUS[r.status][0]} color={STATUS[r.status][1]} />
            </View>
            {r.detail ? <T size={13} style={{ marginTop: 6 }}>“{r.detail}”</T> : null}
            {r.response ? <T size={13} style={{ marginTop: 6 }}>Answer: {r.response}</T> : null}
            {r.retain_until ? <T size={12} color={c.mute}>Records are held until {day(r.retain_until)}.</T> : null}
            {['open', 'in_progress'].includes(r.status) ? <Btn small title="Withdraw" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => act(() => api.post(`/me/health/requests/${r.id}/withdraw`, {}), 'Withdrawn')} /> : null}
          </Card>
        )) : <Empty emoji="📮" title="No requests" sub="Anything you ask for is tracked here with its deadline." />}
      </Section>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={k?.[2] ?? ''} submitLabel="Send request"
        fields={[{ key: 'detail', label: form === 'correction' ? 'What should be corrected?' : 'Anything we should know?', type: 'multiline', optional: form !== 'correction', hint: 'Do not paste medical details you do not need to.' }]}
        onSubmit={async (v) => { await api.post('/me/health/requests', { kind: form, detail: v.detail || undefined }); reqs.reload(); return 'Request sent'; }} />
    </View>
  );
}

/** Health → Privacy: sharing, the rules that apply to you, who accessed your data, and your rights. */
export function PrivacyHub({ onChanged }) {
  const [tab, setTab] = useState('sharing');
  return (
    <View style={{ gap: 10 }}>
      <Seg options={[{ value: 'sharing', label: 'Sharing', emoji: '🤝' }, { value: 'rules', label: 'Your rules', emoji: '⚖️' }, { value: 'log', label: 'Who accessed', emoji: '🔍' }, { value: 'rights', label: 'Your rights', emoji: '📮' }]} value={tab} onChange={setTab} color={c.mint} />
      {tab === 'sharing' && <ConsentManager />}
      {tab === 'rules' && <MyRules onChanged={onChanged} />}
      {tab === 'log' && <AccessLog />}
      {tab === 'rights' && <Rights />}
    </View>
  );
}

function Checks({ checks }) {
  return checks.map((x) => (
    <View key={x.id} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: CHECK[x.status][1], alignItems: 'center', justifyContent: 'center' }}><T weight="900" size={12} color="#fff">{CHECK[x.status][0]}</T></View>
      <View style={{ flex: 1 }}><T weight="800" size={13}>{x.title}</T><T size={12} color={c.mute}>{x.detail}</T></View>
    </View>
  ));
}

const INCIDENT = { kinds: ['unauthorised_access', 'loss_or_theft', 'misdirected_disclosure', 'system_compromise', 'improper_retention', 'other'], state: { open: ['Open', c.sunSoft], assessed: ['Assessed', c.cyanSoft], notified: ['Notified', c.violetSoft], closed: ['Closed', c.lime] } };

function IncidentList({ admin }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/health/incidents', { limit: 50 }), []);
  const [upd, setUpd] = useState(null);
  const NEXT = { open: ['assessed', 'notified', 'closed'], assessed: ['notified', 'closed'], notified: ['closed'], closed: [] };
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data.length) return <Empty emoji="🛡️" title="No incidents" sub="Report anything that put health data at risk — the regulator’s clock starts when you become aware." />;
  const u = upd ? list.data.find((x) => x.id === upd.id) : null;
  return (
    <View style={{ gap: 8 }}>
      {list.data.map((i) => (
        <Card key={i.id} pad={12} color={i.regulator_overdue ? c.pinkSoft : c.paper}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{label(i.kind)} · {i.country}</T><T size={12} color={c.mute}>{label(i.severity)} severity · {i.affected_people} people · aware {when(i.aware_at)}</T></View>
            <Tag label={INCIDENT.state[i.status][0]} color={INCIDENT.state[i.status][1]} />
          </View>
          <T size={13} style={{ marginTop: 6 }}>{i.description}</T>
          <T size={12} color={i.regulator_overdue ? c.red : c.mute} style={{ marginTop: 4 }}>{i.regulator_notified_at ? `Regulator told ${when(i.regulator_notified_at)}` : i.regulator_due_at ? `Regulator deadline ${when(i.regulator_due_at)}${i.regulator_overdue ? ' — OVERDUE' : ''}` : 'Regulator: as soon as practicable'}</T>
          <T size={11} color={c.mute}>{i.obligations?.regulator}</T>
          {admin && NEXT[i.status].length ? <Btn small title="Update" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setUpd(i)} /> : null}
        </Card>
      ))}
      <FormSheet visible={!!u} onClose={() => setUpd(null)} title="Update incident" submitLabel="Save"
        initial={{ status: u ? NEXT[u.status][0] : 'assessed' }}
        fields={[{ key: 'status', label: 'Move to', type: 'choice', options: (u ? NEXT[u.status] : []).map((v) => ({ value: v, label: label(v) })) },
          { key: 'regulator_day', label: 'Regulator told on', type: 'date', optional: true, max: new Date().toISOString().slice(0, 10) },
          { key: 'individuals_day', label: 'Affected people told on', type: 'date', optional: true, max: new Date().toISOString().slice(0, 10) },
          { key: 'note', label: 'Reason or note (needed to close without notifying anyone)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/admin/health/incidents/${u.id}/update`, { status: v.status, regulator_notified_at: v.regulator_day ? new Date(`${v.regulator_day}T12:00:00`).toISOString() : undefined, individuals_notified_at: v.individuals_day ? new Date(`${v.individuals_day}T12:00:00`).toISOString() : undefined, note: v.note || undefined }); list.reload(); return 'Incident updated'; }} />
    </View>
  );
}

/** Practice → Compliance (physio / doctor): checklist for your country, the rules, and the incident register. */
export function PracticeCompliance() {
  const { toast } = useSession();
  const res = useLoad(() => api.get('/me/health/practice-compliance'), []);
  const regs = useLoad(() => api.get('/health/regimes'), []);
  const [form, setForm] = useState(false), [setup, setSetup] = useState(false), [inc, setInc] = useState(0);
  const d = res.data;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <View style={{ gap: 10 }}>
      {res.loading && !d ? <Loading /> : res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : <>
        <Card pad={14} color={d.ready ? c.lime : c.sunSoft}>
          <T weight="900" size={16}>{d.ready ? '✓ Your practice is set up for ' + d.regime.name : 'Finish setting up your practice'}</T>
          <T size={12} color={c.mute}>This checklist covers what you control. It is guidance, not a legal certificate.</T>
          <View style={{ gap: 10, marginTop: 12 }}><Checks checks={d.checks} /></View>
          {!d.country || d.checks.find((x) => x.id === 'notice')?.status !== 'ok' ? <Btn small title="Choose country & read notice" color={c.mint} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 12 }} onPress={() => setSetup(true)} /> : null}
        </Card>
        {setup ? <RegionSetup me={{ country: d.country, needs_notice: true }} onDone={() => { setSetup(false); res.reload(); }} /> : null}
        {d.regime && !setup ? <RegimeCard regime={d.regime} /> : null}
      </>}
      <Section title="Privacy incidents" color={c.orange} action="Report one" onAction={() => setForm(true)}>
        <IncidentList key={inc} />
      </Section>
      <FormSheet visible={form} onClose={() => setForm(false)} title="Report a privacy incident" submitLabel="Report"
        initial={{ kind: 'misdirected_disclosure', severity: 'medium', country: d?.country ?? undefined, affected_people: 1, health_data_involved: true, occurred_day: today, occurred_time: '09:00' }}
        fields={[{ key: 'kind', label: 'What happened', type: 'chips', options: INCIDENT.kinds.map((v) => ({ value: v, label: label(v) })) },
          { key: 'severity', label: 'How serious', type: 'choice', options: ['low', 'medium', 'high'].map((v) => ({ value: v, label: label(v) })) },
          { key: 'country', label: 'Whose rules apply', type: 'chips', options: (regs.data ?? []).map((r) => ({ value: r.code, label: `${r.flag} ${r.name}` })) },
          { key: 'occurred_day', label: 'When did it happen', type: 'date', max: today }, { key: 'occurred_time', label: 'Around what time', type: 'time' },
          { key: 'affected_people', label: 'People affected', type: 'stepper', min: 0, max: 100000, step: 1 },
          { key: 'health_data_involved', label: 'Health data involved', type: 'switch' },
          { key: 'description', label: 'What happened (no names or clinical detail)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post('/health/incidents', { kind: v.kind, severity: v.severity, country: v.country, affected_people: v.affected_people, health_data_involved: !!v.health_data_involved, occurred_at: new Date(`${v.occurred_day}T${v.occurred_time || '00:00'}:00`).toISOString(), description: v.description }); setInc((n) => n + 1); res.reload(); toast('Reported — the platform team was told'); return 'Incident reported'; }} />
    </View>
  );
}

/** Platform team: posture findings, rights-request queue and the incident register. */
export function HealthComplianceDesk() {
  const { toast } = useSession();
  const posture = useLoad(() => api.get('/admin/health/posture'), []);
  const queue = useLoad(() => api.get('/admin/health/requests', { limit: 50 }), []);
  const [resolve, setResolve] = useState(null);
  const act = async (fn, msg) => { try { await fn(); toast(msg); queue.reload(); } catch (e) { toast('' + e.message); } };
  const p = posture.data;
  return (
    <Section title="Health privacy (platform team)" color={c.mint}>
      {posture.loading && !p ? <Loading /> : posture.error ? <ErrorBox error={posture.error} onRetry={posture.reload} /> : (
        <Card pad={14}>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Tag label={`${p.summary.fail} to fix`} color={p.summary.fail ? c.pinkSoft : c.violetSoft} /><Tag label={`${p.summary.warn} to review`} color={p.summary.warn ? c.sunSoft : c.violetSoft} /><Tag label={`${p.summary.ok} fine`} color={c.lime} /></View>
          <View style={{ gap: 10, marginTop: 12 }}><Checks checks={[...p.checks].sort((a, b) => ['fail', 'warn', 'ok'].indexOf(a.status) - ['fail', 'warn', 'ok'].indexOf(b.status))} /></View>
          {p.people_by_country.length ? <T size={12} color={c.mute} style={{ marginTop: 10 }}>People by country: {p.people_by_country.map((x) => `${x.name} ${x.people}`).join(' · ')}</T> : null}
          <T size={11} color={c.mute} style={{ marginTop: 6 }}>{p.disclaimer}</T>
        </Card>
      )}
      <T weight="800">Rights requests</T>
      {queue.loading && !queue.data ? <Loading /> : queue.error ? <ErrorBox error={queue.error} onRetry={queue.reload} /> : queue.data.length ? queue.data.map((r) => (
        <Card key={r.id} pad={12} color={r.overdue ? c.pinkSoft : c.paper}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{label(r.kind)} · {r.subject_name}</T><T size={12} color={c.mute}>{r.country ?? 'No country'} · {dueIn(r.due_at)}</T></View>
            <Tag label={STATUS[r.status][0]} color={STATUS[r.status][1]} />
          </View>
          {r.detail ? <T size={13} style={{ marginTop: 6 }}>“{r.detail}”</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {r.status === 'open' ? <Btn small title="Start" color={c.cyan} ink={c.ink} onPress={() => act(() => api.post(`/admin/health/requests/${r.id}/resolve`, { status: 'in_progress' }), 'Marked in progress')} /> : null}
            <Btn small title="Answer" color={c.mint} ink={c.ink} onPress={() => setResolve(r)} />
          </View>
        </Card>
      )) : <Empty emoji="✅" title="Queue is clear" />}
      <T weight="800">Incident register</T>
      <IncidentList admin />
      <FormSheet visible={!!resolve} onClose={() => setResolve(null)} title={resolve ? `${label(resolve.kind)} request` : ''} submitLabel="Send answer"
        initial={{ status: 'fulfilled' }}
        fields={[{ key: 'status', label: 'Outcome', type: 'choice', options: [{ value: 'fulfilled', label: 'Done' }, { value: 'declined', label: 'Decline' }] },
          { key: 'response', label: 'Answer shown to the person', type: 'multiline', hint: resolve && ['restriction', 'erasure', 'objection'].includes(resolve.kind) ? 'Marking this done ends every provider’s access and holds the records until their retention date. Nothing is deleted.' : undefined }]}
        onSubmit={async (v) => { await api.post(`/admin/health/requests/${resolve.id}/resolve`, { status: v.status, response: v.response }); queue.reload(); return 'Answer sent'; }} />
    </Section>
  );
}
