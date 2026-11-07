// Adaptive coaching (#837): coach opt-in and specialist credentials, the athlete's search filters and credential badges, the profile block and the
// booking adjustments sheet. All rules are on the server (src/coach-adaptive.js, capabilities/coach-adaptive.js); nothing here infers anything about the athlete.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Field, H2, Loading, Screen, Sheet, T } from '../ui';
import { MenuField, MultiMenuField } from '../menu-field';
import { SwitchRow } from '../federation-bits';
import { Counter, DateField } from '../pickers';
import { Pill } from './marketplace';
import { RequestSheet } from './verification';
import { c } from '../theme';
import { t } from '../i18n';

const TONE = { verified: [c.lime, c.limeSoft], self_declared: [c.sun, c.sunSoft], expired: [c.red, c.redSoft], revoked: [c.red, c.redSoft], none: [c.sun, c.sunSoft] };
const COMM_KEYS = ['captioned_video', 'sign_interpreter', 'plain_language_briefing', 'written_instructions', 'screen_reader_materials'];
const ADJ_KEYS = ['step_free_route', 'lift_access', 'accessible_changing', 'accessible_toilet', 'accessible_parking', 'quiet_entry', 'tactile_guidance', 'sport_wheelchair', 'adaptive_kit', 'support_person', 'sighted_guide', 'captioned_video', 'sign_interpreter', 'plain_language_briefing', 'written_instructions', 'extra_transition_time', 'rest_breaks', 'flexible_start', 'quiet_room'];

export const discOptions = (cat) => (cat?.disciplines ?? []).map((d) => ({ value: d.key, label: t(`inc.tpl_${d.key}`) }));
export const fmtOptions = (cat) => (cat?.delivery_formats ?? []).map((k) => ({ value: k, label: t(`adp.fmt_${k}`) }));
export const commOptions = () => COMM_KEYS.map((k) => ({ value: k, label: t(`inc.need_${k}`) }));
export const useAdaptiveCatalogue = () => useLoad(() => api.get('/coaches/adaptive/catalogue'), []).data;

export const StateBadge = ({ state }) => <Pill label={t(`adp.state_${state}`)} fg={(TONE[state] ?? TONE.none)[0]} bg={(TONE[state] ?? TONE.none)[1]} />;

/** Athlete search filters. Uses only what coaches declare or the platform verified; the note says so. */
export function AdaptiveFilters({ value, onChange }) {
  const cat = useAdaptiveCatalogue();
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <Card pad={14}>
      <T weight="800" size={15}>{t('adp.f_title')}</T>
      <View style={{ gap: 10, marginTop: 8 }}>
        <MultiMenuField label={t('adp.f_disc')} value={value.disc} onChange={(v) => set('disc', v)} options={discOptions(cat)} />
        <MultiMenuField label={t('adp.f_format')} value={value.format} onChange={(v) => set('format', v)} options={fmtOptions(cat)} />
        <MultiMenuField label={t('adp.f_comm')} value={value.comm} onChange={(v) => set('comm', v)} options={commOptions()} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}><Chip label={['✓', t('adp.f_verified')].join(' ')} active={value.verified} onPress={() => set('verified', !value.verified)} /></View>
        <T size={12} color={c.mute}>{t('adp.f_note')}</T>
      </View>
    </Card>
  );
}
export const adaptiveParams = (f) => ({
  ...(f.disc.length ? { adaptive_discipline: f.disc.join(',') } : {}), ...(f.format.length ? { delivery_format: f.format.join(',') } : {}),
  ...(f.comm.length ? { comm_support: f.comm.join(',') } : {}), ...(f.verified ? { credential_verified_only: true } : {}),
});
export const emptyAdaptive = { disc: [], format: [], comm: [], verified: false };

