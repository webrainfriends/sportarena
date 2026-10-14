// Health → Privacy: the patient's privacy centre for the country whose health-data rules apply to them (docs/health-compliance.md).
// Choose a country and accept its notice, use your rights with the country's response time, download everything held about you,
// see who opened your data, and read breach notices. Platform team: answer rights requests and run the breach register.
import React, { useState } from 'react';
import { Platform, Pressable, Share, Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { Btn, Card, Chip, Empty, ErrorBox, GradCard, H2, Loading, Row, Seg, Sheet, T, Tag } from '../ui';
import { c, day, when } from '../theme';

const Bar = ({ children, style }) => <View style={[{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, style]}>{children}</View>;
const left = (iso) => {
  const ms = new Date(iso).getTime() - Date.now(), d = Math.ceil(Math.abs(ms) / 864e5);
  return ms < 0 ? { text: `${d} day${d === 1 ? '' : 's'} overdue`, late: true } : { text: d === 0 ? 'due today' : `${d} day${d === 1 ? '' : 's'} left`, late: false };
};
const STATE = { open: [c.sun, 'Received'], in_review: [c.cyan, 'Being looked at'], fulfilled: [c.lime, 'Done'], refused: [c.orange, 'Not possible'], withdrawn: [c.violetSoft, 'Withdrawn'] };
const Fact = ({ label, children }) => (
  <View style={{ gap: 2, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.line }}>
    <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.8 }}>{label.toUpperCase()}</T>
    {typeof children === 'string' ? <T size={13}>{children}</T> : children}
  </View>
);
const Lines = ({ items }) => <View style={{ gap: 3 }}>{items.map((x) => <T key={x} size={13}>• {x}</T>)}</View>;

/** Everything the platform follows for one country, in plain words. */
function CountryRules({ r }) {
  const clocks = r.deadlines.map((d) => `${d.audience === 'regulator' ? 'Regulator' : 'You'}: ${d.rule}`);
  return (
    <Card pad={14}>
      <T weight="900" size={16}>{r.flag} How {r.name} protects your health data</T>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>{r.disclaimer}</T>
      <View style={{ marginTop: 8 }}>
        <Fact label="The law">{<Lines items={r.laws} />}</Fact>
        <Fact label="Who oversees it">{<Lines items={[...r.regulators, ...r.medical_bodies]} />}</Fact>
        <Fact label="Your data counts as">{r.data_class}</Fact>
        <Fact label="Consent">{r.consent_basis}</Fact>
        <Fact label="Young people">{`From ${r.minors.age}. ${r.minors.note}`}</Fact>
        <Fact label="How long records are kept">{`At least ${r.retention.years} years. ${r.retention.basis} Gotmygame never deletes health records, so they are kept at least this long.`}</Fact>
        <Fact label="If something goes wrong">{<Lines items={clocks} />}</Fact>
        <Fact label="Leaving the country">{r.cross_border}</Fact>
        <Fact label="Video and phone visits">{r.telehealth}</Fact>
        <Fact label="Answering your requests">{r.response_rule}</Fact>
      </View>
    </Card>
  );
}

