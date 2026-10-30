// Federation & Governing Body OS (#475): the CLUB, PERSON and ORGANISER side. A club applies to a governing body and keeps its affiliation current
// (OrgAffiliations); a person holds licences, for themselves and for young people they are a verified guardian of (MyLicences); an organiser asks a body to
// sanction an event from the event console (EventSanctions). Every record opens in the one shared detail screen (FederationRecord), and every rule is
// decided by the server: this only shows what it returns and hides what a role cannot use.
import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { A, ABtn, ACard, AEmpty, AT, ASection, ATag } from '../arena';
import { Counter, DateField } from '../pickers';
import { explain, LoadError } from '../access';
import { c } from '../theme';
import { Banner, BodyPicker, JurisdictionPick, Checks, StatusTag, fmtDate, fmtRange, issueDocument, money, statusLabel } from '../federation-ui';

const thisYear = new Date().getFullYear();
// which organisation kinds a category is for (mirrors the server, which is the authority)
const KIND_OK = { club: ['club', 'other', 'company'], academy: ['academy'], school: ['school', 'college', 'university'], league: ['other', 'club', 'company', 'federation'], other: null };
const KIND_NOUN = { club: 'Clubs', academy: 'Academies', school: 'Schools and colleges', league: 'Leagues', other: 'Any organisation' };
const grid = (L) => ({ flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'stretch', ...(L.tablet ? {} : { flexDirection: 'column' }) });
const cell = (L) => (L.tablet ? { flexGrow: 1, flexBasis: L.width >= 1100 ? '31%' : '47%', minWidth: 300 } : {});
const daysText = (d) => (d === null || d === undefined ? '' : d < 0 ? `ended ${-d} days ago` : d === 0 ? 'ends today' : `${d} days left`);

