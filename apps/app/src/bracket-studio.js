// Organiser tools for stages, inside the event console's Games tab (the one home for running an event's games): seeds and draw, publish, governed
// redraws, Swiss rounds, pools → knockout, repechage, conflicts from corrected results, schedule check and the audit trail. Every rule is enforced by
// the API; this screen only asks and shows. Results are still entered in the match centre / score sheet, never here.
import React, { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, Share, View } from 'react-native';
import { api, API } from './api';
import { useLoad } from './hooks';
import { useSession } from './session';
import { A, ABtn, ACard, AChip, AEmpty, ASection, AT, ATag, ReasonSheet } from './arena';
import { Field, Sheet, T } from './ui';
import { AStepperLite } from './bracket-bits';
import { StageBoard } from './bracket-board';
import { locale } from './locale';

const KIND = { round_robin: 'round_robin', knockout: 'knockout', double_elimination: 'double_elimination', swiss: 'swiss', pools: 'pools' };

/** Seeds & draw: reorder the field (touch-sized ▲ ▼), see conflicts as you go, shuffle with the top seeds protected. */
export function SeedSheet({ visible, onClose, eventId, format, teams, start, published, poolCount, title, confirmLabel, onApply }) {
  const { toast } = useSession();
  const [order, setOrder] = useState([]);
  const [check, setCheck] = useState(null);
  const [protect, setProtect] = useState(2);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setOrder(start?.length ? start : teams.map((t) => t.team_id)); setReason(''); setCheck(null); } }, [visible]);
  useEffect(() => {
    if (!visible || order.length < 2) return undefined;
    let off = false;
    api.post(`/events/${eventId}/seed-check`, { format: KIND[format] ?? 'knockout', order, pool_count: poolCount }).then((r) => { if (!off) setCheck(r); }).catch(() => {});
    return () => { off = true; };
  }, [visible, order.join(','), format]);
  const by = new Map(teams.map((t) => [t.team_id, t]));
  const move = (i, d) => { const o = order.slice(); const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; setOrder(o); };
  const top = (i) => { const o = order.slice(); const [x] = o.splice(i, 1); o.unshift(x); setOrder(o); };
  const needReason = published && reason.trim().length < 5;
  return (
    <Sheet visible={visible} onClose={onClose} title={title ?? 'Seeds & draw'}>
      <T size={13} color="#475569">Best seed first. The draw is built from this order; check the warnings, then continue.</T>
      <View accessibilityRole="list" style={{ gap: 6 }}>
        {order.map((id, i) => {
          const t = by.get(id);
          return (
            <View key={id} accessibilityRole="listitem" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' }}>
              <T weight="900" style={{ width: 28 }}>{i + 1}</T>
              <View style={{ flex: 1 }}><T weight="700" numberOfLines={1}>{t?.name ?? id}</T>{t?.city ? <T size={11.5} color="#64748B">{t.city}</T> : null}</View>
              <Pressable onPress={() => top(i)} accessibilityRole="button" accessibilityLabel={`Move ${t?.name} to the top`} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><T size={15}>⤒</T></Pressable>
              <Pressable onPress={() => move(i, -1)} disabled={i === 0} accessibilityRole="button" accessibilityLabel={`Move ${t?.name} up`} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: i === 0 ? 0.3 : 1 }}><T size={18}>▲</T></Pressable>
              <Pressable onPress={() => move(i, 1)} disabled={i === order.length - 1} accessibilityRole="button" accessibilityLabel={`Move ${t?.name} down`} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: i === order.length - 1 ? 0.3 : 1 }}><T size={18}>▼</T></Pressable>
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <AStepperLite label="Keep top seeds in place" value={protect} onChange={setProtect} min={0} max={Math.max(0, order.length - 2)} />
        <ABtn small tone="ghost" title="🎲 Shuffle the rest" onPress={() => onApply({ mode: 'random', protect_top: protect }, reason, true)} />
        <ABtn small tone="ghost" title="Reset to ratings" onPress={() => setOrder(teams.map((t) => t.team_id))} />
      </View>
      {check?.first_round?.length && ['knockout', 'double_elimination'].includes(format) ? (
        <View style={{ gap: 4 }} accessibilityLabel="First round">
          <T size={12} weight="800" color="#64748B">FIRST ROUND</T>
          {check.first_round.map((p, i) => <T key={i} size={13}>{by.get(p.home)?.name ?? 'Bye'}  vs  {by.get(p.away)?.name ?? 'Bye'}</T>)}
        </View>
      ) : null}
      {check?.errors?.map((e) => <T key={e.code} color="#B91C1C" weight="700">⛔ {e.message}</T>)}
      {check?.warnings?.map((w, i) => <T key={i} size={13} color="#92400E">⚠️ {w.message}</T>)}
      {check && !check.errors.length && !check.warnings.length ? <T size={13} color="#047857">✓ No conflicts in this seeding.</T> : null}
      {published ? <Field label="Why is the draw changing? (kept in the audit trail)" value={reason} onChangeText={setReason} multiline /> : null}
      <ABtn title={confirmLabel ?? 'Use this order'} loading={busy} disabled={needReason || !!check?.errors?.length} onPress={async () => { setBusy(true); try { await onApply({ mode: 'manual', order }, reason, false); } catch (x) { toast('' + x.message); } finally { setBusy(false); } }} />
    </Sheet>
  );
}

