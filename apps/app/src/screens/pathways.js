// Learn and study sport: the rules of a sport, programmes and institutions that teach it, the enquiry conversation (shared with the
// institution's admissions team), and the certificates and badges an athlete earns and shows on their profile.
import React, { useState } from 'react';
import { Linking, Platform, Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Seg, Section, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { SportSelect, useSports } from '../sportpicker';
import { c, when } from '../theme';
import { locale } from '../locale';
import { moneyIn } from '../vtime';

import { KINDS, MODES, Explore, Reviews, BucketButton, RatingTag } from './study';
import { Plan, SharedPathways } from './pathway-plan';
export { KINDS, MODES };
export const STAGES = [['new', 'New'], ['in_conversation', 'In conversation'], ['referred', 'Sent to apply'], ['applied', 'Applied'], ['admitted', 'Admitted'], ['enrolled', 'Enrolled'], ['declined', 'Declined'], ['withdrawn', 'Withdrawn'], ['closed', 'Closed']];
export const label = (list, v) => list.find(([k]) => k === v)?.[1] ?? String(v).replace(/_/g, ' ');
export const openLink = (url) => (Platform.OS === 'web' ? window.open(url, '_blank', 'noopener') : Linking.openURL(url));
const day = (d) => new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
const fail = (toast) => (e) => toast('' + e.message);
const opts = (list) => list.map(([value, l]) => ({ value, label: l }));

/** Certificates and badges as they appear on a profile or passport. */
export function CredentialList({ list }) {
  return (
    <View style={{ gap: 10 }}>
      {list.map((x) => (
        <Card key={x.id} pad={14}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <T size={30}>{x.kind === 'badge' ? '🎖️' : x.kind === 'degree' || x.kind === 'diploma' ? '🎓' : '📜'}</T>
            <View style={{ flex: 1 }}>
              <T weight="700">{x.title}</T>
              <T size={12} color={c.mute}>{x.institution}{x.sport ? ` · ${x.sport_emoji ?? ''} ${x.sport}` : ''} · {day(x.issued_on)}{x.expires_on ? ` – ${day(x.expires_on)}` : ''}</T>
              <T size={11} color={c.mute}>Verify with code {x.code}</T>
            </View>
          </View>
        </Card>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------ the hub
export function Pathways() {
  const { push } = useNav();
  const { user } = useSession();
  const [tab, setTab] = useState('explore');
  const enq = useLoad(() => api.get('/me/enquiries', { limit: 100 }), []);
  const bucket = useLoad(() => api.get('/me/bucket', { limit: 100 }), []);
  const unread = (enq.data ?? []).filter((e) => e.unread).length;
  const saved = bucket.data?.length ?? 0;
  return (
    <Screen>
      <GradCard colors={[c.violet, c.ink]}>
        <H1 color="#fff" style={{ fontSize: 28 }}>Learn & study sport</H1>
        <T color="#fff" weight="600" style={{ marginTop: 4 }}>Turn your sport into a qualification: find colleges near you, compare courses, save your favourites and apply.</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          <StatPill value={saved} label="Targets" /><StatPill value={(enq.data ?? []).length} label="Enquiries" /><StatPill value={unread} label="Unread replies" />
        </View>
      </GradCard>
      <View style={{ marginTop: 12 }}>
        <Seg value={tab} onChange={setTab} color={c.violet} options={[{ value: 'explore', label: 'Explore' }, { value: 'plan', label: saved ? `My plan (${saved})` : 'My plan' }, { value: 'learn', label: 'Rules' }, { value: 'enquiries', label: unread ? `Enquiries (${unread})` : 'Enquiries' }, { value: 'credentials', label: 'Badges' }, ...(user.roles.includes('coach') ? [{ value: 'shared', label: 'Shared with me' }] : [])]} />
      </View>
      {tab === 'explore' ? <Explore push={push} onSaved={bucket.reload} /> : null}
      {tab === 'plan' ? <Plan onExplore={() => setTab('explore')} /> : null}
      {tab === 'shared' ? <SharedPathways push={push} /> : null}
      {tab === 'learn' ? <Learn onFind={() => setTab('explore')} /> : null}
      {tab === 'enquiries' ? <Enquiries list={enq} push={push} /> : null}
      {tab === 'credentials' ? <MyCredentials /> : null}
    </Screen>
  );
}

function Learn({ onFind }) {
  const { user, toast } = useSession();
  const [sport, setSport] = useState(null);
  const [form, setForm] = useState(false);
  const rules = useLoad(() => (sport ? api.get(`/sports/${sport}/rules`) : Promise.resolve(null)), [sport]);
  const admin = user.roles.includes('admin');
  const archive = async (r) => { try { await api.patch(`/sport-rules/${r.id}`, { status: 'archived' }); rules.reload(); } catch (e) { fail(toast)(e); } };
  return (
    <>
      <View style={{ marginTop: 12 }}><SportSelect label="Which sport do you want to learn?" value={sport} onChange={setSport} /></View>
      {!sport ? <Empty emoji="📖" title="Pick a sport" sub="Choose the sport you want to build a career in to read its rules and see where to study it." /> : rules.error ? <ErrorBox error={rules.error} onRetry={rules.reload} /> : !rules.data ? <Loading /> : (
        <>
          <Section title={`${rules.data.sport.emoji} Rules of ${rules.data.sport.name}`} color={c.cyan}>
            {(rules.data.scoring ?? []).map((r) => (
              <Card key={r.title}>
                <T weight="700" size={16}>{r.title}</T>
                <T style={{ marginTop: 6 }}>{r.body}</T>
              </Card>
            ))}
            {rules.data.rules.length ? rules.data.rules.map((r) => (
              <Card key={r.id}>
                <T weight="700" size={16}>{r.title}</T>
                <T style={{ marginTop: 6 }}>{r.body}</T>
                {r.source_url ? <Btn small title="Official source" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 10 }} onPress={() => openLink(r.source_url)} /> : null}
                {admin ? <Btn small title="Archive section" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => archive(r)} /> : null}
              </Card>
            )) : rules.data.scoring?.length ? null : <Empty emoji="📚" title="No rules added yet" sub="The platform team has not written the rules of this sport yet. You can still look for courses." />}
            {admin ? <Btn small title="Add a rules section" color={c.violet} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} /> : null}
          </Section>
          <Btn title={`Find courses in ${rules.data.sport.name}`} onPress={onFind} style={{ marginTop: 16 }} />
        </>
      )}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Add a rules section" submitLabel="Add"
        fields={[{ key: 'title', label: 'Title' }, { key: 'body', label: 'Rules', type: 'multiline' }, { key: 'source_url', label: 'Official source link (https)', type: 'url', optional: true }]}
        onSubmit={async (v) => { await api.post(`/sports/${sport}/rules`, v); rules.reload(); return 'Added'; }} />
    </>
  );
}

function Enquiries({ list, push }) {
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <Section title="Your enquiries" color={c.sun}>
      {list.data.length ? list.data.map((e) => (
        <Row key={e.id} title={`${e.unread ? '● ' : ''}${e.institution}`} sub={`${e.programme_title ?? 'General enquiry'}${e.sport ? ` · ${e.sport_emoji} ${e.sport}` : ''}\n${when(e.last_message_at)}`}
          right={<Tag label={label(STAGES, e.status)} />} onPress={() => push('Enquiry', { id: e.id })} />
      )) : <Empty emoji="✉️" title="No enquiries yet" sub="Open a college listed on Sportarena and ask them anything. They answer here." />}
    </Section>
  );
}

function MyCredentials() {
  const { toast } = useSession();
  const [code, setCode] = useState(''), [res, setRes] = useState(null);
  const list = useLoad(() => api.get('/me/credentials', { limit: 100 }), []);
  const toggle = async (x) => { try { await api.patch(`/me/credentials/${x.id}`, { show_on_profile: !x.show_on_profile }); list.reload(); } catch (e) { fail(toast)(e); } };
  const check = async () => { try { setRes(await api.get(`/credentials/verify/${encodeURIComponent(code.trim())}`)); } catch (e) { setRes({ error: e.message }); } };
  return (
    <>
      <Section title="Certificates & badges" color={c.mint}>
        <T size={13} color={c.mute}>Institutions you studied with issue these. The ones you leave switched on show on your public profile and on passport links that include them.</T>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((x) => (
          <Card key={x.id} pad={14}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <T weight="700">{x.title}</T>
                <T size={12} color={c.mute}>{x.institution} · {x.kind} · issued {day(x.issued_on)}{x.expires_on ? ` · expires ${day(x.expires_on)}` : ''}</T>
                <T size={11} color={c.mute}>Code {x.code}</T>
                {x.status === 'revoked' ? <T size={12} color={c.red}>Withdrawn: {x.revoke_reason}</T> : x.expired ? <T size={12} color={c.red}>Expired</T> : null}
              </View>
              {x.status === 'issued' && !x.expired ? <View style={{ alignItems: 'center', gap: 2 }}><Switch value={x.show_on_profile} onValueChange={() => toggle(x)} /><T size={10} color={c.mute}>On profile</T></View> : <Tag label={x.status === 'revoked' ? 'Withdrawn' : 'Expired'} />}
            </View>
          </Card>
        )) : <Empty emoji="🎖️" title="No certificates yet" sub="When a college you enrolled with issues a certificate or badge it appears here." />}
      </Section>
      <Section title="Check a certificate" color={c.cyan}>
        <Field value={code} onChangeText={setCode} placeholder="Code, e.g. GMG-1A2B3C4D5E6F" />
        <Btn small title="Check" onPress={check} disabled={code.trim().length < 6} style={{ alignSelf: 'flex-start' }} />
        {res ? res.error ? <T color={c.red}>{res.error}</T> : <Card><T weight="700">{res.valid ? '✅ Valid' : res.status === 'revoked' ? '⛔ Withdrawn' : '⌛ Expired'} — {res.title}</T><T size={13} color={c.mute}>{res.institution}{res.holder ? ` · ${res.holder.display_name} (@${res.holder.handle})` : ''} · issued {day(res.issued_on)}</T></Card> : null}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ an institution and one of its programmes
function Contact({ id }) {
  const [c2, setC] = useState(null);
  const { toast } = useSession();
  if (c2) return (
    <Card>
      {c2.email ? <T>✉️ {c2.email}</T> : null}{c2.phone ? <T>📞 {c2.phone}</T> : null}{c2.website ? <T color={c.pink} onPress={() => openLink(c2.website)}>🌐 {c2.website}</T> : null}
    </Card>
  );
  return <Btn small title="Show contact details" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={async () => { try { setC(await api.get(`/institutions/${id}/contact`)); } catch (e) { fail(toast)(e); } }} />;
}

function EnquireSheet({ visible, onClose, organisationId, programme }) {
  const { push } = useNav();
  const sports = useSports();
  const progSports = programme?.sports ?? [];
  const pick = progSports.length > 1 || !programme;
  const idOf = (slug) => (sports.data ?? []).find((s) => s.slug === slug)?.id;
  return (
    <FormSheet visible={visible} onClose={onClose} title={programme ? `Ask about ${programme.title}` : 'Ask this institution'} submitLabel="Send enquiry"
      fields={[
        { key: 'message', label: 'Your question', type: 'multiline', hint: 'They reply here and you get a notification. Your email and phone are not shared with them.' },
        ...(pick ? [{ key: 'sport', label: 'Sport you are interested in', type: progSports.length ? 'chips' : 'sport', optional: true, options: progSports.map((s) => ({ value: s.slug, label: `${s.emoji} ${s.name}` })) }] : []),
        { key: 'comms_consent', label: 'Keep me posted with announcements (open days, intakes)', type: 'switch', default: false, hint: 'Optional. You can switch it off any time in the conversation.' },
        { key: 'sponsor_consent', label: 'Let them introduce me to sponsors', type: 'switch', default: false, hint: 'Optional. A sponsor would only see your name and sport, never your contact details.' },
      ]}
      onSubmit={async (v) => {
        try {
          const e = await api.post('/enquiries', { organisation_id: organisationId, programme_id: programme?.id, sport_id: v.sport ? idOf(v.sport) : undefined, message: v.message, comms_consent: !!v.comms_consent, sponsor_consent: !!v.sponsor_consent });
          push('Enquiry', { id: e.id });
          return 'Enquiry sent';
        } catch (err) {
          if (err.details?.enquiry_id) push('Enquiry', { id: err.details.enquiry_id });
          throw err;
        }
      }} />
  );
}

const mail = (e) => openLink(`mailto:${e}`);
const tel = (n) => openLink(`tel:${n.replace(/[^+\d]/g, '')}`);
const Unverified = () => <Card color={c.sunSoft ?? c.paper}><T size={13}>✨ Suggested by AI and not yet verified. Check fees, dates, contacts and the application process on the official website before you rely on them.</T></Card>;

/** Contact details given directly (AI-suggested institutions are not on the platform, so there is no enquiry route). */
function ExtContact({ x }) {
  const any = x.contact_email || x.contact_phone || x.website || x.admissions_url;
  if (!any) return <T size={13} color={c.mute}>No contact details known. Search for the institution's admissions page.</T>;
  return (
    <Card>
      {x.contact_email ? <T color={c.pink} onPress={() => mail(x.contact_email)}>✉️ {x.contact_email}</T> : null}
      {x.contact_phone ? <T color={c.pink} onPress={() => tel(x.contact_phone)}>📞 {x.contact_phone}</T> : null}
      {x.website ? <T color={c.pink} onPress={() => openLink(x.website)}>🌐 {x.website}</T> : null}
      {x.admissions_url ? <T color={c.pink} onPress={() => openLink(x.admissions_url)}>🎓 Admissions page</T> : null}
    </Card>
  );
}
const Fact = ({ k, v }) => (v ? <View style={{ marginTop: 8 }}><T size={12} weight="800" color={c.mute}>{k}</T><T>{v}</T></View> : null);

export function Institution({ id, ext }) {
  const { push } = useNav();
  const [ask, setAsk] = useState(false);
  const o = useLoad(() => api.get(ext ? `/study/institutions/${id}` : `/institutions/${id}`), [id, ext]);
  if (o.error) return <Screen><ErrorBox error={o.error} onRetry={o.reload} /></Screen>;
  if (!o.data) return <Screen><Loading /></Screen>;
  const x = o.data, type = ext ? 'study_institution' : 'institution';
  return (
    <Screen>
      <GradCard colors={[c.violet, c.ink]}>
        <H1 color="#fff" style={{ fontSize: 28 }}>{x.name}</H1>
        <T color="#fff" weight="700">{[x.city, x.country].filter(Boolean).join(', ')}</T>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}><RatingTag rating={x.rating} reviews={x.reviews} /></View>
      </GradCard>
      {ext ? <View style={{ marginTop: 12 }}><Unverified /></View> : null}
      {x.about ? <T style={{ marginTop: 12 }}>{x.about}</T> : null}
      {ext && x.known_for ? <Fact k="KNOWN FOR" v={x.known_for} /> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <BucketButton type={type} id={id} />
        {!ext ? <Btn small title="Ask a question" onPress={() => setAsk(true)} /> : null}
        {x.website ? <Btn small title="Visit website" color={c.paper} ink={c.ink} onPress={() => openLink(x.website)} /> : null}
      </View>
      {ext && x.admissions_process ? <Section title="How admission works" color={c.sun}><Card><T>{x.admissions_process}</T></Card></Section> : null}
      <Section title="Contact" color={c.mint}>{ext ? <ExtContact x={x} /> : <Contact id={id} />}</Section>
      <Section title="Programmes" color={c.cyan}>
        {x.programmes.length ? x.programmes.map((p) => (
          <Row key={p.id} title={p.title} onPress={() => push('Programme', { id: p.id, ext })}
            sub={`${label(KINDS, p.kind)}${p.mode ? ` · ${label(MODES, p.mode)}` : ''}${ext && p.duration_text ? ` · ${p.duration_text}` : ''}${p.sports.length ? ` · ${p.sports.map((s) => s.emoji).join(' ')}` : ''}${p.reviews ? ` · ★ ${p.rating.toFixed(1)} (${p.reviews})` : ''}`}
            right={ext ? (p.fee_text ? <Tag label={p.fee_text} /> : null) : p.fee_minor != null ? <Tag label={moneyIn(p.fee_minor, p.currency)} /> : null} />
        )) : <Empty emoji="🎓" title="No programmes published yet" />}
      </Section>
      {!ext && x.brochures.length ? <Section title="Brochures" color={c.sun}>{x.brochures.map((b) => <Row key={b.id} title={b.title} right={<Tag label="Open" />} onPress={() => openLink(b.url)} />)}</Section> : null}
      <Reviews type={type} id={id} title="Ratings & reviews of this institution" />
      {!ext ? <EnquireSheet visible={ask} onClose={() => setAsk(false)} organisationId={id} /> : null}
    </Screen>
  );
}

export function Programme({ id, ext }) {
  const { push } = useNav();
  const [ask, setAsk] = useState(false);
  const p = useLoad(() => api.get(ext ? `/study/programmes/${id}` : `/programmes/${id}`), [id, ext]);
  if (p.error) return <Screen><ErrorBox error={p.error} onRetry={p.reload} /></Screen>;
  if (!p.data) return <Screen><Loading /></Screen>;
  const x = p.data, type = ext ? 'study_programme' : 'programme', inst = ext ? x.institution : null;
  const instName = ext ? inst.name : x.institution, instId = ext ? inst.id : x.organisation_id, where = ext ? inst : x;
  return (
    <Screen>
      <GradCard colors={[c.violet, c.ink]}>
        <H1 color="#fff" style={{ fontSize: 26 }}>{x.title}</H1>
        <T color="#fff" weight="700">{instName} · {[where.city, where.country].filter(Boolean).join(', ')}</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <Tag label={label(KINDS, x.kind)} color={c.lime} />{x.mode ? <Tag label={label(MODES, x.mode)} color={c.lime} /> : null}
          {x.sports.map((s) => <Tag key={s.id} label={`${s.emoji} ${s.name}`} color={c.lime} />)}
          <RatingTag rating={x.rating} reviews={x.reviews} />
        </View>
      </GradCard>
      {ext ? <View style={{ marginTop: 12 }}><Unverified /></View> : null}
      <Card style={{ marginTop: 12 }}>
        {x.description ? <T>{x.description}</T> : null}
        {ext ? (
          <>
            <Fact k="DURATION" v={x.duration_text} /><Fact k="FEE" v={x.fee_text} /><Fact k="INTAKE" v={x.intake_text} />
            <Fact k="ENTRY REQUIREMENTS" v={x.entry_requirements} /><Fact k="HOW TO APPLY" v={x.how_to_apply} />
          </>
        ) : (
          <>
            {x.duration_months ? <T size={13} color={c.mute} style={{ marginTop: 6 }}>Duration: {x.duration_months} months</T> : null}
            {x.fee_minor != null ? <T size={13} color={c.mute}>Fee: {moneyIn(x.fee_minor, x.currency)}</T> : null}
            {x.next_intake_on ? <T size={13} color={c.mute}>Next intake: {day(x.next_intake_on)}</T> : null}
          </>
        )}
      </Card>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <BucketButton type={type} id={id} />
        {!ext ? <Btn small title="Ask the admissions team" onPress={() => setAsk(true)} /> : null}
        {x.apply_url ? <Btn small title="Apply on their website" color={c.paper} ink={c.ink} onPress={() => openLink(x.apply_url)} /> : null}
        <Btn small title="About the institution" color={c.paper} ink={c.ink} onPress={() => push('Institution', { id: instId, ext })} />
      </View>
      {!ext && x.brochures.length ? <Section title="Brochures" color={c.sun}>{x.brochures.map((b) => <Row key={b.id} title={b.title} right={<Tag label="Open" />} onPress={() => openLink(b.url)} />)}</Section> : null}
      <Section title="Contact" color={c.mint}>{ext ? <ExtContact x={inst} /> : <Contact id={x.organisation_id} />}</Section>
      <Reviews type={type} id={id} title="Ratings & reviews of this course" />
      {!ext ? <EnquireSheet visible={ask} onClose={() => setAsk(false)} organisationId={x.organisation_id} programme={x} /> : null}
    </Screen>
  );
}

// ------------------------------------------------------------------ the conversation (athlete and admissions team)
export function Enquiry({ id }) {
  const { toast } = useSession();
  const [text, setText] = useState(''), [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(null);
  const e = useLoad(() => api.get(`/enquiries/${id}`), [id]);
  if (e.error) return <Screen><ErrorBox error={e.error} onRetry={e.reload} /></Screen>;
  if (!e.data) return <Screen><Loading /></Screen>;
  const x = e.data, staff = x.my_side === 'staff', closed = ['closed', 'declined', 'withdrawn'].includes(x.status);
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); e.reload(); } catch (err) { fail(toast)(err); } };
  const send = async () => { setBusy(true); await act(() => api.post(`/enquiries/${id}/messages`, { body: text.trim() })); setText(''); setBusy(false); };
  const consent = (k, v) => act(() => api.patch(`/enquiries/${id}/consent`, { [k]: v }));
  return (
    <Screen>
      <GradCard colors={[c.violet, c.ink]}>
        <H1 color="#fff" style={{ fontSize: 24 }}>{staff ? `${x.athlete.display_name} (@${x.athlete.handle})` : x.organisation.name}</H1>
        <T color="#fff" weight="700">{x.programme?.title ?? 'General enquiry'}</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}><Tag label={label(STAGES, x.status)} color={c.lime} />{x.comms_consent ? <Tag label="Accepts announcements" color={c.lime} /> : null}</View>
      </GradCard>

      {staff ? (
        <Section title="Admissions" color={c.cyan}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {STAGES.filter(([k]) => ['in_conversation', 'applied', 'admitted', 'enrolled', 'declined', 'closed'].includes(k)).map(([k, l]) => <Chip key={k} label={l} active={x.status === k} onPress={() => k !== x.status && act(() => api.patch(`/enquiries/${id}/status`, { status: k }), `Marked ${l.toLowerCase()}`)} />)}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Btn small title="Send to apply on website" color={c.violet} disabled={closed} onPress={() => act(async () => { await api.post(`/enquiries/${id}/refer`, {}); }, 'Application link sent')} />
            <Btn small title="Share a brochure" color={c.paper} ink={c.ink} disabled={closed} onPress={() => setSheet('brochure')} />
            <Btn small title="Introduce to a sponsor" color={c.paper} ink={c.ink} disabled={closed} onPress={() => (x.sponsor_consent ? setSheet('sponsor') : toast('The athlete has not agreed to sponsor introductions'))} />
            {x.status === 'enrolled' ? <Btn small title="Issue certificate or badge" color={c.pink} onPress={() => setSheet('credential')} /> : null}
          </View>
        </Section>
      ) : (
        <Section title="Your choices" color={c.mint}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}><T weight="700">Announcements</T><T size={12} color={c.mute}>Open days and intake news from this institution.</T></View><Switch value={x.comms_consent} onValueChange={(v) => consent('comms_consent', v)} disabled={closed} /></View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}><T weight="700">Sponsor introductions</T><T size={12} color={c.mute}>They may introduce you to a sponsor. You decide on any offer.</T></View><Switch value={x.sponsor_consent} onValueChange={(v) => consent('sponsor_consent', v)} disabled={closed} /></View>
          {x.apply_url && !closed ? <Btn small title="Open the application page" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => openLink(x.apply_url)} /> : null}
        </Section>
      )}

      {x.sponsor_links.length ? <Section title="Sponsor introductions" color={c.sun}>{x.sponsor_links.map((l) => <Row key={l.id} title={`${l.sponsor_emoji ?? '💎'} ${l.sponsor_name}`} sub={l.note ?? ''} right={<Tag label={l.status === 'introduced' ? 'Introduced' : 'Withdrawn'} />} />)}</Section> : null}

      <Section title="Conversation" color={c.pink}>
        {x.messages.map((m) => {
          const mine = m.side === (staff ? 'institution' : 'athlete');
          if (m.side === 'system') return <T key={m.id} size={12} color={c.mute} style={{ textAlign: 'center' }}>{m.body} · {when(m.created_at)}</T>;
          return (
            <View key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '86%' }}>
              <Card color={mine ? c.pinkSoft : c.paper} pad={12}>
                {m.kind === 'broadcast' ? <Tag label="Announcement" /> : null}
                <T>{m.body}</T>
                {m.brochure_url ? <Btn small title={`📄 ${m.brochure_title}`} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => openLink(m.brochure_url)} /> : null}
                {m.link_url ? <Btn small title="Apply on the website" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => openLink(m.link_url)} /> : null}
                <T size={11} color={c.mute} style={{ marginTop: 4 }}>{m.side === 'institution' ? x.organisation.name : x.athlete.display_name} · {when(m.created_at)}</T>
              </Card>
            </View>
          );
        })}
        {closed && !staff ? <T size={13} color={c.mute}>This enquiry is {label(STAGES, x.status).toLowerCase()}.</T> : (
          <>
            <Field value={text} onChangeText={setText} multiline placeholder="Write a message…" maxLength={4000} />
            <Btn title="Send" onPress={send} loading={busy} disabled={!text.trim() || closed} />
          </>
        )}
        {!staff && !closed ? <Btn small title="Withdraw this enquiry" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start' }} onPress={() => act(async () => { await api.post(`/enquiries/${id}/withdraw`); }, 'Enquiry withdrawn')} /> : null}
      </Section>

      {staff ? <StaffSheets sheet={sheet} close={() => setSheet(null)} enquiry={x} reload={e.reload} /> : null}
    </Screen>
  );
}

