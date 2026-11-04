// Academy → Scouting (#790): campaigns, the prospect pipeline (Talent CRM entries linked to a campaign), the committee file and vote,
// the invitation into the existing admissions flow, and recruitment outcomes. One screen for owners/admins, committee members and scouts: the
// server decides what each person may see and do, the screen only hides what a role cannot use.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { explain } from '../access';
import { useLayout } from '../layout';
import { t } from '../i18n';
import { Bars, Block, Fact, FunnelBars, Initials, Kpi, Split, saveCsv, when } from './academy-ui';
import { CampaignWizard } from './academy-scouting-wizard';

const COLUMNS = [['prospect', ['prospect', 'evaluated']], ['committee', ['committee']], ['decided', ['decided']], ['invited', ['invited']], ['applied', ['applied', 'enrolled']]];
const TONE = { active: c.limeSoft, paused: c.sunSoft, closed: c.violetSoft, draft: c.pinkSoft, archived: c.violetSoft };
const VOTE_TONE = { advance: c.limeSoft, hold: c.sunSoft, decline: c.redSoft };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

export function Scouting({ o, role, archived, toast, onOpenApplication, focus }) {
  const staff = role === 'owner' || role === 'admin';
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/scouting/campaigns`, { limit: 100 }), [o.id]);
  const [sel, setSel] = useState(focus?.campaign ?? null);
  const [wizard, setWizard] = useState(null);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const all = list.data;
  const current = all.find((x) => x.id === sel) ?? all.find((x) => x.status === 'active') ?? all[0] ?? null;
  const done = () => { setWizard(null); list.reload(); };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <View style={{ flex: 1, minWidth: 220 }}>
          {all.length ? <MenuField label={t('scout.pick')} value={current?.id} onChange={setSel} options={all.map((x) => ({ value: x.id, label: x.name, sub: t(`scout.status.${x.status}`) }))} /> : null}
        </View>
        {staff && !archived ? <Btn small title={['＋', t('scout.new')].join(' ')} onPress={() => setWizard({ camp: null, step: 0 })} /> : null}
      </View>
      {!all.length ? (
        <Empty emoji="🔭" title={t('scout.none.title')} sub={staff ? t('scout.none.sub') : t('scout.none.sub_member')} />
      ) : current ? <CampaignView key={current.id} o={o} summary={current} staff={staff && current.can_manage} archived={archived} toast={toast} reload={list.reload} onOpenApplication={onOpenApplication}
        onEdit={(step) => api.get(`/academy/scouting/campaigns/${current.id}`).then((full) => setWizard({ camp: full, step })).catch((e) => toast(explain(e)))} /> : null}
      {wizard ? <CampaignWizard o={o} campaign={wizard.camp} startStep={wizard.step} toast={toast} onClose={done} onDone={done} /> : null}
    </View>
  );
}

function CampaignView({ o, summary, staff, archived, toast, reload, onEdit, onOpenApplication }) {
  const [tab, setTab] = useState('board');
  const full = useLoad(() => api.get(`/academy/scouting/campaigns/${summary.id}`), [summary.id, summary.row_version, summary.status]);
  const status = async (to) => { try { await api.post(`/academy/scouting/campaigns/${summary.id}/status`, { row_version: full.data.row_version, status: to }); reload(); full.reload(); } catch (e) { toast(explain(e)); } };
  const resume = async () => { try { await api.post(`/academy/scouting/campaigns/${summary.id}/launch`, { row_version: full.data.row_version }); reload(); full.reload(); } catch (e) { toast(explain(e)); } };
  const cp = full.data ?? summary, n = summary.counts;
  const target = cp.target_places ?? 0;
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <T weight="800" size={18} style={{ flex: 1 }}>{cp.name}</T>
          <Tag label={t(`scout.status.${cp.status}`)} color={TONE[cp.status]} />
          {cp.reaches_minors ? <Tag label={t('scout.minor_band')} /> : null}
        </View>
        <T size={13} color={c.mute}>{t(`scout.objective.${cp.objective}`)}{cp.starts_on ? ` · ${t('scout.window', { from: when(cp.starts_on), to: when(cp.ends_on) })}` : ''}{cp.decision_by ? ` · ${t('scout.decision_by', { d: when(cp.decision_by) })}` : ''}</T>
        {staff && !archived ? (
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {cp.status === 'draft' ? <Btn small title={t('scout.continue')} onPress={() => onEdit(Math.max(0, (cp.step_reached ?? 1) - 1))} /> : <Btn small title={t('scout.edit_brief')} color={c.paper} ink={c.ink} onPress={() => onEdit(0)} />}
            {cp.status === 'active' ? <Btn small title={t('scout.pause')} color={c.paper} ink={c.ink} onPress={() => status('paused')} /> : null}
            {cp.status === 'paused' ? <Btn small title={t('scout.resume')} onPress={resume} /> : null}
            {['active', 'paused'].includes(cp.status) ? <Btn small title={t('scout.close')} color={c.paper} ink={c.ink} onPress={() => status('closed')} /> : null}
          </View>
        ) : null}
      </Card>
      {cp.status === 'draft' ? <Card color={c.pinkSoft}><T size={13}>{t('scout.draft.banner')}</T>{full.data?.readiness?.blockers?.length ? <T size={12} color={c.mute}>{t('scout.draft.blocks', { n: full.data.readiness.blockers.length })}</T> : null}</Card> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Kpi label={t('scout.kpi.prospects')} value={n.prospects} sub={cp.pipeline_target ? t('scout.kpi.of_pipeline', { n: cp.pipeline_target }) : undefined} />
        <Kpi label={t('scout.kpi.committee')} value={n.in_committee} sub={t('scout.kpi.awaiting')} tone={n.in_committee ? 'alert' : undefined} />
        <Kpi label={t('scout.kpi.invited')} value={n.invited} sub={t('scout.kpi.invited_sub')} />
        <Kpi label={t('scout.kpi.enrolled')} value={n.enrolled} sub={target ? t('scout.kpi.of_places', { n: target }) : undefined} />
      </View>
      <Seg value={tab} onChange={setTab} color={c.violet} options={[{ value: 'board', label: t('scout.tab.board') }, { value: 'report', label: t('scout.tab.report') }, { value: 'brief', label: t('scout.tab.brief') }]} />
      {tab === 'board' ? <Board o={o} campaign={cp} staff={staff} toast={toast} reload={() => { reload(); full.reload(); }} onOpenApplication={onOpenApplication} /> : null}
      {tab === 'report' ? <Report o={o} campaign={cp} toast={toast} /> : null}
      {tab === 'brief' ? <Brief cp={full.data} /> : null}
    </View>
  );
}

// ------------------------------------------------------------------ pipeline board
function Board({ o, campaign, staff, toast, reload, onOpenApplication }) {
  const [open, setOpen] = useState(null);
  const [closed, setClosed] = useState(false);
  const { tablet } = useLayout();
  const rows = useLoad(() => api.get(`/academy/scouting/campaigns/${campaign.id}/prospects`, { limit: 100 }), [campaign.id, campaign.row_version]);
  if (rows.error) return <ErrorBox error={rows.error} onRetry={rows.reload} />;
  if (!rows.data) return <Loading />;
  const shown = rows.data.filter((p) => closed || !['declined', 'withdrawn'].includes(p.journey_stage));
  const body = !shown.length ? <Empty emoji="📥" title={t('scout.board.empty.title')} sub={t('scout.board.empty.sub')} /> : (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Chip label={closed ? t('scout.board.hide_closed') : t('scout.board.show_closed')} active={!closed} onPress={() => setClosed(!closed)} /></View>
      <ScrollView horizontal={tablet} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, flexDirection: tablet ? 'row' : 'column' }}>
        {COLUMNS.map(([key, stages]) => {
          const col = shown.filter((p) => stages.includes(p.journey_stage));
          return (
            <View key={key} style={{ width: tablet ? 250 : '100%', gap: 8 }}>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1, flex: 1 }}>{t(`scout.col.${key}`).toUpperCase()}</T><Tag label={String(col.length)} /></View>
              {col.length ? col.map((p) => <ProspectCard key={p.id} p={p} on={open === p.id} onOpen={() => setOpen(p.id)} campaign={campaign} />) : <T size={12} color={c.mute}>{t('scout.col.empty')}</T>}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
  return <Split open={!!open} onClose={() => setOpen(null)} detailTitle={t('scout.file.title')} list={body} detail={open ? <ProspectFile id={open} toast={toast} onChanged={() => { rows.reload(); reload(); }} onOpenApplication={onOpenApplication} /> : null} />;
}

function ProspectCard({ p, on, onOpen, campaign }) {
  const name = p.access_live && p.athlete ? p.athlete.display_name : t('scout.access.ended');
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${name}, ${t(`scout.stage.${p.journey_stage}`)}${p.region ? `, ${p.region}` : ''}`} style={{ backgroundColor: c.paper, borderRadius: 16, padding: 12, gap: 6, borderWidth: on ? 2 : 1, borderColor: on ? c.pink : c.line, minHeight: 44 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Initials name={name} user={p.athlete} size={34} />
        <View style={{ flex: 1 }}><T weight="800" size={14} numberOfLines={1}>{name}</T><T size={12} color={c.mute}>{[p.sport, p.region].filter(Boolean).join(' · ')}</T></View>
      </View>
      <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
        <Tag label={p.access_live ? t('scout.access.live') : t('scout.access.ended')} color={p.access_live ? c.limeSoft : c.redSoft} />
        {p.athlete?.is_youth ? <Tag label={t('scout.minor')} /> : null}
        {p.stage === 'committee' ? <Tag label={t('scout.votes', { n: p.votes_cast, q: campaign.committee_quorum })} color={c.sunSoft} /> : null}
        {p.shared_evaluations ? <Tag label={t('scout.eval_n', { n: p.shared_evaluations })} color={c.cyanSoft} /> : null}
        {p.referral_source ? <Tag label={p.referral_source} /> : null}
      </View>
    </Pressable>
  );
}

