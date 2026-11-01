// Sports Media, Broadcast & Rights (#482): the vocabulary, formats and small pieces every media screen shares, in the Arena palette of the event console.
// The server is the authority on every rule (scope, exclusivity, embargo, consent, entitlement); these only show what it returns and hide what a role cannot use.
import { formatMoney } from './money';
import React from 'react';
import { View } from 'react-native';
import { locale } from './locale';
import { A, AT, ATag } from './arena';
import { Card, T, Tag } from './ui';
import { c } from './theme';

export const RIGHTS = {
  live_video: ['📺', 'Live video'], delayed_video: ['⏪', 'Delayed / replay'], highlights: ['✨', 'Highlights'], short_form: ['🎞️', 'Short-form clips'], audio: ['🎙️', 'Audio / radio'],
  photography: ['📷', 'Photography'], press: ['📰', 'Press & news'], data_feed: ['📡', 'Data & stats feed'], archive: ['🗄️', 'Archive footage'], social: ['📱', 'Social / digital'],
};
export const rightLabel = (k) => RIGHTS[k]?.[1] ?? String(k).replace(/_/g, ' ');
export const rightChip = (k) => `${RIGHTS[k]?.[0] ?? '•'} ${rightLabel(k)}`;
export const RIGHT_OPTIONS = Object.entries(RIGHTS).map(([value, [i, l]]) => ({ value, label: `${i} ${l}` }));
export const PLATFORMS = { linear_tv: '📺 TV', ott: '▶️ Streaming (OTT)', web: '🌐 Web', mobile_app: '📲 Mobile app', social: '💬 Social', radio: '📻 Radio', in_venue: '🏟️ In venue', print: '🗞️ Print' };
export const platformOptions = (only) => Object.entries(PLATFORMS).filter(([k]) => !only?.length || only.includes(k)).map(([value, label]) => ({ value, label }));
export const PARTNER_KINDS = ['broadcaster', 'streaming_platform', 'radio', 'press', 'photo_agency', 'production_company', 'data_licensee', 'digital_platform', 'other'];
export const TERRITORY = [{ value: 'worldwide', label: '🌍 Worldwide' }, { value: 'include', label: 'Only these countries' }, { value: 'exclude', label: 'Everywhere except' }];
export const territoryText = (r, name = (x) => x) => (r.territory_mode === 'worldwide' ? 'Worldwide' : `${r.territory_mode === 'exclude' ? 'Except ' : ''}${(r.countries ?? []).map(name).join(', ')}`);
export const LANGUAGES = [['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['ar', 'Arabic'], ['pt', 'Portuguese'], ['de', 'German'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ms', 'Malay'], ['ta', 'Tamil']].map(([value, label]) => ({ value, label }));
export const SCOPES = [{ value: 'event', label: '🏆 Whole competition' }, { value: 'fixture', label: '⚽ One game' }, { value: 'collection', label: '🗂️ A collection' }];
export const SUBLICENSING = [{ value: 'none', label: 'No sublicensing' }, { value: 'with_approval', label: 'With approval' }, { value: 'allowed', label: 'Allowed' }];
export const CREW_ROLES = [['producer', '🎬 Producer'], ['director', '🎥 Director'], ['camera_operator', '📹 Camera operator'], ['commentator', '🎙️ Commentator'], ['analyst', '📊 Analyst'], ['photographer', '📷 Photographer'], ['audio_engineer', '🎧 Audio engineer'], ['technical_crew', '🛠️ Technical crew'], ['reporter', '📰 Reporter'], ['other', 'Other']].map(([value, label]) => ({ value, label }));
export const crewRole = (r) => CREW_ROLES.find((x) => x.value === r)?.label ?? String(r).replace(/_/g, ' ');
export const ZONES = [['media_centre', 'Media centre'], ['mixed_zone', 'Mixed zone'], ['press_box', 'Press box'], ['broadcast_compound', 'Broadcast compound'], ['field_of_play', 'Field of play'], ['locker_room', '🔒 Locker room'], ['athlete_area', '🔒 Athlete area'], ['officials_room', '🔒 Officials\' room'], ['medical_area', '🔒 Medical area'], ['team_bench', '🔒 Team bench']].map(([value, label]) => ({ value, label }));
export const PHASES = [{ value: 'setup', label: '🔧 Setup' }, { value: 'rehearsal', label: '🎭 Rehearsal' }, { value: 'live', label: '🔴 Live' }, { value: 'teardown', label: '📦 Teardown' }];
export const ASSET_KINDS = [{ value: 'video', label: '🎬 Video' }, { value: 'clip', label: '🎞️ Clip' }, { value: 'photo', label: '📷 Photo' }, { value: 'audio', label: '🎙️ Audio' }, { value: 'graphic', label: '🖼️ Graphic' }, { value: 'document', label: '📄 Document' }];
export const OWNER_KINDS = [{ value: 'organiser', label: 'The organiser' }, { value: 'partner', label: 'A media partner' }, { value: 'athlete', label: 'An athlete' }, { value: 'third_party', label: 'A third party' }];
export const AUDIENCES = [{ value: 'private', label: '🔒 Private' }, { value: 'licensed', label: '🪪 Licensed partners' }, { value: 'public', label: '🌐 Public' }];
export const CONSENT_KINDS = [{ value: 'guardian_media', label: 'Guardian media consent' }, { value: 'athlete_release', label: 'Athlete release' }, { value: 'team_release', label: 'Team release' }, { value: 'agreement', label: 'Covered by an agreement' }, { value: 'not_required', label: 'Not required' }];
export const DATASETS = [{ value: 'fixtures', label: 'Schedule & status' }, { value: 'live', label: 'Live scores & events' }, { value: 'results', label: 'Official results' }, { value: 'standings', label: 'Standings' }];
export const PROVIDERS = { youtube: 'YouTube Live', twitch: 'Twitch', vimeo: 'Vimeo Live', facebook: 'Facebook Live', mux: 'Mux', cloudflare_stream: 'Cloudflare Stream', aws_ivs: 'Amazon IVS', custom_hls: 'Own HLS / RTMP endpoint', other_external: 'Another provider' };