/** Pick or change the country: read what it means, accept the notice, agree to a transfer when data is stored elsewhere. */
function ChooseCountry({ target, hosted, onClose, onDone }) {
  const { toast } = useSession();
  const [accept, setAccept] = useState(false), [ack, setAck] = useState(false), [busy, setBusy] = useState(false);
  const full = useLoad(() => (target ? api.get('/health-regimes', { code: target.code }) : Promise.resolve(null)), [target?.code]);
  if (!target) return null;
  const r = full.data?.regimes?.[0];
  const away = !hosted.includes(target.code);
  const save = async () => {
    setBusy(true);
    try { await api.post('/medical/privacy', { regime: target.code, accept_notice: true, hosting_transfer_ack: away && ack }); toast(`${target.name} rules now apply`); onDone(); onClose(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={`${target.flag} ${target.name}`}>
      {full.loading && !r ? <Loading /> : r ? <>
        <T size={13}>Your health data will be handled under {r.laws[0]}.</T>
        <T size={13} color={c.mute}>{r.consent_basis}</T>
        <Fact label="Kept for">{`At least ${r.retention.years} years — never deleted by us.`}</Fact>
        <Fact label="If there is a breach">{r.deadlines.map((d) => `${d.audience === 'regulator' ? 'Regulator' : 'You'}: ${d.rule}`).join('\n')}</Fact>
        {away ? <Card color={c.sunSoft} pad={12}><T weight="800" size={13}>Stored outside {target.name}</T><T size={12} color={c.mute}>{r.cross_border}</T>
          <Bar style={{ marginTop: 8 }}><Switch value={ack} onValueChange={setAck} accessibilityLabel="I agree my data is stored outside my country" /><T size={13} style={{ flex: 1 }}>I agree my data is stored outside {target.name}.</T></Bar></Card> : <Tag label={`Stored in ${target.name}`} color={c.lime} />}
        <Bar><Switch value={accept} onValueChange={setAccept} accessibilityLabel="I have read this notice" /><T size={13} style={{ flex: 1 }}>I have read how {target.name} protects my health data.</T></Bar>
        <Btn title="Use these rules" color={c.mint} ink={c.ink} loading={busy} disabled={!accept || (away && !ack)} onPress={save} />
      </> : <ErrorBox error={full.error} onRetry={full.reload} />}
    </Sheet>
  );
}

function Disclosures({ visible, onClose }) {
  const q = useLoad(() => (visible ? api.get('/medical/disclosures', { limit: 50 }) : Promise.resolve(null)), [visible]);
  if (!visible) return null;
  return (
    <Sheet visible onClose={onClose} title="Who has seen my data">
      <T size={12} color={c.mute}>Every time someone opens, adds to, signs or reviews your health data it is written here — who, what area, when. It never shows what was in it.</T>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : <>
        {q.data.entries.length ? q.data.entries.map((e, i) => <Row key={i} left={<T size={20}>{e.roles.includes('doctor') ? '🩺' : e.roles.includes('physio') ? '💆' : '👤'}</T>} title={`${e.who} · ${e.what.toLowerCase()}`} sub={`${e.area} · ${when(e.at)}`} />) : <Empty emoji="🔒" title="Nobody has opened your data" sub="When someone does, it appears here." />}
        {q.data.sharing.length ? <>
          <H2>When you shared</H2>
          {q.data.sharing.map((s, i) => <Row key={i} left={<T size={20}>{s.action === 'grant' ? '🔓' : '🔒'}</T>} title={`${s.action === 'grant' ? 'Shared with' : 'Stopped sharing with'} ${s.provider_name}`} sub={`${s.scope === 'clearance' ? 'Fit-to-play only' : 'Full records'} · ${when(s.created_at)}`} />)}
        </> : null}
      </>}
    </Sheet>
  );
}

async function downloadExport(toast) {
  try {
    const data = await api.get('/medical/export');
    const text = JSON.stringify(data, null, 2), name = `my-health-data-${new Date().toISOString().slice(0, 10)}.json`;
    if (Platform.OS === 'web') { const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); toast('Your data was downloaded'); }
    else await Share.share({ title: name, message: text });
  } catch (e) { toast(e.message); }
}

