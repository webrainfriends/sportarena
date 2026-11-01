// Eligibility screening and application validation (#287). Not a screen of its own: these pieces live inside the program page (rules),
// the application review sheet (screening, requests, exceptions) and the applicant's own application / apply flow (plain reasons).
// Every action calls the API (the server decides who may); this only hides what a role cannot use.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { t } from '../i18n';
import { Btn, Card, Chip, Empty, Field, Loading, Section, Sheet, T, Tag } from '../ui';
import { parseAmount } from '../money';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';

export const OUTCOME_TONE = { eligible: c.lime, needs_info: c.sunSoft, ineligible: c.pinkSoft, review: c.violetSoft };
const OUTCOME_KEY = { eligible: 'scr.outcome_eligible', needs_info: 'scr.outcome_needs_info', ineligible: 'scr.outcome_ineligible', review: 'scr.outcome_review' };
const MARK = { met: '✔', unmet: '✖', unknown: '?' };
const MARK_KEY = { met: 'scr.met', unmet: 'scr.unmet', unknown: 'scr.unknown' };
const TARGETS = ['athlete', 'team', 'event'];
/** The documents a brand can require, picked from a catalogue; each becomes an upload question of the application form with the same key. */
export const DOCUMENTS = [
  { key: 'id_proof', label: 'scr.doc_id' }, { key: 'registration_proof', label: 'scr.doc_registration' }, { key: 'medical_clearance', label: 'scr.doc_medical' },
  { key: 'guardian_consent', label: 'scr.doc_guardian' }, { key: 'payout_proof', label: 'scr.doc_payout' }, { key: 'tax_document', label: 'scr.doc_tax' },
];

export const OutcomeTag = ({ outcome }) => <Tag label={outcome ? t(OUTCOME_KEY[outcome]) : t('scr.not_screened')} color={OUTCOME_TONE[outcome] ?? c.paper} />;

/** Reasons met / not met / not known, then what is missing, then possible duplicates. Colour is never the only signal: each row has a mark and a word. */
export function Reasons({ run }) {
  if (!run) return null;
  return (
    <View style={{ gap: 6 }}>
      {run.reasons.length ? run.reasons.map((r, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }} accessible accessibilityLabel={`${t(MARK_KEY[r.status])}. ${r.message}`}>
          <T weight="900" color={r.status === 'unmet' ? c.red : r.status === 'met' ? c.ink : c.mute} style={{ width: 18 }}>{MARK[r.status]}</T>
          <T size={13} style={{ flex: 1 }}>{r.message}</T>
        </View>
      )) : <T size={12} color={c.mute}>{t('scr.no_rules')}</T>}
      {run.missing.length ? (
        <View style={{ gap: 4, marginTop: 4 }}>
          <T weight="800" size={13}>{t('scr.missing')}</T>
          {run.missing.map((m) => <T key={m.key} size={13}>• {m.label}</T>)}
        </View>
      ) : null}
      {run.duplicate_flags?.length ? (
        <View style={{ gap: 4, marginTop: 4 }} accessibilityRole="alert">
          <T weight="800" size={13}>{t('scr.dups')}</T>
          {run.duplicate_flags.map((f, i) => <T key={i} size={13}>• {f.note}</T>)}
        </View>
      ) : null}
    </View>
  );
}