function StaffSheets({ sheet, close, enquiry: x, reload }) {
  const sports = useSports();
  const orgId = x.organisation.id;
  const brochures = useLoad(() => (sheet === 'brochure' ? api.get(`/organisations/${orgId}/brochures`, { limit: 100 }) : Promise.resolve([])), [sheet]);
  const sponsorsList = useLoad(() => (sheet === 'sponsor' ? api.get('/sponsors', { limit: 100 }) : Promise.resolve([])), [sheet]);
  const idOf = (slug) => (sports.data ?? []).find((s) => s.slug === slug)?.id;
  const active = (brochures.data ?? []).filter((b) => b.status === 'active');
  return (
    <>
      <FormSheet visible={sheet === 'brochure'} onClose={close} title="Share a brochure" submitLabel="Send"
        fields={[active.length ? { key: 'brochure_id', label: 'Brochure', type: 'chips', options: active.map((b) => ({ value: b.id, label: b.title })) } : { key: 'none', type: 'section', label: 'Add a brochure first (Admissions → Programmes & brochures).' }, { key: 'body', label: 'Message', type: 'multiline', default: 'Here is our brochure.' }]}
        initial={{ body: 'Here is our brochure.' }}
        onSubmit={async (v) => { await api.post(`/enquiries/${x.id}/messages`, { body: v.body, brochure_id: v.brochure_id }); reload(); return 'Brochure shared'; }} />
      <FormSheet visible={sheet === 'sponsor'} onClose={close} title="Introduce to a sponsor" submitLabel="Introduce"
        fields={[{ key: 'sponsor_id', label: 'Sponsor', type: 'chips', options: (sponsorsList.data ?? []).map((s) => ({ value: s.id, label: `${s.emoji} ${s.name}` })) }, { key: 'note', label: 'Why this athlete (optional)', optional: true, type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/enquiries/${x.id}/sponsor-links`, v); reload(); return 'Introduced'; }} />
      <FormSheet visible={sheet === 'credential'} onClose={close} title="Issue a certificate or badge" submitLabel="Issue"
        fields={[
          { key: 'kind', label: 'Type', type: 'chips', options: [['certificate', 'Certificate'], ['badge', 'Badge'], ['diploma', 'Diploma'], ['degree', 'Degree'], ['course', 'Course completion']].map(([value, l]) => ({ value, label: l })) },
          { key: 'title', label: 'Title' }, { key: 'description', label: 'What it recognises', type: 'multiline', optional: true },
          { key: 'sport', label: 'Sport', type: 'sport', optional: true }, { key: 'expires_on', label: 'Valid until', type: 'date', optional: true },
        ]}
        onSubmit={async (v) => { const r = await api.post(`/organisations/${orgId}/credentials`, { enquiry_id: x.id, kind: v.kind, title: v.title, description: v.description, sport_id: v.sport ? idOf(v.sport) : undefined, expires_on: v.expires_on }); reload(); return `Issued (${r.code})`; }} />
    </>
  );
}