// ------------------------------------------------------------------ the club
function ApplySheet({ visible, onClose, org, bodyId, onDone }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [body, setBody] = useState(null);
  const [cats, setCats] = useState(null);
  const [cat, setCat] = useState(null);
  const [season, setSeason] = useState(thisYear);
  const [juris, setJuris] = useState();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setCat(null); setNote(''); setSeason(thisYear); if (!bodyId) setBody(null); } }, [visible, bodyId]);
  useEffect(() => { if (visible && bodyId && !body) api.get(`/federation/bodies/${bodyId}`).then(setBody).catch(() => {}); }, [visible, bodyId, body]);
  useEffect(() => {
    setCats(null); setCat(null);
    if (!visible || !body) return;
    api.get(`/federation/bodies/${body.id}/affiliation-categories`).then(setCats).catch((e) => { toast(explain(e)); setCats([]); });
  }, [visible, body?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const fits = (k) => !KIND_OK[k] || KIND_OK[k].includes(org.kind);
  const usable = (cats ?? []).filter((x) => fits(x.applicant_kind));
  const submit = async () => {
    setBusy(true);
    try {
      const a = await api.post('/federation/affiliations', { body_id: body.id, organisation_id: org.id, category_id: cat.id, season_year: season, ...(juris ? { jurisdiction_id: juris } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      toast('Application started. Add the documents and send it.'); onClose(); onDone?.(); push('FederationRecord', { type: 'affiliation', id: a.id });
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Apply for affiliation">
      <View style={{ gap: 14 }}>
        <T size={13} color={c.mute}>Affiliation is a record between {org.name} and the body. It never changes who owns the organisation, who is in it or which teams belong to it.</T>
        <BodyPicker value={body} onChange={(b) => setBody(b)} />
        {body ? (
          cats === null ? <Loading /> : usable.length ? (
            <View style={{ gap: 8 }}>
              <T weight="800" size={13}>Category</T>
              {usable.map((k) => (
                <Card key={k.id} color={cat?.id === k.id ? c.violetSoft : c.paper} pad={12} onPress={() => setCat(k)} accessibilityLabel={`${k.name}. ${k.fee_minor ? money(k.fee_minor, k.currency) : 'No fee'}, ${k.duration_months} months${cat?.id === k.id ? ', selected' : ''}`}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
                    <View style={{ flex: 1 }}><T weight="700">{k.name}</T><T size={12} color={c.mute}>{KIND_NOUN[k.applicant_kind]}{k.sport_name ? ` · ${k.sport_name}` : ''} · {k.duration_months} months</T>{k.description ? <T size={12} color={c.mute} style={{ marginTop: 2 }}>{k.description}</T> : null}</View>
                    <T weight="800">{k.fee_minor ? money(k.fee_minor, k.currency) : 'No fee'}</T>
                  </View>
                </Card>))}
            </View>) : <Empty emoji="🗂️" title="Nothing to apply for" sub={cats.length ? `${body.name} has no category for a ${org.kind}.` : `${body.name} has not opened any affiliation category yet.`} />
        ) : null}
        {cat ? (
          <>
            <Counter label="Season" value={season} onChange={setSeason} min={thisYear - 1} max={thisYear + 2} />
            <JurisdictionPick bodyId={body.id} value={juris} onChange={setJuris} />
            <Field label="Note for the registrar (optional)" value={note} onChangeText={setNote} multiline maxLength={1000} />
            <Btn title="Start application" loading={busy} onPress={submit} />
          </>) : null}
      </View>
    </Sheet>
  );
}

function RegisterSheet({ body, onClose }) {
  const q = useLoad(() => (body ? api.get(`/federation/bodies/${body.id}/affiliated`, { include_descendants: true, limit: 100 }) : Promise.resolve([])), [body?.id]);
  return (
    <Sheet visible={!!body} onClose={onClose} title={body ? `Affiliated with ${body.name}` : ''}>
      {q.loading ? <Loading /> : (q.data ?? []).length ? (
        <View style={{ gap: 8 }}>{q.data.map((r) => (
          <Card key={r.id} color={c.paper} pad={12}><T weight="700">{r.name}</T><T size={12} color={c.mute}>{r.affiliation_no} · {r.category_name}{r.city ? ` · ${r.city}` : ''} · valid to {fmtDate(r.effective_to)}</T></Card>))}</View>
      ) : <Empty emoji="📒" title="No affiliated organisations yet" sub="Only organisations with an approved, in-date affiliation are listed." />}
    </Sheet>
  );
}

function AffiliationCard({ a, L, onChanged, onRegister }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [busy, setBusy] = useState(null);
  const run = async (key, fn) => { setBusy(key); try { await fn(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  const renew = () => run('renew', async () => { const r = await api.post(`/federation/affiliations/${a.id}/renew`, {}); toast('Renewal started'); onChanged(); push('FederationRecord', { type: 'affiliation', id: r.id }); });
  const open = () => push('FederationRecord', { type: 'affiliation', id: a.id });
  const days = a.days_to_expiry;
  const ending = a.status === 'approved' && days !== null && days <= 60;
  const next = a.status === 'draft' ? { t: 'Add documents and submit', f: open } : a.status === 'needs_info' ? { t: 'Respond to the registrar', f: open }
    : a.status === 'expired' || ending ? { t: 'Renew', f: renew, k: 'renew' } : null;
  return (
    <View style={cell(L)}>
      <Card color={ending || a.status === 'expired' ? c.sunSoft : c.paper} onPress={open} accessibilityLabel={`${a.body_name}, ${a.category_name}, season ${a.season_year}, ${statusLabel(a.status)}`}>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}><T weight="800" size={16}>{a.body_name}</T><T size={12} color={c.mute}>{a.category_name}{a.sport_name ? ` · ${a.sport_name}` : ''} · Season {a.season_year}</T></View>
            <StatusTag status={a.status} />
          </View>
          {a.affiliation_no ? <T size={13} weight="700">{a.affiliation_no}</T> : null}
          {a.effective_from ? <T size={12} color={c.mute}>{fmtRange(a.effective_from, a.effective_to)}{a.status === 'approved' ? ` · ${daysText(days)}` : ''}</T> : null}
          {a.fee_status === 'due' ? <Tag label={`Fee due · ${money(a.fee_minor, a.fee_currency)}`} color={c.sun} /> : a.fee_status === 'paid' ? <T size={12} color={c.mute}>Fee {money(a.fee_minor, a.fee_currency)} paid</T> : null}
          {a.decision_reason && ['rejected', 'suspended', 'needs_info'].includes(a.status) ? <T size={12}>{a.decision_reason}</T> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
            {next ? <Btn small title={next.t} loading={busy === next.k} onPress={next.f} /> : null}
            {a.status === 'approved' ? <Btn small title="Certificate" color={c.paper} ink={c.ink} loading={busy === 'cert'} onPress={() => run('cert', () => issueDocument('affiliation', a.id))} /> : null}
            <Btn small title="Who is affiliated" color={c.paper} ink={c.ink} onPress={() => onRegister({ id: a.body_id, name: a.body_name })} />
          </View>
        </View>
      </Card>
    </View>
  );
}

/** The club's federation affiliations: apply, keep documents and renewals current, download the certificate. */
export function OrgAffiliations({ organisation_id, body_id }) {
  const L = useLayout();
  const orgs = useLoad(() => api.get('/organisations', { limit: 100 }), []);
  const mine = useMemo(() => (orgs.data ?? []).filter((o) => o.my_status === 'active' && ['owner', 'admin'].includes(o.my_role) && o.status === 'active'), [orgs.data]);
  const [picked, setPicked] = useState(organisation_id ?? null);
  const org = mine.find((o) => o.id === (picked ?? mine[0]?.id)) ?? (picked ? (orgs.data ?? []).find((o) => o.id === picked) : null);
  const list = useLoad(() => (org ? api.get('/federation/affiliations', { organisation_id: org.id, limit: 100 }) : Promise.resolve(null)), [org?.id]);
  const [apply, setApply] = useState(false);
  const [register, setRegister] = useState(null);
  useEffect(() => { if (body_id && org && list.data && !list.data.items.some((a) => a.body_id === body_id && !['rejected', 'withdrawn', 'expired'].includes(a.status))) setApply(true); }, [body_id, org?.id, !!list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (orgs.error) return <Screen><H1>Affiliations</H1><LoadError error={orgs.error} onRetry={orgs.reload} /></Screen>;
  if (!orgs.data) return <Screen><H1>Affiliations</H1><Loading /></Screen>;
  if (!org) return <Screen><H1>Affiliations</H1><Empty emoji="🏢" title="No organisation to affiliate" sub="Only the owners and admins of a club, academy or school apply for affiliation. Create or join one under Organisations first." /></Screen>;
  const items = list.data?.items ?? [];
  const attention = items.filter((a) => ['needs_info', 'draft'].includes(a.status) || a.status === 'expired' || (a.status === 'approved' && a.days_to_expiry !== null && a.days_to_expiry <= 30));
  return (
    <Screen wide refreshing={list.loading && !!list.data} onRefresh={() => { orgs.reload(); list.reload(); }}>
      <H1>Federation affiliations</H1>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>The governing bodies {org.name} is affiliated with, applying for, or has let lapse. Each one is a record of its own: it never changes your members, teams or ownership.</T>
      {mine.length > 1 ? <View style={{ marginTop: 10 }}><Seg options={mine.map((o) => ({ value: o.id, label: o.name }))} value={org.id} onChange={setPicked} color={c.violet} /></View> : null}
      <View style={{ marginTop: 12, flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn title="Apply to a federation" onPress={() => setApply(true)} /></View>
      {attention.length ? <View style={{ marginTop: 12 }}><Banner tone={c.sunSoft}>{attention.length === 1 ? '1 affiliation needs your attention' : `${attention.length} affiliations need your attention`}: documents to add, a reply to the registrar, or a renewal coming up.</Banner></View> : null}
      {list.error && !list.data ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : items.length ? (
        <Section title={`${list.data.total} ${list.data.total === 1 ? 'affiliation' : 'affiliations'}`} color={c.cyan}>
          <View style={grid(L)}>{items.map((a) => <AffiliationCard key={a.id} a={a} L={L} onChanged={list.reload} onRegister={setRegister} />)}</View>
        </Section>
      ) : <View style={{ marginTop: 16 }}><Empty emoji="🏅" title="Not affiliated with any federation yet" sub="Apply to the national or regional body for your sport. You attach the documents it asks for, send the application and follow it here." /></View>}
      <ApplySheet visible={apply} onClose={() => setApply(false)} org={org} bodyId={body_id} onDone={list.reload} />
      <RegisterSheet body={register} onClose={() => setRegister(null)} />
    </Screen>
  );
}

// ------------------------------------------------------------------ the person
const STANDING_NOTE = { good_standing: 'In good standing', suspended: 'Suspended', expired: 'Expired', revoked: 'Revoked', pending: 'Awaiting a decision' };
async function shareCode(l) {
  const text = `${l.type_name} licence ${l.licence_no} (${l.body_name}). Check it on Sportarena with code ${l.public_code}.`;
  if (Platform.OS === 'web') {
    if (typeof navigator !== 'undefined' && navigator.share) { try { await navigator.share({ text }); return 'Shared'; } catch { return null; } }
    if (typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(text); return 'Copied to the clipboard'; }
    return text;
  }
  await Share.share({ message: text });
  return null;
}

function LicenceCard({ l, L, onChanged }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [busy, setBusy] = useState(null);
  const run = async (key, fn) => { setBusy(key); try { await fn(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  const open = () => push('FederationRecord', { type: 'licence', id: l.id });
  const days = l.days_to_expiry;
  const renewable = l.status === 'expired' || (l.status === 'active' && days !== null && days <= 30);
  const renew = () => run('renew', async () => { const r = await api.post(`/federation/licences/${l.id}/renew`, {}); toast('Renewal started'); onChanged(); push('FederationRecord', { type: 'licence', id: r.id }); });
  const tone = l.standing === 'good_standing' ? c.mint : l.standing === 'suspended' ? c.orange : l.standing === 'pending' ? c.sun : c.pinkSoft;
  return (
    <View style={cell(L)}>
      <Card color={renewable ? c.sunSoft : c.paper} onPress={open} accessibilityLabel={`${l.type_name}, ${l.body_name}, ${STANDING_NOTE[l.standing]}`}>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}><T weight="800" size={16}>{l.type_name}{l.grade ? ` · ${l.grade}` : ''}</T><T size={12} color={c.mute}>{l.body_name} · {l.sport_name}{l.discipline ? ` · ${l.discipline}` : ''}</T></View>
            <Tag label={STANDING_NOTE[l.standing]} color={tone} />
          </View>
          {l.licence_no ? <T size={13} weight="700">{l.licence_no}</T> : <StatusTag status={l.status} />}
          {l.expires_on ? <T size={12} color={c.mute}>{fmtRange(l.issued_on, l.expires_on)} · {daysText(days)}</T> : null}
          {l.fee_status === 'due' ? <Tag label={`Fee due · ${money(l.fee_minor, l.fee_currency)}`} color={c.sun} /> : null}
          {l.decision_reason && ['suspended', 'rejected', 'revoked'].includes(l.status) ? <T size={12}>{l.decision_reason}{l.suspended_until ? ` Until ${fmtDate(l.suspended_until)}.` : ''}</T> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
            {['draft', 'needs_info'].includes(l.status) ? <Btn small title={l.status === 'draft' ? 'Add documents and submit' : 'Respond'} onPress={open} /> : null}
            {renewable ? <Btn small title="Renew" loading={busy === 'renew'} onPress={renew} /> : null}
            {l.holder_role === 'official' && l.status === 'active' ? <Btn small title="Development" color={c.paper} ink={c.ink} onPress={() => push('OfficialsDevelopment')} /> : null}
            {l.status === 'active' ? <Btn small title="Licence document" color={c.paper} ink={c.ink} loading={busy === 'doc'} onPress={() => run('doc', () => issueDocument('licence', l.id))} /> : null}
            {l.public_code && l.status === 'active' ? <Btn small title="Share code" color={c.paper} ink={c.ink} onPress={() => run('share', async () => { const m = await shareCode(l); if (m) toast(m); })} /> : null}
            {l.public_code ? <Btn small title="Check" color={c.paper} ink={c.ink} onPress={() => push('VerifyLicence', { code: l.public_code })} /> : null}
          </View>
          {l.public_code && l.status === 'active' ? <T size={11} color={c.mute} accessibilityLabel={`Verification code ${l.public_code.split('').join(' ')}`}>Verification code {l.public_code}</T> : null}
        </View>
      </Card>
    </View>
  );
}

function LicenceApplySheet({ visible, onClose, bodyId, kids, onDone }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [body, setBody] = useState(null);
  const [types, setTypes] = useState(null);
  const [type, setType] = useState(null);
  const [clubs, setClubs] = useState(null);
  const [club, setClub] = useState(null);
  const [holder, setHolder] = useState(null);
  const [note, setNote] = useState('');
  const [juris, setJuris] = useState();
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  useEffect(() => { if (visible) { setType(null); setClub(null); setHolder(null); setNote(''); setConsent(false); if (!bodyId) setBody(null); } }, [visible, bodyId]);
  useEffect(() => { if (visible && bodyId && !body) api.get(`/federation/bodies/${bodyId}`).then(setBody).catch(() => {}); }, [visible, bodyId, body]);
  useEffect(() => {
    setTypes(null); setType(null); setClubs(null); setClub(null);
    if (!visible || !body) return;
    api.get(`/federation/bodies/${body.id}/licence-types`).then(setTypes).catch((e) => { toast(explain(e)); setTypes([]); });
    api.get(`/federation/bodies/${body.id}/affiliated`, { include_descendants: true, limit: 100 }).then(setClubs).catch(() => setClubs([]));
  }, [visible, body?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const bySport = useMemo(() => { const m = new Map(); for (const t of types ?? []) { const k = t.sport_name; m.set(k, [...(m.get(k) ?? []), t]); } return [...m]; }, [types]);
  const submit = async () => {
    setBusy(true); setConsent(false);
    try {
      const l = await api.post('/federation/licences', { body_id: body.id, type_id: type.id, ...(holder ? { holder_id: holder.id } : {}), ...(club ? { affiliation_id: club.id } : {}), ...(juris ? { jurisdiction_id: juris } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      toast('Application started. Add the documents and send it.'); onClose(); onDone?.(); push('FederationRecord', { type: 'licence', id: l.id });
    } catch (e) { if (e.details?.code === 'guardian_consent_required') setConsent(true); else toast(explain(e)); } finally { setBusy(false); }
  };
  const needsClub = type?.requires_affiliation;
  const ready = type && (!needsClub || club);
  return (
    <Sheet visible={visible} onClose={onClose} title="Apply for a licence">
      <View style={{ gap: 14 }}>
        {kids.length ? (
          <View style={{ gap: 6 }}>
            <T weight="800" size={13}>Who is it for?</T>
            <Seg options={[{ value: null, label: 'Me' }, ...kids.map((k) => ({ value: k.id, label: k.display_name }))]} value={holder?.id ?? null} onChange={(v) => setHolder(v ? kids.find((k) => k.id === v) : null)} color={c.violet} />
            {holder ? <T size={12} color={c.mute}>You apply as {holder.display_name}'s verified guardian. The federation sees your child's name only to issue the licence, and it is never shown publicly.</T> : null}
          </View>) : null}
        <BodyPicker value={body} onChange={setBody} />
        {body ? (types === null ? <Loading /> : types.length ? (
          <View style={{ gap: 10 }}>
            <T weight="800" size={13}>Licence</T>
            {bySport.map(([sport, ts]) => (
              <View key={sport} style={{ gap: 8 }}>
                <T size={12} color={c.mute} weight="700">{sport}</T>
                {ts.map((t) => (
                  <Card key={t.id} color={type?.id === t.id ? c.violetSoft : c.paper} pad={12} onPress={() => { setType(t); setClub(null); }} accessibilityLabel={`${t.name}${t.grade ? `, ${t.grade}` : ''}, ${t.holder_role}${type?.id === t.id ? ', selected' : ''}`}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
                      <View style={{ flex: 1 }}><T weight="700">{t.name}{t.grade ? ` · ${t.grade}` : ''}</T><T size={12} color={c.mute}>{t.holder_role}{t.discipline ? ` · ${t.discipline}` : ''} · {t.duration_months} months{t.requires_affiliation ? ' · through a club' : ''}</T></View>
                      <T weight="800">{t.fee_minor ? money(t.fee_minor, t.currency) : 'No fee'}</T>
                    </View>
                  </Card>))}
              </View>))}
          </View>) : <Empty emoji="🪪" title="No licences offered" sub={`${body.name} has not published any licence type yet.`} />) : null}
        {type && (needsClub || (clubs ?? []).length) ? (
          <View style={{ gap: 8 }}>
            <T weight="800" size={13}>{needsClub ? 'The club you play, coach or officiate for' : 'Club (optional)'}</T>
            {clubs === null ? <Loading /> : (clubs ?? []).length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {!needsClub ? <Chip label="No club" active={!club} onPress={() => setClub(null)} /> : null}
                {clubs.map((k) => <Chip key={k.id} label={k.name} active={club?.id === k.id} onPress={() => setClub(k)} />)}
              </View>) : <T size={12} color={c.mute}>No club is affiliated with this body yet.</T>}
            <T size={11} color={c.mute}>The federation checks that you really belong to the club.</T>
          </View>) : null}
        {ready ? (
          <>
            <JurisdictionPick bodyId={body.id} value={juris} onChange={setJuris} />
            <Field label="Note (optional)" value={note} onChangeText={setNote} multiline maxLength={1000} />
            {consent ? <Banner tone={c.sunSoft} action="Family & guardians" onAction={() => { onClose(); push('Family'); }}>A verified guardian has not given current consent for taking part. Allow it under Family & guardians, then apply again.</Banner> : null}
            <Btn title="Start application" loading={busy} onPress={submit} />
          </>) : null}
      </View>
    </Sheet>
  );
}

/** The person's federation licences, with their standing today, renewals, the code anyone can check, and young people they are a guardian of. */
export function MyLicences({ body_id }) {
  const L = useLayout();
  const { push } = useNav();
  const lic = useLoad(() => api.get('/federation/licences', { mine: true, limit: 100 }), []);
  const fam = useLoad(() => api.get('/youth/guardian-links', { as: 'guardian', status: 'active', limit: 50 }).catch(() => []), []);
  const [apply, setApply] = useState(false);
  const { user } = useSession();
  const kids = (fam.data ?? []).filter((l) => l.child).map((l) => ({ id: l.child_id, display_name: l.child.display_name }));
  useEffect(() => { if (body_id) setApply(true); }, [body_id]);
  const groups = useMemo(() => {
    const m = new Map();
    for (const l of lic.data?.items ?? []) m.set(l.holder_id, { name: l.holder_name, id: l.holder_id, rows: [...(m.get(l.holder_id)?.rows ?? []), l] });
    return [...m.values()].sort((a, b) => (a.id === user?.id ? -1 : b.id === user?.id ? 1 : a.name.localeCompare(b.name)));
  }, [lic.data, user?.id]);
  if (lic.error && !lic.data) return <Screen><H1>My licences</H1><LoadError error={lic.error} onRetry={lic.reload} /></Screen>;
  const attention = (lic.data?.items ?? []).filter((l) => ['needs_info', 'draft'].includes(l.status) || l.status === 'expired' || (l.status === 'active' && l.days_to_expiry !== null && l.days_to_expiry <= 30)).length;
  return (
    <Screen wide refreshing={lic.loading && !!lic.data} onRefresh={lic.reload}>
      <H1>My licences</H1>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>Federation licences held in your name{kids.length ? ' and by the young people you are a verified guardian of' : ''}. Standing is read live from the federation: a licence that has run out shows as expired the same day.</T>
      <View style={{ marginTop: 12, flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn title="Apply for a licence" onPress={() => setApply(true)} />
        <Btn title="Check a licence" color={c.paper} ink={c.ink} onPress={() => push('VerifyLicence')} />
      </View>
      {attention ? <View style={{ marginTop: 12 }}><Banner tone={c.sunSoft}>{attention === 1 ? '1 licence needs' : `${attention} licences need`} your attention: documents to add, a reply, or a renewal coming up.</Banner></View> : null}
      {!lic.data ? <Loading /> : groups.length ? groups.map((g) => (
        <Section key={g.id} title={g.id === user?.id ? 'Yours' : g.name} color={c.mint}>
          <View style={grid(L)}>{g.rows.map((l) => <LicenceCard key={l.id} l={l} L={L} onChanged={lic.reload} />)}</View>
        </Section>)) : <View style={{ marginTop: 16 }}><Empty emoji="🪪" title="No licences yet" sub="Apply to the federation that governs your sport. Once it is issued, your standing and the code anyone can check appear here." /></View>}
      <LicenceApplySheet visible={apply} onClose={() => setApply(false)} bodyId={body_id} kids={kids} onDone={lic.reload} />
    </Screen>
  );
}
// ------------------------------------------------------------------ the organiser (inside the event console)
function SanctionSheet({ visible, onClose, event, onDone }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [body, setBody] = useState(null);
  const [ready, setReady] = useState(null);
  const [cats, setCats] = useState([]);
  const [draft, setDraft] = useState('');
  const [rules, setRules] = useState([]);
  const [rule, setRule] = useState(null);
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [note, setNote] = useState('');
  const [juris, setJuris] = useState();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setBody(null); setReady(null); setCats([]); setDraft(''); setRule(null); setFrom(event.starts_on ? String(event.starts_on).slice(0, 10) : null); setTo(event.ends_on ? String(event.ends_on).slice(0, 10) : null); setNote(''); } }, [visible, event.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (visible) api.get('/ruleset-versions', { sport: event.sport_id, limit: 50 }).then((r) => setRules(r.versions ?? [])).catch(() => setRules([])); }, [visible, event.sport_id]);
  useEffect(() => {
    setReady(null);
    if (!visible || !body) return;
    api.get('/federation/sanction-readiness', { body_id: body.id, event_id: event.id, ...(rule ? { ruleset_version_id: rule.id } : {}) }).then(setReady).catch((e) => toast(explain(e)));
  }, [visible, body?.id, rule?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const addCat = () => { const v = draft.trim(); if (v && !cats.includes(v)) setCats([...cats, v]); setDraft(''); };
  const submit = async () => {
    setBusy(true);
    try {
      const s = await api.post('/federation/sanctions', { body_id: body.id, event_id: event.id, categories: cats, ...(juris ? { jurisdiction_id: juris } : {}), ...(rule ? { ruleset_version_id: rule.id } : {}), ...(from ? { starts_on: from } : {}), ...(to ? { ends_on: to } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      toast('Sanction requested'); onClose(); onDone?.(); push('FederationRecord', { type: 'sanction', id: s.id });
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Request a sanction">
      <View style={{ gap: 14 }}>
        <T size={13} color={c.mute}>Ask a governing body to sanction {event.name}. This points at your existing event; it creates no second event and changes nothing about it.</T>
        <BodyPicker value={body} onChange={setBody} sportId={event.sport_id} />
        {body && !ready ? <Loading /> : null}
        {ready ? (
          <>
            {ready.requirements ? <T size={12} color={c.mute}>Judged against {ready.requirements.policy_title} (version {ready.requirements.version}){ready.requirements.inherited ? ', set by a body above' : ''}.</T> : <T size={12} color={c.mute}>This body has not published sanctioning conditions, so only the basics are checked.</T>}
            <Checks checks={ready.checks} title={ready.ready ? 'Ready to ask' : 'Not ready yet — you can still ask, the registrar sees this'} />
          </>) : null}
        {body ? (
          <>
            <View style={{ gap: 6 }}>
              <T weight="800" size={13}>Categories covered (optional)</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{cats.map((k) => <Chip key={k} active label={`${k}  ✕`} onPress={() => setCats(cats.filter((x) => x !== k))} />)}</View>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Field value={draft} onChangeText={setDraft} placeholder="e.g. U17 Boys, Open, Masters 45+" accessibilityLabel="Add a category" /></View><Btn small title="Add" onPress={addCat} disabled={!draft.trim()} /></View>
            </View>
            {rules.length ? (
              <View style={{ gap: 6 }}>
                <T weight="800" size={13}>Governed rule version (optional)</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <Chip label="Not specified" active={!rule} onPress={() => setRule(null)} />
                  {rules.map((r) => <Chip key={r.id} label={`${r.label} v${r.version}`} active={rule?.id === r.id} onPress={() => setRule(r)} />)}
                </View>
              </View>) : null}
            <JurisdictionPick bodyId={body.id} value={juris} onChange={setJuris} hint="Where the competition is held." />
            <DateField label="Sanctioned from" value={from} onChange={setFrom} optional hint="Defaults to the event's own dates." />
            <DateField label="Sanctioned to" value={to} onChange={setTo} optional min={from ?? undefined} />
            <Field label="Note (optional)" value={note} onChangeText={setNote} multiline maxLength={1000} />
            <Btn title="Request sanction" loading={busy} onPress={submit} />
          </>) : null}
      </View>
    </Sheet>
  );
}

/** One card in the event console: who sanctions this event and a way to ask. Managers only; the record itself opens in the shared detail screen. */
export function EventSanctions({ event, canManage, onChanged }) {
  const { push } = useNav();
  const [ask, setAsk] = useState(false);
  const q = useLoad(() => (canManage ? api.get('/federation/sanctions', { event_id: event.id, limit: 20 }) : Promise.resolve({ items: [] })), [event.id, canManage]);
  if (!canManage) return null;
  const items = q.data?.items ?? [];
  return (
    <>
      <ASection title="Sanctions" sub="Governing bodies that sanction this event" action={['completed', 'cancelled'].includes(event.status) ? undefined : 'Request'} onAction={() => setAsk(true)} />
      {q.error ? <LoadError error={q.error} onRetry={q.reload} /> : !q.data ? <Loading /> : items.length ? items.map((s) => (
        <ACard key={s.id} pad={12} onPress={() => push('FederationRecord', { type: 'sanction', id: s.id })} style={{ gap: 4 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <AT weight="800" size={15} style={{ flex: 1 }}>{s.body_name}</AT><StatusTag status={s.status} />
          </View>
          {s.sanction_no ? <AT size={13} weight="700">{s.sanction_no}</AT> : null}
          {s.approved_starts_on ? <AT size={12} color={A.mute}>Approved {fmtRange(s.approved_starts_on, s.approved_ends_on)}{s.approved_categories?.length ? ` · ${s.approved_categories.join(', ')}` : ''}</AT> : <AT size={12} color={A.mute}>Asked {fmtRange(s.requested_starts_on, s.requested_ends_on)}</AT>}
          {s.conditions?.length ? <AT size={12} color={A.mute}>Conditions: {s.conditions.join('; ')}</AT> : null}
          {s.drift ? <ATag label="Event dates moved outside the sanction" tone={A.orange} /> : null}
          {s.decision_reason && ['needs_info', 'rejected', 'suspended', 'revoked'].includes(s.status) ? <AT size={12}>{s.decision_reason}</AT> : null}
        </ACard>)) : <AEmpty emoji="🏛️" title="Not sanctioned yet" sub="Ask the national or regional body for your sport to sanction this event. You see what it needs before you ask." action={['completed', 'cancelled'].includes(event.status) ? undefined : 'Request a sanction'} onAction={() => setAsk(true)} />}
      <SanctionSheet visible={ask} onClose={() => setAsk(false)} event={event} onDone={() => { q.reload(); onChanged?.(); }} />
    </>
  );
}

/** A small line on the public event page: who sanctions it, if anyone does. Nothing at all otherwise. */
export function SanctionBadge({ id, style }) {
  const q = useLoad(() => api.get(`/events/${id}/sanctions`).catch(() => []), [id]);
  const live = (q.data ?? []).filter((s) => s.status === 'approved');
  if (!live.length) return null;
  return (
    <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }, style]} accessible accessibilityLabel={`Sanctioned by ${live.map((s) => s.body_name).join(' and ')}`}>
      {live.map((s) => <Tag key={s.id} label={`Sanctioned by ${s.body_abbreviation} · ${s.sanction_no}${s.drift ? ' · dates changed' : ''}`} color={s.drift ? c.sun : c.mint} />)}
    </View>
  );
}

/** Entries on an organisation's Manage area: the club's affiliations, and the federation workspace when the organisation is itself a governing body. */
export function FederationLinks({ orgId, role, archived }) {
  const { push } = useNav();
  const mine = useLoad(() => api.get('/federation/mine', { limit: 100 }).catch(() => []), [orgId]);
  const body = (mine.data ?? []).find((b) => b.organisation_id === orgId);
  return (
    <>
      {!archived && ['owner', 'admin'].includes(role) ? <Btn small title="Federation affiliations" color={c.paper} ink={c.ink} onPress={() => push('OrgAffiliations', { organisation_id: orgId })} /> : null}
      {body ? <Btn small title="Open federation workspace" color={c.paper} ink={c.ink} onPress={() => push('FederationHome', { id: body.id })} /> : null}
    </>
  );
}