/** The latest screening of one application. Applicant: plain reasons. Brand managers/approvers: also re-screen, ask for information, grant or revoke an exception. */
export function ScreeningPanel({ applicationId, may, onChanged }) {
  const { toast } = useSession();
  const s = useLoad(() => api.get(`/program-applications/${applicationId}/screening`), [applicationId]);
  const [stale, setStale] = useState(false);
  const [sheet, setSheet] = useState(null); // 'ask' | 'exception'
  const [msg, setMsg] = useState('');
  const d = s.data;
  const act = async (fn, ok) => {
    try { await fn(); toast(ok); setStale(false); setSheet(null); setMsg(''); s.reload(); onChanged?.(); } catch (e) { toast(explain(e)); if (e.status === 409) { setStale(true); s.reload(); } }
  };
  if (s.error) return <LoadError error={s.error} onRetry={s.reload} />;
  if (s.loading && !d) return <Loading />;
  const canChange = may && ['submitted', 'returned'].includes(d.status);
  return (
    <View style={{ gap: 8 }} accessibilityLabel={t('scr.panel_title')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="900" style={{ flex: 1 }}>{t('scr.panel_title')}</T><OutcomeTag outcome={d.outcome} /></View>
      {stale ? <T size={12} color={c.red} accessibilityRole="alert">{t('scr.stale')}</T> : null}
      {!d.screened ? <T size={12} color={c.mute}>{t('scr.pre_feature')}</T> : (
        <>
          <T size={12} color={c.mute}>{t('scr.under_rules', { v: d.latest.rules_version })}</T>
          <Reasons run={d.latest} />
          {d.anonymized ? <T size={12} color={c.mute}>{t('scr.blind')}</T> : null}
        </>
      )}
      {d.exception ? (
        <Card color={c.sunSoft}>
          <T size={13} weight="800">{may ? t('scr.exc_live', { role: d.exception.authority_role }) : t('scr.exc_applicant')}</T>
          {may && d.exception.reason ? <T size={13}>{d.exception.reason}</T> : null}
          {d.exception.expires_at ? <T size={12} color={c.mute}>{t('scr.exc_until', { date: new Date(d.exception.expires_at).toLocaleDateString() })}</T> : null}
          {may && canChange ? <Btn small title={t('scr.exc_revoke')} color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 6 }} accessibilityLabel={t('scr.exc_revoke')} onPress={() => act(() => api.post(`/program-applications/${applicationId}/screening-exception/revoke`, { version: d.version }), t('scr.exc_revoked'))} /> : null}
        </Card>
      ) : null}
      {d.history.length ? <T size={12} color={c.mute}>{t('scr.earlier')}: {d.history.map((h) => `v${h.rules_version} · ${t(OUTCOME_KEY[h.outcome])}`).join(' · ')}</T> : null}
      {canChange ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title={t('scr.rescreen')} color={c.paper} ink={c.ink} accessibilityLabel={t('scr.rescreen')} onPress={() => act(() => api.post(`/program-applications/${applicationId}/screen`, { version: d.version }), t('scr.rescreened'))} />
          {d.latest?.missing?.length ? <Btn small title={t('scr.ask_info')} color={c.paper} ink={c.ink} accessibilityLabel={t('scr.ask_info')} onPress={() => setSheet('ask')} /> : null}
          {['needs_info', 'ineligible'].includes(d.outcome) && !d.exception ? <Btn small title={t('scr.exc_grant')} color={c.violet} accessibilityLabel={t('scr.exc_grant')} onPress={() => setSheet('exception')} /> : null}
        </View>
      ) : null}
      <Sheet visible={sheet === 'ask'} onClose={() => setSheet(null)} title={t('scr.ask_info')}>
        <Field label={t('scr.ask_msg')} value={msg} onChangeText={setMsg} multiline maxLength={1000} />
        <Btn title={t('scr.ask_send')} disabled={!msg.trim()} onPress={() => act(() => api.post(`/program-applications/${applicationId}/request-information`, { version: d.version, message: msg.trim() }), t('scr.asked'))} />
      </Sheet>
      <FormSheet visible={sheet === 'exception'} onClose={() => setSheet(null)} title={t('scr.exc_grant')} submitLabel={t('scr.exc_grant')}
        fields={[{ key: 'reason', label: t('scr.exc_reason'), type: 'multiline' }, { key: 'expires', label: t('scr.exc_expires'), type: 'date', optional: true }]}
        onSubmit={async (v) => {
          if (String(v.reason ?? '').trim().length < 20) throw new Error(t('scr.exc_short'));
          try { await api.post(`/program-applications/${applicationId}/screening-exception`, { version: d.version, reason: v.reason.trim(), ...(v.expires ? { expires_at: new Date(`${v.expires}T23:59:59`).toISOString() } : {}) }); } catch (e) { if (e.status === 409) { setStale(true); s.reload(); } throw e; }
          s.reload(); onChanged?.(); return t('scr.exc_granted');
        }} />
    </View>
  );
}