/** Search-result line for a coach who opted in: the live credential state, and the fixed warning when nothing is verified. */
export function AdaptiveLine({ a }) {
  if (!a) return null;
  return (
    <View style={{ gap: 6, marginTop: 8 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <StateBadge state={a.state} />
        {a.disciplines.map((d) => <Pill key={d} label={t(`inc.tpl_${d}`)} fg={c.pink} bg={c.pinkSoft} />)}
      </View>
      {a.state !== 'verified' ? <T size={12} color={c.mute} accessibilityLiveRegion="polite">{`${t('adp.no_formal')} ${t('adp.disclaimer')}`}</T> : null}
    </View>
  );
}

/** Public profile block: credentials with issuer, scope and validity, what the coach offers, and the disclaimer. Renders nothing for a coach who did not opt in. */
export function AdaptiveProfileBlock({ coachId }) {
  const r = useLoad(() => api.get(`/coaches/${coachId}/adaptive`).catch(() => null), [coachId]);
  const a = r.data;
  if (!a) return null;
  return (
    <View style={{ gap: 10 }}>
      <H2>{t('adp.title')}</H2>
      {a.expertise.map((e) => (
        <Card key={e.id} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <T weight="800" size={15} style={{ flex: 1 }}>{e.credential ?? t(`inc.tpl_${e.discipline}`)}</T><StateBadge state={e.state} />
          </View>
          <T size={13} color={c.mute}>{[t(`inc.tpl_${e.discipline}`), e.years ? `${e.years} ${t('adp.years').toLowerCase()}` : null, e.authority ? t('adp.issuer', { name: e.authority }) : null, e.valid_to ? t('adp.valid_to', { date: e.valid_to }) : null].filter(Boolean).join(' · ')}</T>
        </Card>
      ))}
      {a.formats.length || a.comm.length ? (
        <View style={{ gap: 6 }}>
          <T weight="700" size={13}>{t('adp.offers')}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {a.formats.map((k) => <Pill key={k} label={t(`adp.fmt_${k}`)} />)}{a.comm.map((k) => <Pill key={k} label={t(`inc.need_${k}`)} />)}
          </View>
        </View>
      ) : null}
      {a.no_formal_credential ? <T size={13} color={c.mute}>{t('adp.no_formal')}</T> : null}
      <T size={12} color={c.mute}>{t('adp.disclaimer')}</T>
    </View>
  );
}

/** Coach: Specialist credentials. Opt in, declare expertise, see each credential's live state, and ask for verification through the existing verification flow. */
export function CoachAdaptive() {
  const { toast } = useSession();
  const cat = useAdaptiveCatalogue();
  const mine = useLoad(() => api.get('/me/coach-adaptive'), []);
  const rules = useLoad(() => api.get('/verification/rules'), []);
  const sports = useLoad(() => api.get('/me/sport-profiles').catch(() => []), []);
  const [ex, setEx] = useState({ sport: null, discipline: null, years: 0, training: '', case_id: null }), [busy, setBusy] = useState(false), [ask, setAsk] = useState(false);
  const m = mine.data;
  const run = async (fn, msg) => { try { await fn(); if (msg) toast(msg); mine.reload(); } catch (e) { toast(explain(e)); } };
  if (mine.error) return <Screen><LoadError error={mine.error} onRetry={mine.reload} /></Screen>;
  if (!m) return <Screen><Loading /></Screen>;
  const coachSports = (Array.isArray(sports.data) ? sports.data : sports.data?.profiles ?? sports.data?.items ?? []).filter((s) => s.role === 'coach');
  const save = () => run(async () => { setBusy(true); try { await api.post('/me/coach-adaptive/expertise', { sport: ex.sport, discipline: ex.discipline, years: ex.years, ...(ex.training.trim() ? { specialist_training: ex.training.trim() } : {}), ...(ex.case_id ? { case_id: ex.case_id } : {}) }); } finally { setBusy(false); } }, t('adp.save'));
  return (
    <Screen wide onRefresh={mine.reload}>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1 }}>{t('adp.title').toUpperCase()}</T>
      <T weight="800" size={26}>{t('adp.title')}</T>
      <Card pad={14} style={{ marginTop: 12 }}>
        <SwitchRow label={t('adp.opt_in')} sub={t('adp.opt_in_sub')} value={m.opted_in} onChange={(v) => run(() => api.post('/me/coach-adaptive', { opt_in: v }))} />
      </Card>
      {m.opted_in ? (
        <View style={{ gap: 12, marginTop: 12 }}>
          <Card pad={14}>
            <View style={{ gap: 10 }}>
              <MultiMenuField label={t('adp.f_format')} value={m.formats} onChange={(v) => run(() => api.post('/me/coach-adaptive', { opt_in: true, formats: v }))} options={fmtOptions(cat)} />
              <MultiMenuField label={t('adp.f_comm')} value={m.comm} onChange={(v) => run(() => api.post('/me/coach-adaptive', { opt_in: true, comm: v }))} options={commOptions()} />
            </View>
          </Card>
          <Card pad={14}>
            <View style={{ gap: 10 }}>
              <MenuField label={t('adp.f_disc')} value={ex.discipline} onChange={(v) => setEx({ ...ex, discipline: v })} options={discOptions(cat)} />
              <MenuField label={t('ver.f.sport')} value={ex.sport} onChange={(v) => setEx({ ...ex, sport: v })} options={coachSports.map((s) => ({ value: s.sport_slug ?? s.sport, label: s.sport_name ?? s.sport }))} />
              <Counter label={t('adp.years')} value={ex.years} onChange={(v) => setEx({ ...ex, years: v })} min={0} max={80} />
              <Field label={t('adp.training')} value={ex.training} onChangeText={(x) => setEx({ ...ex, training: x })} multiline maxLength={300} />
              <MenuField label={t('adp.credentials')} value={ex.case_id} onChange={(v) => setEx({ ...ex, case_id: v })} options={m.cases.map((k) => ({ value: k.id, label: `${k.credential_title ?? k.case_no} · ${t(k.status === 'approved' ? 'adp.state_verified' : 'adp.in_review')}` }))} placeholder="—" />
              <Btn title={t('adp.save')} onPress={save} loading={busy} disabled={!ex.discipline || !ex.sport} />
            </View>
          </Card>
          {m.expertise.map((e) => (
            <Card key={e.id} pad={14}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800" style={{ flex: 1 }}>{t(`inc.tpl_${e.discipline}`)}</T><StateBadge state={e.state} /></View>
              <T size={13} color={c.mute}>{[e.years ? `${e.years} ${t('adp.years').toLowerCase()}` : null, e.authority ? t('adp.issuer', { name: e.authority }) : null, e.valid_to ? t('adp.valid_to', { date: e.valid_to }) : null].filter(Boolean).join(' · ')}</T>
              {e.specialist_training ? <T size={13}>{e.specialist_training}</T> : null}
              <Btn small color={c.paper} ink={c.red} title={t('adp.adj_withdraw')} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => run(() => api.post(`/me/coach-adaptive/expertise/${e.id}/archive`))} accessibilityLabel={`${t('adp.adj_withdraw')} ${t(`inc.tpl_${e.discipline}`)}`} />
            </Card>
          ))}
        </View>
      ) : null}
      <H2 style={{ marginTop: 16 }}>{t('adp.credentials')}</H2>
      {m.cases.length ? m.cases.map((k) => (
        <Card key={k.id} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800" style={{ flex: 1 }}>{k.credential_title ?? `#${k.case_no}`}</T>
            {k.status === 'approved' ? <StateBadge state={k.expires_at && new Date(k.expires_at) < new Date() ? 'expired' : 'verified'} /> : k.status === 'revoked' ? <StateBadge state="revoked" /> : <Pill label={t('adp.in_review')} fg={c.cyan} bg={c.cyanSoft} />}</View>
          <T size={13} color={c.mute}>{[k.issuing_authority ? t('adp.issuer', { name: k.issuing_authority }) : null, k.expires_at ? t('adp.valid_to', { date: String(k.expires_at).slice(0, 10) }) : null].filter(Boolean).join(' · ')}</T>
          {k.decision_reason && k.status === 'revoked' ? <T size={12} color={c.mute}>{k.decision_reason}</T> : null}
        </Card>
      )) : <Empty emoji="🪪" title={t('adp.credentials')} sub={t('adp.no_cred')} />}
      <Btn title={['+', t('adp.add_cred')].join(' ')} onPress={() => setAsk(true)} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
      <T size={12} color={c.mute} style={{ marginTop: 10 }}>{t('adp.disclaimer')}</T>
      {rules.data ? <RequestSheet visible={ask} onClose={() => setAsk(false)} rules={rules.data} preset="coach" onDone={mine.reload} /> : null}
    </Screen>
  );
}

