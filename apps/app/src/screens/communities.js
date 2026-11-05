// Communities (issue #66): discover, join and run local and sport communities; post, share verified achievements, comment, report and moderate.
// One screen family on phone, tablet, desktop and web. Every rule (who can see, post, moderate) is decided by the API; this file only calls it.
// All text goes through t(); layouts use flex rows and start/end so right-to-left (Urdu) mirrors. Touch targets are at least 44pt.
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { ReportSheet, Small, itemText } from '../social/people';
import { ProtectedImage } from './team-chat';
import { pickMedia } from '../market/media';
import { c, when } from '../theme';
import { t } from '../i18n';

/** A cursor-paged list: the API returns { items, next }; "more" appends the next page, reload starts again. */
function usePaged(path, params, enabled = true) {
  const [state, setState] = useState({ items: [], next: null, busy: enabled, err: null });
  const key = JSON.stringify(params);
  const load = useCallback(async (cursor) => {
    if (!enabled) return;
    setState((s) => ({ ...s, busy: true, err: null }));
    try {
      const r = await api.get(path, { ...params, ...(cursor ? { before: cursor } : {}) });
      setState((s) => ({ items: cursor ? [...s.items, ...r.items] : r.items, next: r.next, busy: false, err: null }));
    } catch (e) { setState((s) => ({ ...s, busy: false, err: e })); }
  }, [path, key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(null); }, [load]);
  return { ...state, reload: () => load(null), more: () => state.next && load(state.next) };
}

const MoreButton = ({ list }) => (list.next ? (
  <Pressable onPress={list.more} disabled={list.busy} accessibilityRole="button" accessibilityLabel={t('social.more')}
    style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center', borderRadius: 999, borderWidth: 1.5, borderColor: c.ink, paddingHorizontal: 26 }}><T weight="800">{list.busy ? '…' : t('social.more')}</T></Pressable>
) : null);