/** The program's rules: what is in force now, who may edit, and every earlier version. */
export function EligibilityRules({ program, may, onChanged }) {
  const { toast } = useSession();
  const [edit, setEdit] = useState(false);
  const v = useLoad(() => api.get(`/sponsorship-programs/${program.id}/eligibility`, { limit: 20 }), [program.id, program.row_version]);
  const cur = v.data?.items?.[0];
  const rules = cur?.rules;
  return (
    <Section title={t('scr.rules_title')} color={c.cyan} action={may && ['draft', 'published'].includes(program.status) ? t('scr.rules_edit') : undefined} onAction={() => setEdit(true)}>
      {v.error ? <LoadError error={v.error} onRetry={v.reload} /> : v.loading && !v.data ? <Loading /> : !rules ? <Empty emoji="📋" title={t('scr.rules_none')} /> : (
        <Card>
          <T weight="900">{t('scr.rules_version', { v: cur.version })}</T>
          <T size={13}>{(rules.target_types ?? []).map((x) => t(`scr.t_${x}`)).join(', ')}{rules.verified_only ? ` · ${t('scr.f_verified')}` : ''}</T>
          <T size={12} color={c.mute}>{[rules.sports?.length ? rules.sports.join(', ') : t('scr.any_sport'), rules.regions?.length ? rules.regions.join(', ') : t('scr.anywhere')].join(' · ')}</T>
          {rules.required_documents?.length ? <T size={12} color={c.mute}>{t('scr.f_docs')}: {rules.required_documents.map((d) => d.label).join(', ')}</T> : null}
          {v.data.items.length > 1 ? (
            <View style={{ marginTop: 6, gap: 2 }}>
              <T weight="800" size={12}>{t('scr.rules_history')}</T>
              {v.data.items.map((x) => <T key={x.version} size={12} color={c.mute}>v{x.version} · {new Date(x.created_at).toLocaleDateString()} · {t('scr.rules_screened', { n: x.screenings })}{x.note ? ` · ${x.note}` : ''}</T>)}
            </View>
          ) : null}
        </Card>
      )}
      {may ? (
        <FormSheet visible={edit} onClose={() => setEdit(false)} title={t('scr.rules_edit')} submitLabel={t('common.save')}
          initial={{ target_types: rules?.target_types ?? ['athlete', 'team', 'event'], sports: rules?.sports ?? [], regions: rules?.regions ?? [], verified_only: !!rules?.verified_only, max_award_cents: rules?.max_award_cents ?? undefined, required_documents: (rules?.required_documents ?? []).map((d) => d.key), duplicate_check: rules?.duplicate_check ?? true }}
          fields={[
            { key: 'target_types', label: t('scr.f_types'), type: 'multi', options: TARGETS.map((x) => ({ value: x, label: t(`scr.t_${x}`) })) },
            { key: 'sports', label: t('scr.f_sports'), type: 'sports', optional: true },
            { key: 'regions', label: t('scr.f_regions'), type: 'regions', optional: true },
            { key: 'verified_only', label: t('scr.f_verified'), type: 'switch' },
            { key: 'max_award_cents', label: t('scr.f_max'), type: 'money', currency: () => program.currency, optional: true },
            { key: 'required_documents', label: t('scr.f_docs'), type: 'multi', options: DOCUMENTS.map((d) => ({ value: d.key, label: t(d.label) })) },
            { key: 'duplicate_check', label: t('scr.f_dups'), type: 'switch' },
            { key: 'note', label: t('scr.f_note'), optional: true },
          ]}
          onSubmit={async (f) => {
            try {
              const r = await api.post(`/sponsorship-programs/${program.id}/eligibility`, {
                version: program.row_version, target_types: f.target_types, sports: f.sports ?? [], regions: f.regions ?? [], verified_only: !!f.verified_only,
                max_award_cents: f.max_award_cents || null, duplicate_check: f.duplicate_check !== false,
                required_documents: (f.required_documents ?? []).map((k) => ({ key: k, label: t(DOCUMENTS.find((d) => d.key === k)?.label ?? k) })), ...(f.note ? { note: f.note } : {}),
              });
              onChanged?.(); v.reload();
              return r.changed ? t('scr.rules_saved', { v: r.eligibility_version }) : t('scr.rules_same');
            } catch (e) { if (e.status === 409) { onChanged?.(); v.reload(); toast(t('scr.stale')); } throw e; }
          }} />
      ) : null}
    </Section>
  );
}

/** Applicant: pick what you would apply for and see, before filing anything, what is met and what is missing. */
export function EligibilityCheckSheet({ round, targets, currency, onClose }) {
  const [pick, setPick] = useState(null);
  const [text, setText] = useState('');
  const [asked, setAsked] = useState(null); // the amount (minor units) the last check used
  const cents = text.trim() ? parseAmount(text, currency) : null;
  const res = useLoad(() => {
    if (!round || !pick) return Promise.resolve(null);
    const [target_type, target_id] = pick.split(':');
    return api.post(`/program-rounds/${round.id}/eligibility-check`, { target_type, target_id, ...(asked ? { requested_cents: asked } : {}) });
  }, [round?.id, pick, asked]);
  const close = () => { setPick(null); setText(''); setAsked(null); onClose(); };
  return (
    <Sheet visible={!!round} onClose={close} title={t('scr.check_title')}>
      <T size={12} color={c.mute}>{t('scr.check_hint')}</T>
      {targets.length ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityLabel={t('scr.check_for')}>
            {targets.map((x) => <Chip key={x.value} label={x.label} active={pick === x.value} onPress={() => setPick(x.value)} />)}
          </View>
          <Field label={`${t('scr.f_amount')} (${currency})`} value={text} onChangeText={(x) => { setText(x); setAsked(null); }} keyboardType="decimal-pad" placeholder="0.00" accessibilityLabel={t('scr.f_amount')} />
          <Btn small title={t('scr.check_btn')} disabled={!pick || (!!text.trim() && !cents)} onPress={() => setAsked(cents || null)} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t('scr.check_btn')} />
        </>
      ) : <Empty emoji="🔎" title={t('scr.check_none')} />}
      {pick ? (res.error ? <LoadError error={res.error} onRetry={res.reload} /> : res.loading || !res.data ? <Loading /> : (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="900" style={{ flex: 1 }}>{t('scr.panel_title')}</T><OutcomeTag outcome={res.data.outcome} /></View>
          <Reasons run={{ ...res.data, duplicate_flags: [] }} />
        </View>
      )) : null}
    </Sheet>
  );
}
