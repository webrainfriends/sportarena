import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { api } from '../api';
import { useSession } from '../session';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, T, Tag } from '../ui';
import { c, fam } from '../theme';

const POLL_MS = 5000;
const clock = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** One conversation per team, for its members. New messages are fetched every few seconds while the screen is open. */
export function TeamChat({ id }) {
  const { user, toast } = useSession();
  const [team, setTeam] = useState(null);
  const [msgs, setMsgs] = useState(null);       // oldest -> newest
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [announce, setAnnounce] = useState(false);
  const [sending, setSending] = useState(false);
  const [more, setMore] = useState(false);
  const newest = useRef(null);

  const merge = useCallback((incoming) => setMsgs((cur) => {
    const byId = new Map((cur ?? []).map((m) => [m.message_id, m]));
    for (const m of incoming) byId.set(m.message_id, m);
    const all = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    newest.current = all.length ? all[all.length - 1].created_at : null;
    return all;
  }), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [t, first] = await Promise.all([api.get(`/teams/${id}`), api.get(`/teams/${id}/messages`, { limit: 50 })]);
        if (!alive) return;
        setTeam(t); merge(first); setMore(first.length === 50); api.post(`/teams/${id}/messages/read`).catch(() => {});
      } catch (e) { if (alive) setError(e); }
    })();
    const timer = setInterval(async () => {
      if (!newest.current) return;
      try { const fresh = await api.get(`/teams/${id}/messages`, { after: newest.current, limit: 100 }); if (alive && fresh.length) { merge(fresh); api.post(`/teams/${id}/messages/read`).catch(() => {}); } } catch { /* try again next tick */ }
    }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [id, merge]);

  if (error) return <Screen><ErrorBox error={error} onRetry={() => { setError(null); setMsgs(null); }} /></Screen>;
  if (!msgs) return <Screen><Loading /></Screen>;
  const canAnnounce = !!team?.can_manage;

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try { const m = await api.post(`/teams/${id}/messages`, { body, announcement: announce }); setText(''); setAnnounce(false); merge([m]); } catch (e) { toast('' + e.message); } finally { setSending(false); }
  };
  const older = async () => {
    try { const page = await api.get(`/teams/${id}/messages`, { before: msgs[0].created_at, limit: 50 }); merge(page); setMore(page.length === 50); } catch (e) { toast('' + e.message); }
  };
  const remove = async (m) => { try { await api.del(`/teams/${id}/messages/${m.message_id}`); setMsgs((cur) => cur.filter((x) => x.message_id !== m.message_id)); } catch (e) { toast('' + e.message); } };

  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>{team?.emoji} {team?.name}</H1>
      <T color={c.mute} weight="700">Team chat · only members can see this</T>
      {more ? <Btn small title="Earlier messages" color={c.paper} ink={c.ink} onPress={older} style={{ marginTop: 10 }} /> : null}
      <View style={{ gap: 8, marginTop: 12 }}>
        {msgs.length ? msgs.map((m) => (
          <View key={m.message_id} style={{ flexDirection: 'row', gap: 8, justifyContent: m.mine ? 'flex-end' : 'flex-start' }}>
            {m.mine ? null : <Avatar user={m} size={32} />}
            <Pressable onLongPress={(m.mine || canAnnounce) ? () => remove(m) : undefined} style={{ maxWidth: '80%' }}>
              <Card color={m.announcement ? c.sunSoft : m.mine ? c.violetSoft : c.paper} pad={10}>
                {m.announcement ? <Tag label="📣 Announcement" style={{ alignSelf: 'flex-start', marginBottom: 4 }} /> : null}
                {m.mine ? null : <T size={12} weight="800" color={c.violet}>{m.display_name}</T>}
                <T>{m.body}</T>
                <T size={11} color={c.mute} style={{ marginTop: 2 }}>{clock(m.created_at)}{(m.mine || canAnnounce) ? ' · hold to delete' : ''}</T>
              </Card>
            </Pressable>
          </View>
        )) : <Empty emoji="💬" title="No messages yet" sub="Say hello to your team." />}
      </View>
      <View style={{ marginTop: 14, gap: 8 }}>
        <TextInput value={text} onChangeText={setText} placeholder="Message your team" placeholderTextColor="#94A3B8" multiline maxLength={2000}
          style={[fam, { borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 12, minHeight: 48, backgroundColor: c.paper, color: c.ink }]} />
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          {canAnnounce ? <Chip label={announce ? '📣 Announcement — notifies everyone ✓' : '📣 Make it an announcement'} active={announce} onPress={() => setAnnounce(!announce)} /> : null}
          <View style={{ flex: 1 }} />
          <Btn small title="Send" onPress={send} loading={sending} disabled={!text.trim()} />
        </View>
      </View>
    </Screen>
  );
}
