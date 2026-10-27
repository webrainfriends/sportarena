// Federation & Governing Body OS (#475): the Federations hub, the federation workspace (federation-home.js), the record detail and the public licence check.
// One place for everything federation: the bodies you run, your licences, your clubs' affiliations, a directory to find a body, and a way to check a licence.
// The server decides what each person may do; these screens show what it returns and hide what a role cannot use.
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { CountryPicker, countryName } from '../country-picker';
import { SportSelect, useSports } from '../sportpicker';
import { DateField } from '../pickers';
import { openPdf } from '../open-file';
import { explain, LoadError } from '../access';
import { c } from '../theme';
import { Banner, Checks, Evidence, History, StatusTag, ActionBar, DecisionSheet, LEVEL_LABEL, ROLE_LABEL, fmtDate, fmtRange, jurisdiction, money, issueDocument, todayIso, checksOf } from '../federation-ui';
import { Cols, Hero, ListCard, Row2 } from '../federation-bits';

export { FederationHome } from './federation-home';

const LEVELS = Object.entries(LEVEL_LABEL).map(([value, label]) => ({ value, label }));

// ------------------------------------------------------------------ set up a federation
function SetupSheet({ visible, onClose, onDone }) {
  const { toast } = useSession();
  const sports = useSports();
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const owned = (orgs.data ?? []).filter((o) => o.my_status === 'active' && o.my_role === 'owner' && o.kind !== 'federation');
  const bySlug = useMemo(() => Object.fromEntries((sports.data ?? []).map((s) => [s.slug, s.id])), [sports.data]);
  const fields = [
    { key: 'mode', label: 'Start from', type: 'choice', options: [{ value: 'new', label: 'A new organisation' }, ...(owned.length ? [{ value: 'existing', label: 'One I own' }] : [])] },
    { key: 'name', label: 'Name of the federation, association or league', show: (v) => v.mode !== 'existing' },
    { key: 'organisation_id', label: 'Which organisation', type: 'chips', options: owned.map((o) => ({ value: o.id, label: o.name })), show: (v) => v.mode === 'existing' },
    { key: 'level', label: 'Governing level', type: 'chips', options: LEVELS, default: 'national' },
    { key: 'abbreviation', label: 'Abbreviation', hint: '2 to 8 letters or digits. It starts every affiliation, licence and sanction number.', maxLength: 8 },
    { key: 'country', label: 'Country', type: 'country', optional: true },
    { key: 'state', label: 'State or province', optional: true },
    { key: 'region', label: 'Region', optional: true },
    { key: 'district', label: 'District', optional: true },
    { key: 'sports', label: 'Sports governed', type: 'sports' },
    { key: 'discipline', label: 'Discipline (optional)', optional: true, hint: 'If you govern one discipline of these sports, for example Singles or 7s.' },
    { key: 'website', label: 'Website', type: 'url', optional: true, show: (v) => v.mode !== 'existing' },
    { key: 'contact_email', label: 'Public contact email', type: 'email', optional: true, show: (v) => v.mode !== 'existing' },
  ];
  return (
    <FormSheet visible={visible} onClose={onClose} title="Set up a governing body" fields={fields} initial={{ mode: 'new', level: 'national' }} submitLabel="Create"
      onSubmit={async (v) => {
        const body = {
          level: v.level, abbreviation: String(v.abbreviation ?? '').toUpperCase(), country: v.country || undefined, state: v.state || undefined, region: v.region || undefined, district: v.district || undefined,
          sports: (v.sports ?? []).map((slug) => ({ sport_id: bySlug[slug], discipline: v.discipline || '' })).filter((s) => s.sport_id),
          ...(v.mode === 'existing' ? { organisation_id: v.organisation_id } : { name: v.name, website: v.website || undefined, contact_email: v.contact_email || undefined }),
        };
        if (!body.sports.length) throw new Error('Choose the sports you govern');
        const b = await api.post('/federation/bodies', body);
        toast(`${b.name} is set up`); onDone(b);
      }} />
  );
}

