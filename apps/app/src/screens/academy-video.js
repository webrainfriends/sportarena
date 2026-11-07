// Academy OS P1 / Gap 13 (#793): video review & coach feedback, on the screens that already own the moment: the academy session (Video tab), the
// progress console (coach feedback queue) and the family portal (athlete / guardian "Video to review"). There is no video service here: the clip is
// the athlete's own library item, and every screen only calls the API, which re-checks consent, expiry and revocation on every request.
import React, { useState } from 'react';
import { View } from 'react-native';
import { API, api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { explain } from '../access';
import { Btn, Card, Chip, Empty, Loading, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { UrlPlayer } from '../video-player';
import { c } from '../theme';
import { t } from '../i18n';
import { dateTimeIn } from '../vtime';
import { Block, Kpi } from './academy-ui';

const REASON_KEY = { revoked: 'vr.blocked.revoked', expired: 'vr.blocked.expired', unshared: 'vr.blocked.unshared', consent_withdrawn: 'vr.blocked.consent' };
const REVIEW_TONE = { pending: c.sunSoft, understood: c.lime, need_help: c.orangeSoft, question: c.cyanSoft };
const ANN_ICON = { note: '📝', praise: '👏', fix: '🛠️' };
const J = (...a) => a.filter((x) => x !== '' && x != null).join(' ');   // joins an icon / value and a translated label
const ms = (v) => { const s = Math.floor(v / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const parseMs = (v) => { const m = /^(\d{1,3}):([0-5]?\d)$/.exec(String(v ?? '').trim()); return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null; };
const Panel = ({ children, tone }) => <View style={{ backgroundColor: tone ?? c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const Strip = ({ items }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{items.map((k) => <Kpi key={k.label} {...k} />)}</View>;

/** Live access state, in words (never colour alone). */
export const AccessTag = ({ access }) => (access.ok ? <Tag label={J('✓', t('vr.access.ok'))} color={c.lime} /> : <Tag label={J('🔒', t(REASON_KEY[access.reason] ?? 'vr.blocked.revoked'))} color={c.redSoft} />);

/** One clip row: thumbnail block, who/what it is linked to, and its status chips. */
function ClipCard({ x, onOpen, who = true }) {
  return (
    <Card pad={12} onPress={onOpen} accessibilityLabel={`${x.video.title ?? t('vr.hidden')}. ${x.athlete.display_name}. ${t(`vr.review.${x.review_state}`)}`}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <View style={{ width: 96, height: 54, borderRadius: 10, backgroundColor: c.violet, alignItems: 'center', justifyContent: 'center' }}><T size={20} color="#fff">{x.access.ok ? '▶' : '🔒'}</T></View>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800" numberOfLines={2}>{x.video.title ?? t('vr.hidden')}</T>
          <T size={12} color={c.mute} numberOfLines={2}>{[who ? x.athlete.display_name : null, x.session?.title, x.action ? `${t('vr.action')}: ${x.action.title}` : null].filter(Boolean).join(' · ')}</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        <AccessTag access={x.access} />
        <Tag label={t(`vr.review.${x.review_state}`)} color={REVIEW_TONE[x.review_state]} />
        {x.annotation_count ? <Tag label={t('vr.notes_n', { n: x.annotation_count })} color={c.cyanSoft} /> : null}
        {x.expires_at && x.status === 'active' ? <Tag label={t('vr.expires', { d: dateTimeIn(x.expires_at, 'UTC').split(',')[0] })} /> : null}
      </View>
    </Card>
  );
}

// ================================================================================== COACH: the session's Video tab
export function SessionVideo({ s, toast, nav }) {
  const org = s.organisation_id;
  const d = useLoad(() => api.get(`/organisations/${org}/academy/clips`, { session_id: s.id, include_revoked: true, limit: 100 }), [s.id]);
  const [pick, setPick] = useState(false), [open, setOpen] = useState(null);
  if (d.error) return <Panel><Empty emoji="📶" title={t('vr.offline.title')} sub={t('vr.offline.sub')} /><Btn small title={t('common.retry')} onPress={d.reload} /></Panel>;
  if (!d.data) return <Loading />;
  const { totals, items } = d.data;
  return (
    <View style={{ gap: 12 }}>
      <Strip items={[{ label: t('vr.kpi.linked'), value: String(totals.total), sub: t('vr.kpi.linked_sub') }, { label: t('vr.kpi.reviewed'), value: `${totals.reviewed}/${totals.total}`, sub: t('vr.kpi.reviewed_sub') }, { label: t('vr.kpi.actions'), value: String(totals.open_actions), sub: t('vr.kpi.actions_sub'), tone: totals.needs_reply ? 'alert' : undefined }]} />
      <Panel tone={c.cyanSoft}><T weight="800">{t('vr.library.title')}</T><T size={12} color={c.mute}>{t('vr.library.sub')}</T></Panel>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Btn small title={J('＋', t('vr.link'))} onPress={() => setPick(true)} accessibilityLabel={t('vr.link')} />
        <Btn small title={J('🎥', t('vr.capture'))} color={c.paper} ink={c.ink} onPress={() => nav.push('SessionWorkspace', { source_type: 'academy_session', source_id: s.id })} accessibilityLabel={t('vr.capture_a11y')} />
      </View>
      {items.length ? items.map((x) => <ClipCard key={x.id} x={x} onOpen={() => setOpen(x.id)} />) : <Panel><Empty emoji="🎥" title={t('vr.empty.title')} sub={t('vr.empty.sub')} /></Panel>}
      <LinkSheet s={s} visible={pick} onClose={() => setPick(false)} done={(msg) => { setPick(false); d.reload(); toast(msg); }} />
      {open ? <ClipSheet id={open} staff onClose={() => { setOpen(null); d.reload(); }} toast={toast} /> : null}
    </View>
  );
}

/** Pick a shared clip from an enrolled athlete and say what it evidences; optionally create the shared development action. */
function LinkSheet({ s, visible, onClose, done }) {
  const clips = useLoad(() => (visible ? api.get(`/academy/sessions/${s.id}/linkable-clips`, { limit: 100 }) : Promise.resolve([])), [visible, s.id]);
  const objs = useLoad(() => (visible ? api.get(`/academy/sessions/${s.id}/objectives`).catch(() => ({ objectives: [] })) : Promise.resolve({ objectives: [] })), [visible, s.id]);
  const options = (clips.data ?? []).filter((x) => !x.linked).map((x) => ({ value: x.id, label: x.title, sub: x.athlete_name }));
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('vr.link_title')} submitLabel={t('vr.link_submit')}
      initial={{ expires_in_days: 14, athlete_visible: true, make_action: true, action_visibility: true }}
      fields={[
        { key: 'video_id', label: t('vr.f.clip'), type: 'custom', render: ({ v, set }) => (options.length || clips.loading
          ? <MenuField label={t('vr.f.clip')} value={v.video_id} onChange={(x) => set('video_id', x)} options={options} hint={t('vr.f.clip_hint')} />
          : <Empty emoji="🎥" title={t('vr.nolinkable.title')} sub={t('vr.nolinkable.sub')} />) },
        { key: 'objective_key', label: t('vr.f.objective'), type: 'custom', optional: true, render: ({ v, set }) => (objs.data?.objectives?.length
          ? <MenuField label={t('vr.f.objective')} value={v.objective_key ?? ''} onChange={(x) => set('objective_key', x || undefined)} options={[{ value: '', label: t('vr.none') }, ...objs.data.objectives.filter((o) => o.status !== 'removed').map((o) => ({ value: o.objective_key, label: o.snapshot?.title ?? o.objective_key }))]} />
          : null) },
        { key: 'coach_note', label: t('vr.f.note'), type: 'multiline', optional: true, hint: t('vr.f.note_hint') },
        { key: 'assessment_ref', label: t('vr.f.assessment'), optional: true },
        { key: 'make_action', label: t('vr.f.make_action'), type: 'switch', hint: t('vr.f.make_action_hint') },
        { key: 'action_title', label: t('vr.f.action_title'), optional: true, show: (v) => v.make_action },
        { key: 'due_on', label: t('vr.f.due'), type: 'date', optional: true, show: (v) => v.make_action },
        { key: 'action_visibility', label: t('vr.f.action_visible'), type: 'switch', show: (v) => v.make_action },
        { key: 'athlete_visible', label: t('vr.f.athlete_visible'), type: 'switch', hint: t('vr.f.athlete_visible_hint') },
        { key: 'expires_in_days', label: t('vr.f.expires'), type: 'chips', options: [1, 7, 14, 30, 60].map((n) => ({ value: n, label: t('vr.days', { n }) })) },
      ]}
      onSubmit={async (v) => {
        if (!v.video_id) throw new Error(t('vr.f.clip_required'));
        const body = { video_id: v.video_id, objective_key: v.objective_key || undefined, coach_note: v.coach_note || undefined, assessment_ref: v.assessment_ref || undefined, athlete_visible: !!v.athlete_visible, expires_in_days: v.expires_in_days };
        if (v.make_action) body.new_action = { title: v.action_title || t('vr.default_action'), due_on: v.due_on || undefined, visibility: v.action_visibility ? 'athlete' : 'staff' };
        try { await api.post(`/academy/sessions/${s.id}/clips`, body); } catch (e) { throw new Error(explain(e)); }
        done(t('vr.linked')); return t('vr.linked');
      }} />
  );
}

// ================================================================================== clip detail (coach, athlete, guardian)
export function ClipSheet({ id, staff, onClose, toast }) {
  const { user } = useSession();
  const d = useLoad(() => api.get(`/academy/clip-links/${id}`), [id]);
  const [ann, setAnn] = useState(false), [rev, setRev] = useState(false), [respond, setRespond] = useState(false), [edit, setEdit] = useState(false);
  const x = d.data;
  const act = async (fn, msg) => { try { await fn(); toast(msg); d.reload(); } catch (e) { toast(explain(e)); } };
  return (
    <Sheet visible onClose={onClose} title={x?.video?.title ?? t('vr.title')}>
      {d.error ? <Panel><Empty emoji="📶" title={t('vr.offline.title')} sub={t('vr.offline.sub')} /><Btn small title={t('common.retry')} onPress={d.reload} /></Panel> : !x ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><AccessTag access={x.access} /><Tag label={t(`vr.review.${x.review_state}`)} color={REVIEW_TONE[x.review_state]} /><Tag label={x.athlete.display_name} /></View>
          {x.access.ok ? (
            <>
              <UrlPlayer url={x.video.play_url ? `${API.replace(/\/api\/v1$/, '')}${x.video.play_url}` : x.video.embed_url ?? undefined} title={x.video.title} />
              {x.start_ms != null ? <T size={12} color={c.mute}>{t('vr.range', { a: ms(x.start_ms), b: x.end_ms != null ? ms(x.end_ms) : '–' })}</T> : null}
              {x.coach_note ? <Panel><T weight="800" size={13}>{t('vr.coach_note')}</T><T>{x.coach_note}</T></Panel> : null}
              <Block title={t('vr.annotations', { n: x.annotations?.length ?? 0 })}>
                {x.annotations?.length ? x.annotations.map((a) => (
                  <View key={a.id} style={{ flexDirection: 'row', gap: 8 }} accessible accessibilityLabel={J(ms(a.at_ms), a.note)}>
                    <Tag label={J(ANN_ICON[a.kind], ms(a.at_ms))} color={c.violetSoft} /><View style={{ flex: 1 }}><T size={13}>{a.note}</T><T size={11} color={c.mute}>{a.author}</T></View>
                    {staff ? <Btn small title="✕" color={c.paper} ink={c.red} accessibilityLabel={t('vr.remove_note')} onPress={() => act(() => api.del(`/academy/clip-annotations/${a.id}`), t('vr.note_removed'))} /> : null}
                  </View>
                )) : <T size={12} color={c.mute}>{t('vr.no_annotations')}</T>}
                {staff ? <Btn small title={J('＋', t('vr.annotate'))} color={c.paper} ink={c.ink} onPress={() => setAnn(true)} style={{ alignSelf: 'flex-start' }} /> : null}
              </Block>
            </>
          ) : <Panel tone={c.redSoft}><T weight="800" color={c.red}>🔒 {t('vr.blocked.title')}</T><T size={13}>{t(REASON_KEY[x.access.reason] ?? 'vr.blocked.revoked')}. {t('vr.blocked.kept')}</T></Panel>}
          <Block title={t('vr.links')}>
            {x.session ? <T size={13}>🗓️ {x.session.title} · {dateTimeIn(x.session.starts_at, 'UTC')}</T> : null}
            {x.objective_key ? <T size={13}>🎯 {t('vr.f.objective')}: {x.objective_key}</T> : null}
            {x.assessment_ref ? <T size={13}>✅ {t('vr.f.assessment')}: {x.assessment_ref}</T> : null}
            {x.observation_id ? <T size={13}>📝 {t('vr.observation')}</T> : null}
            {x.action ? <T size={13}>⚡ {t('vr.action')}: {x.action.title} · {t(`vr.astatus.${x.action.status}`)}{x.action.due_on ? ` · ${String(x.action.due_on).slice(0, 10)}` : ''}</T> : <T size={12} color={c.mute}>{t('vr.no_action')}</T>}
          </Block>
          <Block title={t('vr.access.title')}>
            <T size={13}>{t('vr.access.consent')}: {x.access.reason === 'consent_withdrawn' ? t('vr.blocked.consent') : t('vr.access.consent_ok')}</T>
            {x.expires_at ? <T size={13}>{t('vr.access.expiry')}: {dateTimeIn(x.expires_at, 'UTC')}</T> : null}
            {x.first_viewed_at ? <T size={12} color={c.mute}>{t('vr.first_viewed')}: {dateTimeIn(x.first_viewed_at, 'UTC')}</T> : null}
          </Block>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {!staff && x.access.ok ? <Btn small title={t('vr.respond')} onPress={() => setRespond(true)} /> : null}
            {staff && x.status === 'active' ? <Btn small title={t('vr.edit')} color={c.paper} ink={c.ink} onPress={() => setEdit(true)} /> : null}
            {x.status === 'active' ? <Btn small title={t('vr.revoke')} color={c.paper} ink={c.red} onPress={() => setRev(true)} /> : null}
          </View>
          <FormSheet visible={ann} onClose={() => setAnn(false)} title={t('vr.annotate')} submitLabel={t('common.save')} initial={{ kind: 'note', at: '0:00' }}
            fields={[{ key: 'at', label: t('vr.f.at'), hint: t('vr.f.at_hint') }, { key: 'kind', label: t('vr.f.kind'), type: 'chips', options: ['note', 'praise', 'fix'].map((k) => ({ value: k, label: `${ANN_ICON[k]} ${t(`vr.kind.${k}`)}` })) }, { key: 'note', label: t('vr.f.note'), type: 'multiline' }]}
            onSubmit={async (v) => { const at = parseMs(v.at); if (at == null) throw new Error(t('vr.f.at_hint')); await api.post(`/academy/clip-links/${id}/annotations`, { at_ms: at, kind: v.kind, note: v.note }); d.reload(); return t('vr.note_added'); }} />
          <FormSheet visible={rev} onClose={() => setRev(false)} title={t('vr.revoke_title')} submitLabel={t('vr.revoke')} color={c.red} fields={[{ key: 'reason', label: t('vr.f.reason'), optional: true, hint: t('vr.revoke_hint') }]}
            onSubmit={async (v) => { await api.post(`/academy/clip-links/${id}/revoke`, { reason: v.reason || undefined }); d.reload(); return t('vr.revoked'); }} />
          <FormSheet visible={respond} onClose={() => setRespond(false)} title={t('vr.respond')} submitLabel={t('vr.send')} initial={{ state: 'understood' }}
            fields={[{ key: 'state', label: t('vr.f.response'), type: 'chips', options: ['understood', 'need_help', 'question'].map((k) => ({ value: k, label: t(`vr.review.${k}`) })) }, { key: 'note', label: t('vr.f.note'), type: 'multiline', optional: true }]}
            onSubmit={async (v) => { await api.post(`/academy/clip-links/${id}/review`, { state: v.state, note: v.note || undefined }); d.reload(); return t('vr.responded'); }} />
          <FormSheet visible={edit} onClose={() => setEdit(false)} title={t('vr.edit')} submitLabel={t('common.save')} initial={{ athlete_visible: !!x.athlete_visible, coach_note: x.coach_note ?? '' }}
            fields={[{ key: 'coach_note', label: t('vr.f.note'), type: 'multiline', optional: true }, { key: 'athlete_visible', label: t('vr.f.athlete_visible'), type: 'switch' }, { key: 'expires_in_days', label: t('vr.f.extend'), type: 'chips', optional: true, options: [7, 14, 30, 60].map((n) => ({ value: n, label: t('vr.days', { n }) })) }]}
            onSubmit={async (v) => { await api.patch(`/academy/clip-links/${id}`, { row_version: x.row_version, coach_note: v.coach_note || undefined, athlete_visible: v.athlete_visible, expires_in_days: v.expires_in_days }); d.reload(); return t('vr.saved'); }} />
        </View>
      )}
    </Sheet>
  );
}

// ================================================================================== athlete / guardian: "Video to review"
export function FamilyVideoReview({ athlete, toast }) {
  const q = athlete.is_me ? {} : { athlete_id: athlete.id };
  const [state, setState] = useState('to_review'), [open, setOpen] = useState(null);
  const d = useLoad(() => api.get('/me/academy/clips', { ...q, state }), [athlete.id, state]);
  if (d.error) return null;
  if (!d.data) return <Loading />;
  const { totals, items } = d.data;
  if (!totals.total && state === 'to_review' && !items.length) return null;     // nothing was ever shared with this family: no empty box on their progress tab
  return (
    <Panel>
      <Block title={t('vr.queue.title')}>
        <T size={12} color={c.mute}>{athlete.is_me ? t('vr.queue.sub') : t('vr.queue.sub_guardian')}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">
          {[['to_review', `${t('vr.queue.to_review')} · ${totals.to_review}`], ['reviewed', t('vr.queue.reviewed')], ['blocked', `${t('vr.queue.blocked')}${totals.blocked ? ` · ${totals.blocked}` : ''}`]].map(([k, l]) => <Chip key={k} label={l} active={state === k} onPress={() => setState(k)} />)}
        </View>
        {items.length ? items.map((x) => <ClipCard key={x.id} x={x} who={false} onOpen={() => setOpen(x.id)} />) : <Empty emoji="🎥" title={t('vr.queue.empty')} />}
        <T size={11} color={c.mute}>{t('vr.queue.note')}</T>
      </Block>
      {open ? <ClipSheet id={open} onClose={() => { setOpen(null); d.reload(); }} toast={toast} /> : null}
    </Panel>
  );
}

// ================================================================================== staff: coach feedback queue (progress console)
export function VideoFeedback({ o, toast }) {
  const [rs, setRs] = useState('all'), [open, setOpen] = useState(null);
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/clips`, { ...(rs === 'all' ? {} : { review_state: rs }), limit: 100 }), [o.id, rs]);
  return (
    <Panel>
      <Block title={t('vr.fb.title')}>
        <T size={12} color={c.mute}>{t('vr.fb.sub')}</T>
        {d.data ? <Strip items={[{ label: t('vr.kpi.linked'), value: String(d.data.totals.total) }, { label: t('vr.kpi.reviewed'), value: `${d.data.totals.reviewed}/${d.data.totals.total}` }, { label: t('vr.kpi.needs_reply'), value: String(d.data.totals.needs_reply), tone: d.data.totals.needs_reply ? 'alert' : undefined }]} /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[['all', t('common.all')], ['need_help', t('vr.review.need_help')], ['question', t('vr.review.question')], ['pending', t('vr.review.pending')]].map(([k, l]) => <Chip key={k} label={l} active={rs === k} onPress={() => setRs(k)} />)}</View>
        {d.error ? <Empty emoji="📶" title={t('vr.offline.title')} sub={t('vr.offline.sub')} /> : !d.data ? <Loading /> : d.data.items.length ? d.data.items.map((x) => <ClipCard key={x.id} x={x} onOpen={() => setOpen(x.id)} />) : <Empty emoji="🎥" title={t('vr.fb.empty')} sub={t('vr.empty.sub')} />}
      </Block>
      {open ? <ClipSheet id={open} staff onClose={() => { setOpen(null); d.reload(); }} toast={toast} /> : null}
    </Panel>
  );
}