/** Athlete (or a verified guardian): share operational session adjustments with the coach of one booking. */
export function AdjustmentsSheet({ hire, onClose }) {
  const { toast } = useSession();
  const [keys, setKeys] = useState([]), [until, setUntil] = useState(null), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  const cur = useLoad(() => (hire ? api.get(`/hires/${hire.id}/adjustments`) : Promise.resolve([])), [hire?.id]);
  if (!hire) return null;
  const live = (cur.data ?? []).filter((a) => !a.revoked_at && new Date(a.expires_at) > new Date());
  const share = async () => { setBusy(true); try { await api.post(`/hires/${hire.id}/adjustments`, { need_keys: keys, expires_on: until, ...(note.trim() ? { note: note.trim() } : {}) }); toast(t('adp.adj_saved')); setKeys([]); setNote(''); cur.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const withdraw = async () => { try { await api.post(`/hires/${hire.id}/adjustments/revoke`); toast(t('adp.adj_withdrawn')); cur.reload(); } catch (e) { toast(explain(e)); } };
  return (
    <Sheet visible onClose={onClose} title={t('adp.adj_title')}>
      <T size={13} color={c.mute}>{t('adp.adj_sub')}</T>
      {live.map((a) => (
        <Card key={a.id} pad={12}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{a.need_keys.map((k) => <Pill key={k} label={t(`inc.need_${k}`)} />)}</View>
          <T size={12} color={c.mute}>{[t('adp.valid_to', { date: String(a.expires_at).slice(0, 10) }), t('adp.adj_reads', { n: a.coach_reads ?? 0 })].join(' · ')}</T>
          <Btn small color={c.paper} ink={c.red} title={t('adp.adj_withdraw')} onPress={withdraw} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
        </Card>
      ))}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="menu">
        {ADJ_KEYS.map((k) => <Chip key={k} label={t(`inc.need_${k}`)} active={keys.includes(k)} onPress={() => setKeys((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]))} />)}
      </View>
      <DateField label={t('adp.adj_until')} value={until} onChange={setUntil} min={new Date().toISOString().slice(0, 10)} />
      <Field label={t('adp.adj_note')} value={note} onChangeText={setNote} multiline maxLength={300} />
      <T size={12} color={c.mute}>{t('adp.adj_notice')}</T>
      <Btn title={t('adp.adj_share')} onPress={share} loading={busy} disabled={!keys.length || !until} />
    </Sheet>
  );
}

/** Coach: the adjustments the athlete chose to share for one booking. Opening it is logged and visible to the athlete; nothing clinical exists to show. */
export function CoachAdjustmentsSheet({ hire, onClose }) {
  const r = useLoad(() => api.get(`/hires/${hire.id}/adjustments`), [hire.id]);
  return (
    <Sheet visible onClose={onClose} title={t('adp.adj_title')}>
      {r.error ? <LoadError error={r.error} onRetry={r.reload} /> : !r.data ? <Loading /> : !r.data.length ? <Empty emoji="🤝" title={t('adp.adj_title')} sub={t('adp.adj_sub')} /> : r.data.map((a) => (
        <Card key={a.id} pad={12}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{a.need_keys.map((k) => <Pill key={k} label={t(`inc.need_${k}`)} />)}</View>
          {a.note ? <T size={13} style={{ marginTop: 6 }}>{a.note}</T> : null}
          <T size={12} color={c.mute}>{t('adp.valid_to', { date: String(a.expires_at).slice(0, 10) })}</T>
        </Card>
      ))}
      <T size={12} color={c.mute}>{t('adp.adj_notice')}</T>
    </Sheet>
  );
}