// ------------------------------------------------------------------ public profile of a body
function ProfileSheet({ id, onClose }) {
  const { push } = useNav();
  const d = useLoad(() => (id ? api.get(`/federation/bodies/${id}`) : Promise.resolve(null)), [id]);
  const [reg, setReg] = useState(null);
  useEffect(() => { setReg(null); }, [id]);
  const b = d.data;
  const go = (name, params) => { onClose(); push(name, params); };
  return (
    <Sheet visible={!!id} onClose={onClose} title={b?.name ?? 'Governing body'}>
      {d.error ? <LoadError error={d.error} onRetry={d.reload} /> : !b ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={LEVEL_LABEL[b.level]} color={c.cyan} /><Tag label={b.abbreviation} /></View>
          <T size={13} color={c.mute}>{jurisdiction(b)}{b.parent ? `${jurisdiction(b) ? ' · ' : ''}Recognised under ${b.parent.name}` : ''}</T>
          {b.description ? <T size={14}>{b.description}</T> : null}
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{b.sports.map((s) => <Chip key={s.id} label={`${s.emoji ?? ''} ${s.sport_name}${s.discipline ? ` · ${s.discipline}` : ''}`} />)}</View>
          {b.website || b.contact_email ? <T size={13} color={c.mute}>{[b.website, b.contact_email, b.contact_phone].filter(Boolean).join(' · ')}</T> : null}
          {b.categories.length ? (
            <Card color={c.paper}><T weight="700" size={14}>Affiliation</T>
              {b.categories.map((k) => <T key={k.id} size={13} color={c.mute} style={{ marginTop: 4 }}>{k.name}{k.fee_minor ? ` · ${money(k.fee_minor, k.currency)}` : ' · no fee'} · {k.duration_months} months</T>)}</Card>) : null}
          {b.licence_types.length ? (
            <Card color={c.paper}><T weight="700" size={14}>Licences</T>
              {b.licence_types.map((k) => <T key={k.id} size={13} color={c.mute} style={{ marginTop: 4 }}>{k.name} · {k.sport_name}{k.grade ? ` · ${k.grade}` : ''}{k.fee_minor ? ` · ${money(k.fee_minor, k.currency)}` : ''}</T>)}</Card>) : null}
          {b.children.length ? <Card color={c.paper}><T weight="700" size={14}>Recognised bodies</T>{b.children.map((k) => <T key={k.id} size={13} color={c.mute} style={{ marginTop: 4 }}>{k.name} · {LEVEL_LABEL[k.level]}</T>)}</Card> : null}
          {reg ? (
            <Card color={c.paper}><T weight="700" size={14}>Affiliated organisations</T>
              {reg.length ? reg.map((r) => <T key={r.id} size={13} color={c.mute} style={{ marginTop: 4 }}>{r.name} · {r.affiliation_no} · valid to {fmtDate(r.effective_to)}</T>) : <T size={13} color={c.mute}>None yet.</T>}</Card>)
            : <Btn small title="See affiliated organisations" color={c.paper} ink={c.ink} onPress={async () => setReg(await api.get(`/federation/bodies/${id}/affiliated`, { include_descendants: true, limit: 50 }).catch(() => []))} style={{ alignSelf: 'flex-start' }} />}
          {b.me ? <Btn title="Open the workspace" onPress={() => go('FederationHome', { id })} /> : null}
          {b.categories.length ? <Btn title="Apply for affiliation" color={c.violet} onPress={() => go('OrgAffiliations', { body_id: id })} /> : null}
          {b.licence_types.length ? <Btn title="Apply for a licence" color={c.violet} onPress={() => go('MyLicences', { body_id: id })} /> : null}
        </View>)}
    </Sheet>
  );
}