export function PrivacyPanel() {
  const { has, toast } = useSession();
  const me = useLoad(() => api.get('/medical/privacy'), []);
  const reqs = useLoad(() => api.get('/medical/privacy/requests', { limit: 30 }), []);
  const notices = useLoad(() => api.get('/medical/privacy/notices').catch(() => []), []);
  const [pick, setPick] = useState(null), [ask, setAsk] = useState(null), [seen, setSeen] = useState(false), [rules, setRules] = useState(false), [busy, setBusy] = useState(false);
  const d = me.data;
  const full = useLoad(() => (d?.profile ? api.get('/health-regimes', { code: d.profile.regime }) : Promise.resolve(null)), [d?.profile?.regime]);
  const reload = () => { me.reload(); reqs.reload(); };
  if (me.loading && !d) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} onRetry={me.reload} />;
  const r = full.data?.regimes?.[0], cur = d.available.find((x) => x.code === d.profile?.regime);
  return (
    <View style={{ gap: 12 }}>
      {d.profile && cur ? (
        <GradCard colors={['#0B1020', '#0F3D3E', '#14746F']} pad={18}>
          <T size={34}>{cur.flag}</T>
          <T weight="900" size={20} color="#fff">Protected under {cur.name}'s rules</T>
          <T size={13} color="rgba(255,255,255,0.78)">{cur.laws[0]}</T>
          <Bar style={{ marginTop: 10 }}>
            <Tag label={d.hosted_in_my_country ? `Stored in ${cur.name}` : d.profile.hosting_transfer_ack_at ? 'Stored abroad · you agreed' : 'Stored abroad'} color={d.hosted_in_my_country ? c.lime : c.sun} />
            <Tag label={`Notice v${d.profile.notice_version}`} color={c.violetSoft} />
            {d.open_requests.overdue ? <Tag label="A request is overdue" color={c.orange} /> : null}
          </Bar>
          <Bar style={{ marginTop: 12 }}>
            <Btn small title="Download my data" color={c.paper} ink={c.ink} loading={busy} onPress={async () => { setBusy(true); await downloadExport(toast); setBusy(false); reqs.reload(); }} />
            <Btn small title="Who has seen my data" color={c.paper} ink={c.ink} onPress={() => setSeen(true)} />
          </Bar>
        </GradCard>
      ) : (
        <GradCard colors={['#0B1020', '#0F3D3E', '#14746F']} pad={18}>
          <T weight="900" size={20} color="#fff">Which country's rules protect your health data?</T>
          <T size={13} color="rgba(255,255,255,0.78)" style={{ marginTop: 4 }}>Health laws differ by country. Choose yours so the right notice, response times and sharing rules apply. Until you do, you can keep using Health as before.</T>
        </GradCard>
      )}

      <View style={{ gap: 8 }}>
        <H2>{d.profile ? 'Change country' : 'Choose your country'}</H2>
        <Bar>{d.available.map((x) => (
          <Pressable key={x.code} disabled={!x.selectable} onPress={() => setPick(x)} accessibilityRole="button" accessibilityLabel={`${x.name}${x.selectable ? '' : ', not available here'}`}
            style={{ opacity: x.selectable ? 1 : 0.45, borderWidth: 1.5, borderColor: d.profile?.regime === x.code ? c.mint : c.line, backgroundColor: d.profile?.regime === x.code ? c.mintSoft : c.paper, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, minWidth: 104 }}>
            <T size={20}>{x.flag}</T><T size={12} weight="800">{x.name}</T>
            <T size={10} color={c.mute}>{!x.selectable ? 'Needs local hosting' : x.needs_transfer_ack ? 'Stored abroad' : 'Stored here'}</T>
          </Pressable>))}</Bar>
        {d.available.some((x) => !x.selectable) ? <T size={11} color={c.mute}>Some countries require health data to stay inside the country. They unlock when this service is hosted there.</T> : null}
      </View>

      {d.profile ? <>
        <View style={{ gap: 8 }}>
          <H2>Your rights</H2>
          <T size={12} color={c.mute}>{r?.response_rule ?? ''}{r ? ' We aim to answer every request in that time.' : ''}</T>
          {Object.keys(LABEL).map((kind) => { const legal = (r?.request_kinds ?? []).some((x) => x.kind === kind); return (
            <Row key={kind} left={<T size={20}>{ICON[kind]}</T>} title={LABEL[kind]} sub={legal ? `Your right in ${cur.name}` : `Not a legal right in ${cur.name} — we will still consider it`}
              right={<Btn small title={kind === 'access' || kind === 'portability' ? 'Download' : kind === 'accounting' ? 'Show me' : 'Ask'} color={legal ? c.mint : c.paper} ink={c.ink}
                onPress={async () => { if (kind === 'access' || kind === 'portability') { await downloadExport(toast); reqs.reload(); } else if (kind === 'accounting') setSeen(true); else setAsk({ kind, label: LABEL[kind] }); }} />} />); })}
        </View>

        <View style={{ gap: 8 }}>
          <H2>My requests</H2>
          {reqs.loading && !reqs.data ? <Loading /> : reqs.data?.length ? reqs.data.map((q) => {
            const [col, label] = STATE[q.status], t = left(q.due_at), live = ['open', 'in_review'].includes(q.status);
            return (
              <Card key={q.id} pad={12}>
                <Bar style={{ justifyContent: 'space-between' }}><T weight="800">{q.label}</T><Tag label={label} color={col} /></Bar>
                {q.detail ? <T size={13} color={c.mute} style={{ marginTop: 4 }}>“{q.detail}”</T> : null}
                {live ? <T size={12} color={t.late ? c.red : c.mute} weight={t.late ? '800' : '500'} style={{ marginTop: 4 }}>Asked {day(q.created_at)} · {t.text}</T> : <T size={12} color={c.mute} style={{ marginTop: 4 }}>Asked {day(q.created_at)}{q.resolved_at ? ` · answered ${day(q.resolved_at)}` : ''}</T>}
                {q.resolution ? <Card color={c.mintSoft} pad={10} style={{ marginTop: 6 }}><T size={13}>{q.resolution}</T></Card> : null}
                {live ? <Btn small title="Withdraw request" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={async () => { try { await api.post(`/medical/privacy/requests/${q.id}/withdraw`, {}); toast('Request withdrawn'); reload(); } catch (e) { toast(e.message); } }} /> : null}
              </Card>);
          }) : <Empty emoji="📬" title="No requests yet" sub="Use a right above and it will show here with its due date." />}
        </View>

        {d.cross_border_shares.length ? (
          <Card color={c.sunSoft} pad={12}>
            <T weight="800">Shared across a border</T>
            <T size={12} color={c.mute}>You agreed to share with these providers, who work under another country's rules. Revoke any time under Access.</T>
            {d.cross_border_shares.map((s) => <T key={s.provider_id} size={13} style={{ marginTop: 4 }}>• {s.provider_name}{s.provider_regime ? ` · ${s.provider_regime}` : ' · country not recorded'}</T>)}
          </Card>) : null}
      </> : null}

      {notices.data?.length ? (
        <View style={{ gap: 8 }}>
          <H2>Important notices</H2>
          {notices.data.map((n) => <Card key={n.id} color={c.sunSoft} pad={12}><Tag label={`Told ${day(n.told_at)}`} color={c.sun} /><T size={13} style={{ marginTop: 6 }}>{n.notice}</T><T size={11} color={c.mute} style={{ marginTop: 4 }}>About {n.affected_count} people were affected.</T></Card>)}
        </View>) : null}

      {r ? <>
        <Btn title={rules ? 'Hide the rules for my country' : `Read the rules for ${cur.name}`} color={c.paper} ink={c.ink} onPress={() => setRules(!rules)} />
        {rules ? <CountryRules r={r} /> : null}
      </> : null}

      {has('admin') ? <PlatformPrivacy /> : null}

      <ChooseCountry target={pick} hosted={d.hosted_in} onClose={() => setPick(null)} onDone={reload} />
      <Disclosures visible={seen} onClose={() => setSeen(false)} />
      <FormSheet visible={!!ask} onClose={() => setAsk(null)} title={ask ? (ask.label ?? LABEL[ask.kind]) : ''} color={c.mint} submitLabel="Send request"
        fields={[{ key: 'detail', label: ask?.kind === 'complaint' ? 'What is your concern?' : 'Tell us what you need', type: 'multiline', optional: true, hint: 'Kept encrypted. Only the privacy team reads it.' }]}
        onSubmit={async (v) => { const x = await api.post('/medical/privacy/requests', { kind: ask.kind, ...(v.detail?.trim() ? { detail: v.detail.trim() } : {}) }); setAsk(null); reload(); return `Received — we aim to answer ${left(x.due_at).text.replace(' left', '')}`; }} />
    </View>
  );
}

