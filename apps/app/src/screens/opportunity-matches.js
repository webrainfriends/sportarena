// Opportunities that fit me: team posts, events and trials, study programmes and sponsorship calls compared with my sport card,
// preferences, availability and budget. Every result says why it fits, what does not, and what data is missing and who can add it.
// A guardian opens it for a young person with child_id; consent is re-checked by the API on every load.
import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Screen, Seg, T, Tag } from '../ui';
import { c, day } from '../theme';

const KINDS = [{ value: 'all', label: 'All' }, { value: 'team_opening', label: '🧢 Teams' }, { value: 'competition', label: '🏆 Events & trials' }, { value: 'study', label: '🎓 Study' }, { value: 'sponsor', label: '🤝 Sponsors' }];
const KIND_LABEL = { team_opening: 'Team opening', competition: 'Event / trial', study: 'Study', sponsor: 'Sponsorship call' };
const FIT = { strong: ['Strong fit', c.mint], possible: ['Possible fit', c.sunSoft], weak: ['Weak fit', c.violetSoft], unknown: ['Not enough data', c.violetSoft], ineligible: ['Not eligible', c.pinkSoft] };
const MARK = { match: '✓', mismatch: '✕', unknown: '?' };
const TONE = { match: c.mint, mismatch: c.pinkSoft, unknown: c.sunSoft };
const DIM = { position: 'Position', level: 'Level', region: 'Region', availability: 'Availability', cost: 'Cost', eligibility: 'Eligibility', sport: 'Sport' };
const say = (e) => (e?.code === 'guardian_consent_required' ? 'A guardian needs to allow recruitment sharing under Family & guardians before opportunities can be matched.' : e?.message ?? 'Something went wrong');

const saveCsv = (filename, csv, setText) => {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  } else setText(csv);
};

