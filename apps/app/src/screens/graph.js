// Sports Graph (#561): one search across people, organisations, teams, events and venues; the Athlete 360 and Organisation 360 (sections the
// viewer may not see say so); effective-dated relationships; and the cross-domain timeline. The UI only calls the /graph API.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Row, Screen, Section, Sheet, T, Tag } from '../ui';
import { HScroll } from '../pickers';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { saveFile } from '../contracts-ui';
import { JourneyCompare, JourneyFilters, OriginLegend, OriginTag, filterQuery, filtered } from './journey-ui';

const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const day = (s) => (s ? new Date(`${String(s).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const span = (e) => `${day(e.valid_from)} – ${e.valid_to ? day(e.valid_to) : 'now'}`;
const say = (e) => (e?.details?.code === 'stale_version' ? 'This was changed somewhere else. Reload and try again.' : e?.message ?? 'Something went wrong');
const KINDS = [['all', 'All'], ['person', 'People'], ['organisation', 'Organisations'], ['team', 'Teams'], ['event', 'Events'], ['venue', 'Venues']];
const ROUTE = { person: 'Athlete360', organisation: 'Organisation360', team: 'Team', event: 'Event', venue: 'Venue' };
const VERIFY = { verified: ['Verified', c.mint], unverified: ['Not yet verified', c.sun], rejected: ['Rejected', c.red], claimed: ['Claimed', c.sun] };
const DOMAIN_LABEL = {
  career: 'Career', competition: 'Matches', result: 'Results', achievement: 'Achievements', contract: 'Contracts', relationship: 'Network', health: 'Availability', organisation: 'Organisation',
  registration: 'Registrations', accreditation: 'Badges', travel: 'Travel', payment: 'Payments', invoice: 'Invoices', sponsorship: 'Sponsors', assessment: 'Assessments', media: 'Media', statistics: 'Statistics', development: 'Development', training: 'Training', opportunity: 'Opportunities', supplier: 'Suppliers',
};
const SOURCE_ROUTE = { career_memberships: 'CareerTimeline', player_contracts: 'PlayerContracts', player_goals: 'MyDevelopment', player_plans: 'MyDevelopment', passport_videos: 'Passport', teams: 'Team', events: 'Event', trips: 'Trip', invoices: 'Invoice', accreditations: 'MyAccreditations' };
const newKey = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const Locked = ({ reason }) => <Card color={c.violetSoft}><T size={13} color={c.mute}>🔒 {reason ?? 'Not shared with you'}</T></Card>;
/** One 360 section: its data when the viewer may see it, else a plain lock note. */
function Part({ title, sec, empty, children }) {
  return (
    <Section title={title} color={c.pink}>
      {!sec || sec.access === 'forbidden' ? <Locked reason={sec?.reason} /> : (Array.isArray(sec.data) && !sec.data.length ? <Empty emoji="🫥" title={empty ?? 'Nothing recorded yet'} /> : children(sec.data))}
    </Section>
  );
}
const Verification = ({ state }) => (VERIFY[state] ? <Tag label={VERIFY[state][0]} color={VERIFY[state][1]} /> : null);

// ------------------------------------------------------------------ search
export function SportsGraph() {
  const { push } = useNav();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [term, setTerm] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const res = useLoad(() => (term.length >= 2 ? api.get('/graph/search', { q: term, kinds: kind === 'all' ? undefined : kind, limit: 40 }) : Promise.resolve([])), [term, kind]);
  const rows = res.data ?? [];
  return (
    <Screen wide>
      <H1>Sports graph</H1>
      <T size={13} color={c.mute}>One search across people, organisations, teams, events and venues.</T>
      <View style={{ marginTop: 12 }}><Field value={q} onChangeText={setQ} placeholder="Search a name, handle or alias…" accessibilityLabel="Search the sports graph" /></View>
      <HScroll style={{ marginTop: 8 }}>{KINDS.map(([k, l]) => <Chip key={k} label={l} active={kind === k} onPress={() => setKind(k)} />)}</HScroll>
      <View style={{ marginTop: 14, gap: 8 }}>
        {term.length < 2 ? <Empty emoji="🔎" title="Search to begin" sub="Type at least two letters. Records with the same name stay separate until an identifier is verified." />
          : res.loading && !res.data ? <Loading /> : res.error ? <ErrorBox error={res.error} onRetry={res.reload} />
          : !rows.length ? <Empty emoji="🫥" title="No matches" sub="Try another spelling, or a known alias." />
          : rows.map((r) => (
            <Row key={`${r.kind}${r.id}`} title={`${r.emoji ?? ''} ${r.label}`.trim()} sub={[nice(r.kind), r.sub].filter(Boolean).join(' · ')} onPress={() => push(ROUTE[r.kind], { id: r.id })}
              right={<View style={{ gap: 4, alignItems: 'flex-end' }}>
                {r.identity === 'verified' ? <Tag label="Verified ID" color={c.mint} /> : <Tag label={r.matched_by === 'alias' ? 'Alias match' : 'Name match only'} color={c.sun} />}
                {r.verified_schemes?.length ? <Tag label={`${r.verified_schemes.length} verified ID${r.verified_schemes.length > 1 ? 's' : ''}`} color={c.mint} /> : null}
              </View>} />
          ))}
      </View>
    </Screen>
  );
}

// ------------------------------------------------------------------ timeline
export function GraphTimeline({ kind, id, organisation_id, filter = {} }) {
  const { push } = useNav();
  const [domains, setDomains] = useState([]);
  const [origin, setOrigin] = useState('');
  const [pages, setPages] = useState(1);
  const fq = filterQuery(filter);
  const csv = domains.length ? domains.join(',') : undefined;
  const tl = useLoad(() => api.get('/graph/timeline', { kind, id, domains: csv, organisation_id, origin: origin || undefined, ...fq, limit: 30 * pages }), [kind, id, csv, pages, origin, JSON.stringify(fq)]);
  const d = tl.data;
  const toggle = (k) => { setPages(1); setDomains((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k])); };
  return (
    <View style={{ gap: 10 }}>
      <HScroll>
        <Chip label="All" active={!domains.length} onPress={() => { setPages(1); setDomains([]); }} />
        {Object.entries(DOMAIN_LABEL).filter(([k]) => !d || d.domains.includes(k)).map(([k, l]) => <Chip key={k} label={l} active={domains.includes(k)} onPress={() => toggle(k)} />)}
      </HScroll>
      <HScroll>
        {[['', 'Any origin'], ['verified', '✓ Verified'], ['user_entered', '✎ Entered by athlete'], ['external', '⇄ External']].map(([k, l]) => <Chip key={k || 'any'} label={l} active={origin === k} onPress={() => { setPages(1); setOrigin(k); }} />)}
      </HScroll>
      {tl.loading && !d ? <Loading /> : tl.error ? <ErrorBox error={tl.error} onRetry={tl.reload} /> : !d.items.length ? <Empty emoji="🕰️" title="Nothing on the timeline yet" sub={filtered(filter) || origin ? 'No records match these filters. Widen the period or sport, or choose Any origin.' : 'Career moves, matches, results, awards and shared availability appear here as they are recorded.'} /> : (
        <View style={{ gap: 8 }}>
          {d.items.map((it) => (
            <Row key={`${it.source.table}${it.source.id}${it.type}${it.at}`} title={it.title} sub={[day(it.at), it.summary].filter(Boolean).join(' · ')}
              onPress={SOURCE_ROUTE[it.source.table] ? () => push(SOURCE_ROUTE[it.source.table], ['career_memberships', 'player_contracts', 'accreditations', 'player_goals', 'player_plans', 'passport_videos'].includes(it.source.table) ? {} : { id: it.source.id }) : undefined}
              right={<View style={{ gap: 4, alignItems: 'flex-end' }}><Tag label={DOMAIN_LABEL[it.domain] ?? it.domain} color={c.cyan} /><OriginTag origin={it.origin} />{it.provenance === 'derived' ? <Tag label="Derived" color={c.violetSoft} /> : null}</View>} />
          ))}
          {d.next_offset ? <Btn small title="Show more" color={c.paper} ink={c.ink} onPress={() => setPages((p) => p + 1)} /> : null}
        </View>
      )}
      {d?.hidden_domains?.length ? <T size={12} color={c.mute}>🔒 Not shown to you: {d.hidden_domains.map((x) => DOMAIN_LABEL[x] ?? x).join(', ')}</T> : null}
      {d ? <OriginLegend origins={d.origins} /> : null}
    </View>
  );
}

// ------------------------------------------------------------------ identity (aliases + verified identifiers)
function IdentityCard({ ident, reload }) {
  const { toast } = useSession();
  const [form, setForm] = useState(null);
  const kind = ident.kind;
  return (
    <Card>
      <H2>{ident.emoji ?? ''} {ident.label}</H2>
      <T size={13} color={c.mute}>{ident.sub}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {ident.aliases.map((a) => <Tag key={a.alias} label={`aka ${a.alias}`} color={c.violetSoft} />)}
        {ident.external_ids.map((x) => <Tag key={x.scheme + x.verification_state} label={`${nice(x.scheme)} · ${VERIFY[x.verification_state]?.[0] ?? x.verification_state}`} color={VERIFY[x.verification_state]?.[1] ?? c.violetSoft} />)}
      </View>
      {ident.can_manage ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <Btn small title="+ Alias" color={c.paper} ink={c.ink} onPress={() => setForm('alias')} accessibilityLabel="Add an alias" />
          <Btn small title="+ Identifier" color={c.paper} ink={c.ink} onPress={() => setForm('ext')} accessibilityLabel="Add an external identifier" />
        </View>
      ) : null}
      {form === 'alias' ? (
        <FormSheet visible onClose={() => setForm(null)} title="Add an alias" submitLabel="Add alias" initial={{}}
          fields={[{ key: 'alias', label: 'Other name', placeholder: 'Former name, abbreviation…', hint: 'Search will find this record by it. It never merges two records.' }]}
          onSubmit={async (v) => { try { await api.post('/graph/aliases', { kind, entity_id: ident.id, alias: v.alias }); toast('Alias added'); setForm(null); reload(); } catch (e) { throw new Error(say(e)); } }} />
      ) : null}
      {form === 'ext' ? (
        <FormSheet visible onClose={() => setForm(null)} title="Add an identifier" submitLabel="Add identifier" initial={{ scheme: 'federation_licence' }}
          fields={[
            { key: 'scheme', label: 'Kind of identifier', type: 'chips', options: ['federation_licence', 'league_registration', 'club_member_no', 'olympic_id', 'data_provider', 'wikidata', 'other'].map((value) => ({ value, label: nice(value).replace(/^./, (x) => x.toUpperCase()) })) },
            { key: 'value', label: 'Identifier', placeholder: 'As printed on the licence or card', hint: 'Stored encrypted. It identifies this record only once the issuer verifies it.' },
            { key: 'issuer_org_id', label: 'Issued by', type: 'entity', entityKind: 'organisation', noun: 'organisation', optional: true },
          ]}
          onSubmit={async (v) => { try { await api.post('/graph/external-ids', { kind, entity_id: ident.id, scheme: v.scheme, value: v.value, issuer_org_id: v.issuer_org_id || undefined }); toast('Identifier added, waiting for the issuer'); setForm(null); reload(); } catch (e) { throw new Error(say(e)); } }} />
      ) : null}
    </Card>
  );
}

/** Relationship list. Rows open a sheet with the history and the actions the viewer's role allows (the server decides). */
function Edges({ edges, reload, anchor }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(null);
  const [ending, setEnding] = useState(null);
  const hist = useLoad(() => (open ? api.get(`/graph/edges/${open.id}/history`) : Promise.resolve([])), [open?.id]);
  const act = async (fn, msg) => { try { await fn(); toast(msg); setOpen(null); reload(); } catch (e) { toast(say(e)); } };
  if (!edges.length) return <Empty emoji="🕸️" title="No relationships recorded" sub="Memberships, affiliations and hierarchy appear here with the dates they applied." />;
  return (
    <View style={{ gap: 8 }}>
      {edges.map((e) => {
        const other = e.from.id === anchor ? e.to : e.from;
        const dir = e.from.id === anchor ? e.rel_label : `${e.rel_label} (by ${e.from.label})`;
        return <Row key={e.id} title={`${nice(dir)} · ${other.label}`} sub={`${span(e)} · ${nice(e.status)}`} onPress={() => setOpen(e)} right={<Verification state={e.verification_state} />} />;
      })}
      <Sheet visible={!!open} onClose={() => setOpen(null)} title="Relationship">
        {open ? (
          <View style={{ gap: 10 }}>
            <T weight="700">{open.from.label} {open.rel_label} {open.to.label}</T>
            <T size={13} color={c.mute}>{span(open)} · recorded by {nice(open.source_authority)}{open.external_ref ? ` · ref ${open.external_ref}` : ''}</T>
            {open.note ? <T size={13}>{open.note}</T> : null}
            {open.status === 'active' ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Btn small title="Verify" onPress={() => act(() => api.post(`/graph/edges/${open.id}/verify`, { decision: 'verified' }), 'Verified')} accessibilityLabel="Verify this relationship" />
                <Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/graph/edges/${open.id}/verify`, { decision: 'rejected' }), 'Rejected')} />
                <Btn small title="End" color={c.paper} ink={c.ink} onPress={() => { setEnding(open); setOpen(null); }} accessibilityLabel="End this relationship" />
              </View>
            ) : null}
            <H2>History</H2>
            {hist.loading ? <Loading /> : (hist.data ?? []).map((h) => <T key={h.id} size={13} color={c.mute}>{day(h.created_at)} · {nice(h.action)} by {h.actor ?? 'system'}{h.reason ? ` — ${h.reason}` : ''}</T>)}
          </View>
        ) : null}
      </Sheet>
      {ending ? (
        <FormSheet visible onClose={() => setEnding(null)} title="End this relationship" submitLabel="End relationship" initial={{ withdraw: false }}
          fields={[
            { key: 'valid_to', label: 'Last day', type: 'date' },
            { key: 'withdraw', label: 'Recorded by mistake (withdraw it)', type: 'switch' },
            { key: 'reason', label: 'Reason', optional: true, placeholder: 'Kept in the history' },
          ]}
          onSubmit={async (v) => { try { await api.post(`/graph/edges/${ending.id}/end`, { valid_to: v.valid_to || undefined, withdraw: !!v.withdraw, reason: v.reason || undefined }); toast('Relationship ended, history kept'); setEnding(null); reload(); } catch (e) { throw new Error(say(e)); } }} />
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ Athlete 360
const A_TABS = [['career', 'Career'], ['play', 'Play'], ['timeline', 'Timeline'], ['compare', 'Compare'], ['development', 'Development'], ['contracts', 'Contracts'], ['health', 'Availability'], ['network', 'Network'], ['portfolio', 'Portfolio']];
export function Athlete360({ id, organisation_id }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [tab, setTab] = useState('career');
  const [f, setF] = useState({ sport: '', period: '' });
  const [base, setBase] = useState(null);
  const fq = filterQuery(f);
  const r = useLoad(() => api.get(`/graph/athletes/${id}/360`, { organisation_id, ...fq }), [id, organisation_id, JSON.stringify(fq)]);
  // the sport and stint pickers list the whole career, so they are taken from the unfiltered read and kept while a filter is on
  useEffect(() => { if (r.data && !filtered(f)) setBase(r.data.sections); }, [r.data]);
  if (r.loading && !r.data) return <Screen><Loading /></Screen>;
  if (r.error) return <Screen><ErrorBox error={r.error} onRetry={r.reload} /></Screen>;
  const s = r.data.sections;
  const all = base ?? s;
  const stints = all.career?.access === 'ok' ? all.career.data.stints : [];
  const sports = [...new Map([...stints.map((m) => [m.sport_slug, m.sport]), ...(all.results?.access === 'ok' ? all.results.data.by_sport.map((x) => [x.sport_slug, x.sport]) : [])]).entries()].map(([slug, name]) => ({ slug, name }));
  const self = r.data.viewer_relation === 'self';
  const ident = { kind: 'person', ...s.identity.data };
  return (
    <Screen wide refreshing={r.loading} onRefresh={r.reload}>
      <IdentityCard ident={ident} reload={r.reload} />
      <HScroll style={{ marginTop: 10 }}>{A_TABS.filter(([k]) => k !== 'portfolio' || self).map(([k, l]) => <Chip key={k} label={l} active={tab === k} onPress={() => setTab(k)} />)}</HScroll>
      {['career', 'play', 'timeline', 'development'].includes(tab) && (stints.length || sports.length) ? <JourneyFilters f={f} setF={setF} sports={sports} stints={stints} /> : null}
      <View style={{ marginTop: 6 }}>
        {tab === 'career' ? (
          <>
            <Part title="Clubs and teams" sec={s.career} empty="No clubs on the career timeline yet">{(d) => (
              <View style={{ gap: 8 }}>{d.stints.map((m) => <Row key={m.id} title={m.club} sub={`${m.sport_emoji ?? ''} ${m.sport} · ${m.starts_on?.slice(0, 7)} – ${m.current ? 'now' : m.ends_on?.slice(0, 7)}`} right={<OriginTag origin={m.origin} />} />)}</View>
            )}</Part>
            {s.career?.access === 'ok' && s.career.data.moves.length ? (
              <Section title="Moves" color={c.pink}>{s.career.data.moves.map((m) => <Row key={m.to_membership_id} title={`${m.from_club} → ${m.to_club}`} sub={`${day(m.on)} · ${m.sport}`} right={<View style={{ gap: 4, alignItems: 'flex-end' }}><OriginTag origin={m.origin} /><Tag label="Derived" color={c.violetSoft} /></View>} />)}</Section>
            ) : null}
          </>
        ) : null}
        {tab === 'play' ? (
          <>
            <Part title="Matches played" sec={s.competitions}>{(d) => (
              <View style={{ gap: 8 }}>
                <T size={13} color={c.mute}>{d.totals.matches} matches · {d.totals.verified_minutes} verified minutes · {d.totals.competitions} competitions</T>
                {d.recent.map((a) => <Row key={a.id} title={`${a.team} vs ${a.opponent ?? 'TBC'}`} sub={`${day(a.scheduled_at)} · ${a.competition} · ${a.sport}`} right={<OriginTag origin={a.origin} />} />)}
              </View>
            )}</Part>
            <Part title="Results by sport" sec={s.results}>{(d) => (
              <View style={{ gap: 8 }}>
                {d.by_sport.map((x) => <Row key={x.sport_slug} title={x.sport} sub={`${x.games} games · ${x.wins} wins · ${x.podiums} podiums`} />)}
                <T size={12} color={c.mute}>{d.note}</T>
              </View>
            )}</Part>
            <Part title="Performance records" sec={s.statistics} empty="No approved records yet">{(d) => <View style={{ gap: 8 }}>{d.map((x) => <Row key={x.source.id} title={x.title} sub={`${day(x.at)} · ${x.summary}`} right={<OriginTag origin={x.origin} />} />)}</View>}</Part>
            <Part title="Achievements" sec={s.achievements} empty="No awards yet">{(d) => <View style={{ gap: 8 }}>{d.map((a) => <Row key={a.id} title={a.name} sub={`${day(a.awarded_at)}${a.competition ? ` · ${a.competition}` : ''}`} />)}</View>}</Part>
          </>
        ) : null}
        {tab === 'contracts' ? <Part title="Contracts" sec={s.contracts} empty="No contracts shared with you">{(d) => <View style={{ gap: 8 }}>{d.map((k) => <Row key={k.id} title={k.title} sub={[nice(k.role), k.team, k.starts_on && `${day(k.starts_on)} – ${day(k.ends_on)}`].filter(Boolean).join(' · ')} right={<Tag label={nice(k.status)} color={c.cyan} />} />)}</View>}</Part> : null}
        {tab === 'health' ? (
          <Part title="Availability" sec={s.health}>{(d) => (
            <Card>
              <T weight="700">{nice(d.status ?? 'unknown')}</T>
              <T size={13} color={c.mute}>{d.valid_until ? `Valid until ${day(d.valid_until)}` : 'No end date'}{d.review_due ? ' · review due' : ''}</T>
              <T size={12} color={c.mute} style={{ marginTop: 6 }}>Availability only, shared by the athlete or guardian. Diagnosis and notes are never part of this view.</T>
            </Card>
          )}</Part>
        ) : null}
        {tab === 'network' ? <Section title="Relationships" color={c.pink}><Edges edges={s.relationships.data} reload={r.reload} anchor={id} /></Section> : null}
        {tab === 'timeline' ? <GraphTimeline kind="person" id={id} organisation_id={organisation_id} filter={f} /> : null}
        {tab === 'compare' ? <JourneyCompare id={id} stints={stints} sport={f.sport} /> : null}
        {tab === 'development' ? (
          <Part title="Goals and plans" sec={s.development} empty="No goals or plans yet">{(d) => (
            <View style={{ gap: 8 }}>
              {d.map((x) => <Row key={`${x.source.id}${x.type}`} title={x.title} sub={[day(x.at), x.summary].filter(Boolean).join(' · ')} onPress={self ? () => push('MyDevelopment') : undefined} right={<OriginTag origin={x.origin} />} />)}
              <T size={12} color={c.mute}>Titles and status only. The reasons behind a goal stay with the athlete.</T>
            </View>
          )}</Part>
        ) : null}
        {tab === 'portfolio' ? (
          <Section title="Share or download this portfolio" color={c.pink}>
            <Card>
              <T>The portfolio is your player passport. Choose what a link shows (this career and development timeline, and separately your goals), who it is for, and how long it lasts. A link can be turned off at any time and always reads the latest records.</T>
              <T size={12} color={c.mute} style={{ marginTop: 8 }}>Every row on a shared portfolio says whether it is verified, entered by you, or external. Contracts, health, payments and travel are never part of it.</T>
              <View style={{ marginTop: 12, flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Btn title="Choose what to share" onPress={() => push('Passport')} accessibilityLabel="Open the passport to choose what to share" />
                <Btn title="Download a copy" color={c.paper} ink={c.ink} onPress={async () => { try { await saveFile('portfolio.json', JSON.stringify(await api.get('/me/passport'), null, 2), 'application/json'); toast('Portfolio saved'); } catch (e) { toast(say(e)); } }} accessibilityLabel="Download a copy of your full portfolio" />
              </View>
            </Card>
          </Section>
        ) : null}
      </View>
    </Screen>
  );
}

// ------------------------------------------------------------------ Organisation 360
const REL_OPTIONS = [['member_of', 'Member of'], ['part_of', 'Part of'], ['affiliated_with', 'Affiliated with']].map(([value, label]) => ({ value, label }));
export function Organisation360({ id }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [tab, setTab] = useState('hierarchy');
  const [adding, setAdding] = useState(false);
  const r = useLoad(() => api.get(`/graph/organisations/${id}/360`), [id]);
  if (r.loading && !r.data) return <Screen><Loading /></Screen>;
  if (r.error) return <Screen><ErrorBox error={r.error} onRetry={r.reload} /></Screen>;
  const s = r.data.sections;
  const staff = r.data.viewer_relation === 'staff';
  const tabs = [['hierarchy', 'Hierarchy'], ['teams', 'Teams'], ['events', 'Events'], ['people', 'People'], ['timeline', 'Timeline']];
  return (
    <Screen wide refreshing={r.loading} onRefresh={r.reload}>
      <IdentityCard ident={{ kind: 'organisation', ...s.identity.data }} reload={r.reload} />
      <HScroll style={{ marginTop: 10 }}>{tabs.map(([k, l]) => <Chip key={k} label={l} active={tab === k} onPress={() => setTab(k)} />)}</HScroll>
      <View style={{ marginTop: 6 }}>
        {tab === 'hierarchy' ? (
          <>
            {staff ? <View style={{ alignItems: 'flex-start', marginBottom: 6 }}><Btn small title="+ Add relationship" onPress={() => setAdding(true)} accessibilityLabel="Add a membership or hierarchy relationship" /></View> : null}
            <Section title="Memberships and hierarchy" color={c.pink}><Edges edges={s.hierarchy.data.edges} reload={r.reload} anchor={id} /></Section>
            {s.hierarchy.data.federation_links.length ? (
              <Section title="Recognised federation links" color={c.pink}>{s.hierarchy.data.federation_links.map((l) => <Row key={l.id} title={`${l.parent} → ${l.child}`} sub={l.valid_from ? `${day(l.valid_from)} – ${l.valid_to ? day(l.valid_to) : 'now'}` : 'Recognised'} right={<Tag label="Federation" color={c.cyan} />} />)}</Section>
            ) : null}
          </>
        ) : null}
        {tab === 'teams' ? <Part title="Teams" sec={s.teams} empty="No teams yet">{(d) => <View style={{ gap: 8 }}>{d.map((t) => <Row key={t.id} title={`${t.emoji ?? ''} ${t.name}`} sub={t.sport} onPress={() => push('Team', { id: t.id })} />)}</View>}</Part> : null}
        {tab === 'events' ? <Part title="Events" sec={s.events} empty="No published events">{(d) => <View style={{ gap: 8 }}>{d.map((e) => <Row key={e.id} title={e.name} sub={`${e.sport} · ${nice(e.kind)}${e.starts_on ? ` · ${day(e.starts_on)}` : ''}`} onPress={() => push('Event', { id: e.id })} />)}</View>}</Part> : null}
        {tab === 'people' ? (
          <>
            <Part title="People" sec={s.people} empty="No staff yet">{(d) => <View style={{ gap: 8 }}>{d.map((p) => <Row key={p.id} title={p.display_name} sub={nice(p.role)} onPress={() => push('Athlete360', { id: p.user_id })} />)}</View>}</Part>
            {s.memberships?.access === 'ok' ? <T size={13} color={c.mute} style={{ marginTop: 8 }}>{s.memberships.data.current} current career stints · {s.memberships.data.verified} verified · {s.memberships.data.total} in total</T> : null}
          </>
        ) : null}
        {tab === 'timeline' ? <GraphTimeline kind="organisation" id={id} /> : null}
      </View>
      {adding ? (
        <FormSheet visible onClose={() => setAdding(false)} title="Add a relationship" submitLabel="Add relationship" initial={{ rel: 'member_of', still: true }}
          fields={[
            { key: 'rel', label: `${s.identity.data.label} is…`, type: 'chips', options: REL_OPTIONS },
            { key: 'to_id', label: 'Organisation', type: 'entity', entityKind: 'organisation', noun: 'organisation' },
            { key: 'valid_from', label: 'From', type: 'date' },
            { key: 'still', label: 'Still current', type: 'switch' },
            { key: 'valid_to', label: 'Until', type: 'date', show: (v) => !v.still },
            { key: 'external_ref', label: 'Reference', optional: true, placeholder: 'Membership or affiliation number' },
          ]}
          onSubmit={async (v) => {
            try {
              await api.post('/graph/edges', { from_kind: 'organisation', from_id: id, rel: v.rel, to_kind: 'organisation', to_id: v.to_id, valid_from: v.valid_from, valid_to: v.still ? undefined : v.valid_to, external_ref: v.external_ref || undefined, idempotency_key: newKey() });
              toast('Relationship added, waiting for the other side to verify'); setAdding(false); r.reload();
            } catch (e) { throw new Error(say(e)); }
          }} />
      ) : null}
    </Screen>
  );
}
