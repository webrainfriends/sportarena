import React, { useState } from 'react';
import { Platform, Pressable, Share, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import qrcode from 'qrcode-generator';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Avatar, Btn, Card, Empty, ErrorBox, H1, H2, Loading, Screen, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day, toneFor } from '../theme';
import { useNav } from '../nav';
import { CredentialList } from './pathways';
import { CoachPassportDesk, GuardianPassports, RecruitmentProfile, RecruitmentSections } from './passport-recruitment';

const nice = (s) => String(s).replace(/_/g, ' ');
const num = (v) => (v === null || v === undefined ? '–' : Number.isInteger(+v) ? String(+v) : String(Math.round(+v * 100) / 100));
const unitOf = (u) => (u === 's' ? ' s' : u === 'm' ? ' m' : '');
const AWARD = { cup: '🏆', trophy: '🏅', medal_gold: '🥇', medal_silver: '🥈', medal_bronze: '🥉', mvp: '🌟', badge: '🎖️' };

/** A scannable QR code drawn as one SVG path (white quiet zone included). */
export function QrCode({ value, size = 200, label = "QR code for the passport link" }) {
  const q = qrcode(0, 'M');
  q.addData(value); q.make();
  const n = q.getModuleCount(), quiet = 2, total = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) d += `M${col + quiet} ${r + quiet}h1v1h-1z`;
  return (
    <View accessible accessibilityLabel={label} style={{ width: size, height: size, backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${total} ${total}`}>
        <Rect width={total} height={total} fill="#fff" />
        <Path d={d} fill="#000" />
      </Svg>
    </View>
  );
}

const SECTIONS = [['show_matches', 'Match history by season', 'matches'], ['show_results', 'Approved results', 'results'], ['show_awards', 'Awards', 'awards'], ['show_credentials', 'Certificates & badges', 'certificates'], ['show_career', 'Clubs & teams timeline', 'clubs & teams'],
  ['show_video', 'Approved video', 'video'], ['show_references', 'Approved coach references', 'references'], ['show_preferences', 'What I\'m looking for', 'preferences'], ['show_availability', 'Availability', 'availability'], ['show_academic', 'Academic evidence', 'academic evidence']];
const EXPIRY = [{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }];

const copyOrShare = async (text, toast) => {
  try {
    if (Platform.OS === 'web' && navigator.clipboard) { await navigator.clipboard.writeText(text); toast('Link copied'); } else await Share.share({ message: text });
  } catch { toast('Could not share the link'); }
};
const fullUrl = (l) => l.url ?? (Platform.OS === 'web' && typeof location !== 'undefined' ? `${location.origin}${l.path}` : l.path);

const Stat = ({ value, label }) => (
  <View style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 14, backgroundColor: c.bg }}>
    <T weight="800" size={20} style={{ fontVariant: ['tabular-nums'], letterSpacing: -0.4 }}>{value}</T>
    <T weight="700" size={10} color={c.mute} style={{ letterSpacing: 0.9, marginTop: 2 }}>{label}</T>
  </View>
);

/** The athlete CV: who they are, where they play, what they have done (season by season), approved results and awards. */
export function PassportCard({ data }) {
  const a = data.athlete;
  const main = data.sport_profiles[0];
  const tone = toneFor(main?.sport_slug);
  const bySeason = new Map();
  for (const r of data.seasons ?? []) bySeason.set(r.season, [...(bySeason.get(r.season) ?? []), r]);
  const sportName = (slug) => data.sport_profiles.find((p) => p.sport_slug === slug)?.sport ?? nice(slug);
  return (
    <View style={{ gap: 16 }}>
      <View style={{ backgroundColor: tone[0], borderRadius: 24, padding: 20, overflow: 'hidden' }}>
        <View pointerEvents="none" style={{ position: 'absolute', right: -40, top: -60, width: 220, height: 220, borderRadius: 110, backgroundColor: '#fff', opacity: 0.14 }} />
        <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
          <Avatar user={a} size={68} />
          <View style={{ flex: 1 }}>
            <T weight="800" size={24} color="#fff" numberOfLines={1} style={{ letterSpacing: -0.5 }}>{a.display_name}</T>
            <T color="#fff" weight="700" style={{ opacity: 0.9 }}>@{a.handle}</T>
            {main ? <T size={13} color="#fff" weight="600" style={{ opacity: 0.9, marginTop: 4 }}>{[main.sport, main.position, main.club].filter(Boolean).join(' · ')}</T> : null}
          </View>
          {main?.jersey_no !== null && main?.jersey_no !== undefined ? <T weight="800" size={44} color="#fff" style={{ opacity: 0.9, letterSpacing: -2 }}>#{main.jersey_no}</T> : null}
        </View>
        {a.bio ? <T size={13} color="#fff" style={{ marginTop: 12, opacity: 0.95 }}>{a.bio}</T> : null}
      </View>

      {data.sport_profiles.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {data.sport_profiles.map((p) => <Tag key={p.sport_slug + p.role} label={`${p.sport_emoji} ${p.sport} · ${nice(p.role)} · ${nice(p.level)}`} color={c.violetSoft} />)}
        </View>
      ) : null}

      {data.career ? (
        <Card pad={16}>
          <H2>Career</H2>
          {data.career.length ? data.career.map((cr) => (
            <View key={cr.sport_slug} style={{ marginTop: 10, gap: 8 }}>
              <T weight="700">{sportName(cr.sport_slug)}</T>
              <View style={{ flexDirection: 'row', gap: 8 }}><Stat value={cr.matches} label="MATCHES" /><Stat value={`${cr.wins}-${cr.draws}-${cr.losses}`} label="W-D-L" /><Stat value={cr.official_matches} label="OFFICIAL" /></View>
            </View>
          )) : <T size={13} color={c.mute} style={{ marginTop: 6 }}>No matches yet.</T>}
          <T size={11} color={c.mute} style={{ marginTop: 10 }}>“Official” counts games played in Gotmygame events. The rest were logged by the athlete.</T>
        </Card>
      ) : null}

      {data.seasons?.length ? (
        <Card pad={16}>
          <H2>Season by season</H2>
          {[...bySeason.entries()].map(([season, rows]) => (
            <View key={season} style={{ marginTop: 12 }}>
              <T weight="800" color={c.pink}>{season}</T>
              {rows.map((r) => <T key={r.sport_slug} size={13} style={{ marginTop: 3 }}>{sportName(r.sport_slug)} · {r.matches} match{r.matches === 1 ? '' : 'es'} · {r.wins}-{r.draws}-{r.losses}{r.official_matches ? ` · ${r.official_matches} official` : ''}</T>)}
            </View>
          ))}
        </Card>
      ) : null}

      {data.verified_results?.length ? (
        <Card pad={16}>
          <H2>Verified results</H2>
          <T size={12} color={c.mute} style={{ marginTop: 2 }}>Approved competition results only. Practice figures are never shown here.</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
            {data.verified_results.map((r) => (
              <View key={r.sport_slug + r.metric} style={{ flexBasis: '47%', flexGrow: 1, backgroundColor: c.bg, borderRadius: 14, padding: 12 }}>
                <T size={11} weight="700" color={c.mute}>{nice(r.metric).toUpperCase()}</T>
                <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{num(r.best)}<T size={13} color={c.mute}>{unitOf(r.unit)}</T></T>
                <T size={11} color={c.mute}>{r.sport} · {r.results} result{r.results === 1 ? '' : 's'}</T>
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      {data.credentials?.length ? (
        <Card pad={16}>
          <H2>Certificates & badges</H2>
          <T size={12} color={c.mute} style={{ marginTop: 2, marginBottom: 10 }}>Issued by the institutions named; each can be checked with its code.</T>
          <CredentialList list={data.credentials} />
        </Card>
      ) : null}

      {data.memberships?.length ? (
        <Card pad={16}>
          <H2>Clubs & teams</H2>
          {data.memberships.map((m) => (
            <View key={m.id} style={{ marginTop: 12 }}>
              <T weight="800">{m.club}</T>
              <T size={13} color={c.mute}>{[`${m.sport_emoji} ${m.sport}`, `${m.starts_on.slice(0, 4)}–${m.current ? 'now' : (m.ends_on ?? '').slice(0, 4)}`, m.position, nice(m.competition_level)].filter(Boolean).join(' · ')}</T>
              <Tag label={m.verification_status === 'verified' ? 'Verified by club' : 'Self-reported'} color={m.verification_status === 'verified' ? c.mint : c.violetSoft} style={{ marginTop: 4, alignSelf: 'flex-start' }} />
            </View>
          ))}
        </Card>
      ) : null}

      {data.awards?.length ? (
        <Card pad={16}>
          <H2>Achievements</H2>
          {data.awards.map((w, i) => <T key={i} style={{ marginTop: 8 }}>{AWARD[w.kind] ?? '🎖️'} <T weight="700">{w.name}</T>{w.event_name ? ` · ${w.event_name}` : ''}{w.year ? ` · ${w.year}` : ''}</T>)}
        </Card>
      ) : null}

      <RecruitmentSections data={data} />
    </View>
  );
}

/** Manage share links: create one (what it shows, how long it lasts), see its QR once, copy it, turn it off. */
export function MyPassport() {
  const { toast } = useSession();
  const prev = useLoad(() => api.get('/me/passport'), []);
  const links = useLoad(() => api.get('/me/passport-links'), []);
  const [form, setForm] = useState(false);
  const [fresh, setFresh] = useState(null); // the just-created link, with its secret
  const [edit, setEdit] = useState(null);
  const { push } = useNav();
  const revoke = async (l) => { try { await api.post(`/me/passport-links/${l.id}/revoke`); toast('Link turned off'); await links.reload(); } catch (e) { toast(e.message); } };
  return (
    <Screen>
      <H1>Player passport</H1>
      <T color={c.mute} style={{ marginTop: 2 }}>Share your sporting CV with a coach or scout. You choose what they see and when the link stops working.</T>
      <Btn small title="Season & career reports (CSV / PDF)" color={c.paper} ink={c.ink} onPress={() => push('SeasonReports')} style={{ alignSelf: 'flex-start', marginTop: 10 }} accessibilityLabel="Open season and career reports" />

      {fresh ? (
        <Card pad={16} style={{ marginTop: 14 }}>
          <T weight="800" size={16}>Your new link</T>
          <T size={12} color={c.mute} style={{ marginTop: 2 }}>Show this QR code or send the link. For your security the link is only shown now; make a new one if you lose it.</T>
          <View style={{ alignItems: 'center', marginVertical: 14 }}><QrCode value={fullUrl(fresh)} size={220} /></View>
          <T selectable size={12} style={{ marginBottom: 10 }}>{fullUrl(fresh)}</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small title="Copy / share link" onPress={() => copyOrShare(fullUrl(fresh), toast)} />
            <Btn small title="Done" color={c.paper} ink={c.ink} onPress={() => setFresh(null)} />
          </View>
        </Card>
      ) : null}

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 22 }}>
        <H2>Share links</H2>
        <Btn small title="+ New link" onPress={() => setForm(true)} />
      </View>
      <View style={{ gap: 10, marginTop: 10 }}>
        {links.error ? <ErrorBox error={links.error} onRetry={links.reload} /> : !links.data ? <Loading /> : !links.data.length ? (
          <Empty emoji="🔗" title="No links yet" sub="Create a link to share your passport. You can turn it off any time." />
        ) : links.data.map((l) => (
          <Card key={l.id} pad={14}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <T weight="700">{l.label || 'Passport link'}</T>
                <T size={12} color={c.mute}>{l.status === 'active' ? `Expires ${day(l.expires_at)}` : l.status === 'expired' ? `Expired ${day(l.expires_at)}` : `Turned off ${day(l.revoked_at)}`} · opened {l.view_count} time{l.view_count === 1 ? '' : 's'}</T>
                <T size={12} color={c.mute}>For: {l.recipient_name ?? 'anyone with the link'}</T>
                <T size={12} color={c.mute}>Shows: {SECTIONS.filter(([k]) => l[k]).map(([, , short]) => short).join(', ') || 'profile only'}</T>
              </View>
              <Tag label={l.status} color={l.status === 'active' ? c.mint : c.violetSoft} />
            </View>
            {l.status === 'active' ? (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <Btn small title="Change" color={c.paper} ink={c.ink} onPress={() => setEdit(l)} />
                <Btn small title="Turn off" color={c.paper} ink={c.red} onPress={() => revoke(l)} />
              </View>
            ) : null}
          </Card>
        ))}
      </View>

      <GuardianPassports onCreated={setFresh} />
      <RecruitmentProfile />

      <H2 style={{ marginTop: 26 }}>What people will see</H2>
      <View style={{ marginTop: 10 }}>{prev.error ? <ErrorBox error={prev.error} onRetry={prev.reload} /> : !prev.data ? <Loading /> : <PassportCard data={prev.data} />}</View>
      <T size={12} color={c.mute} style={{ marginTop: 14 }}>Never shown: email, phone, date of birth, address, private notes or health data. Each link can hide match history, results, awards or certificates.</T>

      {form ? (
        <FormSheet visible onClose={() => setForm(false)} title="New passport link" submitLabel="Create link"
          initial={{ expires_in_days: 30, show_matches: true, show_results: true, show_awards: true, show_credentials: true }}
          fields={[
            { key: 'label', label: 'Who is it for', optional: true, placeholder: 'Academy scout, club trial…' },
            { key: 'recipient_id', label: 'Only this person may open it', type: 'entity', noun: 'person', optional: true, hint: 'Leave empty to let anyone with the link open it.' },
            { key: 'expires_in_days', label: 'Stops working after', type: 'chips', options: EXPIRY },
            ...SECTIONS.map(([key, label]) => ({ key, label: `Show ${label[0].toLowerCase()}${label.slice(1)}`, type: 'switch' })),
          ]}
          onSubmit={async (v) => { const l = await api.post('/me/passport-links', { label: v.label || undefined, recipient_id: v.recipient_id || undefined, expires_in_days: Number(v.expires_in_days), ...Object.fromEntries(SECTIONS.map(([k]) => [k, !!v[k]])) }); setFresh(l); await links.reload(); return 'Link created'; }} />
      ) : null}
      {edit ? (
        <FormSheet visible onClose={() => setEdit(null)} title="Change this link" submitLabel="Save changes"
          initial={{ label: edit.label ?? '', ...Object.fromEntries(SECTIONS.map(([k]) => [k, !!edit[k]])) }}
          fields={[
            { key: 'label', label: 'Who is it for', optional: true },
            { key: 'extend', label: 'Extend from today by', type: 'chips', options: [{ value: 0, label: 'Keep as is' }, ...EXPIRY], default: 0 },
            ...SECTIONS.map(([key, label]) => ({ key, label: `Show ${label[0].toLowerCase()}${label.slice(1)}`, type: 'switch' })),
          ]}
          onSubmit={async (v) => {
            try { await api.patch(`/me/passport-links/${edit.id}`, { version: edit.version, label: v.label || null, ...(Number(v.extend) ? { expires_in_days: Number(v.extend) } : {}), ...Object.fromEntries(SECTIONS.map(([k]) => [k, !!v[k]])) }); }
            catch (e) { await links.reload(); throw e; }
            await links.reload(); return 'Link updated';
          }} />
      ) : null}
    </Screen>
  );
}

/** What a coach or scout sees when they open the link: no sign-in needed. */
export function PassportPublic({ token }) {
  const p = useLoad(() => api.get(`/passport/${encodeURIComponent(token)}`), [token]);
  return (
    <Screen>
      <T weight="800" size={16} color={c.pink} style={{ letterSpacing: -0.3 }}>Gotmygame · Player passport</T>
      <View style={{ marginTop: 12 }}>
        {p.error ? <Empty emoji="🔒" title="This link is not available" sub="It may have expired or been turned off. If it was sent to you personally, sign in with that account and open it again." /> : !p.data ? <Loading /> : <PassportCard data={p.data} />}
      </View>
      {p.data ? <T size={12} color={c.mute} style={{ marginTop: 14 }}>Shared by the athlete. This link stops working {day(p.data.expires_at)}. {p.data.evidence}</T> : null}
    </Screen>
  );
}

/** Coaches: review recruitment videos and write references for the athletes they coach. */
export function PassportDesk() {
  return (
    <Screen>
      <H1>Recruitment</H1>
      <CoachPassportDesk />
    </Screen>
  );
}