export const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
export const fmtD = (iso) => (iso ? new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const fmtRange = (a, b) => (a && b ? `${fmtD(a)} → ${fmtD(b)}` : fmtD(a ?? b));
export const money = (minor, cur) => formatMoney(minor, cur);
const pad = (n) => String(n).padStart(2, '0');
export const dayOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** A calendar range (YYYY-MM-DD, YYYY-MM-DD) becomes the instants it covers in the person's own time zone: start of the first day to the end of the last. */
export const spanIso = (from, to) => ({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to ?? from}T23:59:59`).toISOString() });
export const nice = (s) => String(s ?? '').replace(/_/g, ' ');

const TONE = {
  active: A.green, live: A.green, published: A.green, ready: A.green, acknowledged: A.green, issued: A.green, verified: A.green, delivered: A.green, open: A.green, resolved: A.green, usable: A.green, done: A.green,
  allowed: A.green, pending: A.sun, blocked: A.red, proposed: A.sun, negotiating: A.sun, scheduled: A.cyan, embargoed: A.sun, assigned: A.sun, requested: A.sun, planned: A.cyan, draft: A.mute, attention: A.orange, suspended: A.orange, minor: A.sun, major: A.orange, unconfirmed: A.orange,
  expired: A.mute, ended: A.mute, withdrawn: A.mute, closed: A.mute, released: A.mute, archived: A.mute, offline: A.mute, none: A.mute, not_started: A.mute, info: A.cyan,
  terminated: A.red, declined: A.red, taken_down: A.red, consent_lapsed: A.red, source_withdrawn: A.red, revoked: A.red, missed: A.red, critical: A.red,
};
export const StateTag = ({ state, label }) => <ATag label={label ?? nice(state)} tone={TONE[state] ?? A.violet} />;

/** Label / value lines for a record, on a light sheet. Empty values are left out, never shown as "—". */
export function Facts({ rows }) {
  return (
    <View style={{ gap: 6 }}>
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false).map(([k, v]) => (
        <View key={k} style={{ flexDirection: 'row', gap: 12 }} accessible accessibilityLabel={`${k}: ${v}`}>
          <T size={12.5} weight="700" color={c.mute} style={{ width: 112 }}>{k}</T>
          <T size={13.5} weight="700" style={{ flex: 1 }}>{String(v)}</T>
        </View>
      ))}
    </View>
  );
}

/** Light-sheet counterparts of the console's section heading, status tag and tag row: sheets use the app's light surface, the console page its dark one. */
export const LSection = ({ title, sub, action, onAction }) => (
  <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 10 }}>
    <View style={{ flex: 1 }}><T size={17} weight="800" accessibilityRole="header">{title}</T>{sub ? <T size={12.5} color={c.mute}>{sub}</T> : null}</View>
    {action ? <T size={13} weight="800" color={c.violet} onPress={onAction} accessibilityRole="button" style={{ paddingVertical: 8 }}>{action}</T> : null}
  </View>
);
const LTONE = { green: c.mint, sun: c.sun, orange: c.orange, red: c.pinkSoft, mute: c.violetSoft, cyan: c.cyan };
const LMAP = {
  active: 'green', live: 'green', published: 'green', ready: 'green', acknowledged: 'green', issued: 'green', verified: 'green', delivered: 'green', open: 'green', resolved: 'green', usable: 'green', done: 'green',
  allowed: 'green', pending: 'sun', blocked: 'red', proposed: 'sun', negotiating: 'sun', embargoed: 'sun', assigned: 'sun', requested: 'sun', minor: 'sun', scheduled: 'cyan', planned: 'cyan', info: 'cyan', attention: 'orange', suspended: 'orange', major: 'orange', unconfirmed: 'orange',
  terminated: 'red', declined: 'red', taken_down: 'red', consent_lapsed: 'red', source_withdrawn: 'red', revoked: 'red', missed: 'red', critical: 'red',
};
export const LTag = ({ state, label }) => <Tag label={label ?? nice(state)} color={LTONE[LMAP[state] ?? 'mute']} />;
export const LTags = ({ items }) => (items?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{items.map((t) => <Tag key={t} label={t} color={c.violetSoft} />)}</View> : null);
export const LCard = ({ children, color, pad = 12, style }) => <Card color={color} pad={pad} style={style}><View style={{ gap: 6 }}>{children}</View></Card>;
export const LEmpty = ({ title, sub }) => <View style={{ alignItems: 'center', gap: 4, paddingVertical: 14 }}><T weight="800">{title}</T>{sub ? <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{sub}</T> : null}</View>;

/** A row of small tag chips (rights, platforms). */
export const Tags = ({ items, tone = A.violet }) => (items?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{items.map((t) => <ATag key={t} label={t} tone={tone} />)}</View> : null);

/** The crew badge as [label, state]: the real event accreditation (issued, pending, suspended) or the older department flag (requested, revoked). */
export const BADGE = { none: ['No badge', 'none'], requested: ['Badge requested', 'requested'], pending: ['Badge in review', 'pending'], issued: ['Badge issued', 'issued'], suspended: ['Badge suspended', 'suspended'], revoked: ['Badge revoked', 'revoked'] };
export const badgeOf = (k) => BADGE[k] ?? BADGE.none;
