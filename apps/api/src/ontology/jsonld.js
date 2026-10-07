// Serialises app records as JSON-LD using the IPTC Sport Schema vocabulary. Only public identity
// (handle/display name) is emitted — never personal identification data.
import { NS, roles as roleDefs } from './iptc.js';

export const jsonldContext = {
  sport: NS.sport, spstat: NS.spstat, sa: NS.sa,
  xsd: 'http://www.w3.org/2001/XMLSchema#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  name: 'rdfs:label',
};

const iri = (kind, id) => `${NS.sa}${kind}/${id}`;
const personNode = (p) => ({ '@id': iri('person', p.user_id ?? p.id), '@type': ['sport:Individual', ...(p.classes ?? [])], name: p.display_name, 'sa:handle': p.handle });

export function gameToJsonLd(game, { participants, people, actions }) {
  const g = iri('game', game.id);
  const graph = [{
    '@id': g, '@type': 'sport:Event', name: game.title, 'sport:sport': { '@id': iri('sport', game.sport_slug) },
    'sport:eventStatus': game.status, 'sport:startDateTime': new Date(game.starts_at).toISOString(),
    ...(game.ends_at ? { 'sport:endDateTime': new Date(game.ends_at).toISOString() } : {}),
    ...(game.competition_id ? { 'sport:eventInCompetition': { '@id': iri('competition', game.competition_id) } } : {}),
    ...(game.venue_id ? { 'sport:location': { '@id': iri('site', game.resource_id ?? game.venue_id) } } : {}),
    ...Object.fromEntries(Object.entries(game.attributes).map(([k, v]) => [`sa:${k}`, v])),
  }];
  if (game.competition_id) graph.push({ '@id': iri('competition', game.competition_id), '@type': 'sport:Competition' });
  if (game.venue_id) graph.push({ '@id': iri('site', game.resource_id ?? game.venue_id), '@type': 'sport:Site' });
  for (const p of participants) {
    const agent = p.team_id ? { '@id': iri('team', p.team_id), '@type': 'sport:Team', name: p.team_name } : { '@id': iri('person', p.user_id), '@type': 'sport:Individual', name: p.person_name };
    graph.push(agent, {
      '@id': iri('participation', p.id), '@type': ['sport:Participation', 'sport:CompetitorParticipation', p.team_id ? 'sport:TeamParticipation' : 'sport:IndividualParticipation'],
      'sport:participationIn': { '@id': g }, 'sport:participationBy': { '@id': agent['@id'] },
      ...(p.side ? { 'sa:side': p.side } : {}), ...(p.outcome ? { 'sport:eventOutcome': p.outcome } : {}),
      ...(p.outcome_type ? { 'sport:eventOutcomeType': p.outcome_type } : {}), ...(p.score != null ? { 'sport:score': p.score } : {}),
      ...(p.score_units ? { 'sport:scoreUnits': p.score_units } : {}), ...(p.rank != null ? { 'sport:rank': p.rank } : {}),
      ...Object.fromEntries(Object.entries(p.stats ?? {}).map(([k, v]) => [`sa:${k}`, v])),
    });
  }
  for (const a of people) {
    const kind = roleDefs[a.role]?.kind;
    const cls = kind === 'athlete' ? 'sport:Athlete' : kind === 'official' ? 'sport:Official' : 'sport:Associate';
    graph.push({ ...personNode({ ...a, classes: [cls] }) });
    graph.push({
      '@id': iri('association', a.association_id), '@type': ['sport:Participation', kind === 'athlete' ? 'sport:IndividualParticipation' : kind === 'official' ? 'sport:OfficialParticipation' : 'sport:AssociateParticipation'],
      'sport:participationIn': { '@id': g }, 'sport:participationBy': { '@id': iri('person', a.user_id) }, 'sport:role': a.role,
      ...(a.position ? { 'sport:positionRegular': a.position } : {}), ...(a.uniform_no != null ? { 'sport:uniformNumber': a.uniform_no } : {}),
      ...(a.player_status ? { 'sport:playerStatus': a.player_status } : {}),
      ...Object.fromEntries(Object.entries(a.attributes ?? {}).map(([k, v]) => [`sa:${k}`, v])),
    });
  }
  for (const x of actions) {
    graph.push({
      '@id': iri('action', x.id), '@type': 'sport:Action', 'sport:actionInEvent': { '@id': g }, 'sport:actionType': x.action_type, 'sa:actionClass': x.action_class,
      ...(x.minute != null ? { 'sport:minutesElapsed': x.minute } : {}), ...(x.period != null ? { 'sport:periodValue': x.period } : {}),
      ...(x.user_id ? { 'sa:by': { '@id': iri('person', x.user_id) } } : {}), ...(x.team_id ? { 'sa:team': { '@id': iri('team', x.team_id) } } : {}),
      ...Object.fromEntries(Object.entries(x.attributes ?? {}).map(([k, v]) => [`sa:${k}`, v])),
    });
  }
  // dedupe nodes by @id (a person can appear via several associations); keep merged properties
  const byId = new Map();
  for (const n of graph) {
    const prev = byId.get(n['@id']);
    byId.set(n['@id'], prev ? { ...prev, ...n, '@type': [...new Set([prev['@type'], n['@type']].flat())] } : n);
  }
  return { '@context': jsonldContext, '@graph': [...byId.values()] };
}
