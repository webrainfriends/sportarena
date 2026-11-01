// Network: the one home of your social graph (issue #695) — who you follow, who follows you, friends, requests (incl. as a guardian),
// suggestions, search and privacy. Everything is an API call; the server enforces blocks, privacy and guardian approval.
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Empty, ErrorBox, Field, H1, H2, Loading, Screen, Seg, Sheet, T } from '../ui';
import { MenuField } from '../menu-field';
import { ConnectButtons, PersonRow, Small } from '../social/people';
import { c } from '../theme';
import { t } from '../i18n';

const SECTIONS = ['following', 'followers', 'friends', 'requests', 'suggestions'];

function Following({ data, reload }) {
  const { toast } = useSession();
  const act = (fn) => async () => { try { await fn(); await reload(); } catch (e) { toast(e.message); } };
  if (!data.length) return <Empty emoji="🧭" title={t('social.empty')} sub={t('social.empty_feed')} />;
  return data.map((p) => (
    <PersonRow key={p.follow_id} p={p} sub={p.muted ? t('social.muted') : null}>
      <Small label={p.muted ? t('social.unmute') : t('social.mute')} onPress={act(() => api.patch(`/me/mutes/${p.id}`, { muted: !p.muted }))} />
      <Small label={t('social.unfollow')} onPress={act(() => api.del(`/me/follows/${p.follow_id}`))} />
    </PersonRow>
  ));
}

function Followers({ data, reload }) {
  const { toast } = useSession();
  if (!data.length) return <Empty emoji="👥" title={t('social.empty')} />;
  return data.map((p) => (
    <PersonRow key={p.id} p={p}>
      <Small label={t('social.block')} tone={c.red} onPress={async () => { try { await api.post('/me/contact-blocks', { user_id: p.id, blocked: true }); await reload(); } catch (e) { toast(e.message); } }} />
    </PersonRow>
  ));
}

function Friends({ data, reload }) {
  const { toast } = useSession();
  const act = (fn) => async () => { try { await fn(); await reload(); } catch (e) { toast(e.message); } };
  if (!data) return null;
  const none = !data.friends.length && !data.outgoing.length;
  return (
    <View style={{ gap: 10 }}>
      {none ? <Empty emoji="🤝" title={t('social.empty')} /> : null}
      {data.friends.map((f) => (
        <PersonRow key={f.id} p={{ id: f.person_id, ...f }}>
          <Small label={t('social.unfriend')} onPress={act(() => api.del(`/me/friends/${f.id}`))} />
        </PersonRow>
      ))}
      {data.outgoing.map((f) => (
        <PersonRow key={f.id} p={{ id: f.person_id, ...f }} sub={t('social.waiting')}>
          <Small label={t('social.cancel')} onPress={act(() => api.del(`/me/friends/${f.id}`))} />
        </PersonRow>
      ))}
    </View>
  );
}