const LABEL = { access: 'See everything held about me', portability: 'Get a copy I can take elsewhere', correction: 'Correct something', restriction: 'Limit how my data is used or shared', objection: 'Object to a use', erasure: 'Delete my data', accounting: 'See who accessed my data', withdraw_consent: 'Withdraw a consent', complaint: 'Raise a privacy complaint' };
const ICON = { access: '👁️', portability: '📦', correction: '✏️', restriction: '⏸️', objection: '✋', erasure: '🗑️', accounting: '🔎', withdraw_consent: '↩️', complaint: '📣' };

/** Platform team: answer privacy requests and run the health-breach register. */
function PlatformPrivacy() {
  const { toast } = useSession();
  const [sec, setSec] = useState('requests');
  return (
    <View style={{ gap: 10, marginTop: 6 }}>
      <Card color={c.violetSoft} pad={12}><T weight="900">Platform team · privacy</T><T size={12} color={c.mute}>Answer patients within their country's time, and keep the breach register so every regulator and person is told on time.</T></Card>
      <Seg options={[{ value: 'requests', label: 'Requests', emoji: '📬' }, { value: 'breaches', label: 'Breaches', emoji: '🚨' }]} value={sec} onChange={setSec} color={c.violet} />
      {sec === 'requests' ? <RequestQueue toast={toast} /> : <BreachRegister toast={toast} />}
    </View>
  );
}

