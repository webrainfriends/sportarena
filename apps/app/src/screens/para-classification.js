// Para-sport classification (#488): one place for the athlete/guardian, the classifier and the governing body's classification desk.
// An administrative sporting classification, never a diagnosis. Everything comes from the para-* capabilities (REST/MCP); sensitive evidence is only ever
// opened one item at a time by the athlete/guardian or an assigned classifier, and every read is audited on the server.
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { Kpi } from './academy-ui';
import { ParaEntries } from './para-competition';
import { ParaDisciplines } from './para-disciplines';
import { ParaRegional } from './para-regional';
import { ParaSourceReviews } from './para-source-reviews';
import { StateBadge } from './coach-adaptive';
import { useNav } from '../nav';
import { c } from '../theme';
import { t } from '../i18n';
import { locale } from '../locale';

const STAGES = ['submitted', 'evidence_review', 'assessment_scheduled', 'assessment_completed', 'panel_review', 'decision_issued'];
const STATUSES = ['confirmed', 'review_required', 'temporary', 'not_eligible', 'other'];
const TONE = { confirmed: c.limeSoft, temporary: c.sunSoft, review_required: c.orangeSoft, not_eligible: c.redSoft, other: c.violetSoft };
const ROLES = ['athlete', 'guide', 'pusher', 'caller', 'assistant', 'interpreter'];
/** A comma-separated list typed from the governing document, as a clean array. */
const list = (x) => String(x ?? '').split(/[,;\n]/).map((y) => y.trim()).filter(Boolean);
const label = (group, v) => t(`para.${group}.${v}`);
const join = (...p) => p.filter((x) => x !== null && x !== undefined && x !== '').join(', ');
const dot = (a, b) => [a, b].join(' · ');
const when = (d) => (d ? String(d).slice(0, 10) : '—');
/** A short, locale-aware date ("3 Nov 2028") that fits a stat tile on a phone. */
const short = (d) => { if (!d) return '—'; try { return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${String(d).slice(0, 10)}T00:00:00Z`)); } catch { return when(d); } };

/** Where a case stands, with the words printed (never colour alone). */
function StageTrack({ status }) {
  const at = STAGES.indexOf(status);
  const ended = at < 0;
  return (
    <View accessible accessibilityLabel={ended ? label('stage', status) : t('para.step_of', { n: at + 1, total: STAGES.length, stage: label('stage', status) })} style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {STAGES.map((k, i) => <View key={k} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: ended ? c.line : i < at ? c.mint : i === at ? c.pink : c.violetSoft }} />)}
      </View>
      <T size={12} weight="800" color={ended ? c.mute : c.ink}>{label('stage', status)}</T>
    </View>
  );
}

const Disclaimer = () => (
  <View style={{ backgroundColor: c.cyanSoft, borderRadius: 14, padding: 12 }} accessible accessibilityRole="text">
    <T size={13} color={c.ink}>{t('para.disclaimer')}</T>
  </View>
);

const Row2 = ({ children }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{children}</View>;
const Block = ({ title, right, children }) => (
  <View style={{ gap: 10 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><T size={18} weight="800" style={{ flexShrink: 1 }} accessibilityRole="header">{title}</T>{right}</View>
    {children}
  </View>
);

/** Run an API call, toast the result, reload. */
function useRun(toast, reload) {
  return async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); await reload?.(); return r; } catch (e) { toast(e.message); return null; } };
}

// ------------------------------------------------------------------ case detail (athlete / guardian / classifier / authority staff)
function CaseSheet({ id, onClose, reload }) {
  const { toast } = useSession();
  const d = useLoad(() => (id ? api.get(`/para/cases/${id}`) : Promise.resolve(null)), [id]);
  const run = useRun(toast, async () => { await d.reload(); await reload?.(); });
  const [form, setForm] = useState(null);
  const x = d.data;
  const v = x?.viewer;
  const isLead = x?.panel?.some((p) => p.you && p.role === 'lead');
  const classes = useLoad(() => (x ? api.get('/para/class-versions', { sport_id: x.sport_id, body_id: x.body_id }) : Promise.resolve(null)), [x?.version_id]);
  const classOptions = useMemo(() => (classes.data?.versions ?? []).find((z) => z.id === x?.version_id)?.classes?.map((k) => ({ value: k.code, label: `${k.code} · ${k.name}` })) ?? [], [classes.data, x?.version_id]);
  const open = async (e) => {
    const r = await run(() => api.get(`/para/cases/${id}/evidence/${e.id}`));
    if (r) toast(r.reference ?? (r.file ? `${r.file.name} (${r.file.content_type})` : t('para.opened')));
  };
  return (
    <Sheet visible={!!id} onClose={onClose} title={x ? `${x.sport} · ${x.authority}` : t('para.case')}>
      {d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : !x ? <Loading /> : (
        <View style={{ gap: 14 }}>
          <StageTrack status={x.status} />
          <Row2>
            <Tag label={label('context', x.requested_context)} />
            <Tag label={t('para.version', { n: x.version })} color={c.cyanSoft} />
            {x.appointment_on ? <Tag label={t('para.appointment', { at: when(x.appointment_on) })} color={c.sunSoft} /> : null}
          </Row2>
          {x.requester_note ? <Card pad={12}><T size={12} weight="800" color={c.mute}>{t('para.note').toUpperCase()}</T><T size={14}>{x.requester_note}</T></Card> : null}
          <Block title={t('para.panel')}>
            {x.panel.length ? x.panel.map((p) => (
              <Card key={p.id} pad={12} accessibilityLabel={join(p.name, label('role', p.role), p.decided ? t('para.decided') : t('para.awaiting'))}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <View style={{ flexShrink: 1 }}><T weight="800">{p.name}{p.you ? ` (${t('para.you')})` : ''}</T><T size={12} color={c.mute}>{label('role', p.role)} · {p.grade}</T></View>
                  <Tag label={p.decided ? t('para.decided') : t('para.awaiting')} color={p.decided ? c.limeSoft : c.violetSoft} />
                </View>
                {p.decision_class_code || p.decision_status ? <T size={13}>{p.decision_class_code ?? '—'} · {p.decision_status ? label('status', p.decision_status) : ''}</T> : null}
              </Card>
            )) : <Empty emoji="🧑‍⚖️" title={t('para.no_panel')} sub={t('para.no_panel_sub')} />}
          </Block>
          {x.evidence ? (
            <Block title={t('para.evidence')} right={v === 'athlete' || v === 'guardian' || v === 'panel' ? <Btn small title={t('para.add')} onPress={() => setForm('evidence')} /> : null}>
              <T size={12} color={c.mute}>{t('para.evidence_private')}</T>
              {x.evidence.length ? x.evidence.map((e) => (
                <Card key={e.id} pad={12} onPress={() => open(e)} accessibilityLabel={join(e.label, t('para.open_item'))}>
                  <T weight="800">{e.label}</T><T size={12} color={c.mute}>{e.file_name ?? t('para.reference')}{e.size_bytes ? ` · ${Math.round(e.size_bytes / 1024)} KB` : ''}</T>
                </Card>
              )) : <T size={13} color={c.mute}>{t('para.no_evidence')}</T>}
            </Block>
          ) : <T size={12} color={c.mute}>{t('para.staff_no_evidence')}</T>}
          <Block title={t('para.history')}>
            {x.history.map((h, i) => <T key={i} size={12} color={c.mute}>{when(h.created_at)} · {t(`para.action.${h.action}`)}{h.to_status ? ` → ${label('stage', h.to_status)}` : ''}</T>)}
          </Block>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(v === 'staff' || v === 'panel') ? x.next.filter((n) => n !== 'closed' || v === 'staff').map((n) => <Btn key={n} small color={n === 'incomplete' ? c.paper : c.pink} ink={n === 'incomplete' ? c.red : '#fff'} title={label('stage', n)} onPress={() => setForm(n)} />) : null}
            {v === 'staff' ? <Btn small title={t('para.assign_panel')} onPress={() => setForm('panel')} /> : null}
            {v === 'panel' && x.status === 'panel_review' ? <Btn small title={t('para.record_decision')} onPress={() => setForm('decision')} /> : null}
            {v === 'panel' && x.status === 'panel_review' && isLead ? <Btn small color={c.mint} ink={c.ink} title={t('para.issue')} onPress={() => run(() => api.post(`/para/cases/${id}/outcome`, {}), t('para.issued'))} /> : null}
            {(v === 'athlete' || v === 'guardian') && ['submitted', 'evidence_review', 'assessment_scheduled', 'assessment_completed', 'panel_review'].includes(x.status) ? <Btn small color={c.paper} ink={c.red} title={t('para.withdraw')} onPress={() => run(() => api.post(`/para/cases/${id}/withdraw`, {}), t('para.withdrawn'))} /> : null}
          </View>
          <FormSheet visible={form === 'evidence'} onClose={() => setForm(null)} title={t('para.add_evidence')} notice={t('para.evidence_notice')}
            fields={[{ key: 'label', label: t('para.f_label'), type: 'text' }, { key: 'reference', label: t('para.f_reference'), type: 'url', optional: true }, { key: 'files', label: t('para.f_file'), type: 'files', max: 1, optional: true }]}
            onSubmit={async (val) => { const f = val.files?.[0]; await api.post(`/para/cases/${id}/evidence`, { label: val.label, reference: val.reference || undefined, file_name: f?.file_name, data: f?.data }); toast(t('para.evidence_added')); await d.reload(); }} />
          <FormSheet visible={form === 'decision'} onClose={() => setForm(null)} title={t('para.record_decision')} notice={t('para.decision_notice')}
            fields={[{ key: 'class_code', label: t('para.f_class'), type: 'chips', options: classOptions, optional: true }, { key: 'status', label: t('para.f_status'), type: 'chips', options: STATUSES.map((s) => ({ value: s, label: label('status', s) })) }]}
            onSubmit={async (val) => { await api.post(`/para/cases/${id}/decision`, val); toast(t('para.recorded')); await d.reload(); }} />
          <FormSheet visible={form === 'assessment_scheduled'} onClose={() => setForm(null)} title={label('stage', 'assessment_scheduled')}
            fields={[{ key: 'appointment_on', label: t('para.f_appointment'), type: 'datetime' }]}
            onSubmit={async (val) => { await api.post(`/para/cases/${id}/advance`, { to: 'assessment_scheduled', appointment_on: val.appointment_on }); await d.reload(); await reload?.(); }} />
          <FormSheet visible={form === 'incomplete' || form === 'closed'} onClose={() => setForm(null)} title={label('stage', form ?? 'closed')}
            fields={[{ key: 'reason', label: t('para.f_reason'), type: 'multiline' }]}
            onSubmit={async (val) => { await api.post(`/para/cases/${id}/advance`, { to: form, reason: val.reason }); await d.reload(); await reload?.(); }} />
          <FormSheet visible={form === 'panel'} onClose={() => setForm(null)} title={t('para.assign_panel')}
            fields={[{ key: 'classifier', label: t('para.f_classifier'), type: 'multimenu', max: 1, load: async () => (await api.get('/para/classifiers', { body_id: x.body_id })).classifiers.filter((k) => k.live && k.sport_id === x.sport_id).map((k) => ({ value: k.id, label: k.name, sub: `${k.grade}${k.class_codes?.length ? ` · ${k.class_codes.join(', ')}` : ''}` })) },
              { key: 'role', label: t('para.f_role'), type: 'chips', options: ['lead', 'member', 'observer'].map((r) => ({ value: r, label: label('role', r) })) }]}
            initial={{ role: 'member' }}
            onSubmit={async (val) => { await api.post(`/para/cases/${id}/panel`, { members: [{ classifier_id: [].concat(val.classifier)[0], role: val.role }] }); toast(t('para.assigned')); await d.reload(); }} />
          {['evidence_review', 'assessment_completed', 'panel_review'].includes(form) ? (
            <Btn title={label('stage', form)} onPress={async () => { await run(() => api.post(`/para/cases/${id}/advance`, { to: form }), t('para.updated')); setForm(null); }} />
          ) : null}
        </View>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ Step indicator for multi-step flows
function Steps({ current, total }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 0, marginBottom: 16 }}>
      {Array.from({ length: total }, (_, i) => (
        <React.Fragment key={i}>
          <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: i < current ? c.pink : i === current ? c.pink : c.violetSoft, ...(i === current ? { shadowColor: c.pink, shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 0 }, elevation: 4 } : {}) }}>
            <T size={12} weight="900" color={i <= current ? '#fff' : c.mute}>{i < current ? '✓' : i + 1}</T>
          </View>
          {i < total - 1 ? <View style={{ flex: 1, height: 2, backgroundColor: i < current ? c.pink : c.line }} /> : null}
        </React.Fragment>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------ Start-a-classification: 3-step elite flow
function StartClassificationSheet({ visible, onClose, published, coverage, athleteId, onDone }) {
  const { toast } = useSession();
  const [requesting, setRequesting] = useState(null); // sport_id being requested
  const requestDefinition = async (sport) => {
    setRequesting(sport.sport_id);
    try {
      await api.post('/para/sport-definition-requests', { sport_id: String(sport.sport_id) });
      toast(t('para.request_sport_sent'));
    } catch (e) { toast(e.message); }
    finally { setRequesting(null); }
  };
  const [step, setStep] = useState(0);
  const [sportSearch, setSportSearch] = useState('');
  const [selectedSportId, setSelectedSportId] = useState(null);
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [context, setContext] = useState('initial');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => { setStep(0); setSportSearch(''); setSelectedSportId(null); setSelectedVersion(null); setContext('initial'); setNote(''); };
  const handleClose = () => { reset(); onClose(); };

  // Group published versions by sport for the picker
  const sportMap = useMemo(() => {
    const m = {};
    for (const v of published) {
      if (!m[v.sport_id]) m[v.sport_id] = { sport_id: v.sport_id, sport: v.sport, emoji: v.emoji ?? '♿', versions: [] };
      m[v.sport_id].versions.push(v);
    }
    // Merge in coverage catalogue (sports without definitions appear as "not yet")
    for (const s of (coverage ?? [])) {
      const sid = s.sport_id ?? s.id;
      if (sid && !m[sid]) m[sid] = { sport_id: sid, sport: s.name, emoji: s.emoji ?? '♿', versions: [] };
    }
    return Object.values(m).sort((a, b) => a.sport.localeCompare(b.sport));
  }, [published, coverage]);

  const filteredSports = useMemo(() => {
    const q = sportSearch.trim().toLowerCase();
    return q ? sportMap.filter((s) => s.sport.toLowerCase().includes(q)) : sportMap;
  }, [sportMap, sportSearch]);

  const selectedSport = sportMap.find((s) => s.sport_id === selectedSportId);
  // If only one governing body/version for the sport, auto-select
  const versionOptions = selectedSport?.versions ?? [];

  const submit = async () => {
    if (!selectedVersion) return;
    setSubmitting(true);
    try {
      await api.post('/para/cases', { athlete_id: athleteId || undefined, body_id: selectedVersion.body_id, sport_id: selectedVersion.sport_id, discipline: selectedVersion.discipline || '', requested_context: context, note: note.trim() || undefined });
      toast(t('para.submitted'));
      reset();
      onClose();
      onDone?.();
    } catch (e) { toast(e.message); }
    finally { setSubmitting(false); }
  };

  const stepTitles = [t('para.start_sport_step'), t('para.start_auth_step'), t('para.start_review_step')];

  return (
    <Sheet visible={visible} onClose={handleClose} title={t('para.start')}>
      <Steps current={step} total={3} />

      {/* Step 0 — Sport picker */}
      {step === 0 && (
        <View style={{ gap: 12 }}>
          <T size={18} weight="900">{t('para.start_sport_title')}</T>
          <T size={13} color={c.mute}>{t('para.start_sport_sub')}</T>
          <Field label="" placeholder={t('para.search_sport')} value={sportSearch} onChangeText={setSportSearch} />
          <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {filteredSports.length === 0 ? (
              <View style={{ padding: 24, alignItems: 'center', gap: 8 }}>
                <T size={28}>♿</T>
                <T size={14} color={c.mute} style={{ textAlign: 'center' }}>{t('para.no_sports_found')}</T>
              </View>
            ) : filteredSports.map((s) => {
              const governed = s.versions.length > 0;
              const isSelected = selectedSportId === s.sport_id;
              return (
                <View key={s.sport_id} style={{ marginBottom: 8 }}>
                  <Pressable onPress={() => governed ? setSelectedSportId(s.sport_id) : null}
                    accessibilityRole="button" accessibilityLabel={join(s.sport, governed ? t('para.sport_governed') : t('para.sport_not_yet'))}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 16, borderWidth: 1.5, borderColor: isSelected ? c.pink : c.line, backgroundColor: isSelected ? c.pinkSoft : c.paper }}>
                    <T size={28} style={{ width: 36, textAlign: 'center' }}>{s.emoji}</T>
                    <View style={{ flex: 1 }}>
                      <T size={15} weight="800">{s.sport}</T>
                      <T size={12} color={c.mute} style={{ marginTop: 2 }}>
                        {governed ? s.versions.map((v) => `${v.authority} · ${t('para.version', { n: v.version })}`).join(' · ') : t('para.start_sport_no_def')}
                      </T>
                    </View>
                    <Tag label={governed ? t('para.sport_governed') : t('para.sport_not_yet')} color={governed ? c.limeSoft : c.orangeSoft} />
                  </Pressable>
                  {!governed ? (
                    <View style={{ marginTop: 4, paddingHorizontal: 4 }}>
                      <Btn small title={requesting === s.sport_id ? t('common.loading') : t('para.request_sport_btn')}
                        disabled={requesting === s.sport_id}
                        color={c.cyanSoft} ink={c.cyan}
                        onPress={() => requestDefinition(s)}
                        accessibilityLabel={t('para.request_sport_a11y', { sport: s.sport })} />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
          <Btn title={t('para.next')} disabled={!selectedSportId} onPress={() => {
            const vers = sportMap.find((s) => s.sport_id === selectedSportId)?.versions ?? [];
            if (vers.length === 1) setSelectedVersion(vers[0]);
            setStep(1);
          }} />
        </View>
      )}

      {/* Step 1 — Authority, discipline, context, note */}
      {step === 1 && selectedSport && (
        <View style={{ gap: 14 }}>
          <T size={18} weight="900">{selectedSport.emoji} {selectedSport.sport}</T>
          <View style={{ backgroundColor: c.cyanSoft, borderRadius: 12, padding: 12 }}>
            <T size={12} color={c.ink}>{t('para.start_notice')}</T>
          </View>

          {/* Governing body — only shown when multiple govern same sport */}
          {versionOptions.length > 1 ? (
            <View style={{ gap: 6 }}>
              <T size={12} weight="800" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('para.f_authority')}</T>
              {versionOptions.map((v) => (
                <Pressable key={v.id} onPress={() => setSelectedVersion(v)} accessibilityRole="radio" accessibilityChecked={selectedVersion?.id === v.id}
                  style={{ padding: 14, borderRadius: 16, borderWidth: 1.5, borderColor: selectedVersion?.id === v.id ? c.pink : c.line, backgroundColor: selectedVersion?.id === v.id ? c.pinkSoft : c.paper }}>
                  <T size={14} weight="800">{v.authority}</T>
                  <T size={12} color={c.mute} style={{ marginTop: 3 }}>{t('para.version', { n: v.version })} · {t('para.f_effective_on', { date: short(v.effective_from) })} · {t('para.panel_size', { n: v.panel_size })}</T>
                  {v.scope_countries?.length ? <T size={12} color={c.mute}>{v.scope_countries.join(', ')}</T> : null}
                </Pressable>
              ))}
            </View>
          ) : versionOptions.length === 1 ? (
            <Card pad={14} style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <T size={14} weight="800">{versionOptions[0].authority}</T>
                <Tag label={t('para.version', { n: versionOptions[0].version })} color={c.cyanSoft} />
              </View>
              <T size={12} color={c.mute}>{t('para.panel_size', { n: versionOptions[0].panel_size })} · {t('para.appeal_days', { n: versionOptions[0].appeal_days })} · {t(`para.rule.${versionOptions[0].review_rule}`)}</T>
              <T size={12} color={c.mute}>{t('para.f_effective_on', { date: short(versionOptions[0].effective_from) })}</T>
            </Card>
          ) : (
            <Card pad={14}><T size={13} color={c.mute}>{t('para.no_definition_sport')}</T></Card>
          )}

          {/* Classification context */}
          <View style={{ gap: 8 }}>
            <T size={12} weight="800" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('para.f_context')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {['initial', 'review', 'reassessment', 'international'].map((k) => (
                <Pressable key={k} onPress={() => setContext(k)} accessibilityRole="radio" accessibilityChecked={context === k}
                  style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1.5, borderColor: context === k ? c.pink : c.line, backgroundColor: context === k ? c.pinkSoft : c.paper }}>
                  <T size={13} weight="700" color={context === k ? c.pink : c.ink}>{label('context', k)}</T>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Note for classifiers */}
          <Field label={t('para.f_note')} value={note} onChangeText={setNote} multiline hint={t('para.f_note_hint')} />

          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small color={c.paper} ink={c.ink} title={t('common.back')} onPress={() => setStep(0)} style={{ flex: 1 }} />
            <View style={{ flex: 2 }}>
              <Btn title={t('para.next')} disabled={versionOptions.length > 1 && !selectedVersion} onPress={() => { if (versionOptions.length === 1) setSelectedVersion(versionOptions[0]); setStep(2); }} />
            </View>
          </View>
        </View>
      )}

      {/* Step 2 — Review & confirm */}
      {step === 2 && selectedVersion && (
        <View style={{ gap: 14 }}>
          <T size={18} weight="900">{t('para.start_confirm_title')}</T>
          <View style={{ backgroundColor: c.limeSoft, borderRadius: 12, padding: 12 }}>
            <T size={12} color={c.ink}>{t('para.confirm_notice')}</T>
          </View>

          {/* Summary card */}
          <Card pad={16} style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flexShrink: 1 }}>
                <T size={16} weight="900">{selectedSport?.emoji} {selectedSport?.sport}</T>
                <T size={12} color={c.mute} style={{ marginTop: 3 }}>{selectedVersion.authority}</T>
              </View>
              <Tag label={label('context', context)} color={c.cyanSoft} />
            </View>
            <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10, gap: 7 }}>
              {[
                [t('para.f_definition'), `${t('para.version', { n: selectedVersion.version })} · ${short(selectedVersion.effective_from)}`],
                [t('para.f_panel_size'), `${selectedVersion.panel_size} ${t('para.start_classifiers')}`],
                [t('para.f_appeal_days'), `${selectedVersion.appeal_days} ${t('para.days')}`],
                [t('para.f_review_rule'), t(`para.rule.${selectedVersion.review_rule}`) + (selectedVersion.review_months ? ` · ${selectedVersion.review_months} ${t('para.start_months')}` : '')],
                ...(selectedVersion.discipline ? [[t('para.f_discipline_label'), selectedVersion.discipline]] : []),
              ].map(([lbl, val]) => (
                <View key={lbl} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <T size={12} color={c.mute}>{lbl}</T>
                  <T size={12} weight="700" style={{ textAlign: 'right', flexShrink: 1 }}>{val}</T>
                </View>
              ))}
            </View>
          </Card>

          {/* What happens next */}
          <T size={12} weight="800" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('para.what_next')}</T>
          <View style={{ gap: 7 }}>
            {[t('para.next_step_desk'), t('para.next_step_panel', { n: selectedVersion.panel_size }), t('para.next_step_assessment'), t('para.next_step_decision'), t('para.next_step_appeal', { n: selectedVersion.appeal_days })].map((s, i) => (
              <T key={i} size={13} color={c.ink}>{s}</T>
            ))}
          </View>

          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small color={c.paper} ink={c.ink} title={t('common.back')} onPress={() => setStep(1)} style={{ flex: 1 }} />
            <View style={{ flex: 2 }}>
              <Btn title={submitting ? t('common.loading') : t('para.submit_case')} disabled={submitting} onPress={submit} />
            </View>
          </View>
        </View>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ coach para credentials
// Shows adaptive coaching credential state, classifier credentials for para sports and para officiating status.
function CoachParaCredentials({ desk }) {
  const { toast } = useSession();
  const { push } = useNav();
  const adaptive = useLoad(() => api.get('/me/coach-adaptive').catch(() => null), []);
  const a = adaptive.data;
  const paraClassifiers = (desk.classifier ?? []).filter((k) => k.is_para || k.sport_slug?.startsWith('para') || k.discipline);
  const hasAdaptive = !!a?.opted_in;
  const credState = a?.expertise?.length
    ? (a.expertise.some((e) => e.state === 'verified') ? 'verified' : 'self_declared')
    : 'none';
  return (
    <View style={{ gap: 18 }}>
      <Disclaimer />

      {/* Adaptive coaching */}
      <Block title={t('para.coach_cred_title')} right={
        <Btn small title={t('para.coach_set_up_btn')} color={c.paper} ink={c.ink} onPress={() => push?.('CoachAdaptive')} accessibilityLabel={t('para.coach_set_up_btn')} />
      }>
        <T size={13} color={c.mute}>{t('para.coach_cred_sub')}</T>
        {adaptive.loading && !a ? <Loading /> : adaptive.error ? <ErrorBox error={adaptive.error} onRetry={adaptive.reload} /> : (
          <View style={{ gap: 10 }}>
            {!a || !hasAdaptive ? (
              <Empty emoji="🏅" title={t('para.coach_no_para_sports')} sub={t('para.coach_no_para_sub')} />
            ) : (
              a.expertise.map((e) => (
                <Card key={e.id} pad={14} style={{ gap: 6 }} accessibilityLabel={[e.discipline, e.state].join(' · ')}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <T weight="800" size={14} style={{ flexShrink: 1 }}>{e.credential ?? t(`inc.tpl_${e.discipline}`)}</T>
                    <StateBadge state={e.state} />
                  </View>
                  {e.authority ? <T size={12} color={c.mute}>{t('adp.issuer', { name: e.authority })}{e.valid_to ? ` · ${t('adp.valid_to', { date: e.valid_to })}` : ''}</T> : null}
                </Card>
              ))
            )}
            {hasAdaptive && a.expertise.length ? (
              <T size={12} color={c.mute}>{t('adp.disclaimer')}</T>
            ) : null}
          </View>
        )}
      </Block>

      {/* Para classifier credentials (if any) */}
      {paraClassifiers.length ? (
        <Block title={t('para.coach_officiating_title')}>
          {paraClassifiers.map((k) => (
            <Card key={k.id} pad={14} style={{ gap: 6 }} accessibilityLabel={[k.sport, k.grade, k.live ? t('para.live') : label('credstate', k.status)].join(' · ')}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <T weight="800" size={14}>{k.sport}{k.discipline ? ` · ${k.discipline}` : ''}</T>
                <Tag label={k.live ? t('para.live') : label('credstate', k.status)} color={k.live ? c.limeSoft : c.orangeSoft} />
              </View>
              <T size={12} color={c.mute}>{k.issuing_body} · {k.grade}{k.class_codes?.length ? ` · ${k.class_codes.join(', ')}` : ''}</T>
              <T size={12} color={c.mute}>{t('para.expires', { date: short(k.expires_on) })}</T>
            </Card>
          ))}
        </Block>
      ) : (
        <Block title={t('para.coach_officiating_title')}>
          <Empty emoji="🪪" title={t('para.coach_officiating_none')} sub={t('para.no_credential_sub')} />
        </Block>
      )}
    </View>
  );
}

// ------------------------------------------------------------------ athlete / guardian
function Mine({ athleteId, wards, onWard }) {
  const { toast } = useSession();
  const { tablet } = useLayout();
  const d = useLoad(() => api.get('/me/para-classification', athleteId ? { athlete_id: athleteId } : {}), [athleteId]);
  const defs = useLoad(() => api.get('/para/class-versions', { limit: 100 }), []);
  const cov = useLoad(() => api.get('/para/coverage', { para: true, limit: 200 }), []);
  const [startVisible, setStartVisible] = useState(false);
  const [form, setForm] = useState(null), [caseId, setCaseId] = useState(null);
  const x = d.data;
  const run = useRun(toast, d.reload);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!x) return <Loading />;
  const published = (defs.data?.versions ?? []).filter((v) => v.status === 'published');
  const coverage = cov.data?.sports ?? [];
  const open = x.cases.filter((k) => ['submitted', 'evidence_review', 'assessment_scheduled', 'assessment_completed', 'panel_review'].includes(k.status));
  const next = x.outcomes.map((o) => o.review_by).filter(Boolean).sort()[0];
  const hasActions = x.pending_actions.length > 0;
  return (
    <View style={{ gap: 18 }}>
      <Disclaimer />
      {wards.length ? <MenuField label={t('para.acting_for')} value={athleteId ?? ''} onChange={(v) => onWard(v || null)} options={[{ value: '', label: t('para.myself') }, ...wards.map((w) => ({ value: w.id, label: w.name }))]} /> : null}
      <Row2>
        <Kpi label={t('para.kpi_classes')} value={String(x.outcomes.length)} sub={t('para.kpi_classes_sub')} />
        <Kpi label={t('para.kpi_open')} value={String(open.length)} sub={t('para.kpi_open_sub')} />
        <Kpi label={t('para.kpi_review')} value={short(next)} sub={t('para.kpi_review_sub')} tone={x.pending_actions.some((a) => a.kind === 'review_due') ? 'alert' : undefined} />
        <Kpi label={t('para.kpi_actions')} value={String(x.pending_actions.length)} sub={t('para.kpi_actions_sub')} tone={hasActions ? 'alert' : undefined} />
      </Row2>
      <ParaEntries athleteId={athleteId} />

      {/* Pending actions — prominent when present */}
      {hasActions ? (
        <Block title={t('para.next_steps')}>
          {x.pending_actions.map((a, i) => (
            <Card key={i} pad={14} style={{ borderLeftWidth: 4, borderLeftColor: a.kind === 'review_due' ? c.red : c.orange }}>
              <T size={14} weight="800">
                {a.kind === 'appointment' ? t('para.appointment', { at: when(a.at) }) : a.kind === 'review_due' ? t('para.review_by', { date: a.by }) : a.label ? t('para.evidence_may_be_asked') : ''}
              </T>
            </Card>
          ))}
        </Block>
      ) : null}

      {/* Current classifications — rich cards */}
      <Block title={t('para.current')} right={<Btn small title={t('para.start')} onPress={() => setStartVisible(true)} />}>
        {x.outcomes.length ? (
          <View style={{ gap: 10, flexDirection: tablet ? 'row' : 'column', flexWrap: 'wrap' }}>
            {x.outcomes.map((o) => (
              <Card key={o.id} pad={18} style={{ gap: 10, flexGrow: 1, flexBasis: tablet ? 300 : '100%', borderWidth: o.review_overdue ? 2 : 1, borderColor: o.review_overdue ? c.orange : c.line }} accessibilityLabel={join(o.sport, o.class_code, label('status', o.status), o.authority)}>
                <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.5, textTransform: 'uppercase' }}>{o.sport}{o.discipline ? ` · ${o.discipline}` : ''}</T>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <T size={42} weight="900" style={{ letterSpacing: -1.5 }}>{o.class_code ?? '—'}</T>
                  <View style={{ gap: 6 }}>
                    <Tag label={label('status', o.status)} color={TONE[o.status]} />
                    {o.review_overdue ? <Tag label={t('para.review_due')} color={c.orangeSoft} /> : null}
                    {o.appeal ? <Tag label={dot(label('appeal', o.appeal.kind), label('appealstate', o.appeal.status))} color={c.sunSoft} /> : null}
                  </View>
                </View>
                <View style={{ gap: 5 }}>
                  <T size={13} weight="800">{t('para.issued_by', { authority: o.authority })}</T>
                  <T size={12} color={c.mute}>{[o.decision_ref, t('para.version', { n: o.version })].filter(Boolean).join(' · ')}</T>
                  <T size={12} color={c.mute}>{t('para.effective', { date: short(o.effective_from) })}</T>
                  {o.review_by ? <T size={12} color={o.review_overdue ? c.orange : c.mute} weight={o.review_overdue ? '800' : '400'}>{t('para.review_by', { date: short(o.review_by) })}</T> : null}
                  {o.expires_on ? <T size={12} color={c.mute}>{t('para.expires', { date: short(o.expires_on) })}</T> : null}
                </View>
                {(!o.appeal || o.appeal.status !== 'open') && o.appeal_open_until ? (
                  <Btn small color={c.paper} ink={c.ink} title={t('para.ask_review', { date: o.appeal_open_until })} onPress={() => setForm({ appeal: o })} />
                ) : null}
              </Card>
            ))}
          </View>
        ) : <Empty emoji="🏅" title={t('para.none')} sub={t('para.none_sub')} />}
      </Block>

      {/* Open cases — stage tracker with detail */}
      <Block title={t('para.cases')}>
        {x.cases.length ? x.cases.map((k) => (
          <Card key={k.id} pad={16} onPress={() => setCaseId(k.id)} style={{ gap: 10 }} accessibilityLabel={join(k.sport, k.authority, label('stage', k.status))}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
              <View style={{ flexShrink: 1 }}>
                <T weight="800" size={14}>{k.sport}{k.discipline ? ` · ${k.discipline}` : ''}</T>
                <T size={12} color={c.mute} style={{ marginTop: 2 }}>{k.authority}</T>
              </View>
              <Tag label={label('context', k.requested_context)} color={c.cyanSoft} />
            </View>
            <StageTrack status={k.status} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {k.appointment_on ? <T size={12} color={c.mute}>{t('para.appointment', { at: when(k.appointment_on) })}</T> : null}
              <T size={12} color={c.mute}>{t('para.age_days', { n: k.age_days })}</T>
            </View>
          </Card>
        )) : <Empty emoji="📋" title={t('para.no_cases')} sub={t('para.no_cases_sub')} />}
      </Block>

      {x.external_references.length ? (
        <Block title={t('para.external')}>
          {x.external_references.map((e) => (
            <Card key={e.id} pad={14} style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <T weight="800">{e.sport} · {e.class_code}</T>
                <Tag label={label('verify', e.verification)} color={e.verification === 'verified' ? c.limeSoft : c.sunSoft} />
              </View>
              <T size={12} color={c.mute}>{e.authority} · {label('status', e.status)}</T>
            </Card>
          ))}
        </Block>
      ) : null}

      {/* 3-step classification starter */}
      <StartClassificationSheet visible={startVisible} onClose={() => setStartVisible(false)} published={published} coverage={coverage} athleteId={athleteId} onDone={d.reload} />

      <FormSheet visible={!!form?.appeal} onClose={() => setForm(null)} title={t('para.ask_review_title')} notice={t('para.appeal_notice')}
        fields={[{ key: 'kind', label: t('para.f_kind'), type: 'chips', options: ['review', 'protest', 'appeal'].map((k) => ({ value: k, label: label('appeal', k) })) }, { key: 'grounds', label: t('para.f_grounds'), type: 'multiline' }]}
        initial={{ kind: 'review' }}
        onSubmit={async (val) => { await api.post(`/para/outcomes/${form.appeal.id}/appeals`, val); toast(t('para.appeal_lodged')); await d.reload(); }} />
      <CaseSheet id={caseId} onClose={() => setCaseId(null)} reload={d.reload} />
    </View>
  );
}

// ------------------------------------------------------------------ classifier
function Desk({ desk }) {
  const { toast } = useSession();
  const cases = useLoad(() => api.get('/para/cases', { scope: 'assigned' }), []);
  const appeals = useLoad(() => api.get('/para/appeals', { scope: 'assigned' }), []);
  const [caseId, setCaseId] = useState(null), [ruling, setRuling] = useState(null);
  const run = useRun(toast, async () => { await cases.reload(); await appeals.reload(); });
  const liveCount = desk.classifier.filter((k) => k.live).length;
  return (
    <View style={{ gap: 18 }}>
      <Disclaimer />
      <Row2>
        <Kpi label={t('para.kpi_credentials')} value={`${liveCount}/${desk.classifier.length}`} sub={t('para.kpi_credentials_sub')} tone={liveCount === 0 ? 'alert' : undefined} />
        <Kpi label={t('para.kpi_assigned')} value={String(desk.assigned_cases)} sub={t('para.kpi_assigned_sub')} />
        <Kpi label={t('para.kpi_appeals')} value={String(desk.assigned_appeals)} sub={t('para.kpi_appeals_sub')} tone={desk.assigned_appeals ? 'alert' : undefined} />
        <Kpi label={t('para.kpi_desk_decided')} value={String((cases.data?.cases ?? []).filter((k) => k.panel_decided === k.panel_assigned && k.panel_assigned > 0).length)} sub={t('para.kpi_desk_decided_sub')} />
      </Row2>

      <Block title={t('para.credentials')}>
        {desk.classifier.length ? desk.classifier.map((k) => (
          <Card key={k.id} pad={14} style={{ gap: 6 }} accessibilityLabel={join(k.sport, k.grade, k.live ? t('para.live') : label('credstate', k.status))}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <T weight="800" size={14}>{k.sport}{k.discipline ? ` · ${k.discipline}` : ''}</T>
              <Tag label={k.live ? t('para.live') : label('credstate', k.status)} color={k.live ? c.limeSoft : c.orangeSoft} />
            </View>
            <T size={12} color={c.mute}>{k.issuing_body} · {k.grade} · {k.class_codes?.length ? k.class_codes.join(', ') : t('para.all_classes')}</T>
            <T size={12} color={c.mute}>{t('para.expires', { date: short(k.expires_on) })}</T>
          </Card>
        )) : <Empty emoji="🪪" title={t('para.no_credential')} sub={t('para.no_credential_sub')} />}
      </Block>

      <Block title={t('para.assigned_cases')}>
        {cases.data?.cases?.length ? cases.data.cases.map((k) => {
          const needsDecision = k.status === 'panel_review' && k.panel_decided < k.panel_assigned;
          return (
            <Card key={k.id} pad={16} onPress={() => setCaseId(k.id)} style={{ gap: 10, borderLeftWidth: needsDecision ? 4 : 0, borderLeftColor: c.pink }} accessibilityLabel={join(k.sport, label('stage', k.status))}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                <View style={{ flexShrink: 1 }}>
                  <T weight="800" size={14}>{k.athlete}</T>
                  <T size={12} color={c.mute} style={{ marginTop: 2 }}>{k.sport}{k.discipline ? ` · ${k.discipline}` : ''}</T>
                </View>
                {needsDecision ? <Tag label={t('para.desk_record_now')} color={c.pinkSoft} /> : null}
              </View>
              <StageTrack status={k.status} />
              <T size={12} color={c.mute}>{t('para.panel_progress', { done: k.panel_decided, total: k.panel_assigned })} · {t('para.age_days', { n: k.age_days })}</T>
            </Card>
          );
        }) : <Empty emoji="📋" title={t('para.no_assigned')} sub={t('para.no_assigned_sub')} />}
      </Block>

      <Block title={t('para.reviews')}>
        {appeals.data?.appeals?.length ? appeals.data.appeals.map((a) => (
          <Card key={a.id} pad={16} style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <View style={{ flexShrink: 1 }}>
                <T weight="800" size={14}>{a.athlete} · {a.sport}</T>
                <T size={12} color={c.mute} style={{ marginTop: 2 }}>{a.class_code ?? '—'} · {t('para.deadline', { date: a.deadline_on })}</T>
              </View>
              <Tag label={dot(label('appeal', a.kind), label('appealstate', a.status))} color={c.sunSoft} />
            </View>
            <T size={13} color={c.ink}>{a.grounds}</T>
            {a.status === 'open' ? <Btn small title={t('para.rule')} onPress={() => setRuling(a)} /> : null}
          </Card>
        )) : <Empty emoji="⚖️" title={t('para.no_reviews')} sub={t('para.no_reviews_sub')} />}
      </Block>

      <FormSheet visible={!!ruling} onClose={() => setRuling(null)} title={t('para.rule')} notice={t('para.rule_notice')}
        fields={[{ key: 'ruling', label: t('para.f_ruling'), type: 'chips', options: ['upheld', 'dismissed'].map((k) => ({ value: k, label: label('appealstate', k) })) },
          { key: 'class_code', label: t('para.f_class_new'), type: 'text', optional: true, show: (v) => v.ruling === 'upheld' },
          { key: 'status', label: t('para.f_status'), type: 'chips', optional: true, show: (v) => v.ruling === 'upheld', options: STATUSES.map((s) => ({ value: s, label: label('status', s) })) },
          { key: 'note', label: t('para.f_reason'), type: 'multiline' }]}
        onSubmit={async (val) => { await run(() => api.post(`/para/appeals/${ruling.id}/rule`, { ...val, class_code: val.class_code || undefined, status: val.status || undefined }), t('para.ruled')); }} />
      <CaseSheet id={caseId} onClose={() => setCaseId(null)} reload={cases.reload} />
    </View>
  );
}

// ------------------------------------------------------------------ governing body
function Authority({ desk }) {
  const { toast } = useSession();
  const { tablet } = useLayout();
  const [bodyId, setBodyId] = useState(desk.governs[0]?.id);
  const queue = useLoad(() => api.get('/para/cases', { scope: 'body', body_id: bodyId, limit: 100 }), [bodyId]);
  const versions = useLoad(() => api.get('/para/class-versions', { body_id: bodyId, limit: 50 }), [bodyId]);
  const classifiers = useLoad(() => api.get('/para/classifiers', { body_id: bodyId }), [bodyId]);
  const appeals = useLoad(() => api.get('/para/appeals', { scope: 'body', body_id: bodyId }), [bodyId]);
  const refs = useLoad(() => api.get('/para/external-refs', { body_id: bodyId }), [bodyId]);
  const [form, setForm] = useState(null), [caseId, setCaseId] = useState(null), [rows, setRows] = useState([{ code: '', name: '' }]);
  const reloadAll = async () => { await Promise.all([queue, versions, classifiers, appeals, refs].map((l) => l.reload())); };
  const run = useRun(toast, reloadAll);
  const body = desk.governs.find((b) => b.id === bodyId);
  const by = queue.data?.by_status ?? {};
  const bodySports = useLoad(() => api.get('/federation/bodies', { limit: 100 }), []);
  const sportOptions = useMemo(() => (bodySports.data?.bodies ?? bodySports.data ?? []).find?.((b) => b.id === bodyId)?.sports?.map((s) => ({ value: s.sport_id, label: `${s.emoji ?? ''} ${s.name}`.trim() })) ?? [], [bodySports.data, bodyId]);
  return (
    <View style={{ gap: 18 }}>
      <Disclaimer />
      {desk.governs.length > 1 ? <MenuField label={t('para.authority')} value={bodyId} onChange={setBodyId} options={desk.governs.map((b) => ({ value: b.id, label: b.name }))} /> : <T weight="800" size={16}>{body?.name}</T>}
      <Row2>
        <Kpi label={t('para.kpi_queue')} value={String(STAGES.slice(0, 5).reduce((n, s) => n + (by[s] ?? 0), 0))} sub={t('para.kpi_queue_sub')} />
        <Kpi label={t('para.kpi_panel_review')} value={String(by.panel_review ?? 0)} sub={t('para.kpi_panel_review_sub')} />
        <Kpi label={t('para.kpi_classifiers')} value={String((classifiers.data?.classifiers ?? []).filter((k) => k.live).length)} sub={t('para.kpi_classifiers_sub')} />
        <Kpi label={t('para.kpi_open_reviews')} value={String((appeals.data?.appeals ?? []).filter((a) => a.status === 'open').length)} sub={t('para.kpi_open_reviews_sub')} />
      </Row2>
      <Block title={t('para.queue')}>
        {queue.data?.cases?.length ? queue.data.cases.map((k) => (
          <Card key={k.id} pad={14} onPress={() => setCaseId(k.id)} style={{ gap: 8 }} accessibilityLabel={join(k.athlete, k.sport, label('stage', k.status))}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800">{k.athlete} · {k.sport}</T><T size={12} color={c.mute}>{t('para.age_days', { n: k.age_days })}</T></View>
            <StageTrack status={k.status} /><T size={12} color={c.mute}>{t('para.panel_progress', { done: k.panel_decided, total: k.panel_assigned })}</T>
          </Card>
        )) : <Empty emoji="📥" title={t('para.queue_empty')} sub={t('para.queue_empty_sub')} />}
      </Block>
      <Block title={t('para.definitions')} right={<Btn small title={t('para.new_version')} onPress={() => setForm('version')} />}>
        {versions.data?.versions?.length ? versions.data.versions.map((v) => (
          <Card key={v.id} pad={14} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800">{v.sport}{v.discipline ? ` · ${v.discipline}` : ''} · {t('para.version', { n: v.version })}</T><Tag label={v.deprecated_at ? t('ps.state.deprecated') : v.status === 'draft' ? t(`ps.approval.${v.approval_status}`) : label('vstate', v.status)} color={v.status === 'published' ? c.limeSoft : v.status === 'draft' ? c.sunSoft : c.violetSoft} /></View>
            <T size={13} color={c.mute}>{v.title} · {t('para.panel_size', { n: v.panel_size })} · {t('para.appeal_days', { n: v.appeal_days })}</T>
            <T size={13}>{v.classes.map((k) => k.code).join(' · ')}</T>
            {v.publisher || v.source_url ? <T size={12} color={c.mute}>{[v.publisher, v.source_url].filter(Boolean).join(' · ')}</T> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {v.status === 'draft' && v.approval_status === 'draft' && v.source_url ? <Btn small color={c.cyan} title={t('ps.act_submit')} onPress={() => run(() => api.post(`/para/class-versions/${v.id}/submit`, {}), t('ps.submitted'))} /> : null}
              {v.status === 'draft' && v.approval_status === 'submitted' ? <Btn small color={c.paper} ink={c.red} title={t('ps.act_reject')} onPress={() => setForm({ reject: v })} /> : null}
              {v.status === 'draft' && v.approval_status !== 'rejected' && (!v.source_url || v.approval_status === 'submitted') ? <Btn small title={t('para.publish')} onPress={() => run(() => api.post(`/para/class-versions/${v.id}/publish`, {}), t('para.published'))} /> : null}
              {v.status === 'published' ? <Btn small color={c.paper} ink={c.red} title={t('ps.act_deprecate')} onPress={() => setForm({ deprecate: v })} /> : null}
              {v.status === 'retired' ? <Btn small color={c.paper} ink={c.ink} title={t('ps.act_rollback')} onPress={() => setForm({ rollback: v })} /> : null}
            </View>
          </Card>
        )) : <Empty emoji="📘" title={t('para.no_definitions')} sub={t('para.no_definitions_sub')} />}
      </Block>
      <Block title={t('para.classifiers')} right={<Btn small title={t('para.grant')} onPress={() => setForm('grant')} />}>
        {classifiers.data?.classifiers?.length ? classifiers.data.classifiers.map((k) => (
          <Card key={k.id} pad={12} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800">{k.name} · {k.sport}</T><Tag label={k.live ? t('para.live') : label('credstate', k.status)} color={k.live ? c.limeSoft : c.orangeSoft} /></View>
            <T size={12} color={c.mute}>{k.grade} · {t('para.expires', { date: k.expires_on })}</T>
            {k.status === 'active' ? <Btn small color={c.paper} ink={c.red} title={t('para.suspend')} onPress={() => setForm({ end: k, action: 'suspend' })} /> : k.status === 'suspended' ? <Btn small title={t('para.reinstate')} onPress={() => setForm({ end: k, action: 'reinstate' })} /> : null}
          </Card>
        )) : <T size={13} color={c.mute}>{t('para.no_classifiers')}</T>}
      </Block>
      <Block title={t('para.reviews')}>
        {appeals.data?.appeals?.length ? appeals.data.appeals.map((a) => (
          <Card key={a.id} pad={12} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800">{a.athlete} · {a.sport}</T><Tag label={dot(label('appeal', a.kind), label('appealstate', a.status))} color={c.sunSoft} /></View>
            <T size={12} color={c.mute}>{t('para.deadline', { date: a.deadline_on })} · {a.reviewer_assigned ? t('para.reviewer_set') : t('para.reviewer_needed')}</T>
            {a.status === 'open' && !a.reviewer_assigned ? <Btn small title={t('para.assign_reviewer')} onPress={() => setForm({ reviewer: a })} /> : null}
          </Card>
        )) : <T size={13} color={c.mute}>{t('para.no_reviews')}</T>}
      </Block>
      <Block title={t('para.external')} right={<Btn small title={t('para.record_ref')} onPress={() => setForm('ref')} />}>
        <T size={12} color={c.mute}>{t('para.external_note')}</T>
        {refs.data?.references?.length ? refs.data.references.map((r) => (
          <Card key={r.id} pad={12} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800">{r.athlete} · {r.sport} · {r.class_code}</T><Tag label={label('verify', r.status)} color={r.status === 'verified' ? c.limeSoft : c.sunSoft} /></View>
            <T size={12} color={c.mute}>{r.provenance}</T>
            {r.status === 'unverified' ? <Btn small title={t('para.verify')} onPress={() => run(() => api.post(`/para/external-refs/${r.id}/verify`, { decision: 'verified' }), t('para.verified'))} /> : null}
          </Card>
        )) : <T size={13} color={c.mute}>{t('para.no_refs')}</T>}
      </Block>

      <Sheet visible={form === 'version'} onClose={() => setForm(null)} title={t('para.new_version')}>
        <FormSheet inline onClose={() => setForm(null)} notice={t('para.version_notice')}
          fields={[{ key: 'sport', label: t('para.f_sport'), type: 'chips', options: sportOptions },
            { key: 'discipline', label: t('para.f_discipline'), type: 'text', optional: true }, { key: 'title', label: t('para.f_title'), type: 'text' }, { key: 'source_ref', label: t('para.f_source'), type: 'text', hint: t('para.f_source_hint') },
            { key: 'publisher', label: t('ps.publisher'), type: 'text', optional: true }, { key: 'source_url', label: t('ps.source'), type: 'text', optional: true, hint: t('ps.f_source_url_hint') },
            { key: 'scope_countries', label: t('ps.scope'), type: 'countries', optional: true, hint: t('ps.f_scope_hint') },
            { key: 'event_categories', label: t('ps.categories'), type: 'text', optional: true, hint: t('ps.f_list_hint') }, { key: 'adaptations', label: t('ps.adaptations'), type: 'text', optional: true, hint: t('ps.f_list_hint') },
            { key: 'permitted_roles', label: t('ps.roles'), type: 'multi', optional: true, options: ROLES.map((r) => ({ value: r, label: t(`ps.role.${r}`) })) },
            { key: 'classification_required', label: t('ps.class_req'), type: 'switch', default: true },
            { key: 'effective_from', label: t('para.f_effective'), type: 'date' }, { key: 'panel_size', label: t('para.f_panel_size'), type: 'stepper', min: 1, max: 7, default: 1 },
            { key: 'appeal_days', label: t('para.f_appeal_days'), type: 'stepper', min: 1, max: 365, default: 14, suffix: t('para.days') },
            { key: 'review_rule', label: t('para.f_review_rule'), type: 'chips', options: ['none', 'fixed_term', 'review_required'].map((k) => ({ value: k, label: label('rule', k) })) },
            { key: 'review_months', label: t('para.f_review_months'), type: 'stepper', min: 1, max: 240, default: 24, show: (v) => v.review_rule && v.review_rule !== 'none' }]}
          initial={{ review_rule: 'none', panel_size: 1, appeal_days: 14 }}
          submitLabel={t('para.next')}
          onSubmit={async (val) => { setForm({ classes: val }); }} />
      </Sheet>
      <Sheet visible={!!form?.classes} onClose={() => setForm(null)} title={t('para.classes')}>
        <View style={{ gap: 10 }}>
          {rows.map((r, i) => (
            <FormSheet key={i} inline hideSubmit onClose={() => {}} fields={[{ key: 'code', label: t('para.f_code'), type: 'text' }, { key: 'name', label: t('para.f_class_name'), type: 'text' }]} initial={r} onChange={(val) => setRows((all) => all.map((x, j) => (j === i ? { ...x, ...val } : x)))} />
          ))}
          <Btn small color={c.paper} ink={c.ink} title={t('para.add_class')} onPress={() => setRows((all) => [...all, { code: '', name: '' }])} />
          <Btn title={t('para.save_draft')} onPress={async () => {
            const v = form.classes; const s = [].concat(v.sport)[0];
            await run(() => api.post('/para/class-versions', { body_id: bodyId, sport_id: s, discipline: v.discipline || '', title: v.title, source_ref: v.source_ref, effective_from: v.effective_from, panel_size: v.panel_size, appeal_days: v.appeal_days, review_rule: v.review_rule, review_months: v.review_rule !== 'none' ? v.review_months : undefined, publisher: v.publisher || undefined, source_url: v.source_url || undefined, scope_countries: v.scope_countries?.length ? v.scope_countries : undefined, event_categories: list(v.event_categories), adaptations: list(v.adaptations), permitted_roles: v.permitted_roles?.length ? v.permitted_roles : undefined, classification_required: v.classification_required, classes: rows.filter((r) => r.code && r.name) }), t('para.drafted'));
            setForm(null); setRows([{ code: '', name: '' }]);
          }} />
        </View>
      </Sheet>
      <FormSheet visible={form === 'grant'} onClose={() => setForm(null)} title={t('para.grant')} notice={t('para.grant_notice')}
        fields={[{ key: 'user_id', label: t('para.f_person'), type: 'entity', entityKind: 'person', noun: t('para.person') }, { key: 'sport', label: t('para.f_sport'), type: 'chips', options: sportOptions },
          { key: 'discipline', label: t('para.f_discipline'), type: 'text', optional: true }, { key: 'grade', label: t('para.f_grade'), type: 'text' }, { key: 'credential_no', label: t('para.f_credential_no'), type: 'text', optional: true },
          { key: 'issued_on', label: t('para.f_issued'), type: 'date' }, { key: 'expires_on', label: t('para.f_expires'), type: 'date' }]}
        onSubmit={async (val) => { await api.post('/para/classifiers', { body_id: bodyId, user_id: val.user_id, sport_id: [].concat(val.sport)[0], discipline: val.discipline || '', grade: val.grade, credential_no: val.credential_no || undefined, issued_on: val.issued_on, expires_on: val.expires_on }); toast(t('para.granted')); await reloadAll(); }} />
      <FormSheet visible={!!form?.reject} onClose={() => setForm(null)} title={t('ps.act_reject')} fields={[{ key: 'reason', label: t('ps.reason'), type: 'multiline' }]}
        onSubmit={async (val) => { await api.post(`/para/class-versions/${form.reject.id}/reject`, { reason: val.reason }); await reloadAll(); }} />
      <FormSheet visible={!!form?.deprecate} onClose={() => setForm(null)} title={t('ps.act_deprecate')} notice={t('ps.deprecate_notice')} fields={[{ key: 'reason', label: t('ps.reason'), type: 'multiline' }]}
        onSubmit={async (val) => { await api.post(`/para/class-versions/${form.deprecate.id}/deprecate`, { reason: val.reason }); await reloadAll(); }} />
      <FormSheet visible={!!form?.rollback} onClose={() => setForm(null)} title={t('ps.act_rollback')} notice={t('ps.rollback_notice')}
        fields={[{ key: 'effective_from', label: t('para.f_effective'), type: 'date' }, { key: 'reason', label: t('ps.reason'), type: 'multiline' }]}
        onSubmit={async (val) => { await api.post(`/para/class-versions/${form.rollback.id}/rollback`, { reason: val.reason, effective_from: val.effective_from }); await reloadAll(); }} />
      <FormSheet visible={!!form?.end} onClose={() => setForm(null)} title={form?.action ? t(`para.${form.action}`) : ''}
        fields={[{ key: 'reason', label: t('para.f_reason'), type: 'multiline' }]}
        onSubmit={async (val) => { await api.post(`/para/classifiers/${form.end.id}/end`, { action: form.action, reason: val.reason }); await reloadAll(); }} />
      <FormSheet visible={!!form?.reviewer} onClose={() => setForm(null)} title={t('para.assign_reviewer')} notice={t('para.reviewer_notice')}
        fields={[{ key: 'classifier', label: t('para.f_classifier'), type: 'multimenu', max: 1, load: async () => (classifiers.data?.classifiers ?? []).filter((k) => k.live).map((k) => ({ value: k.id, label: k.name, sub: k.sport })) }]}
        onSubmit={async (val) => { await api.post(`/para/appeals/${form.reviewer.id}/reviewer`, { classifier_id: [].concat(val.classifier)[0] }); toast(t('para.assigned')); await reloadAll(); }} />
      <FormSheet visible={form === 'ref'} onClose={() => setForm(null)} title={t('para.record_ref')} notice={t('para.ref_notice')}
        fields={[{ key: 'athlete_id', label: t('para.f_athlete'), type: 'entity', entityKind: 'person', noun: t('para.athlete') }, { key: 'sport', label: t('para.f_sport'), type: 'chips', options: sportOptions },
          { key: 'external_id', label: t('para.f_external_id'), type: 'text' }, { key: 'class_code', label: t('para.f_class_new'), type: 'text' }, { key: 'class_status', label: t('para.f_status'), type: 'chips', options: STATUSES.map((s) => ({ value: s, label: label('status', s) })) },
          { key: 'effective_from', label: t('para.f_effective'), type: 'date' }, { key: 'review_by', label: t('para.f_review_by'), type: 'date', optional: true }, { key: 'provenance', label: t('para.f_provenance'), type: 'text' }]}
        initial={{ class_status: 'confirmed' }}
        onSubmit={async (val) => { await api.post('/para/external-refs', { body_id: bodyId, athlete_id: val.athlete_id, sport_id: [].concat(val.sport)[0], external_id: val.external_id, class_code: val.class_code, class_status: val.class_status, effective_from: val.effective_from, review_by: val.review_by || undefined, provenance: val.provenance }); toast(t('para.ref_recorded')); await reloadAll(); }} />
      <CaseSheet id={caseId} onClose={() => setCaseId(null)} reload={reloadAll} />
    </View>
  );
}

// ------------------------------------------------------------------ screen
export function ParaClassification() {
  const { user } = useSession();
  const desk = useLoad(() => api.get('/me/para-desk'), []);
  const [tab, setTab] = useState('me'), [ward, setWard] = useState(null);
  if (desk.error) return <Screen><ErrorBox error={desk.error} onRetry={desk.reload} /></Screen>;
  if (!desk.data) return <Screen><Loading /></Screen>;
  const d = desk.data;
  const isPlatAdmin = desk.data ? (user?.roles?.includes('platform_admin') ?? false) : false;
  const isCoach = user?.roles?.includes('coach') ?? false;
  const tabs = [
    ['me', t('para.tab_me')],
    ...(isCoach ? [['coach_para', t('para.tab_coach')]] : []),
    ['disciplines', t('ps.tab')],
    ['regional', t('psr.title')],
    ...(d.classifier.length ? [['desk', t('para.tab_desk')]] : []),
    ...(d.governs.length ? [['authority', t('para.tab_authority')]] : []),
    ...(isPlatAdmin ? [['source_reviews', t('psr.source_review_title')]] : []),
  ];
  return (
    <Screen wide onRefresh={desk.reload}>
      <View style={{ gap: 14 }}>
        <T size={26} weight="800" accessibilityRole="header">{t('para.title')}</T>
        {tabs.length > 1 ? <Seg options={tabs.map(([v, l]) => ({ value: v, label: l }))} value={tab} onChange={setTab} /> : null}
        {tab === 'me' ? <Mine athleteId={ward} wards={d.wards} onWard={setWard} /> : tab === 'coach_para' ? <CoachParaCredentials desk={d} /> : tab === 'disciplines' ? <ParaDisciplines /> : tab === 'regional' ? <ParaRegional /> : tab === 'desk' ? <Desk desk={d} /> : tab === 'authority' ? <Authority desk={d} /> : tab === 'source_reviews' ? <ParaSourceReviews /> : null}
      </View>
    </Screen>
  );
}