/** Requests waiting on me: follows, friend requests and, for a guardian, anything involving their child. */
function Requests({ follow, friends, reload }) {
  const { toast } = useSession();
  const act = (fn) => async () => { try { await fn(); await reload(); } catch (e) { toast(e.message); } };
  const guardianFriends = friends?.guardian ?? [];
  const incomingFriends = friends?.incoming ?? [];
  const nothing = !follow.incoming.length && !follow.guardian.length && !follow.sent.length && !guardianFriends.length && !incomingFriends.length;
  if (nothing) return <Empty emoji="📭" title={t('social.empty')} />;
  return (
    <View style={{ gap: 10 }}>
      {incomingFriends.map((f) => (
        <PersonRow key={f.id} p={{ id: f.person_id, ...f }} sub={t('social.friend_request')}>
          <Btn small title={t('social.accept')} color={c.pink} onPress={act(() => api.patch(`/me/friends/${f.id}`, { decision: 'accept' }))} />
          <Small label={t('social.decline')} onPress={act(() => api.patch(`/me/friends/${f.id}`, { decision: 'decline' }))} />
        </PersonRow>
      ))}
      {follow.incoming.map((r) => (
        <PersonRow key={r.id} p={{ id: r.person_id, ...r }} sub={t('social.follow_request')}>
          <Btn small title={t('social.approve')} color={c.pink} onPress={act(() => api.post(`/me/follow-requests/${r.id}`, { approve: true }))} />
          <Small label={t('social.decline')} onPress={act(() => api.post(`/me/follow-requests/${r.id}`, { approve: false }))} />
        </PersonRow>
      ))}
      {follow.guardian.map((r) => (
        <Card key={r.id} pad={12}>
          <T weight="800" size={14.5}>{t('social.for_child', { name: r.follower_name })}</T>
          <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{r.follower_name} → {r.target_name}</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn small title={t('social.approve')} color={c.pink} onPress={act(() => api.post(`/me/follow-requests/${r.id}`, { approve: true }))} />
            <Small label={t('social.decline')} onPress={act(() => api.post(`/me/follow-requests/${r.id}`, { approve: false }))} />
          </View>
        </Card>
      ))}
      {guardianFriends.map((f) => (
        <Card key={f.id} pad={12}>
          <T weight="800" size={14.5}>{t('social.friend_request')}</T>
          <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{f.requester_name} → {f.addressee_name}</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn small title={t('social.approve')} color={c.pink} onPress={act(() => api.patch(`/me/friends/${f.id}`, { decision: 'guardian_approve' }))} />
            <Small label={t('social.decline')} onPress={act(() => api.patch(`/me/friends/${f.id}`, { decision: 'guardian_decline' }))} />
          </View>
        </Card>
      ))}
      {follow.sent.map((r) => (
        <PersonRow key={r.id} p={{ id: r.person_id, ...r }} sub={r.status === 'guardian_pending' ? t('social.waiting_guardian') : t('social.waiting')}>
          <Small label={t('social.cancel')} onPress={act(() => api.del(`/me/follows/${r.id}`))} />
        </PersonRow>
      ))}
    </View>
  );
}

const WHY = { team: 'social.why_team', game: 'social.why_game', venue: 'social.why_venue' };

/** People you may know (from a shared team, game or venue) plus a name search over the public directory. */
function Suggestions({ reload }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const sug = useLoad(() => api.get('/me/social-suggestions'), []);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setFound(null); return undefined; }
    const h = setTimeout(() => api.get('/people', { q: term, limit: 20 }).then(setFound).catch(() => setFound([])), 300);
    return () => clearTimeout(h);
  }, [q]);
  const list = found ?? sug.data ?? [];
  return (
    <View style={{ gap: 10 }}>
      <Field value={q} onChangeText={setQ} placeholder={t('social.search')} accessibilityLabel={t('social.find')} />
      {sug.loading && !found ? <Loading /> : null}
      {sug.error && !found ? <ErrorBox error={sug.error} onRetry={sug.reload} /> : null}
      {!sug.loading && !list.length ? <Empty emoji="🔎" title={t('social.empty')} /> : null}
      {list.map((p) => (
        <PersonRow key={p.id} p={p} sub={p.reasons?.map((r) => t(WHY[r])).join(' · ')}>
          <ConnectButtons p={p} onDone={reload} />
        </PersonRow>
      ))}
    </View>
  );
}