function RequestQueue({ toast }) {
  const q = useLoad(() => api.get('/admin/health/privacy-requests', { limit: 50 }), []);
  const [res, setRes] = useState(null);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  return (
    <View style={{ gap: 8 }}>
      {q.data.length ? q.data.map((x) => { const t = left(x.due_at); return (
        <Card key={x.id} pad={12}>
          <Bar style={{ justifyContent: 'space-between' }}><T weight="800">{x.label}</T><Tag label={`${x.regime}${x.statutory ? '' : ' · discretionary'}`} color={c.violetSoft} /></Bar>
          <T size={13}>{x.person}</T>
          {x.detail ? <T size={13} color={c.mute}>“{x.detail}”</T> : null}
          <T size={12} weight={t.late ? '800' : '500'} color={t.late ? c.red : c.mute} style={{ marginTop: 4 }}>{t.text} · {STATE[x.status][1]}</T>
          <Bar style={{ marginTop: 8 }}>
            {x.status === 'open' ? <Btn small title="Start" color={c.cyan} onPress={async () => { try { await api.post(`/admin/health/privacy-requests/${x.id}/resolve`, { status: 'in_review', note: 'We are looking at your request.' }); q.reload(); } catch (e) { toast(e.message); } }} /> : null}
            <Btn small title="Answer" color={c.mint} ink={c.ink} onPress={() => setRes(x)} />
          </Bar>
        </Card>); }) : <Empty emoji="✅" title="No open requests" />}
      <FormSheet visible={!!res} onClose={() => setRes(null)} title={res ? `${res.label} · ${res.person}` : ''} color={c.violet} submitLabel="Send answer"
        fields={[{ key: 'status', label: 'Outcome', type: 'choice', options: [{ value: 'fulfilled', label: 'Done' }, { value: 'refused', label: 'Cannot do' }] }, { key: 'note', label: 'What the person will read', type: 'multiline', hint: ['restriction', 'erasure', 'withdraw_consent'].includes(res?.kind) ? 'Marking this done stops ALL sharing (every grant is revoked, kept in history). Say what must be retained and for how long.' : 'Say what was done, or why not.' }]}
        initial={{ status: 'fulfilled' }}
        onSubmit={async (v) => { await api.post(`/admin/health/privacy-requests/${res.id}/resolve`, { status: v.status, note: v.note }); setRes(null); q.reload(); return 'Answer sent'; }} />
    </View>
  );
}

