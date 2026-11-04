// The scout's side of a campaign, inside the existing Talent CRM entry sheet (#790): add this prospect to a campaign they are assigned to, and later
// submit it to the committee with the evaluations, notes and approved videos they choose. No separate scout workspace; the prospect stays a Talent CRM entry.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain } from '../access';
import { t } from '../i18n';
import { when } from './academy-ui';

export function CampaignBlock({ entry, evaluations, live, toast, onChanged }) {
  const link = useLoad(() => api.get(`/me/scouting/entries/${entry.id}`), [entry.id, entry.row_version, evaluations.length]);
  const mine = useLoad(() => api.get('/me/scouting/campaigns', { status: 'active' }), []);
  const [form, setForm] = useState(null);
  const p = link.data;
  const fit = (mine.data ?? []).filter((x) => x.roles.some((r) => ['scout', 'regional_lead'].includes(r)));
  if (!live || link.loading && !link.data && !fit.length) return null;
  if (!p && !fit.length) return null;
  const fail = (e) => { throw new Error(explain(e)); };
  return (
    <View style={{ gap: 8 }}>
      <T weight="800" size={18}>{t('scout.entry.title')}</T>
      {p ? (
        <Card pad={12}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>{p.campaign.name}</T><Tag label={t(`scout.stage.${p.journey_stage}`)} /></View>
          <T size={12} color={c.mute}>{t('scout.entry.evals', { n: p.evaluations, min: p.campaign.min_evaluations })}</T>
          {['prospect', 'evaluated'].includes(p.stage) ? <Btn small title={t('scout.entry.submit')} onPress={() => setForm('submit')} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : <T size={12} color={c.mute}>{t('scout.entry.with_committee')}</T>}
        </Card>
      ) : <Btn small title={t('scout.entry.add')} color={c.paper} ink={c.ink} onPress={() => setForm('add')} style={{ alignSelf: 'flex-start' }} />}
      {form === 'add' ? <AddForm entry={entry} campaigns={fit} onClose={() => setForm(null)} onDone={() => { setForm(null); link.reload(); onChanged(); toast(t('scout.entry.added')); }} fail={fail} /> : null}
      {form === 'submit' && p ? <SubmitForm p={p} evaluations={evaluations} onClose={() => setForm(null)} onDone={() => { setForm(null); link.reload(); onChanged(); toast(t('scout.entry.submitted')); }} fail={fail} /> : null}
    </View>
  );
}

function AddForm({ entry, campaigns, onClose, onDone, fail }) {
  const [campaign, setCampaign] = useState(campaigns[0]?.id);
  const cur = campaigns.find((x) => x.id === campaign) ?? campaigns[0];
  const sources = useLoad(() => (cur ? api.get(`/organisations/${cur.organisation_id}/academy/referral-sources`).catch(() => []) : Promise.resolve([])), [cur?.id]);
  return (
    <FormSheet visible onClose={onClose} title={t('scout.entry.add')} submitLabel={t('scout.entry.add_btn')} initial={{ campaign: cur?.id, region: cur?.my_regions?.[0] ?? cur?.regions?.[0] }} fields={[
      { key: 'campaign', label: t('scout.pick'), type: 'chips', options: campaigns.map((x) => ({ value: x.id, label: `${x.name} · ${x.organisation}` })) },
      { key: 'region', label: t('scout.team.region'), type: 'chips', options: (v) => { const k = campaigns.find((x) => x.id === v.campaign) ?? cur; return (k?.my_regions?.length ? k.my_regions : k?.regions ?? []).map((r) => ({ value: r, label: r })); } },
      { key: 'referral_source_id', label: t('scout.f.sources_one'), type: 'multimenu', max: 1, optional: true, options: (sources.data ?? []).map((s) => ({ value: s.id, label: s.name, sub: s.region ?? '' })) },
    ]} onSubmit={async (v) => { setCampaign(v.campaign); try { await api.post(`/academy/scouting/campaigns/${v.campaign}/prospects`, { entry_id: entry.id, region: v.region, referral_source_id: v.referral_source_id?.[0] }); onDone(); } catch (e) { fail(e); } }} />
  );
}

function SubmitForm({ p, evaluations, onClose, onDone, fail }) {
  const videos = useLoad(() => api.get(`/academy/scouting/prospects/${p.id}/video-options`).catch(() => []), [p.id]);
  return (
    <FormSheet visible onClose={onClose} title={t('scout.entry.submit')} submitLabel={t('scout.entry.submit_btn')} initial={{ evaluation_ids: evaluations.slice(0, 5).map((e) => e.id), release_notes: false, video_ids: [] }} fields={[
      { key: 'evaluation_ids', label: t('scout.entry.pick_evals'), type: 'multimenu', options: evaluations.map((e) => ({ value: e.id, label: `${'★'.repeat(e.overall)} · ${t(`scout.basis.${e.basis}`)}`, sub: when(e.observed_on) })), hint: t('scout.entry.pick_hint', { min: p.campaign.min_evaluations }) },
      { key: 'release_notes', label: t('scout.entry.release_notes'), type: 'switch', hint: t('scout.entry.release_hint') },
      { key: 'video_ids', label: t('scout.entry.videos'), type: 'multimenu', optional: true, options: (videos.data ?? []).map((v) => ({ value: v.id, label: v.title, sub: v.url })), hint: t('scout.entry.videos_hint') },
    ]} onSubmit={async (v) => { try { await api.post(`/academy/scouting/prospects/${p.id}/submit`, { row_version: p.row_version, evaluation_ids: v.evaluation_ids, release_notes: v.release_notes, video_ids: v.video_ids ?? [] }); onDone(); } catch (e) { fail(e); } }} />
  );
}