// ------------------------------------------------------------------------------------------------ discover
function CommunityCard({ cm, onOpen, onChanged }) {
  const { toast } = useSession();
  const member = cm.my_status === 'active';
  const join = async () => {
    try { const r = await api.post(`/communities/${cm.slug}/join`, {}); toast(r.status === 'pending' ? t('community.requested') : t('community.joined')); onChanged(); }
    catch (e) { toast(e.message); }
  };
  const action = member || cm.invited || cm.join_mode === 'invite' ? null : cm.my_status === 'pending' ? <Tag label={t('community.requested')} color={c.sunSoft} /> : (
    <Small label={cm.join_mode === 'open' ? t('community.join') : t('community.ask')} onPress={join} />
  );
  return (
    <Card pad={14}>
      <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${cm.name}. ${t('community.open')}`} style={{ minHeight: 44, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <T size={26}>{cm.sport?.emoji ?? '👥'}</T>
          <View style={{ flex: 1 }}>
            <T weight="800" size={16} numberOfLines={2}>{cm.name}</T>
            <T size={12.5} color={c.mute}>{t('community.members_n', { n: cm.members ?? 0 })}{cm.city ? ` · ${cm.city}` : ''}</T>
          </View>
        </View>
        {cm.description ? <T size={13.5} numberOfLines={3}>{cm.description}</T> : null}
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {cm.sport ? <Tag label={cm.sport.name} color={c.violetSoft} /> : null}
          {cm.adaptive ? <Tag label={t('comm.adaptive_badge')} color={c.cyanSoft} textColor={c.cyan} /> : null}
          {(cm.para_sports ?? []).map((ps) => <Tag key={ps} label={ps} color={c.cyanSoft} textColor={c.cyan} />)}
          <Tag label={t(`community.vis_${cm.visibility}`)} color={c.cyanSoft ?? c.violetSoft} />
          {cm.audience === 'all' ? <Tag label={t('community.aud_all_short')} color={c.mintSoft} /> : null}
          {cm.invited ? <Tag label={t('community.invited')} color={c.sunSoft} /> : null}
        </View>
      </Pressable>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Small label={t('community.open')} onPress={onOpen} />
        {action}
      </View>
    </Card>
  );
}

function CreateSheet({ visible, onClose, onCreated }) {
  const { toast } = useSession();
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('community.create')} submitLabel={t('community.create')}
      fields={[
        { key: 'name', label: t('community.name'), type: 'text' },
        { key: 'description', label: t('community.about'), type: 'multiline', optional: true },
        { key: 'sport', label: t('community.sport'), type: 'sport', optional: true },
        { key: 'city', label: t('community.city'), type: 'regions', optional: true },
        { key: 'visibility', label: t('community.vis_label'), type: 'chips', default: 'public', options: ['public', 'private', 'hidden'].map((v) => ({ value: v, label: t(`community.vis_${v}`) })) },
        { key: 'join_mode', label: t('community.join_how'), type: 'chips', default: 'open', options: ['open', 'request', 'invite'].map((v) => ({ value: v, label: t(`community.join_${v}`) })) },
        { key: 'audience', label: t('community.audience'), type: 'chips', default: 'adults', options: ['adults', 'all'].map((v) => ({ value: v, label: t(`community.aud_${v}`) })) },
      ]}
      onSubmit={async (v) => {
        const city = Array.isArray(v.city) ? v.city[0] : v.city;
        const r = await api.post('/communities', { name: v.name, ...(v.description ? { description: v.description } : {}), ...(v.sport ? { sport: v.sport } : {}), ...(city ? { city } : {}), visibility: v.visibility, join_mode: v.join_mode, audience: v.audience });
        onClose(); toast(t('community.created')); onCreated(r);
      }} />
  );
}

export default function Communities({ section }) {
  const L = useLayout();
  const { push } = useNav();
  const { toast } = useSession();
  const [tab, setTab] = useState(['discover', 'mine', 'invitations'].includes(section) ? section : 'discover');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [adaptiveOnly, setAdaptiveOnly] = useState(false);
  const [create, setCreate] = useState(false);
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim().length > 1 ? q.trim() : ''), 300); return () => clearTimeout(h); }, [q]);
  const list = usePaged('/communities', { scope: tab === 'mine' ? 'mine' : 'discover', limit: 20, ...(term ? { q: term } : {}), ...(adaptiveOnly ? { adaptive: true } : {}) }, tab !== 'invitations');
  const inv = useLoad(() => api.get('/me/community-invitations', { limit: 50 }), []);
  const answer = (v, decision) => async () => {
    try { await api.post(`/me/community-invitations/${v.id}`, { decision }); await inv.reload(); list.reload(); if (decision === 'accept') push('CommunityDetail', { slug: v.slug }); }
    catch (e) { toast(e.message); }
  };
  const options = [{ value: 'discover', label: t('community.discover') }, { value: 'mine', label: t('community.mine') }, { value: 'invitations', label: `${t('community.invitations')}${inv.data?.length ? ` (${inv.data.length})` : ''}` }];
  return (
    <Screen wide={L.tablet}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <H1>{t('community.title')}</H1>
        <Small label={t('community.create')} onPress={() => setCreate(true)} />
      </View>
      <Seg options={options} value={tab} onChange={setTab} />
      <View style={{ marginTop: 14, gap: 10 }}>
        {tab !== 'invitations' ? (
          <View style={{ gap: 8 }}>
            <Field value={q} onChangeText={setQ} placeholder={t('community.search')} accessibilityLabel={t('community.search')} />
            <Pressable onPress={() => setAdaptiveOnly((v) => !v)} accessibilityRole="checkbox" accessibilityLabel={t('comm.filter_adaptive')}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 }}>
              <View style={{ width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: adaptiveOnly ? c.cyan : c.cyanSoft, backgroundColor: adaptiveOnly ? c.cyan : c.paper, alignItems: 'center', justifyContent: 'center' }}>
                {adaptiveOnly ? <T style={{ color: c.paper, fontSize: 12, fontWeight: '900' }}>✓</T> : null}
              </View>
              <T style={{ fontSize: 13, color: c.ink }}>{t('comm.filter_adaptive')}</T>
            </Pressable>
          </View>
        ) : null}
        {tab === 'invitations' ? (
          inv.loading && !inv.data ? <Loading /> : inv.error ? <ErrorBox error={inv.error} onRetry={inv.reload} /> : !inv.data?.length ? <Empty emoji="✉️" title={t('community.no_invitations')} /> : inv.data.map((v) => (
            <Card key={v.id} pad={14}>
              <T weight="800" size={15.5}>{v.name}</T>
              <T size={12.5} color={c.mute}>{t('community.invited_by', { name: v.inviter_name })}</T>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <Btn small title={t('social.accept')} color={c.pink} onPress={answer(v, 'accept')} />
                <Small label={t('social.decline')} onPress={answer(v, 'decline')} />
              </View>
            </Card>
          ))
        ) : (
          <>
            {list.err ? <ErrorBox error={list.err} onRetry={list.reload} /> : null}
            {list.busy && !list.items.length ? <Loading /> : !list.items.length && !list.err ? <Empty emoji="👥" title={t('community.empty')} sub={t('community.empty_sub')} /> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {list.items.map((cm) => <View key={cm.id} style={{ flexBasis: L.tablet ? '48%' : '100%', flexGrow: 1 }}><CommunityCard cm={cm} onOpen={() => push('CommunityDetail', { slug: cm.slug })} onChanged={list.reload} /></View>)}
            </View>
            <MoreButton list={list} />
          </>
        )}
      </View>
      <CreateSheet visible={create} onClose={() => setCreate(false)} onCreated={(r) => { list.reload(); push('CommunityDetail', { slug: r.slug }); }} />
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------------ posts
function ShareLine({ share }) {
  if (!share) return null;
  if (share.unavailable) return <Tag label={t('community.share_gone')} color={c.sunSoft} />;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <T size={22}>{{ result: '🏅', achievement: '🏆', streak: '🔥', hosted_game: '🎟️', rating: '📈' }[share.kind]}</T>
      <T weight="700" size={14.5} style={{ flexShrink: 1 }}>{itemText({ ...share, data: share.data })}</T>
      <Tag label={t('social.verified')} color={c.mintSoft} />
    </View>
  );
}

function Comments({ post, visible, onClose, onCount }) {
  const { toast } = useSession();
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (after) => {
    setBusy(true); setErr(null);
    try { const r = await api.get(`/market/posts/${post.id}/comments`, { limit: 20, ...(after ? { after } : {}) }); setRows((x) => (after ? [...x, ...r] : r)); setMore(r.length === 20); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }, [post.id]);
  useEffect(() => { if (visible) load(null); }, [visible, load]);
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    try { await api.post(`/market/posts/${post.id}/comments`, { body }); setText(''); await load(null); onCount?.(); } catch (e) { toast(e.message); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={t('community.comments')}>
      {err ? <ErrorBox error={err} onRetry={() => load(null)} /> : null}
      {busy && !rows.length ? <Loading /> : !rows.length && !err ? <T color={c.mute}>{t('community.no_comments')}</T> : null}
      <View style={{ gap: 10 }}>
        {rows.map((r) => (
          <View key={r.id} style={{ flexDirection: 'row', gap: 10 }}>
            <Avatar user={{ display_name: r.display_name, avatar_emoji: r.avatar_emoji, avatar_color: r.avatar_color, avatar_url: r.avatar_url }} size={34} />
            <View style={{ flex: 1 }}><T weight="800" size={13.5}>{r.display_name} <T size={12} color={c.mute}>{when(r.created_at)}</T></T><T size={14}>{r.body}</T></View>
          </View>
        ))}
      </View>
      {more ? <Small label={t('social.more')} onPress={() => load(rows[rows.length - 1].cursor)} /> : null}
      <Field value={text} onChangeText={setText} placeholder={t('community.comment_ph')} accessibilityLabel={t('community.comment_ph')} multiline />
      <Btn title={t('community.send')} color={c.pink} onPress={send} disabled={!text.trim()} />
    </Sheet>
  );
}

function PostCard({ p, staff, slug, onChanged }) {
  const { toast } = useSession();
  const { push } = useNav();
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [state, setState] = useState({ liked: p.my_reaction, likes: p.reactions, comments: p.comments });
  const like = async () => { try { const r = await api.post(`/market/posts/${p.id}/react`, {}); setState((s) => ({ ...s, liked: r.reacted, likes: r.reactions })); } catch (e) { toast(e.message); } };
  const run = (fn, msg) => async () => { try { await fn(); setMenu(false); if (msg) toast(msg); onChanged(); } catch (e) { toast(e.message); } };
  const a = p.author;
  return (
    <Card pad={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable onPress={() => push('Person', { id: a.id })} accessibilityRole="button" accessibilityLabel={a.display_name} style={{ flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Avatar user={a} size={40} />
          <View style={{ flex: 1 }}><T weight="800" size={14.5} numberOfLines={1}>{a.display_name}</T><T size={12} color={c.mute}>{when(p.created_at)}</T></View>
        </Pressable>
        <Pressable onPress={() => setMenu(!menu)} accessibilityRole="button" accessibilityLabel={`${a.display_name}: ${t('social.more')}`} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><T size={20} weight="800" color={c.mute}>⋯</T></Pressable>
      </View>
      {p.text ? <T size={15} style={{ marginTop: 10 }}>{p.text}</T> : null}
      {p.share ? <View style={{ marginTop: 10 }}><ShareLine share={p.share} /></View> : null}
      {p.media?.length ? <View style={{ marginTop: 10, gap: 8 }}>{p.media.map((m) => (m.kind === 'photo' ? <ProtectedImage key={m.id} media={{ url: m.url, kind: 'image' }} /> : null))}</View> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Small label={`${state.liked ? '♥' : '♡'} ${state.likes}`} onPress={like} tone={state.liked ? c.pink : undefined} />
        <Small label={`💬 ${state.comments}`} onPress={() => setOpen(true)} />
      </View>
      {menu ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {!p.is_mine ? <Small label={t('social.report')} onPress={() => { setMenu(false); setReport(true); }} /> : null}
          {!p.is_mine ? <Small label={t('social.mute')} onPress={run(() => api.patch(`/me/mutes/${a.id}`, { muted: true }), t('social.muted'))} /> : null}
          {!p.is_mine ? <Small label={t('social.block')} tone={c.red} onPress={run(() => api.post('/me/contact-blocks', { user_id: a.id, blocked: true }), t('social.blocked'))} /> : null}
          {p.is_mine ? <Small label={t('community.remove')} tone={c.red} onPress={run(() => api.post(`/communities/${slug}/posts/${p.id}/remove`, {}), t('community.removed'))} /> : null}
          {staff && !p.is_mine ? <Small label={t('community.remove')} tone={c.red} onPress={() => { setMenu(false); setRemoving(true); }} /> : null}
        </View>
      ) : null}
      <Comments post={p} visible={open} onClose={() => setOpen(false)} onCount={() => setState((s) => ({ ...s, comments: s.comments + 1 }))} />
      <ReportSheet visible={report} onClose={() => setReport(false)} target={{ target_type: 'community_post', target_id: p.id }} />
      <FormSheet visible={removing} onClose={() => setRemoving(false)} title={t('community.remove')} submitLabel={t('community.remove')}
        fields={[{ key: 'reason', label: t('community.remove_reason'), type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/communities/${slug}/posts/${p.id}/remove`, { reason: v.reason }); toast(t('community.removed')); setRemoving(false); onChanged(); }} />
    </Card>
  );
}

