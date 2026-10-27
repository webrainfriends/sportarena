// Federation OS (#475): the registers a body works from: affiliations, licences and sanctions. Each is the canonical list with the body's own filters;
// tapping a row opens the record. Categories and licence types (what the body offers) are managed beside the register that uses them.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Chip, Empty, Field, Loading, Section, Seg, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c } from '../theme';
import { fmtDate, fmtRange, money, HOLDER_ROLES } from '../federation-ui';
import { ListCard, Pager } from '../federation-bits';

const PAGE = 20;
const STATUSES = {
  affiliations: ['submitted', 'under_review', 'needs_info', 'approved', 'suspended', 'expired', 'rejected', 'withdrawn'],
  licences: ['submitted', 'under_review', 'needs_info', 'active', 'suspended', 'expired', 'revoked', 'rejected', 'withdrawn'],
  sanctions: ['requested', 'under_review', 'needs_info', 'approved', 'suspended', 'revoked', 'rejected', 'withdrawn'],
};
const LABEL = (s) => s.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const TYPE = { affiliations: 'affiliation', licences: 'licence', sanctions: 'sanction' };
const KINDS = ['club', 'academy', 'school', 'league', 'other'].map((v) => ({ value: v, label: LABEL(v) }));
const useDebounced = (v, ms = 300) => { const [x, setX] = useState(v); useEffect(() => { const t = setTimeout(() => setX(v), ms); return () => clearTimeout(t); }, [v, ms]); return x; };

/** What this body offers: affiliation categories or licence types, with add / edit / archive for the role that owns them. */
function Offer({ kind, id, can }) {
  const body = useLoad(() => api.get(`/federation/bodies/${id}`), [id]);
  const rows = useLoad(() => api.get(`/federation/bodies/${id}/${kind === 'affiliations' ? 'affiliation-categories' : 'licence-types'}`, { include_archived: true }), [id, kind]);
  const [edit, setEdit] = useState(null);
  const sports = body.data?.sports ?? [];
  const aff = kind === 'affiliations';
  const fields = aff ? [
    { key: 'name', label: 'Name', hint: 'e.g. Full club, Associate school' },
    { key: 'applicant_kind', label: 'Who can apply', type: 'chips', options: KINDS },
    ...(sports.length ? [{ key: 'sport_id', label: 'Sport (optional)', type: 'chips', options: sports.map((s) => ({ value: s.sport_id, label: s.sport_name })), optional: true }] : []),
    { key: 'description', label: 'Description', multiline: true, optional: true },
    { key: 'currency', label: 'Currency', type: 'currency', default: 'USD' },
    { key: 'fee_minor', label: 'Fee (leave 0 for none)', type: 'money', currency: (v) => v.currency },
    { key: 'duration_months', label: 'Lasts (months)', type: 'stepper', min: 1, max: 60, default: 12 },
    ...(edit?.id ? [{ key: 'archived', label: 'Retire this category', type: 'switch' }] : []),
  ] : [
    { key: 'name', label: 'Name', hint: 'e.g. Senior player, Umpire' },
    { key: 'holder_role', label: 'Held by', type: 'chips', options: HOLDER_ROLES },
    { key: 'sport_id', label: 'Sport', type: 'chips', options: sports.map((s) => ({ value: s.sport_id, label: s.sport_name })) },
    { key: 'discipline', label: 'Discipline (optional)', optional: true },
    { key: 'grade', label: 'Grade (optional)', optional: true, hint: 'e.g. Level 2' },
    { key: 'grade_rank', label: 'Grade rank', type: 'stepper', min: 0, max: 20, default: 0, hint: 'Higher is more senior. Sanction conditions can ask for officials of a rank or above.' },
    { key: 'duration_months', label: 'Lasts (months)', type: 'stepper', min: 1, max: 120, default: 12 },
    { key: 'currency', label: 'Currency', type: 'currency', default: 'USD' },
    { key: 'fee_minor', label: 'Fee (leave 0 for none)', type: 'money', currency: (v) => v.currency },
    { key: 'requires_verification', label: 'Needs a platform-verified profile', type: 'chips', options: [{ value: 'none', label: 'No' }, { value: 'coach', label: 'Coach' }, { value: 'physio', label: 'Physio' }, { value: 'doctor', label: 'Doctor' }, { value: 'gamer', label: 'Athlete' }] },
    { key: 'requires_affiliation', label: 'Held through an affiliated club', type: 'switch' },
    { key: 'window_required', label: 'Only while a registration window is open', type: 'switch' },
    ...(edit?.id ? [{ key: 'archived', label: 'Retire this licence type', type: 'switch' }] : []),
  ];
  const initial = edit?.id ? { ...edit, archived: !!edit.archived_at, requires_verification: edit.requires_verification ?? 'none', sport_id: edit.sport_id ?? undefined } : { applicant_kind: 'club', holder_role: 'athlete', requires_verification: 'none', sport_id: sports.length === 1 ? sports[0].sport_id : undefined };
  return (
    <Section title={aff ? 'Affiliation categories' : 'Licence types'} color={c.cyan} action={can ? 'Add' : undefined} onAction={() => setEdit({})}>
      {rows.error ? <LoadError error={rows.error} onRetry={rows.reload} /> : !rows.data ? <Loading /> : rows.data.length ? rows.data.map((k) => (
        <ListCard key={k.id} title={k.name} sub={aff ? `${LABEL(k.applicant_kind)}${k.sport_name ? ` · ${k.sport_name}` : ''} · ${k.duration_months} months` : `${k.holder_role} · ${k.sport_name}${k.discipline ? ` · ${k.discipline}` : ''}${k.grade ? ` · ${k.grade}` : ''} · ${k.duration_months} months`}
          sub2={k.fee_minor ? money(k.fee_minor, k.currency) : 'No fee'} status={k.archived_at ? 'archived' : undefined} onPress={can ? () => setEdit(k) : undefined} />))
        : <Empty emoji={aff ? '🏷️' : '🪪'} title={aff ? 'No affiliation categories yet' : 'No licence types yet'} sub={can ? 'Add what clubs or people can apply for.' : undefined} />}
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Change' : 'Add'} fields={fields} initial={initial}
        onSubmit={async (v) => {
          const out = { ...v, ...(edit?.id ? { [aff ? 'category_id' : 'type_id']: edit.id } : {}), archived: !!v.archived };
          if (out.requires_verification === 'none') delete out.requires_verification;
          await api.post(`/federation/bodies/${id}/${aff ? 'affiliation-categories' : 'licence-types'}`, out);
          rows.reload(); body.reload(); return 'Saved';
        }} />
    </Section>
  );
}

