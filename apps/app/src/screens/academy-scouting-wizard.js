// Scouting campaign creation (#790): an 8-step brief, saved as a draft after every step, ending in a readiness check that the server enforces on launch.
// Steps: brief, player profile, territory, scouting team, evaluation model, safeguarding, committee & pipeline, review & launch.
// Every choice uses the control that fits (pickers, steppers, switches, date range, money); text boxes are only for names and notes.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, ErrorBox, Loading, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../menu-field';
import { Counter, Stepper } from '../pickers';
import { c } from '../theme';
import { explain } from '../access';
import { t } from '../i18n';

const STEP_KEYS = ['brief', 'profile', 'territory', 'team', 'eval', 'safe', 'committee', 'review'];
const lab = (key, v) => t(`scout.${key}.${v}`);
const opts = (key, list) => list.map((v) => ({ value: v, label: lab(key, v) }));
const toMembers = (ms) => ms.map((m) => ({ user_id: m.user_id, role: m.role, region: m.region ?? undefined, capacity: m.capacity ?? undefined }));

export function CampaignWizard({ o, campaign, startStep = 0, onClose, onDone, toast }) {
  const opt = useLoad(() => api.get(`/organisations/${o.id}/academy/scouting/options`), [o.id]);
  const [camp, setCamp] = useState(campaign ?? null);
  const [members, setMembers] = useState(campaign?.members ?? []);
  const [step, setStep] = useState(Math.min(startStep, 7));
  const [sources, setSources] = useState(null);
  const [addSource, setAddSource] = useState(false);
  const live = !!camp && camp.status !== 'draft';
  const full = useLoad(() => (camp ? api.get(`/academy/scouting/campaigns/${camp.id}`) : Promise.resolve(null)), [camp?.id, camp?.row_version, step]);
  useEffect(() => { if (full.data?.members) setMembers(full.data.members); }, [full.data]);
  if (opt.error) return <Sheet visible onClose={onClose} title={t('scout.wiz.title')}><ErrorBox error={opt.error} onRetry={opt.reload} /></Sheet>;
  if (!opt.data) return <Sheet visible onClose={onClose} title={t('scout.wiz.title')}><Loading /></Sheet>;
  const O = opt.data;
  const sourceOpts = (sources ?? O.referral_sources).map((s) => ({ value: s.id, label: s.name, sub: `${lab('refkind', s.kind)}${s.region ? ` · ${s.region}` : ''}` }));
  const sportOpts = O.sports.map((s) => ({ value: s.id, label: `${s.emoji} ${s.name}` }));
  const progOpts = O.programmes.map((p) => ({ value: p.id, label: p.title, sub: `${p.sport} · ${p.status}` }));
  const people = O.members.map((m) => ({ value: m.user_id, label: m.display_name, sub: `@${m.handle}` }));

  const save = async (raw, to) => {
    const patch = Object.fromEntries(Object.entries(raw).filter(([, x]) => x !== '' && x !== undefined));
    try {
      let row;
      if (!camp) row = await api.post(`/organisations/${o.id}/academy/scouting/campaigns`, { ...patch, step_reached: 1 });
      else row = await api.patch(`/academy/scouting/campaigns/${camp.id}`, { row_version: camp.row_version, ...patch, step_reached: Math.max(camp.step_reached ?? 1, (to ?? step) + 1) });
      setCamp(row);
      toast?.(t('scout.wiz.saved'));
      if (to != null) setStep(to);
      return row;
    } catch (e) { throw new Error(explain(e)); }
  };
  const saveTeam = async (next, to) => {
    try {
      const row = await api.post(`/academy/scouting/campaigns/${camp.id}/team`, { row_version: camp.row_version, members: toMembers(next) });
      setCamp(row); setMembers(row.members); toast?.(t('scout.wiz.saved'));
      if (to != null) setStep(to);
    } catch (e) { throw new Error(explain(e)); }
  };
  const back = () => setStep((s) => Math.max(0, s - 1));
  const next = (k) => t('scout.wiz.next_to', { step: t(`scout.wiz.s.${STEP_KEYS[k]}`) });
  const c0 = camp ?? {};
  const regions = [...new Set([...(c0.regions ?? []), ...O.scouts.flatMap((s) => s.regions ?? [])])];
  const sportSlugs = O.sports.filter((s) => (c0.sport_ids ?? []).includes(s.id));
  const positionOpts = [...new Set(sportSlugs.flatMap((s) => s.positions))].map((p) => ({ value: p, label: p }));
  const total = (v) => ['technical', 'tactical', 'physical', 'mental', 'potential'].reduce((a, k) => a + (v[`w_${k}`] ?? 0), 0);
  const year = new Date().getFullYear();

  return (
    <Sheet visible onClose={onClose} title={camp ? camp.name : t('scout.wiz.title')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T size={12} color={c.mute} style={{ flex: 1 }}>{t('scout.wiz.step', { n: step + 1, m: 8 })} · {t(`scout.wiz.s.${STEP_KEYS[step]}`)}</T>
        <Tag label={t(`scout.status.${camp?.status ?? 'draft'}`)} color={live ? c.limeSoft : undefined} />
      </View>
      <Stepper steps={STEP_KEYS.map((k) => t(`scout.wiz.s.${k}`))} current={step} onJump={(i) => (camp || i === 0) && setStep(i)} />

      {step === 0 ? <FormSheet inline visible initial={{ ...c0, owner_id: c0.owner_id ? [c0.owner_id] : [], budget_minor: c0.budget_minor ?? undefined, currency: c0.currency ?? 'GBP' }} submitLabel={next(1)} onClose={() => {}} fields={[
        { key: 'name', label: t('scout.f.name') },
        { key: 'objective', label: t('scout.f.objective'), type: 'chips', options: opts('objective', O.objectives) },
        { key: 'season_label', label: t('scout.f.season'), optional: true },
        { key: 'sport_ids', label: t('scout.f.sports'), type: 'multimenu', options: sportOpts, hint: t('scout.f.sports_hint') },
        { key: 'programme_ids', label: t('scout.f.programmes'), type: 'multimenu', options: progOpts, hint: t('scout.f.programmes_hint') },
        { key: 'owner_id', label: t('scout.f.owner'), type: 'multimenu', max: 1, options: people },
        { key: 'target_places', label: t('scout.f.target'), type: 'stepper', min: 1, max: 500, default: 12 },
        { key: 'scholarship_places', label: t('scout.f.scholarship'), type: 'stepper', min: 0, max: 500, default: 0 },
        { key: 'pipeline_target', label: t('scout.f.pipeline'), type: 'stepper', min: 1, max: 5000, step: 5, default: 60, hint: t('scout.f.pipeline_hint') },
        { key: 'starts_on', label: t('scout.f.window'), type: 'daterange', toKey: 'ends_on', min: new Date().toISOString().slice(0, 10) },
        { key: 'decision_by', label: t('scout.f.decision_by'), type: 'date', min: new Date().toISOString().slice(0, 10) },
        { type: 'section', label: t('scout.f.budget_section') },
        { key: 'currency', label: t('scout.f.currency'), type: 'currency' },
        { key: 'budget_minor', label: t('scout.f.budget'), type: 'money', currency: (x) => x.currency, optional: true },
        { key: 'cost_centre', label: t('scout.f.cost_centre'), optional: true },
      ]} onSubmit={async (x) => { const { currency, budget_minor, owner_id, ...rest } = x; await save({ ...rest, owner_id: owner_id?.[0] ?? null, ...(budget_minor ? { budget_minor, currency } : {}) }, 1); }} /> : null}

      {step === 1 ? <FormSheet inline visible initial={{ ...c0, positions: c0.positions ?? [], genders: c0.genders ?? [], dominance: c0.dominance ?? [], levels: c0.levels ?? [], birth_year_min: c0.birth_year_min ?? year - 14, birth_year_max: c0.birth_year_max ?? year - 12, req_academic: c0.requirements?.academic ?? '', req_rules: c0.requirements?.eligibility_rules ?? '', flag_relative_age: c0.flag_relative_age ?? true }} submitLabel={next(2)} onBack={back} onClose={() => {}} fields={[
        { key: 'birth_year_min', label: t('scout.f.born_from'), type: 'stepper', min: 1990, max: year, hint: (v) => t('scout.f.born_hint', { a: year - v.birth_year_max, b: year - v.birth_year_min }), locked: live },
        { key: 'birth_year_max', label: t('scout.f.born_to'), type: 'stepper', min: 1990, max: year },
        { key: 'genders', label: t('scout.f.genders'), type: 'multi', options: opts('gender', ['boys', 'girls', 'mixed']), optional: true },
        { key: 'dominance', label: t('scout.f.dominance'), type: 'multi', options: opts('dominance', ['right', 'left', 'either']), optional: true },
        { key: 'positions', label: t('scout.f.positions'), type: 'multimenu', options: positionOpts, optional: true, hint: positionOpts.length ? t('scout.f.positions_hint') : t('scout.f.positions_none') },
        { key: 'levels', label: t('scout.f.levels'), type: 'multi', options: opts('level', O.levels), optional: true },
        { key: 'residency', label: t('scout.f.residency'), type: 'chips', options: opts('residency', O.residency), optional: true },
        { key: 'flag_relative_age', label: t('scout.f.relative_age'), type: 'switch', hint: t('scout.f.relative_age_hint') },
        { type: 'section', label: t('scout.f.requirements') },
        { key: 'req_academic', label: t('scout.f.academic'), optional: true, type: 'multiline' },
        { key: 'req_rules', label: t('scout.f.rules'), optional: true, type: 'multiline', hint: t('scout.f.rules_hint') },
      ]} onSubmit={async (x) => { const { req_academic, req_rules, ...rest } = x; await save({ ...rest, ...(live ? { birth_year_min: undefined, birth_year_max: undefined } : {}), requirements: { ...(req_academic ? { academic: req_academic } : {}), ...(req_rules ? { eligibility_rules: req_rules } : {}) } }, 2); }} /> : null}

      {step === 2 ? (
        <View style={{ gap: 12 }}>
          <FormSheet inline visible initial={{ regions: c0.regions ?? [], scouting_modes: c0.scouting_modes ?? [], referral_source_ids: c0.referral_source_ids ?? [] }} submitLabel={next(3)} onBack={back} onClose={() => {}} fields={[
            { key: 'regions', label: t('scout.f.regions'), type: 'regions', hint: t('scout.f.regions_hint') },
            { key: 'scouting_modes', label: t('scout.f.modes'), type: 'multi', options: opts('mode', O.scouting_modes), optional: true },
            { key: 'referral_source_ids', label: t('scout.f.sources'), type: 'multimenu', options: sourceOpts, optional: true, hint: t('scout.f.sources_hint') },
          ]} onSubmit={async (x) => { await save(x, 3); }} extra={<Btn small title={t('scout.f.add_source')} color={c.paper} ink={c.ink} onPress={() => setAddSource(true)} style={{ alignSelf: 'flex-start' }} />} />
          {addSource ? <FormSheet visible onClose={() => setAddSource(false)} title={t('scout.f.add_source')} submitLabel={t('common.save')} initial={{ kind: 'school' }} fields={[
            { key: 'name', label: t('scout.f.source_name') }, { key: 'kind', label: t('scout.f.source_kind'), type: 'chips', options: opts('refkind', O.referral_kinds) }, { key: 'region', label: t('scout.f.source_region'), type: 'region', optional: true }]}
            onSubmit={async (x) => { try { await api.post(`/organisations/${o.id}/academy/referral-sources`, { name: x.name, kind: x.kind, region: x.region || null }); setSources(await api.get(`/organisations/${o.id}/academy/referral-sources`)); setAddSource(false); } catch (e) { throw new Error(explain(e)); } }} /> : null}
        </View>
      ) : null}

      {step === 3 ? <TeamStep camp={camp} members={members} regions={c0.regions ?? []} scouts={O.scouts} onSave={(next) => saveTeam(next, 4)} onBack={back} nextLabel={next(4)} /> : null}

      {step === 4 ? <FormSheet inline visible initial={{ ...Object.fromEntries(['technical', 'tactical', 'physical', 'mental', 'potential'].map((k) => [`w_${k}`, (c0.rubric ?? []).find((r) => r.key === k)?.weight ?? 0])), min_evaluations: c0.min_evaluations ?? 2, required_bases: c0.required_bases ?? [] }} submitLabel={next(5)} onBack={back} onClose={() => {}} fields={[
        { type: 'section', label: t('scout.f.rubric') },
        ...['technical', 'tactical', 'physical', 'mental', 'potential'].map((k, i) => ({ key: `w_${k}`, label: lab('criterion', k), type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', hint: i === 4 ? (v) => t('scout.f.rubric_total', { n: total(v) }) : undefined })),
        { key: 'min_evaluations', label: t('scout.f.min_evals'), type: 'stepper', min: 1, max: 10 },
        { key: 'required_bases', label: t('scout.f.bases'), type: 'multi', options: opts('basis', O.bases), optional: true, hint: t('scout.f.bases_hint') },
      ]} onSubmit={async (x) => {
        const rubric = ['technical', 'tactical', 'physical', 'mental', 'potential'].filter((k) => x[`w_${k}`] > 0).map((k) => ({ key: k, weight: x[`w_${k}`] }));
        await save({ rubric: live ? undefined : rubric, min_evaluations: x.min_evaluations, required_bases: x.required_bases ?? [] }, 5);
      }} /> : null}

      {step === 5 ? <FormSheet inline visible initial={{ guardian_consent_required: c0.guardian_consent_required ?? true, notes_private: c0.notes_private ?? true, video_requires_grant: c0.video_requires_grant ?? true, contact_policy: c0.contact_policy ?? 'via_guardian', retention_months: c0.retention_months ?? 12 }} submitLabel={next(6)} onBack={back} onClose={() => {}} fields={[
        { key: 'guardian_consent_required', label: t('scout.f.consent'), type: 'switch', hint: t('scout.f.consent_hint') },
        { key: 'notes_private', label: t('scout.f.notes_private'), type: 'switch', hint: t('scout.f.notes_private_hint') },
        { key: 'video_requires_grant', label: t('scout.f.video_grant'), type: 'switch', hint: t('scout.f.video_grant_hint') },
        { key: 'contact_policy', label: t('scout.f.contact'), type: 'chips', options: opts('contact', O.contact_policies) },
        { key: 'retention_months', label: t('scout.f.retention'), type: 'stepper', min: 1, max: 120, step: 1, suffix: ` ${t('scout.f.months')}`, hint: t('scout.f.retention_hint') },
      ]} onSubmit={async (x) => { await save(x, 6); }} /> : null}

      {step === 6 ? <CommitteeStep camp={camp} members={members} people={people} sla={c0.sla_days ?? {}} onSave={async (next, patch) => { await save(patch); await saveTeam(next, 7); }} onBack={back} nextLabel={next(7)} /> : null}

      {step === 7 ? (
        <View style={{ gap: 12 }}>
          {full.error ? <ErrorBox error={full.error} onRetry={full.reload} /> : !full.data ? <Loading /> : (
            <>
              <Card><T weight="800">{t('scout.rd.title', { pct: full.data.readiness.pct })}</T>
                <View style={{ height: 10, borderRadius: 6, backgroundColor: c.violetSoft, overflow: 'hidden', marginTop: 6 }}><View style={{ width: `${full.data.readiness.pct}%`, height: 10, backgroundColor: full.data.readiness.blockers.length ? c.orange : c.lime }} /></View>
              </Card>
              {full.data.readiness.blockers.length ? (
                <Card color={c.orangeSoft}>
                  <T weight="800">{t('scout.rd.blocks')}</T>
                  {full.data.readiness.blockers.map((b) => (
                    <View key={b.code} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
                      <T style={{ flex: 1 }} size={13}>✕ {b.label}</T>
                      <Btn small title={t('scout.rd.fix', { n: b.step })} color={c.paper} ink={c.ink} onPress={() => setStep(b.step - 1)} />
                    </View>
                  ))}
                </Card>
              ) : null}
              <Card><T weight="800">{t('scout.rd.ready')}</T>{full.data.readiness.ready.map((r) => <T key={r.code} size={13}>✓ {r.label}</T>)}</Card>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Btn title={t('scout.wiz.back')} color={c.paper} ink={c.ink} onPress={back} />
                <Btn title={t('scout.wiz.exit')} color={c.paper} ink={c.ink} onPress={() => { onDone?.(); }} />
                {!live ? <Btn title={t('scout.launch')} disabled={!!full.data.readiness.blockers.length} onPress={async () => { try { await api.post(`/academy/scouting/campaigns/${camp.id}/launch`, { row_version: full.data.row_version }); toast?.(t('scout.launched')); onDone?.(); } catch (e) { toast?.(explain(e)); full.reload(); } }} /> : null}
              </View>
            </>
          )}
        </View>
      ) : null}
      {step > 0 && step < 7 ? <T size={11} color={c.mute}>{t('scout.wiz.autosave')}</T> : null}
    </Sheet>
  );
}

/** Scouts: a verified recruiter linked to the academy, the region they cover and how many prospects they can carry. */
function TeamStep({ camp, members, regions, scouts, onSave, onBack, nextLabel }) {
  const [list, setList] = useState(members.filter((m) => ['scout', 'regional_lead'].includes(m.role)));
  const others = members.filter((m) => !['scout', 'regional_lead'].includes(m.role));
  const [draft, setDraft] = useState({ user_id: null, region: null, capacity: 10, role: 'scout' });
  const [err, setErr] = useState(null);
  const add = () => { if (!draft.user_id || !draft.region) return; setList((l) => [...l.filter((x) => !(x.user_id === draft.user_id && x.region === draft.region && x.role === draft.role)), { ...draft, display_name: scouts.find((s) => s.user_id === draft.user_id)?.display_name }]); setDraft({ ...draft, user_id: null }); };
  return (
    <View style={{ gap: 12 }}>
      {!regions.length ? <Card color={c.sunSoft}><T size={13}>{t('scout.team.need_regions')}</T></Card> : null}
      {list.length ? list.map((m) => (
        <Card key={`${m.user_id}${m.region}${m.role}`} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{m.display_name}</T><T size={12} color={c.mute}>{t(`scout.role.${m.role}`)} · {m.region}{m.capacity ? ` · ${t('scout.team.capacity', { n: m.capacity })}` : ''}</T></View>
            <Btn small title={t('scout.team.remove')} color={c.paper} ink={c.ink} onPress={() => setList((l) => l.filter((x) => x !== m))} />
          </View>
        </Card>
      )) : <T size={13} color={c.mute}>{t('scout.team.none')}</T>}
      <Card>
        <T weight="800">{t('scout.team.add')}</T>
        <MenuField label={t('scout.team.scout')} value={draft.user_id} onChange={(v) => setDraft({ ...draft, user_id: v })} options={scouts.map((s) => ({ value: s.user_id, label: s.display_name, sub: `@${s.handle}` }))} placeholder={scouts.length ? t('common.choose') : t('scout.team.no_scouts')} />
        <MenuField label={t('scout.team.role')} value={draft.role} onChange={(v) => setDraft({ ...draft, role: v })} options={['scout', 'regional_lead'].map((v) => ({ value: v, label: t(`scout.role.${v}`) }))} />
        <MenuField label={t('scout.team.region')} value={draft.region} onChange={(v) => setDraft({ ...draft, region: v })} options={regions.map((r) => ({ value: r, label: r }))} />
        <Counter label={t('scout.team.capacity_label')} value={draft.capacity} min={1} max={500} step={5} onChange={(v) => setDraft({ ...draft, capacity: v })} />
        <Btn small title={t('scout.team.add_btn')} disabled={!draft.user_id || !draft.region} onPress={add} style={{ alignSelf: 'flex-start' }} />
      </Card>
      {err ? <T color={c.red} size={13}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}><Btn title={t('scout.wiz.back')} color={c.paper} ink={c.ink} onPress={onBack} /><Btn title={nextLabel} onPress={async () => { try { await onSave([...others, ...list]); } catch (e) { setErr(e.message); } }} /></View>
    </View>
  );
}

/** Committee people, quorum and rule, and the service levels each stage should meet. */
function CommitteeStep({ camp, members, people, sla, onSave, onBack, nextLabel }) {
  const by = (r) => members.filter((m) => m.role === r).map((m) => m.user_id);
  const [v, setV] = useState({ committee: by('committee'), chair: by('chair'), safe: by('safeguarding_officer'), quorum: camp?.committee_quorum ?? 3, rule: camp?.committee_rule ?? 'majority', evaluate: sla.evaluate ?? 14, committee_sla: sla.committee ?? 7, invite: sla.invite ?? 5, trial: sla.trial ?? 21 });
  const [err, setErr] = useState(null);
  const set = (k) => (x) => setV((s) => ({ ...s, [k]: x }));
  return (
    <View style={{ gap: 12 }}>
      <MultiMenuField label={t('scout.f.committee')} value={v.committee} onChange={set('committee')} options={people} placeholder={t('common.choose')} />
      <MultiMenuField label={t('scout.f.chair')} value={v.chair} onChange={(x) => set('chair')(x.slice(-1))} options={people} max={1} placeholder={t('common.choose')} />
      <MultiMenuField label={t('scout.f.safeguarding_officer')} value={v.safe} onChange={set('safe')} options={people} placeholder={t('common.choose')} hint={t('scout.f.safeguarding_hint')} />
      <Counter label={t('scout.f.quorum')} value={v.quorum} min={1} max={15} onChange={set('quorum')} />
      <MenuField label={t('scout.f.rule')} value={v.rule} onChange={set('rule')} options={['majority', 'unanimous'].map((x) => ({ value: x, label: t(`scout.rule.${x}`) }))} hint={t('scout.f.rule_hint2')} />
      <T weight="800">{t('scout.f.sla')}</T>
      {[['evaluate', 'sla_evaluate'], ['committee_sla', 'sla_committee'], ['invite', 'sla_invite'], ['trial', 'sla_trial']].map(([k, l]) => <Counter key={k} label={t(`scout.f.${l}`)} value={v[k]} min={1} max={90} onChange={set(k)} suffix={` ${t('scout.f.days')}`} />)}
      {err ? <T color={c.red} size={13}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}><Btn title={t('scout.wiz.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={nextLabel} onPress={async () => {
          const ids = new Set(v.committee); v.chair.forEach((x) => ids.delete(x));
          const keep = members.filter((m) => ['scout', 'regional_lead'].includes(m.role));
          const next = [...keep, ...[...ids].filter((u) => !v.safe.includes(u)).map((user_id) => ({ user_id, role: 'committee' })), ...v.chair.map((user_id) => ({ user_id, role: 'chair' })), ...v.safe.map((user_id) => ({ user_id, role: 'safeguarding_officer' }))];
          try { await onSave(next, { committee_quorum: v.quorum, committee_rule: v.rule, sla_days: { evaluate: v.evaluate, committee: v.committee_sla, invite: v.invite, trial: v.trial } }); } catch (e) { setErr(e.message); }
        }} /></View>
    </View>
  );
}
