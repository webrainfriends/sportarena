// The score sheet: referee fixes the totals and submits, both team managers sign (or dispute), the organiser approves or sends it
// back, and publishing makes it the official result. Every role sees only the buttons that are theirs.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { A, ABtn, ACard, AChip, AEmpty, AHero, AScreen, AStepper, ASection, AT, AG, ReasonSheet } from '../arena';
import { ErrorBox, Field, Loading } from '../ui';

const TONE = { draft: AG.neon, submitted: AG.sun, approved: AG.lime, rejected: AG.live, published: ['#10B981', '#34D399'], superseded: ['#3B2F7A', '#2A2160'] };
const KNOCKOUT = ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final', 'third_place'];
const ROLE = { referee: 'Officials', home_manager: 'Home team', away_manager: 'Away team' };
const SEV = { error: ['⛔', A.red], warn: ['⚠️', A.sun], info: ['ℹ️', A.cyan] };

export function ScoreSheet({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const sheet = useLoad(() => api.get(`/fixtures/${id}/score-sheet`).catch((e) => (e.status === 404 ? null : Promise.reject(e))), [id]);
  const live = useLoad(() => api.get(`/fixtures/${id}/live`), [id]);
  const [edit, setEdit] = useState(null);       // { home, away, winner, notes, reason }
  const [ask, setAsk] = useState(null);         // 'reject' | 'waive' | 'dispute' | 'revise'
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const reload = () => { sheet.reload(); live.reload(); };
  if (sheet.error) return <AScreen><ErrorBox error={sheet.error} onRetry={sheet.reload} /></AScreen>;
  if (live.error) return <AScreen><ErrorBox error={live.error} onRetry={live.reload} /></AScreen>;
  if (sheet.loading || live.loading || !live.data) return <AScreen><Loading /></AScreen>;
  const g = live.data, v = g.viewer ?? {}, f = g.fixture;
  const run = async (fn, ok) => { setBusy(true); try { const r = await fn(); if (ok) toast(ok); reload(); return r; } catch (x) { toast('' + x.message + (x.details?.anomalies ? ` (${x.details.anomalies.map((a) => a.message).join('; ')})` : '')); return null; } finally { setBusy(false); } };

  const s = sheet.data;
  if (!s) {
    return (
      <AScreen>
        <AHero kicker="Score sheet" title={`${f.home?.name ?? 'Home'} vs ${f.away?.name ?? 'Away'}`} sub="No sheet yet." emoji="📝" />
        {v.can_score && ['scheduled', 'finished', 'completed'].includes(f.status)
          ? <ABtn title="Open a score sheet" tone="neon" loading={busy} onPress={() => run(() => api.post(`/fixtures/${id}/score-sheet`), 'Sheet opened')} />
          : <AEmpty emoji="⏳" title="Not at full time yet" sub="The sheet opens when the match ends." />}
      </AScreen>
    );
  }

  const editable = v.can_score && ['draft', 'rejected'].includes(s.status);
  const e = edit ?? { home: s.home_score, away: s.away_score, winner: s.winner_team_id, notes: s.notes ?? '', reason: s.adjusted_reason ?? '' };
  const set = (patch) => setEdit({ ...e, ...patch });
  const level = e.home != null && e.home === e.away;
  const needsWinner = KNOCKOUT.includes(s.fixture.round_kind) || g.ruleset.draw_allowed === false; // a league draw is just a draw
  const home = s.fixture.home_id, away = s.fixture.away_id;
  const signed = (role) => s.signoffs.find((x) => x.role === role);
  const myRoles = v.manages === 'both' ? ['home_manager', 'away_manager'] : v.manages ? [`${v.manages}_manager`] : [];
  const canSign = s.status === 'submitted' && myRoles.length && myRoles.some((r) => !signed(r));
  const save = () => run(() => api.patch(`/score-sheets/${s.id}`, { home_score: e.home ?? undefined, away_score: e.away ?? undefined, winner_team_id: level ? e.winner ?? undefined : undefined, notes: e.notes || undefined, adjusted_reason: e.reason || undefined }).then((r) => { setEdit(null); return r; }), 'Saved');

  return (
    <AScreen>
      <AHero kicker={`Score sheet · v${s.version}${s.round > 1 ? ` · round ${s.round}` : ''}`} title={`${s.fixture.home_name ?? 'Home'} vs ${s.fixture.away_name ?? 'Away'}`} sub={{ draft: 'Being prepared', submitted: 'Waiting for sign-off', approved: 'Approved, ready to publish', rejected: 'Sent back for changes', published: 'Official result' }[s.status] ?? s.status} tone={TONE[s.status] ?? AG.hero} emoji={s.status === 'published' ? '🏆' : '📝'} />

      <ACard>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {editable
            ? <><AStepper label={s.fixture.home_name ?? 'Home'} value={e.home} onChange={(x) => set({ home: x })} color={A.magenta} /><AT size={28} weight="900" color={A.mute}>:</AT><AStepper label={s.fixture.away_name ?? 'Away'} value={e.away} onChange={(x) => set({ away: x })} color={A.cyan} /></>
            : <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 16 }}><AT size={54} weight="900" num>{s.home_score ?? '–'}</AT><AT size={28} weight="900" color={A.mute}>:</AT><AT size={54} weight="900" num>{s.away_score ?? '–'}</AT></View>}
        </View>
        {g.ruleset.kind === 'sets' ? <AT size={11.5} color={A.mute} style={{ textAlign: 'center', marginTop: 8 }}>Scores are sets won (best of {g.ruleset.sets.best_of})</AT> : null}
        {needsWinner && (editable ? level : s.home_score != null && s.home_score === s.away_score) ? (
          <View style={{ marginTop: 14, gap: 8 }}>
            <AT size={12} weight="800" color={A.mute}>LEVEL AFTER PLAY: WHO WON? (EXTRA TIME / PENALTIES)</AT>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {[[home, s.fixture.home_name], [away, s.fixture.away_name]].map(([tid, name]) => <AChip key={tid} label={name} active={(editable ? e.winner : s.winner_team_id) === tid} onPress={editable ? () => set({ winner: tid }) : undefined} />)}
              
            </View>
          </View>
        ) : null}
      </ACard>

      {s.totals?.sets?.length ? <ACard><AT size={12} weight="800" color={A.mute}>SETS</AT><AT size={16} weight="800" num style={{ marginTop: 6 }}>{s.totals.sets.map((x) => `${x.home}–${x.away}`).join('   ')}</AT></ACard> : null}
      {s.totals?.periods?.length ? <ACard><AT size={12} weight="800" color={A.mute}>BY PERIOD</AT>{s.totals.periods.map((p) => <AT key={p.period} size={14} weight="700" num style={{ marginTop: 4 }}>{p.period}: {p.home}–{p.away}</AT>)}</ACard> : null}

      {editable ? (
        <ACard style={{ gap: 12 }}>
          <Field label="Notes (optional)" value={e.notes} onChangeText={(x) => set({ notes: x })} multiline />
          {s.source === 'match_log' ? <Field label="Why does it differ from the match log? (only if you changed the score)" value={e.reason} onChangeText={(x) => set({ reason: x })} /> : null}
          <ABtn small tone="ghost" title="Save changes" onPress={save} loading={busy} disabled={!edit} />
        </ACard>
      ) : s.notes ? <ACard><AT size={12} weight="800" color={A.mute}>NOTES</AT><AT size={14} style={{ marginTop: 4 }}>{s.notes}</AT></ACard> : null}

      {s.anomalies?.length ? (
        <>
          <ASection title="Checks" sub="Run when the sheet is submitted" />
          {s.anomalies.map((a, i) => <ACard key={i} pad={12} tone={SEV[a.severity][1]}><AT size={13.5} weight="700">{SEV[a.severity][0]} {a.message}</AT></ACard>)}
        </>
      ) : null}

      <ASection title="Sign-off" sub="Officials and both teams" />
      <ACard style={{ gap: 10 }}>
        {['referee', 'home_manager', 'away_manager'].map((role) => {
          const x = signed(role);
          return (
            <View key={role} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <AT size={18}>{x ? (x.decision === 'signed' ? '✅' : '⚠️') : '⏳'}</AT>
              <View style={{ flex: 1 }}><AT size={14} weight="800">{ROLE[role]}</AT>{x ? <AT size={12} color={A.mute}>{x.decision === 'signed' ? 'Signed' : 'Disputed'} by {x.display_name}{x.comment ? `: ${x.comment}` : ''}</AT> : <AT size={12} color={A.mute}>Waiting</AT>}</View>
            </View>
          );
        })}
        {s.waived_reason ? <AT size={12} color={A.sun}>Approved without every sign-off: {s.waived_reason}</AT> : null}
        {s.rejected_reason && s.status === 'rejected' ? <AT size={13} weight="700" color={A.red}>Sent back: {s.rejected_reason}</AT> : null}
      </ACard>

      <View style={{ gap: 10 }}>
        {editable ? <ABtn title="Submit for sign-off" tone="hero" loading={busy} onPress={async () => { if (edit) { const ok = await save(); if (!ok) return; } run(() => api.post(`/score-sheets/${s.id}/submit`), 'Submitted'); }} /> : null}
        {canSign ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <ABtn title="✍️ Sign" tone="lime" style={{ flex: 1 }} loading={busy} onPress={() => run(() => api.post(`/score-sheets/${s.id}/sign`, { decision: 'signed' }), 'Signed')} />
            <ABtn title="Dispute" tone="ghost" style={{ flex: 1 }} onPress={() => setAsk('dispute')} />
          </View>
        ) : null}
        {v.organiser && s.status === 'submitted' ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <ABtn title="Approve" tone="lime" style={{ flex: 1 }} loading={busy} onPress={() => (s.pending_signoffs.length || s.disputes.length ? setAsk('waive') : run(() => api.post(`/score-sheets/${s.id}/approve`), 'Approved'))} />
            <ABtn title="Send back" tone="ghost" style={{ flex: 1 }} onPress={() => setAsk('reject')} />
          </View>
        ) : null}
        {v.organiser && s.status === 'approved' ? (
          <>
            <ABtn title="🚀 Publish official result" tone="hero" loading={busy} onPress={() => run(() => api.post(`/score-sheets/${s.id}/publish`), 'Published')} />
            <ABtn title="Send back" tone="ghost" small onPress={() => setAsk('reject')} />
          </>
        ) : null}
        {v.organiser && s.status === 'published' ? <ABtn title="Correct this result" tone="ghost" small onPress={() => setAsk('revise')} /> : null}
        {(v.can_score || v.organiser) ? <ABtn title="🤖 AI review" tone="neon" small loading={busy} onPress={async () => { const r = await run(() => api.post(`/score-sheets/${s.id}/ai/review`)); if (r) setReview(r); }} /> : null}
        {s.status === 'published' ? <ABtn title="See event results" tone="neon" small onPress={() => push('EventResults', { id: f.event_id })} /> : null}
      </View>

      {review ? (
        <ACard tone={A.cyan} style={{ gap: 8 }}>
          <AT size={12} weight="800" color={A.cyan}>{review.ai ? 'AI REVIEW' : 'REVIEW (BUILT-IN RULES)'}</AT>
          <AT size={14} weight="600" style={{ lineHeight: 20 }}>{review.summary}</AT>
          {review.concerns?.map((c, i) => <AT key={i} size={13}>{SEV[c.severity]?.[0]} {c.text}</AT>)}
          {review.questions?.length ? <AT size={12} weight="800" color={A.mute} style={{ marginTop: 4 }}>QUESTIONS FOR THE REFEREE</AT> : null}
          {review.questions?.map((q, i) => <AT key={i} size={13}>• {q}</AT>)}
        </ACard>
      ) : null}

      <ASection title="History" />
      <View style={{ gap: 6 }}>
        {s.history.map((h, i) => <AT key={i} size={12.5} color={A.mute}>{new Date(h.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · {h.actor_name} · <AT size={12.5} weight="800" color={A.ink}>{h.action}</AT>{h.note ? ` · ${h.note}` : ''}</AT>)}
      </View>

      <ReasonSheet visible={ask === 'dispute'} onClose={() => setAsk(null)} title="Dispute this sheet" sub="Tell the organiser what is wrong." presets={['Wrong score', 'A goal is missing', 'A goal should not count', 'Wrong winner']} confirmLabel="Send dispute" tone="sun"
        onConfirm={(comment) => run(() => api.post(`/score-sheets/${s.id}/sign`, { decision: 'disputed', comment }), 'Dispute sent')} />
      <ReasonSheet visible={ask === 'reject'} onClose={() => setAsk(null)} title="Send back to the referee" presets={['Check the second half', 'Score does not match the log', 'Winner not named', 'Missing sign-off']} confirmLabel="Send back" tone="live"
        onConfirm={(reason) => run(() => api.post(`/score-sheets/${s.id}/reject`, { reason }), 'Sent back')} />
      <ReasonSheet visible={ask === 'waive'} onClose={() => setAsk(null)} title="Approve without every sign-off" sub={`${s.pending_signoffs.length ? `Still to sign: ${s.pending_signoffs.map((r) => ROLE[r]).join(', ')}. ` : ''}${s.disputes.length ? 'There is an open dispute. ' : ''}Your reason is kept on the sheet.`} presets={['Team manager unreachable', 'Dispute resolved on site', 'Referee confirmed']} confirmLabel="Approve anyway" tone="lime"
        onConfirm={(waived_reason) => run(() => api.post(`/score-sheets/${s.id}/approve`, { waived_reason }), 'Approved')} />
      <ReasonSheet visible={ask === 'revise'} onClose={() => setAsk(null)} title="Correct a published result" sub="A new version is opened. The published result stays official until the correction is approved and published." presets={['Scored for the wrong team', 'Protest upheld', 'Scorer error']} confirmLabel="Open correction" tone="sun"
        onConfirm={(reason) => run(() => api.post(`/fixtures/${id}/score-sheet/revise`, { reason }), 'Correction opened')} />
    </AScreen>
  );
}