/** Competitions under the body's jurisdiction, from the canonical events, with this body's sanction state. */
function Competitions({ id, below }) {
  const { push } = useNav();
  const [sanctioned, setSanctioned] = useState(null);
  const [offset, setOffset] = useState(0);
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const list = useLoad(() => api.get(`/federation/bodies/${id}/events`, { include_descendants: below, sanctioned: sanctioned || undefined, q: q || undefined, limit: PAGE, offset }), [id, below, sanctioned, q, offset]);
  return (
    <View style={{ gap: 10 }}>
      <Field value={text} onChangeText={(x) => { setText(x); setOffset(0); }} placeholder="Search competitions" accessibilityLabel="Search competitions" />
      <Seg options={[{ value: null, label: 'All' }, { value: 'yes', label: 'Sanctioned' }, { value: 'pending', label: 'Request pending' }, { value: 'no', label: 'Not sanctioned' }]} value={sanctioned} onChange={(v) => { setSanctioned(v); setOffset(0); }} />
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : (
        <>
          <T size={12} color={c.mute}>{list.data.total} competition{list.data.total === 1 ? '' : 's'} under jurisdiction</T>
          {list.data.items.length ? list.data.items.map((e) => (
            <ListCard key={e.id} title={e.name} sub={`${e.sport_name} · ${fmtRange(e.starts_on, e.ends_on)}${e.city ? ` · ${e.city}` : ''}`} sub2={[e.organiser_organisation, e.venue_name, e.sanction_no].filter(Boolean).join(' · ')}
              status={e.sanction_status ?? undefined} statusLabel={e.sanction_status ? undefined : undefined} onPress={e.sanction_id ? () => push('FederationRecord', { type: 'sanction', id: e.sanction_id }) : () => push('Event', { id: e.id })} />))
            : <Empty emoji="🏆" title="No competitions found" sub="Events in the sports you govern, run by affiliated organisations or sent to you for sanction, appear here." />}
          <Pager total={list.data.total} offset={offset} limit={PAGE} onOffset={setOffset} busy={list.loading} />
        </>)}
    </View>
  );
}