function Lines({ title, items, render, tone }) {
  if (!items?.length) return null;
  return <View style={{ gap: 4 }}><AT size={12} weight="900" color={tone ?? A.mute}>{title}</AT>{items.map((x, i) => <View key={i}>{render(x)}</View>)}</View>;
}

function CheckSheet({ visible, onClose, eventId, stage }) {
  const r = useLoad(() => (visible ? api.get(`/events/${eventId}/stages/${stage.id}/schedule-check`) : Promise.resolve(null)), [visible, stage?.id]);
  return (
    <Sheet visible={visible} onClose={onClose} title="Schedule check">
      {r.loading || !r.data ? <T color="#475569">Checking…</T> : r.data.ok ? <T color="#047857" weight="700">✓ No clashes in {r.data.checked} games: no team, court or official is double-booked, rest is respected and every game follows the games that feed it.</T> : r.data.conflicts.map((c, i) => <T key={i} color="#B91C1C" weight="600">⛔ {c.message}</T>)}
    </Sheet>
  );
}

function AuditSheet({ visible, onClose, eventId, stage }) {
  const r = useLoad(() => (visible ? api.get(`/events/${eventId}/stages/${stage.id}/revisions`) : Promise.resolve([])), [visible, stage?.id]);
  const label = { generated: 'Draw created', published: 'Published', seed_edit: 'Seeds edited', redraw: 'Redrawn', round_generated: 'Round paired', stage_generated: 'Knockout created', repechage_generated: 'Repechage created', correction: 'Correction', conflict_resolved: 'Conflict decided', format_revision: 'Format revised' };
  return (
    <Sheet visible={visible} onClose={onClose} title="Draw history">
      <T size={12.5} color="#475569">Every change to this stage, with who, why and the inputs needed to reproduce the draw.</T>
      {(r.data ?? []).map((x) => (
        <View key={x.id} style={{ gap: 2, borderTopWidth: 1, borderTopColor: '#E2E8F0', paddingTop: 8 }}>
          <T weight="800">v{x.version} · {label[x.kind] ?? x.kind}</T>
          <T size={12} color="#64748B">{new Date(x.created_at).toLocaleString(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}{x.actor_name ? ` · ${x.actor_name}` : ''}{x.algorithm ? ` · ${x.algorithm}` : ''}</T>
          {x.reason ? <T size={13}>“{x.reason}”</T> : null}
          {x.inputs?.draw_seed ? <T size={11.5} color="#64748B">Draw seed {x.inputs.draw_seed}</T> : null}
        </View>
      ))}
    </Sheet>
  );
}

/** Share, print, PDF and embed of the published bracket. Web opens the page; phones use the system share sheet. */
function ShareSheet({ visible, onClose, eventId }) {
  const origin = API.replace(/\/api\/v1$/, '') || (typeof location !== 'undefined' ? location.origin : '');
  const page = `${origin}/api/v1/share/bracket/${eventId}`;
  const snippet = `<iframe src="${page}/embed" title="Bracket" style="width:100%;min-height:520px;border:0" loading="lazy"></iframe>`;
  const open = (url) => Linking.openURL(url).catch(() => {});
  return (
    <Sheet visible={visible} onClose={onClose} title="Share, print or embed">
      <T size={13} color="#475569">These show the published stages only and update as official results come in. Private events cannot be shared or embedded.</T>
      <ABtn title="Share the bracket link" onPress={() => (Platform.OS === 'web' ? open(page) : Share.share({ message: page, url: page }))} />
      <ABtn tone="ghost" title="Print-ready page" onPress={() => open(page)} />
      <ABtn tone="ghost" title="Download as PDF" onPress={() => open(`${page}/pdf`)} />
      <T size={12.5} weight="800">Embed on your website</T>
      <T size={11.5} color="#475569" selectable>{snippet}</T>
      <T size={11.5} color="#64748B">Add ?theme=dark or ?theme=light to the embed address to match your site.</T>
    </Sheet>
  );
}

function Conflicts({ eventId, list, reload }) {
  const { toast } = useSession();
  const [ask, setAsk] = useState(null);
  if (!list?.length) return null;
  const resolve = async (action, reason) => { try { await api.post(`/bracket-conflicts/${ask.id}/resolve`, { action, reason }); toast(action === 'replay' ? 'Replacement game created' : 'Played game kept'); reload(); } catch (x) { toast('' + x.message); } };
  return (
    <ACard tone={A.red} style={{ gap: 8 }}>
      <AT size={16} weight="900">⚠️ {list.length} game{list.length === 1 ? '' : 's'} need{list.length === 1 ? 's' : ''} your decision</AT>
      <AT size={12.5} color={A.mute}>An earlier result was corrected after a later game was already played. Nothing was changed automatically.</AT>
      {list.map((c) => (
        <View key={c.id} style={{ gap: 6, backgroundColor: A.panel2, borderRadius: 14, padding: 10 }}>
          <AT size={14} weight="800">{c.fixture_round}</AT>
          <AT size={13} color={A.mute}>Played with <AT size={13} weight="800">{c.played_team ?? 'the earlier line-up'}</AT>; the corrected result puts <AT size={13} weight="800">{c.expected_team ?? 'a team still to be decided'}</AT> there.</AT>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <ABtn small tone="ghost" title="Keep the played game" onPress={() => setAsk({ ...c, action: 'keep_played' })} />
            <ABtn small tone="live" title="Replay it" onPress={() => setAsk({ ...c, action: 'replay' })} />
          </View>
        </View>
      ))}
      <ReasonSheet visible={!!ask} onClose={() => setAsk(null)} title={ask?.action === 'replay' ? 'Replay this game' : 'Keep the played game'}
        sub={ask?.action === 'replay' ? 'The played game stays in the history as superseded. A new game with the corrected line-up takes its court and time. Officials must be assigned again.' : 'The result stands as played. Your reason is kept in the audit trail.'}
        presets={ask?.action === 'replay' ? ['Protest upheld', 'Wrong team advanced', 'Scoring error'] : ['Result stands', 'Protest rejected', 'Both teams agreed']} confirmLabel={ask?.action === 'replay' ? 'Create replacement' : 'Keep it'} tone={ask?.action === 'replay' ? 'live' : 'lime'}
        onConfirm={(reason) => resolve(ask.action, reason)} />
    </ACard>
  );
}

/** Change the format of a stage whose games have not started (bronze game, grand-final reset): a recorded format revision, with a reason once published. */
export function FormatSheet({ visible, onClose, eventId, stage, onDone }) {
  const { toast } = useSession();
  const [third, setThird] = useState(false), [reset, setReset] = useState(false), [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
  const f = stage?.format ?? {};
  const dbl = stage?.kind === 'double_elimination', ko = stage?.kind === 'knockout';
  useEffect(() => { if (visible) { setThird(!!f.third_place); setReset(!!f.reset); setReason(''); } }, [visible]);
  const published = !!stage?.published_at;
  const need = published && reason.trim().length < 5;
  const apply = async () => {
    setBusy(true);
    try {
      await api.post(`/events/${eventId}/stages/${stage.id}/redraw`, { mode: 'seeds', reason: reason.trim() || undefined, ...(ko ? { third_place: third } : {}), ...(dbl ? { format_config: { reset } } : {}) });
      toast('Format revised: the old games are kept as history'); onDone?.(); onClose();
    } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Change the format">
      <T size={13} color="#475569">Only possible before any game has started. The stage is redrawn from the current seeds and the change is kept in the history.</T>
      {ko ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><AChip label="Third-place game" active={third} onPress={() => setThird(!third)} /></View> : null}
      {dbl ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><AChip label="Grand-final reset game" active={reset} onPress={() => setReset(!reset)} /></View> : null}
      {published ? <Field label="Why is the format changing? (kept in the audit trail)" value={reason} onChangeText={setReason} multiline /> : null}
      <ABtn title="Revise the format" loading={busy} disabled={need} onPress={apply} />
    </Sheet>
  );
}

/** All stages of the event with the organiser's actions. */
export function StageDesk({ id, accepted, openGame, reload: reloadAll }) {
  const { toast } = useSession();
  const st = useLoad(() => api.get(`/events/${id}/stages`), [id]);
  const cf = useLoad(() => api.get(`/events/${id}/bracket-conflicts?status=open`), [id]);
  const [seeds, setSeeds] = useState(null), [fmt, setFmt] = useState(null), [check, setCheck] = useState(null), [audit, setAudit] = useState(null), [busy, setBusy] = useState(null), [share, setShare] = useState(false);
  const refresh = () => { st.reload(); cf.reload(); reloadAll?.(); };
  const teams = accepted.map((a) => ({ team_id: a.team_id, name: a.name, city: a.city }));
  const act = async (key, fn, ok) => { setBusy(key); try { const r = await fn(); toast(typeof ok === 'function' ? ok(r) : ok); refresh(); return r; } catch (x) { toast('' + x.message); return null; } finally { setBusy(null); } };
  if (st.loading && !st.data) return <T color={A.mute}>Loading stages…</T>;
  const stages = st.data ?? [];
  if (!stages.length) return <AEmpty emoji="🏆" title="No stage yet" sub="Plan a group stage, knockout, double elimination, Swiss or pools below. Seeds and the draw stay editable until you publish." />;
  return (
    <View style={{ gap: 14 }}>
      <Conflicts eventId={id} list={cf.data} reload={refresh} />
      {stages.map((s) => {
        const n = s.sections?.flatMap((x) => x.rounds.flatMap((r) => r.games)) ?? [];
        const semisDone = s.kind === 'knockout' && s.sections?.[0]?.rounds.find((r) => r.key === 'semi')?.games.every((g) => g.state === 'final');
        const hasRepechage = s.sections?.some((x) => x.key === 'repechage');
        return (
          <StageBoard key={s.id} stage={s} onGame={openGame}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {s.status === 'draft' ? <ABtn small tone="lime" title="Publish" loading={busy === `p${s.id}`} onPress={() => act(`p${s.id}`, () => api.post(`/events/${id}/stages/${s.id}/publish`), 'Published: spectators can see it now')} /> : null}
              {['round_robin', 'knockout', 'double_elimination', 'pools'].includes(s.kind) && !s.locked && s.status !== 'completed' ? <ABtn small tone="ghost" title={s.status === 'draft' ? 'Seeds & draw' : 'Redraw'} onPress={() => setSeeds(s)} /> : null}
              {s.swiss && s.next_round_ready ? <ABtn small tone="hero" title={`Pair round ${s.swiss.rounds_generated + 1}`} loading={busy === `r${s.id}`} onPress={() => act(`r${s.id}`, () => api.post(`/events/${id}/stages/${s.id}/next-round`), (r) => `Round ${r.round} paired${r.bye ? ` · bye: ${teams.find((t) => t.team_id === r.bye.team)?.name ?? ''}` : ''}`)} /> : null}
              {s.kind === 'pools' && s.pools_complete && !s.child_stage_id ? <ABtn small tone="hero" title="Create the knockout" loading={busy === `k${s.id}`} onPress={() => act(`k${s.id}`, () => api.post(`/events/${id}/stages/${s.id}/advance`, { third_place: !!s.format?.pools?.third_place, publish: true }), (r) => `Knockout created · ${r.created} games`)} /> : null}
              {s.format?.repechage_template && semisDone && !hasRepechage ? <ABtn small tone="hero" title="Generate repechage" loading={busy === `x${s.id}`} onPress={() => act(`x${s.id}`, () => api.post(`/events/${id}/stages/${s.id}/repechage`, {}), (r) => `Repechage created · ${r.created} games`)} /> : null}
              {['knockout', 'double_elimination'].includes(s.kind) && !s.locked && s.status !== 'completed' ? <ABtn small tone="ghost" title="Change format" onPress={() => setFmt(s)} /> : null}
              <ABtn small tone="ghost" title="Check schedule" onPress={() => setCheck(s)} />
              <ABtn small tone="ghost" title="History" onPress={() => setAudit(s)} />
              {s.status !== 'draft' ? <ABtn small tone="ghost" title="Share · print · embed" onPress={() => setShare(true)} /> : null}
            </View>
            {s.status !== 'draft' && n.length && s.locked ? <AT size={11.5} color={A.mute}>Games have started: the draw is locked. Corrections keep history.</AT> : null}
          </StageBoard>
        );
      })}
      <SeedSheet visible={!!seeds} onClose={() => setSeeds(null)} eventId={id} format={seeds?.kind} teams={teams} start={seeds ? stages.find((x) => x.id === seeds.id)?.field : null} published={!!seeds?.published_at}
        poolCount={seeds?.format?.pools?.pool_count} title={seeds?.status === 'draft' ? 'Seeds & draw' : 'Redraw this stage'} confirmLabel={seeds?.status === 'draft' ? 'Apply new order' : 'Redraw with this order'}
        onApply={async (body, reason) => { await api.post(`/events/${id}/stages/${seeds.id}/redraw`, { ...body, reason: reason || undefined }); toast(seeds.status === 'draft' ? 'Draw updated' : 'Redrawn: the old games are kept as history'); setSeeds(null); refresh(); }} />
      {fmt ? <FormatSheet visible eventId={id} stage={fmt} onClose={() => setFmt(null)} onDone={refresh} /> : null}
      <ShareSheet visible={share} onClose={() => setShare(false)} eventId={id} />
      {check ? <CheckSheet visible onClose={() => setCheck(null)} eventId={id} stage={check} /> : null}
      {audit ? <AuditSheet visible onClose={() => setAudit(null)} eventId={id} stage={audit} /> : null}
    </View>
  );
}

/** What a spectator, player or non-organiser reads: the published stages, list first on a phone. */
export function StagesView({ id, openGame }) {
  const st = useLoad(() => api.get(`/events/${id}/stages`), [id]);
  if (st.loading && !st.data) return <T color={A.mute}>Loading…</T>;
  if (!st.data?.length) return <AEmpty emoji="🏆" title="No bracket yet" sub="The organiser publishes the draw here. Rounds fill in as results are made official." />;
  return <View style={{ gap: 14 }}>{st.data.map((s) => <StageBoard key={s.id} stage={s} onGame={openGame} />)}</View>;
}