function RuleLine({ r }) {
  return (
    <View accessible accessibilityLabel={`${DIM[r.dimension] ?? r.dimension}: ${r.status === 'match' ? 'fits' : r.status === 'mismatch' ? 'does not fit' : 'unknown'}. ${r.detail}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: TONE[r.status], alignItems: 'center', justifyContent: 'center' }}><T weight="800" size={12}>{MARK[r.status]}</T></View>
      <View style={{ flex: 1 }}><T size={13} weight="700">{DIM[r.dimension] ?? r.dimension}</T><T size={13} color={c.mute}>{r.detail}</T></View>
    </View>
  );
}

function MatchCard({ m, open, onToggle, onFix, onOpen }) {
  const o = m.opportunity;
  const [label, tone] = FIT[m.fit] ?? FIT.unknown;
  return (
    <Card pad={14} onPress={onToggle} accessibilityLabel={`${o.title}. ${label}${m.score != null ? `, ${m.score} percent` : ''}. ${open ? 'Hide' : 'Show'} why`}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <T weight="800">{o.title}</T>
            <T size={12} color={c.mute}>{[KIND_LABEL[o.kind], o.sport, o.organiser, o.region, o.date ? day(o.date) : null].filter(Boolean).join(' · ')}</T>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}><Tag label={label} color={tone} />{m.score != null ? <T size={12} weight="800">{m.score}%</T> : null}</View>
        </View>
        <T size={12} color={c.mute}>{m.checks.known} of {m.checks.total} checks could be made{m.missing.length ? ` · ${m.missing.length} missing` : ''}</T>
        {open ? (
          <View style={{ gap: 8, marginTop: 4 }}>
            {m.rules.map((r) => <RuleLine key={r.rule} r={r} />)}
            {m.missing.length ? (
              <View style={{ gap: 6 }}>
                <T weight="800" size={13}>Missing data</T>
                {m.missing.map((g) => (
                  <View key={g.rule} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <T size={12} color={c.mute} style={{ flex: 1, minWidth: 180 }}>{g.who === 'player' ? 'You can add this: ' : 'The organiser has to add this: '}{g.detail}</T>
                    {g.who === 'player' && g.where ? <Btn small title="Add it" color={c.paper} ink={c.ink} onPress={() => onFix(g.where)} accessibilityLabel={`Add ${DIM[g.dimension] ?? g.dimension} data`} /> : null}
                  </View>
                ))}
              </View>
            ) : null}
            <Btn small title="Open" color={c.violet} onPress={() => onOpen(o)} style={{ alignSelf: 'flex-start' }} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

export function OpportunityMatches({ child_id, name }) {
  const { push, goTab } = useNav();
  const { toast } = useSession();
  const [kind, setKind] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [csv, setCsv] = useState(null);
  const q = useLoad(() => api.get('/me/opportunity-matches', { limit: 100, include_ineligible: showAll, ...(kind !== 'all' ? { kinds: kind } : {}), ...(child_id ? { on_behalf_of: child_id } : {}) }), [kind, showAll, child_id]);
  const fix = (where) => (where === 'SportProfile' ? goTab('Player') : where === 'Settings' ? goTab('Me') : push('Passport'));
  const open = (o) => (o.kind === 'competition' ? push('Event', { id: o.id }) : o.kind === 'study' ? push('Programme', { id: o.id }) : o.kind === 'sponsor' ? push('SponsorCall', { id: o.id }) : push('Billboard'));
  const exportCsv = async () => {
    try { const e = await api.get('/me/opportunity-matches/export', { ...(child_id ? { on_behalf_of: child_id } : {}), include_ineligible: showAll, ...(kind !== 'all' ? { kinds: kind } : {}) }); saveCsv(e.filename, e.csv, setCsv); toast(`Exported ${e.rows} match${e.rows === 1 ? '' : 'es'}. This download is logged.`); } catch (e) { toast(say(e)); }
  };
  const d = q.data;
  return (
    <Screen refreshing={q.loading && !!d} onRefresh={q.reload}>
      <H1>{name ? `${name}'s opportunities` : 'Opportunities for me'}</H1>
      <T size={13} color={c.mute}>Compared with your sport card, preferences, availability and budget. Only what you or the organiser entered is counted; missing data is shown, never guessed. Matches are private to you.</T>
      <Seg options={KINDS} value={kind} onChange={setKind} />
      {q.error ? <ErrorBox error={{ ...q.error, message: say(q.error) }} onRetry={q.reload} /> : !d ? <Loading /> : (
        <>
          {d.profile_gaps.map((g) => <Card key={g.dimension} color={c.sunSoft} pad={14}><T size={13}>{g.detail}</T><Btn small title="Add a sport card" onPress={() => fix(g.where)} style={{ alignSelf: 'flex-start', marginTop: 8 }} /></Card>)}
          {d.gaps.length ? (
            <Card pad={14} color={c.violetSoft}>
              <T weight="800" size={13}>Add this to improve your matches</T>
              {d.gaps.filter((g) => g.who === 'player').map((g) => (
                <View key={`${g.dimension}${g.where}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <T size={13} style={{ flex: 1 }}>{DIM[g.dimension] ?? g.dimension} · helps {g.matches} result{g.matches === 1 ? '' : 's'}</T>
                  <Btn small title="Add" color={c.paper} ink={c.ink} onPress={() => fix(g.where)} accessibilityLabel={`Add ${DIM[g.dimension] ?? g.dimension}`} />
                </View>
              ))}
            </Card>
          ) : null}
          {d.pool_full.length ? <T size={12} color={c.mute}>Showing the newest listings only; narrow by type to see more.</T> : null}
          {d.items.length === 0 && !d.profile_gaps.length ? <Empty emoji="🔎" title="Nothing open fits right now" sub={d.hidden_ineligible ? `${d.hidden_ineligible} you cannot apply to are hidden.` : 'New posts, events, programmes and sponsorship calls appear here as they are published.'} /> : d.items.map((m) => (
            <MatchCard key={`${m.opportunity.kind}${m.opportunity.id}`} m={m} open={openId === m.opportunity.id} onToggle={() => setOpenId(openId === m.opportunity.id ? null : m.opportunity.id)} onFix={fix} onOpen={open} />
          ))}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title={showAll ? 'Hide ones I cannot apply to' : `Show ones I cannot apply to${d.hidden_ineligible ? ` (${d.hidden_ineligible})` : ''}`} color={c.paper} ink={c.ink} onPress={() => setShowAll(!showAll)} />
            <Btn small title="Export CSV" color={c.paper} ink={c.ink} onPress={exportCsv} />
          </View>
          {csv ? <Card pad={12}><T size={12} selectable>{csv}</T></Card> : null}
        </>
      )}
    </Screen>
  );
}