export function RegisterTab({ kind, id, me, below, preset }) {
  const { push } = useNav();
  const body = useLoad(() => api.get(`/federation/bodies/${id}`), [id]);
  const [status, setStatus] = useState(preset.status ?? null);
  const [expiring, setExpiring] = useState(preset.expiring ?? null);
  const [drift, setDrift] = useState(false);
  const [season, setSeason] = useState(null);
  const [sport, setSport] = useState(null);
  const [view, setView] = useState(preset.view ?? 'requests');
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useDebounced(text.trim());
  const year = new Date().getFullYear();
  const params = { body_id: id, include_descendants: below, status: status || undefined, q: q || undefined, limit: PAGE, offset,
    ...(kind === 'affiliations' ? { season_year: season || undefined, expiring_within_days: expiring || undefined } : {}),
    ...(kind === 'licences' ? { sport_id: sport || undefined, expiring_within_days: expiring || undefined } : {}),
    ...(kind === 'sanctions' && drift ? { drift: true } : {}) };
  const list = useLoad(() => (kind === 'sanctions' && view === 'events' ? Promise.resolve(null) : api.get(`/federation/${kind}`, params)), [kind, id, below, status, q, offset, season, sport, expiring, drift, view]);
  const reset = (fn) => (v) => { fn(v); setOffset(0); };
  const can = kind === 'sanctions' ? me.can.sanctions : kind === 'licences' ? me.can.licences : me.can.affiliations;
  const d = list.data;
  const row = (r) => {
    if (kind === 'affiliations') return <ListCard key={r.id} title={r.organisation_name} sub={`${r.category_name} · ${r.season_year}${below ? ` · ${r.body_abbreviation}` : ''}`} sub2={r.affiliation_no ? `${r.affiliation_no} · ${r.effective_to ? `valid to ${fmtDate(r.effective_to)}` : ''}` : r.submitted_at ? `Submitted ${fmtDate(r.submitted_at)}` : undefined} status={r.status} onPress={() => push('FederationRecord', { type: 'affiliation', id: r.id })} />;
    if (kind === 'licences') return <ListCard key={r.id} title={r.holder_name} sub={`${r.type_name}${r.grade ? ` · ${r.grade}` : ''} · ${r.sport_name}${below ? ` · ${r.body_abbreviation}` : ''}`} sub2={r.licence_no ? `${r.licence_no} · valid to ${fmtDate(r.expires_on)}` : r.submitted_at ? `Submitted ${fmtDate(r.submitted_at)}` : undefined} status={r.status} onPress={() => push('FederationRecord', { type: 'licence', id: r.id })} />;
    return <ListCard key={r.id} title={r.event_name} sub={`${r.sport_name} · ${fmtRange(r.approved_starts_on ?? r.requested_starts_on, r.approved_ends_on ?? r.requested_ends_on)}${below ? ` · ${r.body_abbreviation}` : ''}`} sub2={r.sanction_no ?? undefined} status={r.status} tone={r.drift ? c.orangeSoft : undefined} right={r.drift ? <T size={11} color={c.orange} weight="700">Event moved</T> : undefined} onPress={() => push('FederationRecord', { type: 'sanction', id: r.id })} />;
  };
  return (
    <View style={{ gap: 10 }}>
      {kind === 'sanctions' ? <Seg options={[{ value: 'requests', label: 'Sanction requests' }, { value: 'events', label: 'Competitions under jurisdiction' }]} value={view} onChange={setView} /> : null}
      {kind === 'sanctions' && view === 'events' ? <Competitions id={id} below={below} /> : (
        <>
          <Field value={text} onChangeText={reset(setText)} placeholder={kind === 'affiliations' ? 'Search by club or number' : kind === 'licences' ? 'Search by name or licence number' : 'Search by competition or number'} accessibilityLabel="Search the register" />
          <Seg options={[{ value: null, label: 'All' }, ...STATUSES[kind].map((s) => ({ value: s, label: LABEL(s) }))]} value={status} onChange={reset(setStatus)} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {kind !== 'sanctions' ? <Chip label="Ending within 30 days" active={expiring === 30} onPress={() => reset(setExpiring)(expiring === 30 ? null : 30)} /> : null}
            {kind === 'sanctions' ? <Chip label="Event moved since sanction" active={drift} onPress={() => reset(setDrift)(!drift)} /> : null}
            {kind === 'affiliations' ? [year - 1, year, year + 1].map((y) => <Chip key={y} label={`Season ${y}`} active={season === y} onPress={() => reset(setSeason)(season === y ? null : y)} />) : null}
            {kind === 'licences' ? (body.data?.sports ?? []).map((s) => <Chip key={s.sport_id} label={s.sport_name} active={sport === s.sport_id} onPress={() => reset(setSport)(sport === s.sport_id ? null : s.sport_id)} />) : null}
          </View>
          {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !d ? <Loading /> : (
            <>
              <T size={12} color={c.mute} accessibilityLiveRegion="polite">{d.total} {kind === 'sanctions' ? 'sanction request' : kind.slice(0, -1)}{d.total === 1 ? '' : 's'}{status || q || expiring || season || sport || drift ? ' match' : ''}</T>
              {d.items.length ? d.items.map(row) : (
                <Empty emoji={kind === 'affiliations' ? '🏟️' : kind === 'licences' ? '🪪' : '🏆'} title={status || q ? 'Nothing matches' : `No ${kind} yet`} sub={status || q ? 'Try removing a filter.' : kind === 'affiliations' ? 'Clubs apply from their organisation page. Define the categories below first.' : kind === 'licences' ? 'People apply from Federations. Define the licence types below first.' : 'Organisers ask from their event.'} />)}
              <Pager total={d.total} offset={offset} limit={PAGE} onOffset={setOffset} busy={list.loading} />
            </>)}
        </>)}
      {kind !== 'sanctions' ? <Offer kind={kind} id={id} can={can} /> : null}
    </View>
  );
}