/** The post box: text, up to four photos, and optionally one of your own verified achievements. */
function Composer({ slug, onPosted }) {
  const { toast, user } = useSession();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState([]);
  const [media, setMedia] = useState([]);
  const show = async () => {
    setOpen(true);
    try { setMine(await api.get('/me/activity-feed', { scope: 'mine', limit: 20 })); } catch { setMine([]); }
  };
  const attach = async () => {
    try { const f = await pickMedia(); if (!f) return; const m = await api.upload('/market/media', f.blob); if (m.kind !== 'photo') throw new Error(t('community.photos_only')); setMedia((l) => [...l, m]); }
    catch (e) { toast(e.message); }
  };
  const close = () => { setOpen(false); setMedia([]); };
  return (
    <Card pad={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar user={user} size={44} />
        <Pressable onPress={show} accessibilityRole="button" accessibilityLabel={t('community.write')} style={{ flex: 1, minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 18 }}>
          <T color={c.mute} weight="600">{t('community.write')}</T>
        </Pressable>
      </View>
      <FormSheet visible={open} onClose={close} title={t('community.write')} submitLabel={t('community.post')}
        fields={[
          { key: 'text', label: t('community.text'), type: 'multiline', optional: true },
          ...(mine.length ? [{ key: 'share', label: t('community.share'), type: 'chips', optional: true, options: mine.map((i) => ({ value: i.key, label: itemText(i) })) }] : []),
        ]}
        extra={(
          <View style={{ gap: 8 }}>
            <Small label={`📷 ${t('community.add_photo')}${media.length ? ` (${media.length})` : ''}`} onPress={attach} disabled={media.length >= 4} />
            {media.length ? <Small label={t('community.clear_photos')} onPress={() => setMedia([])} /> : null}
          </View>
        )}
        onSubmit={async (v) => {
          const [kind, ...rest] = (v.share ?? '').split(':');
          await api.post(`/communities/${slug}/posts`, { text: v.text ?? '', media_ids: media.map((m) => m.id), ...(v.share ? { ref_kind: kind, ref_id: rest.join(':') } : {}) });
          close(); toast(t('community.posted')); onPosted();
        }} />
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ moderation
const OUTCOMES = ['hidden', 'warned', 'silenced', 'dismissed'];

/** Reports waiting for a decision: the platform admin sees every community's, an owner or moderator only their own. */
export function ModerationQueue({ visible, onClose, community }) {
  const { toast } = useSession();
  const [show, setShow] = useState(false);
  const [decide, setDecide] = useState(null);
  const list = usePaged('/social/reports', { status: 'open', limit: 20, ...(community ? { community } : {}), ...(show ? { include_content: true } : {}) }, visible);
  return (
    <Sheet visible={visible} onClose={onClose} title={t('community.reports')}>
      <Seg options={[{ value: false, label: t('community.hide_text') }, { value: true, label: t('community.show_text') }]} value={show} onChange={setShow} />
      {list.err ? <ErrorBox error={list.err} onRetry={list.reload} /> : null}
      {list.busy && !list.items.length ? <Loading /> : !list.items.length && !list.err ? <Empty emoji="✅" title={t('community.no_reports')} /> : null}
      <View style={{ gap: 10 }}>
        {list.items.filter((r) => r.source === 'social').map((r) => (
          <Card key={r.id} pad={12}>
            <T weight="800" size={14.5}>{t(`community.reason_${r.reason}`)}{r.community_name ? ` · ${r.community_name}` : ''}</T>
            <T size={12.5} color={c.mute}>{r.actor_name ?? ''} · {when(r.created_at)}</T>
            {show && r.content ? <T size={14} style={{ marginTop: 6 }}>{r.content}</T> : null}
            <View style={{ marginTop: 10, alignSelf: 'flex-start' }}><Small label={t('community.decide')} onPress={() => setDecide(r)} /></View>
          </Card>
        ))}
      </View>
      <MoreButton list={list} />
      <FormSheet visible={!!decide} onClose={() => setDecide(null)} title={t('community.decide')} submitLabel={t('community.decide')}
        fields={[
          { key: 'outcome', label: t('community.outcome'), type: 'chips', options: OUTCOMES.map((o) => ({ value: o, label: t(`community.out_${o}`) })), default: 'dismissed' },
          { key: 'reason', label: t('community.decision_reason'), type: 'multiline' },
          { key: 'silence_minutes', label: t('community.silence_for'), type: 'stepper', min: 5, max: 43200, step: 60, default: 60, show: (v) => v.outcome === 'silenced' },
        ]}
        onSubmit={async (v) => {
          await api.patch(`/social/reports/${decide.id}`, { outcome: v.outcome, reason: v.reason, ...(v.outcome === 'silenced' ? { silence_minutes: v.silence_minutes } : {}) });
          toast(t('community.decided')); setDecide(null); list.reload();
        }} />
    </Sheet>
  );
}

/** Appeal a moderation decision (opens a support case). */
export function AppealSheet({ visible, onClose, reportId }) {
  const { toast } = useSession();
  const { push } = useNav();
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('community.appeal_title')} submitLabel={t('community.appeal')}
      fields={[{ key: 'statement', label: t('community.appeal_statement'), type: 'multiline' }]}
      onSubmit={async (v) => { await api.post(`/social/reports/${reportId}/appeal`, { statement: v.statement }); toast(t('community.appealed')); onClose(); push('Support'); }} />
  );
}

/** The page a "your content was reviewed" notification opens: the decision can be appealed from here. */
export function Appeal({ report_id }) {
  const L = useLayout();
  const { back } = useNav();
  return (
    <Screen wide={L.tablet}>
      <H1>{t('community.appeal_title')}</H1>
      <T size={14} color={c.mute} style={{ marginVertical: 10 }}>{t('community.appeal_intro')}</T>
      <AppealSheet visible onClose={back} reportId={report_id} />
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------------ one community
function MembersSheet({ visible, onClose, cm, staff, owner, onChanged }) {
  const { toast, user } = useSession();
  const [status, setStatus] = useState('active');
  const [invite, setInvite] = useState(false);
  const list = usePaged(`/communities/${cm.slug}/members`, { status, limit: 30 }, visible);
  const act = (m, action, extra) => async () => {
    try { await api.post(`/communities/${cm.slug}/members/${m.id}`, { action, ...extra }); list.reload(); onChanged(); } catch (e) { toast(e.message); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={t('community.members')}>
      {staff ? <Seg options={[{ value: 'active', label: t('community.members') }, { value: 'pending', label: t('community.join_requests') }]} value={status} onChange={setStatus} /> : null}
      {staff ? <Small label={t('community.invite')} onPress={() => setInvite(true)} /> : null}
      {list.err ? <ErrorBox error={list.err} onRetry={list.reload} /> : null}
      {list.busy && !list.items.length ? <Loading /> : !list.items.length ? <T color={c.mute}>{t('social.empty')}</T> : null}
      <View style={{ gap: 8 }}>
        {list.items.map((m) => (
          <Card key={m.id} pad={10}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Avatar user={m} size={36} />
              <View style={{ flex: 1, minWidth: 120 }}><T weight="800" size={14} numberOfLines={1}>{m.display_name}</T><T size={12} color={c.mute}>{t(`community.role_${m.role}`)}{m.silenced ? ` · ${t('community.silenced')}` : ''}</T></View>
              {staff && m.id !== user.id && m.role !== 'owner' ? (
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {status === 'pending' ? <><Small label={t('social.approve')} onPress={act(m, 'approve')} /><Small label={t('social.decline')} onPress={act(m, 'decline')} /></> : (
                    <>
                      {owner ? <Small label={m.role === 'moderator' ? t('community.make_member') : t('community.make_mod')} onPress={act(m, m.role === 'moderator' ? 'make_member' : 'make_moderator')} /> : null}
                      <Small label={m.silenced ? t('community.unsilence') : t('community.silence_hour')} onPress={act(m, m.silenced ? 'unsilence' : 'silence', { silence_minutes: 60 })} />
                      <Small label={t('community.remove_member')} tone={c.red} onPress={act(m, 'remove')} />
                    </>
                  )}
                </View>
              ) : null}
            </View>
          </Card>
        ))}
      </View>
      <MoreButton list={list} />
      <FormSheet visible={invite} onClose={() => setInvite(false)} title={t('community.invite')} submitLabel={t('community.invite')}
        fields={[{ key: 'user_id', label: t('community.person'), type: 'entity', entityKind: 'person' }]}
        onSubmit={async (v) => { await api.post(`/communities/${cm.slug}/invitations`, { user_id: v.user_id }); toast(t('community.invite_sent')); setInvite(false); }} />
    </Sheet>
  );
}

export function CommunityDetail({ slug }) {
  const L = useLayout();
  const { toast } = useSession();
  const nav = useNav();
  const cm = useLoad(() => api.get(`/communities/${slug}`), [slug]);
  const can = cm.data?.can;
  const feed = usePaged(`/communities/${slug}/feed`, { limit: 15 }, !!can?.read);
  const [members, setMembers] = useState(false);
  const [reports, setReports] = useState(false);
  const act = (fn, msg) => async () => { try { await fn(); if (msg) toast(msg); cm.reload(); feed.reload(); } catch (e) { toast(e.message); } };
  if (cm.loading && !cm.data) return <Screen wide={L.tablet}><Loading /></Screen>;
  if (cm.error) return <Screen wide={L.tablet}><ErrorBox error={cm.error} onRetry={cm.reload} /></Screen>;
  const d = cm.data;
  const member = d.my_status === 'active';
  return (
    <Screen wide={L.tablet}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T size={34}>{d.sport?.emoji ?? '👥'}</T>
        <View style={{ flex: 1 }}><H1>{d.name}</H1><T size={13} color={c.mute}>{t('community.members_n', { n: d.members })}{d.city ? ` · ${d.city}` : ''}</T></View>
      </View>
      {d.description ? <T size={14.5} style={{ marginTop: 8 }}>{d.description}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Tag label={t(`community.vis_${d.visibility}`)} color={c.violetSoft} />
        {d.my_role ? <Tag label={t(`community.role_${d.my_role}`)} color={c.mintSoft} /> : null}
        {d.my_status === 'pending' ? <Tag label={t('community.requested')} color={c.sunSoft} /> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {can?.join ? <Btn small title={d.join_mode === 'open' ? t('community.join') : t('community.ask')} color={c.pink} onPress={act(() => api.post(`/communities/${slug}/join`, {}), d.join_mode === 'open' ? t('community.joined') : t('community.requested'))} /> : null}
        {can?.read ? <Small label={t('community.members')} onPress={() => setMembers(true)} /> : null}
        {can?.manage ? <Small label={t('community.reports')} onPress={() => setReports(true)} /> : null}
        {member && !can?.own ? <Small label={t('community.leave')} onPress={act(async () => { await api.post(`/communities/${slug}/leave`, {}); }, t('community.left'))} /> : null}
        {can?.own ? <Small label={t('community.archive')} tone={c.red} onPress={act(async () => { await api.post(`/communities/${slug}/archive`, {}); nav.back(); }, t('community.archived'))} /> : null}
      </View>
      <View style={{ marginTop: 16, gap: 12 }}>
        {!can?.read ? <Card color={c.violetSoft} pad={14}><T size={14}>{t('community.private_note')}</T></Card> : null}
        {can?.post ? <Composer slug={slug} onPosted={feed.reload} /> : null}
        {can?.read ? (
          <>
            {feed.err ? <ErrorBox error={feed.err} onRetry={feed.reload} /> : null}
            {feed.busy && !feed.items.length ? <Loading /> : !feed.items.length && !feed.err ? <Empty emoji="📝" title={t('community.empty_feed')} sub={t('community.empty_feed_sub')} /> : null}
            {feed.items.map((p) => <PostCard key={p.id} p={p} slug={slug} staff={!!can?.manage} onChanged={feed.reload} />)}
            <MoreButton list={feed} />
          </>
        ) : null}
      </View>
      {can?.read ? <MembersSheet visible={members} onClose={() => setMembers(false)} cm={d} staff={!!can.manage} owner={!!can.own} onChanged={cm.reload} /> : null}
      {can?.manage ? <ModerationQueue visible={reports} onClose={() => setReports(false)} community={slug} /> : null}
    </Screen>
  );
}