// ------------------------------------------------------------------ the prospect / committee file
function ProspectFile({ id, toast, onChanged, onOpenApplication }) {
  const d = useLoad(() => api.get(`/academy/scouting/prospects/${id}`), [id]);
  const [vote, setVote] = useState({ vote: 'advance', reason: '' });
  const [invite, setInvite] = useState(false);
  const [conflict, setConflict] = useState(false);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data, p = x.prospect;
  const run = async (fn, msg) => { try { await fn(); if (msg) toast(msg); d.reload(); onChanged(); } catch (e) { toast(explain(e)); } };
  if (x.redacted) return <View style={{ gap: 10 }}><Empty emoji="🔒" title={t('scout.file.redacted.title')} sub={t('scout.file.redacted.sub')} /><Log events={x.events} /></View>;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Initials name={p.athlete.display_name} user={p.athlete} size={44} />
        <View style={{ flex: 1 }}><T weight="800" size={16}>{p.athlete.display_name}</T><T size={12} color={c.mute}>{[p.sport, p.region, p.referral_source].filter(Boolean).join(' · ')}</T></View>
        <Tag label={t(`scout.stage.${p.journey_stage}`)} />
      </View>
      <Card color={c.limeSoft} pad={12}><T size={13} weight="700">🛡️ {x.consent.required ? t('scout.file.consent_youth') : t('scout.file.consent_adult')}</T><T size={12} color={c.mute}>{t('scout.file.consent_note')}</T></Card>

      <Block title={t('scout.file.evals')}>
        {x.evaluations.length ? x.evaluations.map((e) => (
          <Card key={e.id} pad={12}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <Tag label={t(`scout.basis.${e.basis}`)} /><Tag label={when(e.observed_on)} /><Tag label={t('scout.overall', { n: e.overall })} color={c.limeSoft} />{e.weighted != null ? <Tag label={t('scout.weighted', { n: e.weighted })} color={c.cyanSoft} /> : null}{e.round > 1 ? <Tag label={t('scout.round', { n: e.round })} /> : null}
            </View>
            <Bars label={t('scout.file.evals')} rows={Object.entries(e.ratings ?? {}).map(([k, v]) => ({ label: t(`scout.criterion.${k}`), value: v, text: `${v}/5`, tone: c.pink }))} />
            {e.notes ? <T size={13}>{e.notes}</T> : <T size={12} color={c.mute}>{e.notes_released ? t('scout.file.notes_empty') : t('scout.file.notes_private')}</T>}
          </Card>
        )) : <T size={13} color={c.mute}>{t('scout.file.no_evals')}</T>}
      </Block>

      <Block title={t('scout.file.videos')}>
        {x.videos.length ? x.videos.map((v) => <Fact key={v.id} k={t('scout.file.video')} v={`${v.title} · ${v.url}`} />) : <T size={13} color={c.mute}>{t('scout.file.no_videos')}</T>}
        <T size={11} color={c.mute}>{t('scout.file.video_note')}</T>
      </Block>

      <Block title={t('scout.file.votes')} right={<Tag label={t('scout.quorum', { n: x.tally.quorum, rule: t(`scout.rule.${x.tally.rule}`) })} />}>
        {x.votes.map((v) => (
          <View key={v.voter_id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 8, borderRadius: 12, backgroundColor: c.bg }}>
            <View style={{ flex: 1 }}><T weight="700" size={13}>{v.voter}</T>{v.reason ? <T size={12} color={c.mute}>{v.reason}</T> : null}</View><Tag label={t(`scout.vote.${v.vote}`)} color={VOTE_TONE[v.vote]} />
          </View>
        ))}
        {x.tally.pending.map((v) => <View key={v.user_id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 8, borderRadius: 12, backgroundColor: c.bg }}><T size={13} style={{ flex: 1 }}>{v.display_name}</T><Tag label={t('scout.vote.pending')} color={c.sunSoft} /></View>)}
        {x.can_vote ? (
          <View style={{ gap: 8 }}>
            <T weight="800" size={13}>{t('scout.vote.yours')}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{['advance', 'hold', 'decline'].map((v) => <Chip key={v} label={t(`scout.vote.${v}_long`)} active={vote.vote === v} onPress={() => setVote({ ...vote, vote: v })} />)}</View>
            <FormReason value={vote.reason} onChange={(r) => setVote({ ...vote, reason: r })} required={vote.vote === 'decline'} />
            <Btn title={t('scout.vote.cast')} disabled={vote.vote === 'decline' && !vote.reason.trim()} onPress={() => run(() => api.post(`/academy/scouting/prospects/${id}/votes`, { vote: vote.vote, reason: vote.reason.trim() || undefined }), t('scout.vote.cast_done'))} />
            {!x.conflict_declared ? <Btn small title={t('scout.conflict')} color={c.paper} ink={c.ink} onPress={() => setConflict(true)} style={{ alignSelf: 'flex-start' }} /> : <T size={12} color={c.mute}>{t('scout.conflict_declared')}</T>}
          </View>
        ) : null}
        {x.can_decide ? <Btn title={t('scout.decide_btn', { outcome: t(`scout.vote.${x.outcome_if_decided}`) })} onPress={() => run(() => api.post(`/academy/scouting/prospects/${id}/decision`, { row_version: p.row_version }), t('scout.decide_done'))} /> : x.prospect.stage === 'committee' ? <T size={12} color={c.mute}>{t('scout.decide_wait', { n: x.tally.quorum - x.tally.cast > 0 ? x.tally.quorum - x.tally.cast : 0 })}</T> : null}
      </Block>

      {x.can_invite ? (
        <Block title={t('scout.invite.title')}>
          <T size={12} color={c.mute}>{t('scout.invite.note')}</T>
          <Btn title={t('scout.invite.btn')} onPress={() => setInvite(true)} />
        </Block>
      ) : null}
      {x.application ? <Block title={t('scout.file.application')}><Fact k={t('scout.file.application_stage')} v={x.application.stage.replaceAll('_', ' ')} />{onOpenApplication ? <Btn small title={t('scout.source.open_application')} color={c.paper} ink={c.ink} onPress={() => onOpenApplication(x.application.id)} style={{ alignSelf: 'flex-start' }} /> : null}</Block> : null}
      <Log events={x.events} />
      {invite ? <FormSheet visible onClose={() => setInvite(false)} title={t('scout.invite.title')} submitLabel={t('scout.invite.btn')} initial={{ mode: 'trial', programme_id: x.campaign.programme_ids[0] }} fields={[
        { key: 'programme_id', label: t('scout.invite.programme'), type: 'chips', options: x.programmes.map((pr) => ({ value: pr.id, label: pr.title })) },
        { key: 'mode', label: t('scout.invite.mode'), type: 'chips', options: [{ value: 'trial', label: t('scout.invite.trial') }, { value: 'offer', label: t('scout.invite.offer') }], hint: t('scout.invite.note') }]}
        onSubmit={async (v) => { try { await api.post(`/academy/scouting/prospects/${id}/invite`, { row_version: p.row_version, programme_id: v.programme_id, mode: v.mode }); d.reload(); onChanged(); return t('scout.invite.done'); } catch (e) { throw new Error(explain(e)); } }} /> : null}
      {conflict ? <FormSheet visible onClose={() => setConflict(false)} title={t('scout.conflict')} submitLabel={t('common.save')} fields={[{ key: 'reason', label: t('scout.conflict_reason'), type: 'multiline' }]}
        onSubmit={async (v) => { try { await api.post(`/academy/scouting/prospects/${id}/conflict`, { reason: v.reason }); d.reload(); } catch (e) { throw new Error(explain(e)); } }} /> : null}
    </View>
  );
}