/** Privacy: who sees my activity, who may follow me, whether I'm suggested; and the people I blocked or muted. */
function PrivacySheet({ visible, onClose }) {
  const { toast } = useSession();
  const st = useLoad(() => api.get('/me/social-settings'), []);
  const bm = useLoad(() => api.get('/me/blocked-muted'), []);
  const set = async (patch) => { try { await api.patch('/me/social-settings', patch); await st.reload(); } catch (e) { toast(e.message); } };
  const s = st.data;
  const vis = ['public', 'followers', 'friends', 'private'].map((v) => ({ value: v, label: t(`social.vis_${v}`) }));
  const modes = [['open', 'social.fm_open'], ['approval', 'social.fm_approval'], ['closed', 'social.fm_closed']].map(([value, k]) => ({ value, label: t(k) }));
  const undo = (kind, p) => async () => { try { if (kind === 'blocked') await api.post('/me/contact-blocks', { user_id: p.id, blocked: false }); else await api.patch(`/me/mutes/${p.id}`, { muted: false }); await bm.reload(); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible={visible} onClose={onClose} title={t('social.privacy')}>
      {st.loading && !s ? <Loading /> : st.error ? <ErrorBox error={st.error} onRetry={st.reload} /> : s ? (
        <View style={{ gap: 14 }}>
          {s.young ? <Card color={c.sunSoft} pad={12}><T size={13}>{t('social.young')}</T></Card> : null}
          <MenuField label={t('social.vis_label')} value={s.default_item_visibility} options={vis} onChange={(v) => set({ default_item_visibility: v })} disabled={s.young} />
          <MenuField label={t('social.follow_label')} value={s.follow_mode} options={modes} onChange={(v) => set({ follow_mode: v })} disabled={s.young} />
          <Seg options={[{ value: true, label: t('social.discoverable') }, { value: false, label: t('social.hidden_from_suggestions') }]} value={s.discoverable} onChange={(v) => set({ discoverable: v })} />
        </View>
      ) : null}
      <H2>{t('social.blocked_muted')}</H2>
      {bm.data ? (
        <View style={{ gap: 8 }}>
          {!bm.data.blocked.length && !bm.data.muted.length ? <T size={13} color={c.mute}>{t('social.empty')}</T> : null}
          {bm.data.blocked.map((p) => <PersonRow key={`b${p.id}`} p={p} sub={t('social.block')}><Small label={t('social.unblock')} onPress={undo('blocked', p)} /></PersonRow>)}
          {bm.data.muted.map((p) => <PersonRow key={`m${p.id}`} p={p} sub={t('social.muted')}><Small label={t('social.unmute')} onPress={undo('muted', p)} /></PersonRow>)}
        </View>
      ) : null}
    </Sheet>
  );
}

export default function Network({ section: initial }) {
  const L = useLayout();
  const [section, setSection] = useState(SECTIONS.includes(initial) ? initial : 'following');
  const [privacy, setPrivacy] = useState(false);
  const following = useLoad(() => api.get('/me/following', { limit: 100 }), []);
  const followers = useLoad(() => api.get('/me/followers', { limit: 100 }), []);
  const friends = useLoad(() => api.get('/me/friends'), []);
  const reqs = useLoad(() => api.get('/me/follow-requests'), []);
  const reload = useCallback(() => Promise.all([following.reload(), followers.reload(), friends.reload(), reqs.reload()]), [following.reload, followers.reload, friends.reload, reqs.reload]);
  const waiting = (reqs.data?.incoming.length ?? 0) + (reqs.data?.guardian.length ?? 0) + (friends.data?.incoming.length ?? 0) + (friends.data?.guardian.length ?? 0);
  const options = SECTIONS.map((k) => ({ value: k, label: `${t(`social.${k}`)}${k === 'requests' && waiting ? ` (${waiting})` : ''}` }));
  const cur = { following, followers, friends, requests: reqs }[section];
  return (
    <Screen wide={L.tablet}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <H1>{t('social.title')}</H1>
        <Small label={t('social.privacy')} onPress={() => setPrivacy(true)} />
      </View>
      <Seg options={options} value={section} onChange={setSection} />
      <View style={{ marginTop: 14, gap: 10 }}>
        {cur?.error ? <ErrorBox error={cur.error} onRetry={cur.reload} /> : cur?.loading && !cur.data ? <Loading /> : null}
        {section === 'following' && following.data ? <Following data={following.data} reload={reload} /> : null}
        {section === 'followers' && followers.data ? <Followers data={followers.data} reload={reload} /> : null}
        {section === 'friends' && friends.data ? <Friends data={friends.data} reload={reload} /> : null}
        {section === 'requests' && reqs.data ? <Requests follow={reqs.data} friends={friends.data} reload={reload} /> : null}
        {section === 'suggestions' ? <Suggestions reload={reload} /> : null}
      </View>
      <PrivacySheet visible={privacy} onClose={() => setPrivacy(false)} />
    </Screen>
  );
}
