// Federation & Governing Body OS (#475): the Federations hub, the federation workspace (federation-home.js), the record detail and the public licence check.
// One place for everything federation: the bodies you run, your licences, your clubs' affiliations, a directory to find a body, and a way to check a licence.
// The server decides what each person may do; these screens show what it returns and hide what a role cannot use.
import React, { useEffect, useMemo, useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { CountryPicker, countryName } from '../country-picker';
import { SportsMulti, SportSelect, useSports } from '../sportpicker';
import { DateField } from '../pickers';
import { openPdf } from '../open-file';
import { CameraScan, hasCamera } from '../camera-scan';
import { locale } from '../locale';
import { t } from '../i18n';
import { explain, LoadError } from '../access';
import { c } from '../theme';
import { Banner, Checks, Evidence, History, StatusTag, ActionBar, DecisionSheet, LEVEL_LABEL, ROLE_LABEL, fmtDate, fmtRange, jurisdiction, money, issueDocument, todayIso, checksOf } from '../federation-ui';
import { Cols, Hero, ListCard, Row2 } from '../federation-bits';

export { FederationHome } from './federation-home';

const LEVELS = Object.entries(LEVEL_LABEL).map(([value, label]) => ({ value, label }));

// ------------------------------------------------------------------ set up a federation (elite 3-step wizard)
const RECOGNISED_BY_OPTS = ['IOC', 'IPC', 'GAISF', 'Government ministry', 'National Olympic Committee', 'None / independent'];
const MEMBER_TYPE_OPTS = ['Individual athlete', 'Club', 'Association', 'Regional body', 'National body'];
const FED_STEPS = ['Identity & Authority', 'Jurisdiction & Recognition', 'Structure & Launch'];

function FederationWizard({ visible, onClose, onDone }) {
  const { toast } = useSession();
  const sports = useSports();
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const owned = (orgs.data ?? []).filter((o) => o.my_status === 'active' && o.my_role === 'owner' && o.kind !== 'federation');
  const bySlug = useMemo(() => Object.fromEntries((sports.data ?? []).map((s) => [s.slug, s.id])), [sports.data]);
  const [step, setStep] = useState(0);
  const [v, setV] = useState({ mode: 'new', level: 'national', is_public: false, open_membership: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, val) => setV((p) => ({ ...p, [k]: val }));
  const toggle = (key, item) => set(key, (v[key] ?? []).includes(item) ? (v[key] ?? []).filter((x) => x !== item) : [...(v[key] ?? []), item]);

  const can = [
    (v.mode === 'existing' ? !!v.organisation_id : !!v.name?.trim()) && !!v.level && !!v.abbreviation?.trim() && !!(v.sports ?? []).length,
    !!v.country,
    true,
  ][step];

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body = {
        level: v.level, abbreviation: String(v.abbreviation ?? '').toUpperCase(),
        country: v.country || undefined, state: v.state || undefined, region: v.region || undefined,
        sports: (v.sports ?? []).map((slug) => ({ sport_id: bySlug[slug], discipline: v.discipline || '' })).filter((s) => s.sport_id),
        ...(v.mode === 'existing' ? { organisation_id: v.organisation_id } : { name: v.name, website: v.website || undefined }),
      };
      if (!body.sports.length) throw new Error('Choose the sports you govern');
      const b = await api.post('/federation/bodies', body);
      toast(`${b.name} is set up`); onClose(); onDone(b);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Set up a governing body">
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 16 }}>
        {FED_STEPS.map((s, i) => <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i < step ? c.violet : i === step ? c.pink : c.p1 }} />)}
      </View>
      <T weight="800" size={15} style={{ marginBottom: 12 }}>{FED_STEPS[step]}</T>

      {step === 0 ? (
        <View style={{ gap: 12 }}>
          {owned.length ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {[{ value: 'new', label: 'New organisation' }, { value: 'existing', label: 'One I own' }].map((opt) => (
                <Chip key={opt.value} label={opt.label} active={v.mode === opt.value} onPress={() => set('mode', opt.value)} />
              ))}
            </View>
          ) : null}
          {v.mode !== 'existing' ? (
            <Field label="Federation name *" value={v.name ?? ''} onChangeText={(x) => set('name', x)} placeholder="e.g. National Badminton Federation" />
          ) : (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {owned.map((o) => <Chip key={o.id} label={o.name} active={v.organisation_id === o.id} onPress={() => set('organisation_id', o.id)} />)}
            </View>
          )}
          <Field label="Abbreviation *" value={v.abbreviation ?? ''} onChangeText={(x) => set('abbreviation', x.toUpperCase())} placeholder="e.g. NBF" hint="2–8 letters or digits. Starts every licence and affiliation number." maxLength={8} />
          <T weight="700" size={13} style={{ marginTop: 4 }}>Governing level *</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {LEVELS.map((l) => <Chip key={l.value} label={l.label} active={v.level === l.value} onPress={() => set('level', l.value)} />)}
          </View>
          <SportsMulti label="Sports governed *" value={v.sports ?? []} onChange={(x) => set('sports', x)} />
          <Field label="Discipline" value={v.discipline ?? ''} onChangeText={(x) => set('discipline', x)} placeholder="e.g. 7s, Singles" hint="If you govern one discipline only." optional />
          <Field label="Founded year" value={v.founded_year ?? ''} onChangeText={(x) => set('founded_year', x)} placeholder="e.g. 1948" optional />
        </View>
      ) : null}

      {step === 1 ? (
        <View style={{ gap: 12 }}>
          <Field label="Country *" value={v.country ?? ''} onChangeText={(x) => set('country', x)} placeholder="e.g. India, Australia" hint="Primary country this body governs." />
          <Field label="State or province" value={v.state ?? ''} onChangeText={(x) => set('state', x)} optional />
          <Field label="Region" value={v.region ?? ''} onChangeText={(x) => set('region', x)} optional />
          <T weight="700" size={13} style={{ marginTop: 4 }}>Recognised by</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {RECOGNISED_BY_OPTS.map((r) => <Chip key={r} label={r} active={(v.recognised_by ?? []).includes(r)} onPress={() => toggle('recognised_by', r)} />)}
          </View>
          {v.mode !== 'existing' ? <Field label="Website" value={v.website ?? ''} onChangeText={(x) => set('website', x)} placeholder="https://" optional /> : null}
          <Field label="Affiliation code" value={v.affiliation_code ?? ''} onChangeText={(x) => set('affiliation_code', x)} hint="Assigned by parent body, if any." optional />
        </View>
      ) : null}

      {step === 2 ? (
        <View style={{ gap: 12 }}>
          <T weight="700" size={13}>Membership types</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {MEMBER_TYPE_OPTS.map((m) => <Chip key={m} label={m} active={(v.member_types ?? []).includes(m)} onPress={() => toggle('member_types', m)} />)}
          </View>
          <Card color={c.p1} style={{ padding: 12, gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <T size={14}>List in governing body directory</T>
              <Switch value={!!v.is_public} onValueChange={(x) => set('is_public', x)} trackColor={{ false: c.line, true: c.pink }} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <T size={14}>Open to membership applications</T>
              <Switch value={!!v.open_membership} onValueChange={(x) => set('open_membership', x)} trackColor={{ false: c.line, true: c.pink }} />
            </View>
          </Card>
          <Card color={c.cyanSoft} style={{ padding: 12 }}>
            <T weight="700" size={14}>{v.mode !== 'existing' ? (v.name ?? '—') : (owned.find((o) => o.id === v.organisation_id)?.name ?? '—')}</T>
            <T size={12} color={c.mute}>{LEVEL_LABEL[v.level] ?? v.level} · {v.abbreviation ?? '—'}{v.country ? ` · ${v.country}` : ''}</T>
            <T size={12} color={c.mute}>{(v.sports ?? []).length} sport{(v.sports ?? []).length !== 1 ? 's' : ''} governed</T>
          </Card>
          {err ? <T color={c.red} size={13}>{err}</T> : null}
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
        {step > 0 ? <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setStep((s) => s - 1)} style={{ flex: 1 }} /> : null}
        {step < 2 ? <Btn title="Next" disabled={!can} onPress={() => setStep((s) => s + 1)} style={{ flex: 1 }} /> : (
          <Btn title="Create federation" loading={busy} disabled={!can || busy} onPress={submit} style={{ flex: 1 }} />
        )}
      </View>
    </Sheet>
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

      <FederationWizard visible={setup} onClose={() => setSetup(false)} onDone={(b) => { mine.reload(); push('FederationHome', { id: b.id }); }} />
      <ProfileSheet id={profile} onClose={() => setProfile(null)} />
    </Screen>
  );
}

// ------------------------------------------------------------------ public licence check
/** A printed code (12 letters and digits), a card QR token, or a link that carries either: the value the check takes. */
const checkValue = (raw) => {
  const s = String(raw ?? '').trim();
  try { const v = new URL(s).searchParams.get('verify'); if (v) return checkValue(v); } catch { /* not a link */ }
  return /^LC1\./.test(s) ? s : s.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 12);
};
export function VerifyLicence({ code: initial }) {
  const [code, setCode] = useState(initial ? checkValue(initial) : '');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(false);
  const clean = checkValue(code);
  const ready = clean.length === 12 || /^LC1\./.test(clean);
  const check = async (value = clean) => {
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await api.get(`/federation/verify/${encodeURIComponent(value)}`)); } catch (e) { setErr(e.status === 404 ? t('fedx.verify.notFound') : e.status === 410 ? t('fedx.verify.expired') : explain(e)); } finally { setBusy(false); }
  };
  useEffect(() => { if (initial && (checkValue(initial).length === 12 || /^LC1\./.test(checkValue(initial)))) check(checkValue(initial)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Screen>
      <H1>{t('fedx.verify.title')}</H1>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>{t('fedx.verify.hint')}</T>
      <View style={{ gap: 12, marginTop: 14 }}>
        {scan && hasCamera ? <CameraScan onClose={() => setScan(false)} onCode={(v) => { setScan(false); setCode(checkValue(v)); check(checkValue(v)); }} /> : null}
        <Field label={t('fedx.verify.label')} value={/^LC1\./.test(clean) ? t('fedx.verify.cardCode') : clean} onChangeText={(x) => { setCode(x); setRes(null); setErr(null); }} placeholder="A1B2C3D4E5F6" maxLength={12} accessibilityLabel={t('fedx.verify.label')} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Btn title={t('fedx.verify.button')} loading={busy} disabled={!ready} onPress={() => check()} />
          {hasCamera && !scan ? <Btn color={c.paper} ink={c.ink} title={t('fedx.verify.scan')} onPress={() => setScan(true)} accessibilityLabel={t('fedx.verify.scan')} /> : null}
        </View>
        {err ? <Banner tone={c.pinkSoft}>{err}</Banner> : null}
        {res ? (
          <Card color={res.valid ? c.mintSoft : c.pinkSoft} pad={18}>
            <View accessible accessibilityLiveRegion="polite" accessibilityLabel={`${res.valid ? t('fedx.verify.good') : t('fedx.verify.notGood')}: ${res.type_name}, ${res.status}`}>
              <T size={22} weight="800">{res.valid ? `✓ ${t('fedx.verify.good')}` : `✕ ${t('fedx.verify.notGood')}`}</T>
              <View style={{ marginTop: 6 }}><StatusTag status={res.status} /></View>
              <View style={{ marginTop: 12 }}>
                <Row2 k={t('fedx.verify.holder')} v={res.holder_name} /><Row2 k={t('fedx.verify.licence')} v={`${res.type_name}${res.grade ? ` · ${res.grade}` : ''}`} /><Row2 k={t('fedx.card.sport')} v={`${res.sport_name}${res.discipline ? ` · ${res.discipline}` : ''}`} />
                <Row2 k={t('fedx.card.number')} v={res.licence_no} /><Row2 k={t('fedx.card.validity')} v={fmtRange(res.issued_on, res.expires_on)} /><Row2 k={t('fedx.verify.issuer')} v={`${res.body_name} (${res.body_abbreviation})`} />
              </View>
              {res.checked_at ? <T size={11} color={c.mute} style={{ marginTop: 8 }}>{t('fedx.verify.checkedAt', { time: new Date(res.checked_at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) })}</T> : null}
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