const NOTICE = { pending: [c.violetSoft, 'Pending'], overdue_target: [c.sun, 'Past our target'], overdue_legal: [c.orange, 'Past legal deadline'], sent: [c.lime, 'Sent'], not_required: [c.violetSoft, 'Not required'] };
function BreachRegister({ toast }) {
  const q = useLoad(() => api.get('/admin/health/breaches'), []);
  const regimes = useLoad(() => api.get('/health-regimes'), []);
  const [form, setForm] = useState(false), [note, setNote] = useState(null);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const opts = (regimes.data?.regimes ?? []).map((x) => ({ value: x.code, label: `${x.flag} ${x.name}` }));
  return (
    <View style={{ gap: 8 }}>
      <Btn small title="Report a breach" color={c.orange} style={{ alignSelf: 'flex-start' }} onPress={() => setForm(true)} />
      {q.data.length ? q.data.map((b) => (
        <Card key={b.id} pad={12} color={b.worst === 'overdue_legal' ? c.pinkSoft : c.paper}>
          <Bar style={{ justifyContent: 'space-between' }}><T weight="800">{b.scope.replace('_', ' ')} · {b.affected_count} people</T><Tag label={b.status} color={c.cyan} /></Bar>
          <T size={12} color={c.mute}>Found {when(b.discovered_at)} · {b.severity} · {b.regimes.join(', ')}</T>
          <T size={13} style={{ marginTop: 4 }}>{b.summary}</T>
          {b.notices.map((n) => { const [col, label] = NOTICE[n.state]; return (
            <Row key={n.id} left={<T size={16}>{n.audience === 'regulator' ? '🏛️' : '👤'}</T>} title={`${n.country} · ${n.audience}`} sub={`${n.rule}${n.due_at ? ` · legal ${when(n.due_at)}` : ` · our target ${when(n.target_at)}`}`}
              right={n.state === 'sent' || n.state === 'not_required' ? <Tag label={label} color={col} /> : <Btn small title="Record" color={c.violet} onPress={() => setNote({ b, n })} />} />); })}
          {b.status !== 'closed' ? <Btn small title="Close breach" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={async () => { try { await api.post(`/admin/health/breaches/${b.id}`, { status: 'closed' }); q.reload(); } catch (e) { toast(e.message); } }} /> : null}
        </Card>)) : <Empty emoji="🛡️" title="No open breaches" />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Report a health-data breach" color={c.orange} submitLabel="Start the clocks"
        fields={[
          { key: 'discovered_at', label: 'When did we become aware?', type: 'date', hint: 'The clocks run from this moment (start of that day).' },
          { key: 'scope', label: 'What was exposed?', type: 'chips', options: [{ value: 'records', label: 'Records' }, { value: 'appointments', label: 'Appointments' }, { value: 'event_coverage', label: 'Event medical log' }, { value: 'credentials', label: 'Credentials' }, { value: 'other', label: 'Other' }] },
          { key: 'regimes', label: 'Whose people are affected?', type: 'multi', options: opts },
          { key: 'affected_count', label: 'How many people?', type: 'stepper', min: 0, max: 100000, step: 1, default: 1 },
          { key: 'severity', label: 'How serious?', type: 'choice', options: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
          { key: 'summary', label: 'What happened (internal)', type: 'multiline' }, { key: 'containment', label: 'What we did', type: 'multiline', optional: true }]}
        initial={{ severity: 'medium', scope: 'records' }}
        onSubmit={async (v) => { await api.post('/admin/health/breaches', { discovered_at: new Date(`${v.discovered_at}T00:00:00`).toISOString(), scope: v.scope, regimes: v.regimes, affected_count: Number(v.affected_count), severity: v.severity, summary: v.summary, ...(v.containment ? { containment: v.containment } : {}) }); setForm(false); q.reload(); return 'Recorded — the clocks are running'; }} />
      <FormSheet visible={!!note} onClose={() => setNote(null)} title={note ? `${note.n.country} · ${note.n.audience}` : ''} color={c.violet} submitLabel="Save"
        fields={[{ key: 'outcome', label: 'Outcome', type: 'choice', options: [{ value: 'sent', label: 'Notice sent' }, { value: 'not_required', label: 'Not required' }] },
          { key: 'reference', label: note?.n.audience === 'individuals' ? 'The notice people will read' : 'Regulator case number', type: note?.n.audience === 'individuals' ? 'multiline' : 'text', optional: true, show: (v) => v.outcome === 'sent' },
          { key: 'reason', label: 'Why no notice is needed', type: 'multiline', show: (v) => v.outcome === 'not_required' }]}
        initial={{ outcome: 'sent' }}
        onSubmit={async (v) => { await api.post(`/admin/health/breaches/${note.b.id}`, { notice: { regime: note.n.regime, audience: note.n.audience, outcome: v.outcome, ...(v.outcome === 'sent' ? { reference: v.reference } : { reason: v.reason }) } }); setNote(null); q.reload(); return 'Recorded'; }} />
    </View>
  );
}