const FormReason = ({ value, onChange, required }) => <Field label={[t('scout.vote.reason'), required ? '*' : ''].join(' ').trim()} value={value} onChangeText={onChange} multiline minHeight={64} />;

function Log({ events }) {
  if (!events?.length) return null;
  return (
    <Block title={t('scout.file.log')}>
      {events.map((e, i) => <T key={i} size={12} color={c.mute}>{when(e.created_at)} · {t(`scout.event.${e.kind}`)}{e.to_stage ? ` → ${t(`scout.stage.${e.to_stage}`)}` : ''}{e.note ? ` · ${e.note}` : ''}</T>)}
    </Block>
  );
}

// ------------------------------------------------------------------ outcomes
function Report({ o, campaign, toast }) {
  const rep = useLoad(() => api.get(`/organisations/${o.id}/academy/scouting/report`, { campaign_id: campaign.id }), [o.id, campaign.id]);
  if (rep.error) return <ErrorBox error={rep.error} onRetry={rep.reload} />;
  if (!rep.data) return <Loading />;
  const r = rep.data, f = r.funnel;
  const steps = [['prospects', f.prospects], ['committee', f.committee], ['advanced', f.advanced], ['invited', f.invited], ['applied', f.applied], ['enrolled', f.enrolled]].map(([k, v], i, a) => ({ label: t(`scout.rep.step.${k}`), value: v, rate: i ? pct(v, a[i - 1][1]) : null }));
  const download = async () => { try { const x = await api.get(`/organisations/${o.id}/academy/scouting/report/export`, { campaign_id: campaign.id }); await saveCsv(x.filename, x.csv); } catch (e) { toast(explain(e)); } };
  const m = r.median_days;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Kpi label={t('scout.rep.conv')} value={r.conversion.prospect_to_enrolled == null ? '–' : `${r.conversion.prospect_to_enrolled}%`} sub={t('scout.rep.conv_sub')} />
        <Kpi label={t('scout.rep.invite_conv')} value={r.conversion.invited_to_enrolled == null ? '–' : `${r.conversion.invited_to_enrolled}%`} sub={t('scout.rep.invite_conv_sub')} />
      </View>
      <Card><Block title={t('scout.rep.funnel')} right={<Btn small title={t('scout.rep.csv')} color={c.paper} ink={c.ink} onPress={download} />}>
        <FunnelBars steps={steps} />
        <T size={12} color={c.mute}>{t('scout.rep.median', { a: m.prospect_to_submitted ?? '–', b: m.submitted_to_decision ?? '–', c: m.decision_to_invite ?? '–' })}</T>
      </Block></Card>
      <Card><Block title={t('scout.rep.source')}>{r.by_source.length ? <Bars label={t('scout.rep.source')} rows={r.by_source.map((s) => ({ label: s.label, value: s.prospects, text: `${s.prospects} · ${s.invited} · ${s.enrolled}` }))} /> : <T size={13} color={c.mute}>{t('scout.rep.none')}</T>}<T size={11} color={c.mute}>{t('scout.rep.legend')}</T></Block></Card>
      <Card><Block title={t('scout.rep.region')}>
        {r.by_region.length ? r.by_region.map((g) => <View key={g.key} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="700" size={13} style={{ flex: 1 }}>{g.label}</T><T size={13}>{g.prospects} · {g.invited} · {g.enrolled}</T>{g.coverage_gap ? <Tag label={t('scout.rep.gap')} color={c.redSoft} /> : <Tag label={t('scout.rep.scouts', { n: g.scouts })} />}</View>) : <T size={13} color={c.mute}>{t('scout.rep.none')}</T>}
      </Block></Card>
      <Card><Block title={t('scout.rep.scout')}>
        {r.by_scout.length ? <Bars label={t('scout.rep.scout')} rows={r.by_scout.map((s) => ({ label: s.name, value: s.prospects, text: s.capacity ? `${s.prospects} / ${s.capacity}` : String(s.prospects), tone: s.capacity && s.prospects >= s.capacity ? c.orange : c.cyan }))} /> : <T size={13} color={c.mute}>{t('scout.rep.none')}</T>}
      </Block></Card>
      {r.sla.map((s) => (s.overdue.evaluate || s.overdue.committee || s.overdue.invite ? <Card key={s.campaign_id} color={c.orangeSoft}><T weight="800" size={13}>{t('scout.rep.overdue')}</T><T size={13}>{t('scout.rep.overdue_detail', { a: s.overdue.evaluate ?? 0, b: s.overdue.committee ?? 0, c: s.overdue.invite ?? 0 })}</T></Card> : null))}
      <T size={11} color={c.mute}>{t('scout.rep.note')}</T>
    </View>
  );
}

function Brief({ cp }) {
  if (!cp) return <Loading />;
  return (
    <Card>
      <Fact k={t('scout.f.sports')} v={cp.sports?.map((s) => `${s.emoji} ${s.name}`).join(', ')} />
      <Fact k={t('scout.f.programmes')} v={cp.programmes?.map((p) => p.title).join(', ')} />
      <Fact k={t('scout.f.born_from')} v={cp.birth_year_min != null ? `${cp.birth_year_min} – ${cp.birth_year_max}` : null} />
      <Fact k={t('scout.f.positions')} v={cp.positions?.join(', ')} />
      <Fact k={t('scout.f.regions')} v={cp.regions?.join(', ')} />
      <Fact k={t('scout.f.target')} v={cp.target_places} />
      <Fact k={t('scout.f.rule')} v={`${t(`scout.rule.${cp.committee_rule}`)} · ${t('scout.f.quorum')} ${cp.committee_quorum}`} />
      <Fact k={t('scout.f.contact')} v={t(`scout.contact.${cp.contact_policy}`)} />
      {cp.members?.map((m) => <Fact key={m.id} k={t(`scout.role.${m.role}`)} v={`${m.display_name}${m.region ? ` · ${m.region}` : ''}`} />)}
    </Card>
  );
}