// ------------------------------------------------------------------ the hub
export function Federations() {
  const { push } = useNav();
  const [setup, setSetup] = useState(false);
  const [profile, setProfile] = useState(null);
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [level, setLevel] = useState(null);
  const [sport, setSport] = useState(null);
  const [country, setCountry] = useState('');
  const sports = useSports();
  const sportId = sports.data?.find((s) => s.slug === sport)?.id;
  useEffect(() => { const t = setTimeout(() => setQ(typed.trim()), 300); return () => clearTimeout(t); }, [typed]);
  const mine = useLoad(() => api.get('/federation/mine', { limit: 50 }), []);
  const lic = useLoad(() => api.get('/federation/licences', { mine: true, limit: 3 }).catch(() => ({ total: 0, items: [] })), []);
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const dir = useLoad(() => api.get('/federation/bodies', { q: q || undefined, level: level || undefined, sport_id: sportId || undefined, country: country || undefined, limit: 20 }), [q, level, sportId, country]);
  const clubs = (orgs.data ?? []).filter((o) => o.my_status === 'active' && ['owner', 'admin'].includes(o.my_role) && o.kind !== 'federation');
  if (mine.error && !mine.data) return <Screen><H1>Federations</H1><LoadError error={mine.error} onRetry={mine.reload} /></Screen>;
  return (
    <Screen refreshing={mine.loading && !!mine.data} onRefresh={() => { mine.reload(); lic.reload(); dir.reload(); }} wide>
      <H1>Federations</H1>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>Affiliations, licences and sanctions in one place: run a governing body, keep your licences in good standing, or find the body that governs your sport.</T>

      <Section title="Your governing bodies" color={c.cyan} action="Set up" onAction={() => setSetup(true)}>
        {!mine.data ? <Loading /> : mine.data.length ? mine.data.map((b) => (
          <ListCard key={b.id} title={b.name} sub={`${LEVEL_LABEL[b.level]} · ${b.abbreviation}${jurisdiction(b) ? ` · ${jurisdiction(b)}` : ''}`}
            sub2={[b.org_role ? (b.org_role === 'owner' ? 'Owner' : 'Admin') : null, ...(b.roles ?? []).map((r) => ROLE_LABEL[r])].filter(Boolean).join(' · ')} status={b.body_status !== 'active' ? b.body_status : undefined}
            onPress={() => push('FederationHome', { id: b.id })} label={`${b.name}, open workspace`} />))
          : <Empty emoji="🏛️" title="You do not run a governing body yet" sub="Set up a federation, association or league to take affiliations, issue licences and sanction competitions." />}
        {mine.data && !mine.data.length ? <Btn title="Set up a governing body" onPress={() => setSetup(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>

      <Section title="My licences" color={c.mint} action="All licences" onAction={() => push('MyLicences')}>
        {!lic.data ? <Loading /> : lic.data.items.length ? lic.data.items.map((l) => (
          <ListCard key={l.id} title={`${l.type_name}${l.grade ? ` · ${l.grade}` : ''}`} sub={`${l.body_name} · ${l.sport_name}`} sub2={l.expires_on ? `${l.licence_no} · valid to ${fmtDate(l.expires_on)}` : undefined}
            status={l.standing === 'good_standing' ? 'good_standing' : l.status} onPress={() => push('FederationRecord', { type: 'licence', id: l.id })} />))
          : <Empty emoji="🪪" title="No licences yet" sub="Apply to the body that governs your sport. A guardian applies for a young person." />}
        {lic.data && !lic.data.items.length ? <Btn title="Apply for a licence" color={c.violet} onPress={() => push('MyLicences')} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>

      {clubs.length ? (
        <Section title="Club affiliations" color={c.sun}>
          {clubs.map((o) => <ListCard key={o.id} title={o.name} sub={`${o.kind} · ${o.my_role}`} right={<T size={12} color={c.pink} weight="700">Affiliations ›</T>} onPress={() => push('OrgAffiliations', { organisation_id: o.id })} />)}
        </Section>) : null}

      <Section title="Check a licence" color={c.orange}>
        <ListCard title="Verify a licence code" sub="Officials, clubs and organisers can confirm a licence is genuine and in good standing." onPress={() => push('VerifyLicence')} right={<T size={12} color={c.pink} weight="700">Check ›</T>} />
      </Section>

      <Section title="Find a federation" color={c.pink}>
        <Field value={typed} onChangeText={setTyped} placeholder="Search by name or abbreviation" accessibilityLabel="Search governing bodies" />
        <Seg options={[{ value: null, label: 'Any level' }, ...LEVELS]} value={level} onChange={setLevel} />
        <SportSelect label="Sport" value={sport} onChange={setSport} optional allLabel="Any sport" />
        <CountryPicker label="Country" value={country} onChange={setCountry} optional />
        {dir.error ? <LoadError error={dir.error} onRetry={dir.reload} /> : !dir.data ? <Loading /> : dir.data.length ? dir.data.map((b) => (
          <ListCard key={b.id} title={b.name} sub={`${LEVEL_LABEL[b.level]} · ${b.abbreviation}${b.country ? ` · ${countryName(b.country)}` : ''}${b.parent_name ? ` · under ${b.parent_name}` : ''}`}
            sub2={(b.sports ?? []).map((s) => s.name).join(', ')} onPress={() => setProfile(b.id)} label={`${b.name}, view profile`} />))
          : <Empty emoji="🔎" title="No governing body found" sub="Try another name, sport or level." />}
      </Section>

      <SetupSheet visible={setup} onClose={() => setSetup(false)} onDone={(b) => { mine.reload(); push('FederationHome', { id: b.id }); }} />
      <ProfileSheet id={profile} onClose={() => setProfile(null)} />
    </Screen>
  );
}

// ------------------------------------------------------------------ public licence check
export function VerifyLicence() {
  const [code, setCode] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const clean = code.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 12);
  const check = async () => {
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await api.get(`/federation/verify/${clean}`)); } catch (e) { setErr(e.status === 404 ? 'No licence has that code. Check the code printed on the licence and try again.' : explain(e)); } finally { setBusy(false); }
  };
  return (
    <Screen>
      <H1>Check a licence</H1>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>Enter the 12-character code printed on a licence to see whether it is in good standing today.</T>
      <View style={{ gap: 12, marginTop: 14 }}>
        <Field label="Licence code" value={clean} onChangeText={(x) => { setCode(x); setRes(null); setErr(null); }} placeholder="A1B2C3D4E5F6" maxLength={12} accessibilityLabel="Licence code, 12 letters and digits" />
        <Btn title="Check licence" loading={busy} disabled={clean.length !== 12} onPress={check} />
        {err ? <Banner tone={c.pinkSoft}>{err}</Banner> : null}
        {res ? (
          <Card color={res.valid ? c.mintSoft : c.pinkSoft} pad={18}>
            <View accessible accessibilityLiveRegion="polite" accessibilityLabel={`${res.valid ? 'Valid' : 'Not valid'}: ${res.type_name}, ${res.status}`}>
              <T size={22} weight="800">{res.valid ? '✓ In good standing' : '✕ Not in good standing'}</T>
              <View style={{ marginTop: 6 }}><StatusTag status={res.status} /></View>
              <View style={{ marginTop: 12 }}>
                <Row2 k="Holder" v={res.holder_name} /><Row2 k="Licence" v={`${res.type_name}${res.grade ? ` · ${res.grade}` : ''}`} /><Row2 k="Sport" v={`${res.sport_name}${res.discipline ? ` · ${res.discipline}` : ''}`} />
                <Row2 k="Number" v={res.licence_no} /><Row2 k="Valid" v={fmtRange(res.issued_on, res.expires_on)} /><Row2 k="Issued by" v={`${res.body_name} (${res.body_abbreviation})`} />
              </View>
            </View>
          </Card>) : null}
      </View>
    </Screen>
  );
}

// ------------------------------------------------------------------ one record
const KIND = { affiliation: 'affiliations', licence: 'licences', sanction: 'sanctions' };
const IN_FORCE = { affiliation: 'approved', licence: 'active', sanction: 'approved' };
const PARTY_ACTIONS = ['submit', 'withdraw', 'renew', 'amend', 'resubmit'];

/** Approving a sanction also sets the approved categories and conditions; everything else is the shared decision sheet. */
function SanctionApprove({ visible, onClose, record, onDone }) {
  const { toast } = useSession();
  const [cats, setCats] = useState('');
  const [conds, setConds] = useState('');
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [override, setOverride] = useState('');
  const [failed, setFailed] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setCats((record.categories ?? []).join(', ')); setConds(''); setFrom(null); setTo(null); setOverride(''); setFailed(null); } }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = (s, sep) => s.split(sep).map((x) => x.trim()).filter(Boolean);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/federation/sanctions/${record.id}/decision`, { action: 'approve', version: record.row_version, approved_categories: list(cats, ','), conditions: list(conds, '\n'),
        ...(from ? { approved_starts_on: from } : {}), ...(to ? { approved_ends_on: to } : {}), ...(override ? { override_reason: override } : {}) });
      toast('Sanction approved'); onClose(); onDone();
    } catch (e) { const ch = checksOf(e); if (ch) setFailed(ch); else toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Approve sanction">
      <View style={{ gap: 12 }}>
        <Field label="Approved categories (comma separated)" value={cats} onChangeText={setCats} hint="Defaults to what the organiser asked for." />
        <Field label="Conditions (one per line)" value={conds} onChangeText={setConds} multiline minHeight={90} />
        <DateField label="Approved from" value={from} onChange={setFrom} optional hint={`Defaults to ${fmtDate(record.requested_starts_on)}`} />
        <DateField label="Approved to" value={to} onChange={setTo} optional min={from ?? undefined} />
        {failed ? (<><Checks checks={failed} title="Not all conditions are met" /><Field label="Approve anyway — record why (logged as a compliance exception)" value={override} onChangeText={setOverride} multiline maxLength={500} /></>) : null}
        <Btn title={failed ? 'Approve with override' : 'Approve'} loading={busy} disabled={!!failed && override.trim().length < 5} onPress={submit} />
      </View>
    </Sheet>
  );
}

export function FederationRecord({ type, id }) {
  const { toast } = useSession();
  const nav = useNav();
  const kind = KIND[type];
  const rec = useLoad(() => api.get(`/federation/${kind}/${id}`), [kind, id]);
  const docs = useLoad(() => api.get('/federation/documents', { subject_type: type, subject_id: id }).catch(() => []), [type, id]);
  const [act, setAct] = useState(null);
  const [fee, setFee] = useState(false);
  const [amend, setAmend] = useState(false);
  const [why, setWhy] = useState(null);       // withdraw
  const [busy, setBusy] = useState(null);
  const reload = () => { rec.reload(); docs.reload(); };
  const r = rec.data;
  if (rec.error && !r) return <Screen><H1>Record</H1><LoadError error={rec.error} onRetry={rec.reload} /></Screen>;
  if (!r) return <Screen><Loading /></Screen>;

  const party = r.as.party, staff = r.as.staff;
  const title = type === 'affiliation' ? r.organisation_name : type === 'licence' ? `${r.holder_name} · ${r.type_name}` : r.event_name;
  const number = r.affiliation_no ?? r.licence_no ?? r.sanction_no;
  const can = (a) => r.actions.includes(a);
  const call = async (path, body, msg) => { setBusy(path); try { const out = await api.post(`/federation/${kind}/${id}/${path}`, body ?? {}); toast(msg); return out; } catch (e) { toast(explain(e)); return null; } finally { setBusy(null); } };
  const checks = r.preview ?? (r.decided_checks?.length ? r.decided_checks : null);
  const partyBtns = PARTY_ACTIONS.filter((a) => can(a));
  const required = r.requirements?.required_documents ?? [];
  const canEditEvidence = party && (can('submit') || can('amend'));

  const facts = (
    <Card color={c.paper}>
      {type === 'affiliation' ? (<><Row2 k="Organisation" v={r.organisation_name} /><Row2 k="Category" v={r.category_name} /><Row2 k="Sport" v={r.sport_name} /><Row2 k="Season" v={r.season_year} /><Row2 k="Valid" v={r.effective_from ? fmtRange(r.effective_from, r.effective_to) : null} />
        <Row2 k="Expires in" v={r.days_to_expiry !== null && r.days_to_expiry !== undefined && r.status === 'approved' ? `${r.days_to_expiry} days` : null} /></>) : null}
      {type === 'licence' ? (<><Row2 k="Holder" v={r.holder_name} /><Row2 k="Licence" v={r.type_name} /><Row2 k="Role" v={r.holder_role} /><Row2 k="Sport" v={`${r.sport_name}${r.discipline ? ` · ${r.discipline}` : ''}`} /><Row2 k="Grade" v={r.grade} />
        <Row2 k="Valid" v={r.issued_on ? fmtRange(r.issued_on, r.expires_on) : null} /><Row2 k="Club" v={r.affiliation_no} /><Row2 k="Standing" v={r.standing?.replace('_', ' ')} />
        <Row2 k="Check code" v={r.public_code} /><Row2 k="Suspended until" v={r.suspended_until ? fmtDate(r.suspended_until) : null} /></>) : null}
      {type === 'sanction' ? (<><Row2 k="Competition" v={r.event_name} /><Row2 k="Sport" v={r.sport_name} /><Row2 k="Requested" v={fmtRange(r.requested_starts_on, r.requested_ends_on)} /><Row2 k="Approved" v={r.approved_starts_on ? fmtRange(r.approved_starts_on, r.approved_ends_on) : null} />
        <Row2 k="Categories" v={(r.approved_categories ?? r.categories ?? []).join(', ')} /><Row2 k="Rules" v={r.ruleset_label ? `${r.ruleset_label} v${r.ruleset_version}` : null} /></>) : null}
      <Row2 k="Fee" v={r.fee_minor ? `${money(r.fee_minor, r.fee_currency)} · ${r.fee_status}` : null} />
      <Row2 k="Decided" v={r.decided_at ? fmtDate(r.decided_at) : null} /><Row2 k="Reason" v={r.decision_reason} />
      {r.requirements ? <T size={11.5} color={c.mute} style={{ marginTop: 8 }}>Judged against “{r.requirements.policy_title}” version {r.requirements.version}{r.requirements.inherited ? ' (from the body above)' : ''}.</T> : null}
    </Card>
  );

  return (
    <Screen refreshing={rec.loading} onRefresh={reload} wide>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <StatusTag status={r.status} />{number ? <Tag label={number} /> : null}<Tag label={r.body_abbreviation} color={c.cyan} />
      </View>
      <H1 style={{ marginTop: 8 }}>{title}</H1>
      <T size={13} color={c.mute}>{r.body_name} · {type === 'affiliation' ? 'Affiliation' : type === 'licence' ? 'Licence' : 'Sanction'}</T>

      <View style={{ gap: 12, marginTop: 14 }}>
        {r.override_reason ? <Banner tone={c.sunSoft}>Compliance exception: approved although a requirement was not met. Reason recorded: {r.override_reason}</Banner> : null}
        {r.drift ? <Banner tone={c.pinkSoft}>The event has moved outside the sanctioned dates or been cancelled. Review this sanction.</Banner> : null}
        {r.status === 'needs_info' ? <Banner>More information was requested{r.decision_reason ? `: ${r.decision_reason}` : ''}. {party ? 'Add what is needed and send it back.' : ''}</Banner> : null}

        {(partyBtns.length || r.actions.length) ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {can('submit') ? <Btn small title={r.status === 'needs_info' ? 'Send back' : 'Submit'} loading={busy === 'submit'} onPress={async () => { if (await call('submit', {}, 'Submitted')) reload(); }} /> : null}
            {can('resubmit') ? <Btn small title="Send back for review" onPress={async () => { try { await api.patch(`/federation/sanctions/${id}`, { resubmit: true }); toast('Sent back for review'); reload(); } catch (e) { toast(explain(e)); } }} /> : null}
            {can('amend') ? <Btn small title="Change request" color={c.violet} onPress={() => setAmend(true)} /> : null}
            {can('renew') ? <Btn small title="Renew" color={c.violet} loading={busy === 'renew'} onPress={async () => { const n = await call('renew', {}, 'Renewal started'); if (n) nav.replace('FederationRecord', { type, id: n.id }); }} /> : null}
            {can('withdraw') ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => setWhy('')} /> : null}
          </View>) : null}
        {staff ? <ActionBar kind={kind} record={r} onAct={setAct} onDocument={r.status === IN_FORCE[type] ? async () => { setBusy('doc'); try { await issueDocument(type, id); docs.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } } : undefined} documentLabel={type === 'affiliation' ? 'Issue certificate' : type === 'licence' ? 'Issue licence document' : 'Issue sanction letter'} busy={busy === 'doc'} /> : null}
        {staff && can('record_fee') && r.fee_status === 'due' ? <Btn small title="Record fee" color={c.paper} ink={c.ink} onPress={() => setFee(true)} style={{ alignSelf: 'flex-start' }} /> : null}
        {party && !staff && r.status === IN_FORCE[type] ? <Btn small title="Get my document" color={c.paper} ink={c.ink} loading={busy === 'doc'} style={{ alignSelf: 'flex-start' }} onPress={async () => { setBusy('doc'); try { await issueDocument(type, id); docs.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } }} /> : null}
      </View>

      <View style={{ marginTop: 14 }}>
        <Cols
          a={<>
            {type === 'sanction' ? (
              <Card color={c.paper} onPress={() => nav.push('Event', { id: r.event_id })} accessibilityLabel={`Open the event ${r.event_name}`}>
                <T weight="700" size={14}>The event</T><T size={13} style={{ marginTop: 4 }}>{r.event_name}</T>
                <T size={12} color={c.mute}>{fmtRange(r.event_starts_on, r.event_ends_on)}{r.venue_name ? ` · ${r.venue_name}` : ''}{r.event_city ? ` · ${r.event_city}` : ''}</T>
                <T size={12} color={c.pink} weight="700" style={{ marginTop: 6 }}>Open event ›</T>
              </Card>) : null}
            {facts}
            {type === 'sanction' && r.conditions?.length ? <Card color={c.paper}><T weight="700" size={14}>Conditions</T>{r.conditions.map((x, n) => <T key={n} size={13} style={{ marginTop: 4 }}>{n + 1}. {x}</T>)}</Card> : null}
            <Checks checks={checks} title={r.preview ? 'Requirements right now' : 'Requirements at the decision'} />
          </>}
          b={<>
            <Evidence type={type} id={id} items={r.evidence} canAdd={canEditEvidence} canRead={party || staff} required={required} onChanged={reload} />
            {docs.data?.length ? (
              <Card color={c.paper}><T weight="700" size={14}>Documents issued</T>
                {docs.data.map((d) => (
                  <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <View style={{ flex: 1 }}><T size={13} weight="600">PDF · {d.pages} page{d.pages === 1 ? '' : 's'}</T><T size={12} color={c.mute}>Issued {fmtDate(d.created_at)}</T></View>
                    <Btn small title="Open" color={c.paper} ink={c.ink} onPress={async () => { try { await openPdf(`/branded-documents/${d.id}/file`, `${type}-${d.id.slice(0, 8)}`); } catch (e) { toast(explain(e)); } }} />
                  </View>))}
              </Card>) : null}
            <History history={r.history} />
          </>} />
      </View>

      {act && !(type === 'sanction' && act === 'approve') ? <DecisionSheet visible onClose={() => setAct(null)} kind={kind} record={r} action={act} onDone={reload} /> : null}
      {type === 'sanction' ? <SanctionApprove visible={act === 'approve'} onClose={() => setAct(null)} record={r} onDone={reload} /> : null}
      <FormSheet visible={fee} onClose={() => setFee(false)} title="Record the fee" submitLabel="Record"
        fields={[{ key: 'status', label: 'Outcome', type: 'chips', options: [{ value: 'paid', label: 'Paid' }, { value: 'waived', label: 'Waived' }] },
          { key: 'paid_on', label: 'Paid on', type: 'date', optional: true, show: (v) => v.status === 'paid' }, { key: 'reference', label: 'Your reference', optional: true, show: (v) => v.status === 'paid' },
          { key: 'reason', label: 'Why is it waived?', multiline: true, show: (v) => v.status === 'waived', optional: true }]}
        initial={{ status: 'paid', paid_on: todayIso() }} onSubmit={async (v) => { await api.post(`/federation/${kind}/${id}/fee`, v); reload(); return 'Fee recorded'; }} />
      <FormSheet visible={amend} onClose={() => setAmend(false)} title="Change the request" submitLabel="Save" fields={[
        { key: 'categories', label: 'Categories (comma separated)', optional: true }, { key: 'range', label: 'Dates', type: 'daterange', toKey: 'to', optional: true }, { key: 'note', label: 'Note', multiline: true, optional: true }]}
        initial={{ categories: (r.categories ?? []).join(', '), range: r.requested_starts_on, to: r.requested_ends_on, note: '' }}
        onSubmit={async (v) => { await api.patch(`/federation/sanctions/${id}`, { ...(v.categories !== undefined ? { categories: v.categories.split(',').map((x) => x.trim()).filter(Boolean) } : {}), ...(v.range ? { starts_on: v.range, ends_on: v.to } : {}), ...(v.note ? { note: v.note } : {}) }); reload(); return 'Request updated'; }} />
      <Sheet visible={why !== null} onClose={() => setWhy(null)} title="Withdraw">
        <View style={{ gap: 12 }}>
          <T size={13} color={c.mute}>The record and its history stay. You can apply again later.</T>
          <Field label="Reason (optional)" value={why ?? ''} onChangeText={setWhy} multiline maxLength={500} />
          <Btn title="Withdraw" color={c.red} loading={busy === 'withdraw'} onPress={async () => { if (await call('withdraw', why ? { reason: why } : {}, 'Withdrawn')) { setWhy(null); reload(); } }} />
        </View>
      </Sheet>
    </Screen>
  );
}
