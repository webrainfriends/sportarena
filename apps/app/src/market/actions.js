import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLoad } from '../hooks';
import { Avatar, Btn, Empty, Field, Loading, Sheet, T } from '../ui';
import { c } from '../theme';
import { setIntent, takeIntent } from './intent';

/** Poster's view of who responded, with accept / decline. */
function LeadsSheet({ post, onClose }) {
  const { toast } = useSession();
  const { push } = useNav();
  const leads = useLoad(() => api.get(`/market/posts/${post.id}/applications`), [post.id]);
  const decide = async (id, decision) => { try { await api.post(`/market/applications/${id}/decide`, { decision }); toast(decision === 'accepted' ? 'Accepted — they have been notified' : 'Declined'); leads.reload(); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible onClose={onClose} title={`Responses · ${post.title}`}>
      {leads.loading && !leads.data ? <Loading /> : !leads.data?.length ? <Empty emoji="📭" title="No responses yet" sub="You will be notified as soon as someone applies." /> : leads.data.map((l) => (
        <View key={l.id} style={{ gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Avatar user={l} size={38} />
            <View style={{ flex: 1 }}><T weight="700" onPress={() => { onClose(); push('Person', { id: l.user_id }); }}>{l.display_name}</T><T size={12} color={c.mute}>@{l.handle} · {l.status}</T></View>
          </View>
          {l.message ? <T size={13} color="#334155">{l.message}</T> : null}
          {l.status === 'pending' ? <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title="Accept" color={c.lime} onPress={() => decide(l.id, 'accepted')} /><Btn small title="Decline" color={c.paper} onPress={() => decide(l.id, 'declined')} /></View> : null}
        </View>
      ))}
    </Sheet>
  );
}

function CommentsSheet({ post, onClose, onChanged }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get(`/market/posts/${post.id}/comments`), [post.id]);
  const [text, setText] = useState('');
  const send = async () => { if (!text.trim()) return; try { await api.post(`/market/posts/${post.id}/comments`, { body: text.trim() }); setText(''); list.reload(); onChanged?.(post.id, { comments: post.comments + 1 }); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible onClose={onClose} title="Comments">
      {list.loading && !list.data ? <Loading /> : !list.data?.length ? <T color={c.mute}>No comments yet — start the conversation.</T> : list.data.map((m) => (
        <View key={m.id} style={{ flexDirection: 'row', gap: 10 }}>
          <Avatar user={m} size={32} />
          <View style={{ flex: 1, backgroundColor: c.bg, borderRadius: 14, padding: 10 }}><T weight="700" size={12}>{m.display_name}</T><T size={14}>{m.body}</T></View>
        </View>
      ))}
      <Field value={text} onChangeText={setText} placeholder="Write a comment…" multiline />
      <Btn title="Comment" onPress={send} />
    </Sheet>
  );
}

function ApplySheet({ post, onClose, onChanged }) {
  const { toast } = useSession();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const sale = post.kind === 'sale';
  const send = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/market/posts/${post.id}/apply`, { message: msg || undefined }); toast(sale ? 'Sent — the seller has been notified' : 'Application sent ✓'); onChanged?.(post.id, { my_application: 'pending', applicants: post.applicants + 1 }); onClose(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={sale ? 'Contact the seller' : 'Apply'}>
      <T weight="700" size={16}>{post.title}</T>
      <Field label="Message" value={msg} onChangeText={setMsg} multiline placeholder={sale ? 'Is it still available? Where can we meet?' : 'Your position, experience, availability…'} hint="Your profile is shared with the poster when you send this." />
      {err ? <T color={c.red} weight="600" size={13}>{err}</T> : null}
      <Btn title={sale ? 'Send message' : 'Send application'} onPress={send} loading={busy} />
    </Sheet>
  );
}

/**
 * Every action on a card goes through `gate(action, post)`.
 * Signed out: remember what the visitor wanted, then `openAuth(intent)` starts the guided login flow.
 * Signed in: do it (like, comment, apply, view profile, manage responses).
 * `onPatch(id, patch)` lets the list update a card in place.
 */
export function useMarketActions({ openAuth, onPatch }) {
  const { user, toast } = useSession();
  const { push } = useNav();
  const [sheet, setSheet] = useState(null);

  const gate = useCallback(async (action, post, extra) => {
    if (!user) { const intent = { action, postId: post?.id, title: post?.title }; setIntent(intent); openAuth?.(intent); return; }
    try {
      if (action === 'profile') { if (post.author?.id) push('Person', { id: post.author.id }); }
      else if (action === 'react' && extra === 'comments') setSheet({ type: 'comments', post });
      else if (action === 'react') { const r = await api.post(`/market/posts/${post.id}/react`); onPatch?.(post.id, { my_reaction: r.reacted, reactions: r.reactions }); }
      else if (action === 'apply' || action === 'contact') setSheet({ type: 'apply', post });
      else if (action === 'manage') setSheet({ type: 'leads', post });
    } catch (e) { toast(e.message); }
  }, [user, openAuth, onPatch, push, toast]);

  const sheets = sheet ? (
    sheet.type === 'apply' ? <ApplySheet post={sheet.post} onClose={() => setSheet(null)} onChanged={onPatch} />
      : sheet.type === 'comments' ? <CommentsSheet post={sheet.post} onClose={() => setSheet(null)} onChanged={onPatch} />
      : <LeadsSheet post={sheet.post} onClose={() => setSheet(null)} />
  ) : null;
  return { gate, sheets, user };
}

/** After the visitor signs in, finish what they came to do (e.g. open the apply form for the post they tapped). */
export function useResumeIntent(gate, user, { onPost, onAdvertise, onBook } = {}) {
  useEffect(() => {
    if (!user) return;
    const intent = takeIntent();
    if (intent?.action === 'post') return onPost?.();
    if (intent?.action === 'advertise') return onAdvertise?.();
    if (intent?.action === 'book') return onBook?.(intent);
    if (!intent?.postId) return;
    api.get(`/market/posts/${intent.postId}`).then((p) => gate(intent.action, p)).catch(() => {});
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
}
