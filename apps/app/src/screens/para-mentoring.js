// PS-25 Para-athlete peer mentoring: discover mentors, manage mentorships, mentor dashboard.
// Three-tab layout: Discover / My Mentorships / Mentor Dashboard.
// Fully accessible: all touch targets ≥44pt, start/end layout for RTL (Urdu), t() for all strings.
// Encrypted fields (goal, bio, notes) are submitted/received through the API only; never stored locally.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../fields/MenuField';
import { c, when } from '../theme';
import { t } from '../i18n';

// ─────────────────────────────────────────────────────────── helpers

function usePaged(path, params, enabled = true) {
  const [state, setState] = useState({ items: [], next: null, busy: enabled, err: null });
  const key = JSON.stringify(params);
  const load = useCallback(async (cursor) => {
    if (!enabled) return;
    setState((s) => ({ ...s, busy: true, err: null }));
    try {
      const r = await api.get(path, { ...params, ...(cursor ? { before: cursor } : {}) });
      setState((s) => ({ items: cursor ? [...s.items, ...r.items] : r.items, next: r.next ?? null, busy: false, err: null }));
    } catch (e) { setState((s) => ({ ...s, busy: false, err: e })); }
  }, [path, key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(null); }, [load]);
  return { ...state, reload: () => load(null), more: () => state.next && load(state.next) };
}

const STATUS_COLORS = { requested: c.sun, accepted: c.cyan, active: c.lime, completed: c.mint, ended: c.violet, declined: c.red };
const statusColor = (s) => STATUS_COLORS[s] ?? c.violet;
const statusLabel = (s) => t(`pam.status_${s}`) ?? s;

const FORMATS = ['video', 'phone', 'in_person', 'async_message'];
const formatLabel = (f) => t(`pam.session_format_${f}`) ?? f;

// ─────────────────────────────────────────────────────────── MetricStrip

function MetricStrip({ items }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginBottom: 18 }}>
      {items.map((item) => (
        <View key={item.label} style={{ flex: 1, backgroundColor: c.cyanSoft, borderRadius: 12, padding: 14, alignItems: 'center' }}>
          <T style={{ fontSize: 22, fontWeight: '800', color: c.pink }}>{item.value}</T>
          <T style={{ fontSize: 11, color: c.violet, marginTop: 2, textAlign: 'center' }}>{item.label}</T>
        </View>
      ))}
    </View>
  );
}

// ─────────────────────────────────────────────────────────── MentorCard

function MentorCard({ mentor, onRequest }) {
  return (
    <Card style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
        <Avatar size={48} name={mentor.athlete_name} color={c.pink} />
        <View style={{ flex: 1 }}>
          <T weight="700" style={{ fontSize: 16, color: c.ink }}>{mentor.athlete_name}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 5 }}>
            {(mentor.sports ?? []).map((s) => <Chip key={s} style={{ backgroundColor: c.cyanSoft }}><T style={{ fontSize: 11, color: c.cyan }}>{s}</T></Chip>)}
          </View>
          {mentor.disciplines?.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
              {mentor.disciplines.map((d) => <Tag key={d} style={{ backgroundColor: c.violetSoft }}><T style={{ fontSize: 11 }}>{d}</T></Tag>)}
            </View>
          )}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {mentor.peer_years != null && <Chip style={{ backgroundColor: c.mint + '22' }}><T style={{ fontSize: 11, color: c.mint }}>{t('pam.years', { n: mentor.peer_years, s: mentor.peer_years !== 1 ? 's' : '' })}</T></Chip>}
            {(mentor.comm_formats ?? []).map((f) => <Chip key={f} style={{ backgroundColor: c.sun + '22' }}><T style={{ fontSize: 11, color: c.sun }}>{formatLabel(f)}</T></Chip>)}
            {mentor.availability && <Chip style={{ backgroundColor: c.paper, borderWidth: 1, borderColor: c.cyanSoft }}><T style={{ fontSize: 11, color: c.violet }}>{mentor.availability}</T></Chip>}
          </View>
        </View>
      </View>
      <View style={{ marginTop: 12 }}>
        <Btn label={t('pam.request')} onPress={() => onRequest(mentor)} color={c.pink} />
      </View>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────── RequestSheet

function RequestSheet({ mentor, visible, onClose, onDone }) {
  const [sportId, setSportId] = useState(null);
  const [discipline, setDiscipline] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/para/mentorships', { mentor_id: mentor.athlete_id, sport_id: sportId || undefined, discipline: discipline || undefined, goal: goal || undefined });
      onDone?.();
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('pam.request')}>
      <T style={{ fontSize: 13, color: c.violet, marginBottom: 10 }}>{t('pam.privacy_note')}</T>
      {err && <ErrorBox error={err} />}
      <Field label={t('pam.goal')} hint={t('pam.goal_hint')} value={goal} onChangeText={setGoal} multiline maxLength={600} />
      <Btn label={busy ? '…' : t('pam.request')} onPress={submit} disabled={busy} color={c.pink} style={{ marginTop: 14 }} />
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────── DiscoverTab

function DiscoverTab() {
  const [sportFilter, setSportFilter] = useState(null);
  const [formatFilter, setFormatFilter] = useState(null);
  const [requesting, setRequesting] = useState(null);
  const [done, setDone] = useState(false);
  const list = usePaged('/para/mentors', { sport: sportFilter, comm_format: formatFilter });

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      {/* Filter bar */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <Field label={t('pam.sport_filter')} value={sportFilter ?? ''} onChangeText={setSportFilter} style={{ flex: 1, minWidth: 140 }} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {FORMATS.map((f) => (
            <Pressable key={f} onPress={() => setFormatFilter(formatFilter === f ? null : f)} accessibilityRole="checkbox" accessibilityLabel={formatLabel(f)}
              style={{ minHeight: 36, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1.5, borderColor: formatFilter === f ? c.pink : c.cyanSoft, backgroundColor: formatFilter === f ? c.pink + '22' : c.paper, justifyContent: 'center' }}>
              <T style={{ fontSize: 12, color: formatFilter === f ? c.pink : c.violet }}>{formatLabel(f)}</T>
            </Pressable>
          ))}
        </View>
      </View>
      {list.busy && !list.items.length ? <Loading /> : list.err ? <ErrorBox error={list.err} /> : list.items.length === 0 ? (
        <Empty title={t('pam.empty_discover')} />
      ) : (
        list.items.map((m) => <MentorCard key={m.id} mentor={m} onRequest={(mentor) => { setRequesting(mentor); setDone(false); }} />)
      )}
      {requesting && (
        <RequestSheet mentor={requesting} visible onClose={() => setRequesting(null)} onDone={() => { list.reload(); setDone(true); }} />
      )}
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────── MentorshipRow

function MentorshipRow({ item, isMentor, onView }) {
  return (
    <Pressable onPress={() => onView(item)} accessibilityRole="button" accessibilityLabel={`${t('pam.mentorship_with')} ${isMentor ? item.mentee_name : item.mentor_name}`}
      style={{ marginBottom: 10 }}>
      <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <Avatar size={40} name={isMentor ? item.mentee_name : item.mentor_name} color={c.cyan} />
        <View style={{ flex: 1 }}>
          <T weight="700" style={{ fontSize: 15 }}>{isMentor ? item.mentee_name : item.mentor_name}</T>
          <T style={{ fontSize: 12, color: c.violet }}>{item.sport_name ?? '—'}{item.discipline ? ` · ${item.discipline}` : ''}</T>
        </View>
        <View style={{ backgroundColor: statusColor(item.status) + '22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
          <T style={{ fontSize: 11, color: statusColor(item.status), fontWeight: '700' }}>{statusLabel(item.status)}</T>
        </View>
      </Card>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────── SessionSheet

function SessionSheet({ mentorshipId, visible, onClose, onDone }) {
  const [title, setTitle] = useState('');
  const [format, setFormat] = useState('video');
  const [scheduledAt, setScheduledAt] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/para/mentorships/${mentorshipId}/sessions`, { title: title || undefined, format, scheduled_at: scheduledAt || undefined, notes: notes || undefined });
      onDone?.(); onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('pam.session_schedule')}>
      {err && <ErrorBox error={err} />}
      <Field label={t('pam.session_title')} value={title} onChangeText={setTitle} maxLength={120} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 8 }}>
        {FORMATS.map((f) => (
          <Pressable key={f} onPress={() => setFormat(f)} accessibilityRole="radio" accessibilityLabel={formatLabel(f)}
            style={{ minHeight: 36, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1.5, borderColor: format === f ? c.pink : c.cyanSoft, backgroundColor: format === f ? c.pink + '22' : c.paper, justifyContent: 'center' }}>
            <T style={{ fontSize: 12, color: format === f ? c.pink : c.violet }}>{formatLabel(f)}</T>
          </Pressable>
        ))}
      </View>
      <Field label={t('pam.session_time')} value={scheduledAt} onChangeText={setScheduledAt} hint="ISO date-time" />
      <Field label={t('pam.session_notes')} value={notes} onChangeText={setNotes} multiline maxLength={2000} />
      <Btn label={busy ? '…' : t('pam.session_schedule')} onPress={submit} disabled={busy} color={c.cyan} style={{ marginTop: 14 }} />
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────── MentorshipDetailSheet

function MentorshipDetailSheet({ item, isMentor, visible, onClose, onChanged }) {
  const [schedulingSession, setSchedulingSession] = useState(false);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [rating, setRating] = useState(5);
  const [feedbackBody, setFeedbackBody] = useState('');
  const [ending, setEnding] = useState(false);
  const [endReason, setEndReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { data: sessions, reload: reloadSessions } = useLoad(() => api.get(`/para/mentorships/${item?.id}/sessions`), [item?.id]);

  const accept = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/para/mentorships/${item.id}/respond`, { response: 'accept' }); onChanged?.(); onClose(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const decline = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/para/mentorships/${item.id}/respond`, { response: 'decline' }); onChanged?.(); onClose(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const end = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/para/mentorships/${item.id}/end`, { outcome: 'completed', reason: endReason || undefined }); onChanged?.(); onClose(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const submitFeedback = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/para/mentorships/${item.id}/feedback`, { rating, body: feedbackBody || undefined }); setSubmittingFeedback(false); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };

  if (!item) return null;

  return (
    <Sheet visible={visible} onClose={onClose} title={isMentor ? item.mentee_name : item.mentor_name}>
      {err && <ErrorBox error={err} />}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <View style={{ backgroundColor: statusColor(item.status) + '22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
          <T style={{ fontSize: 12, color: statusColor(item.status), fontWeight: '700' }}>{statusLabel(item.status)}</T>
        </View>
        {item.sport_name && <T style={{ fontSize: 13, color: c.violet }}>{item.sport_name}</T>}
      </View>

      {/* Mentor actions: accept/decline if requested */}
      {isMentor && item.status === 'requested' && (
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
          <Btn label={busy ? '…' : t('pam.accept')} onPress={accept} disabled={busy} color={c.lime} style={{ flex: 1 }} />
          <Btn label={t('pam.decline')} onPress={decline} disabled={busy} color={c.red} variant="outline" style={{ flex: 1 }} />
        </View>
      )}

      {/* Session timeline */}
      {item.status === 'active' && (
        <>
          <H2>{t('pam.sessions')}</H2>
          {(sessions ?? []).length === 0 ? (
            <T style={{ color: c.violet, marginBottom: 10 }}>{t('pam.sessions_empty')}</T>
          ) : (
            (sessions ?? []).map((s) => (
              <View key={s.id} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginBottom: 6, padding: 10, backgroundColor: c.cyanSoft, borderRadius: 10 }}>
                <T style={{ flex: 1, fontSize: 13 }}>{formatLabel(s.format)} · {s.scheduled_at ? new Date(s.scheduled_at).toLocaleDateString() : '—'}</T>
                <Chip style={{ backgroundColor: statusColor(s.status) + '22' }}><T style={{ fontSize: 11, color: statusColor(s.status) }}>{s.status}</T></Chip>
              </View>
            ))
          )}
          <Btn label={t('pam.session_schedule')} onPress={() => setSchedulingSession(true)} color={c.cyan} style={{ marginBottom: 10 }} />
        </>
      )}

      {/* Feedback */}
      {['active', 'completed', 'ended'].includes(item.status) && !submittingFeedback && (
        <Btn label={t('pam.feedback')} onPress={() => setSubmittingFeedback(true)} color={c.mint} variant="outline" style={{ marginBottom: 8 }} />
      )}
      {submittingFeedback && (
        <View style={{ marginBottom: 12, padding: 12, backgroundColor: c.cyanSoft, borderRadius: 12 }}>
          <H2>{t('pam.feedback')}</H2>
          <View style={{ flexDirection: 'row', gap: 6, marginVertical: 8 }}>
            {[1,2,3,4,5].map((n) => (
              <Pressable key={n} onPress={() => setRating(n)} accessibilityRole="radio" accessibilityLabel={`${n} star${n > 1 ? 's' : ''}`}
                style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: n <= rating ? c.sun : c.cyanSoft, alignItems: 'center', justifyContent: 'center' }}>
                <T style={{ fontSize: 18 }}>★</T>
              </Pressable>
            ))}
          </View>
          <Field label={t('pam.feedback_note')} value={feedbackBody} onChangeText={setFeedbackBody} multiline maxLength={1000} />
          <Btn label={busy ? '…' : t('pam.submit')} onPress={submitFeedback} disabled={busy} color={c.mint} style={{ marginTop: 8 }} />
        </View>
      )}

      {/* End mentorship */}
      {['requested', 'active'].includes(item.status) && !ending && (
        <Btn label={t('pam.end')} onPress={() => setEnding(true)} color={c.red} variant="outline" style={{ marginTop: 4 }} />
      )}
      {ending && (
        <View style={{ marginTop: 8, padding: 12, backgroundColor: c.red + '11', borderRadius: 12 }}>
          <Field label={t('pam.end_reason')} value={endReason} onChangeText={setEndReason} maxLength={300} />
          <Btn label={busy ? '…' : t('pam.end_confirm')} onPress={end} disabled={busy} color={c.red} style={{ marginTop: 8 }} />
        </View>
      )}

      {schedulingSession && (
        <SessionSheet mentorshipId={item.id} visible onClose={() => setSchedulingSession(false)} onDone={reloadSessions} />
      )}
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────── MyMentorshipsTab

function MyMentorshipsTab({ userId }) {
  const [roleTab, setRoleTab] = useState('any');
  const [viewing, setViewing] = useState(null);
  const list = usePaged('/para/mentorships', { role: roleTab });

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Seg value={roleTab} onChange={setRoleTab} color={c.pink}
        options={[{ label: t('pam.role_any'), value: 'any' }, { label: t('pam.role_mentee'), value: 'mentee' }, { label: t('pam.role_mentor'), value: 'mentor' }]} />

      {list.busy && !list.items.length ? <Loading /> : list.err ? <ErrorBox error={list.err} /> : list.items.length === 0 ? (
        <Empty title={t('pam.empty_mine')} />
      ) : (
        list.items.map((item) => (
          <MentorshipRow key={item.id} item={item} isMentor={item.mentor_id === userId} onView={setViewing} />
        ))
      )}

      {viewing && (
        <MentorshipDetailSheet item={viewing} isMentor={viewing.mentor_id === userId} visible onClose={() => setViewing(null)} onChanged={list.reload} />
      )}
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────── MentorProfileEditor

function MentorProfileEditor({ profile, onSaved }) {
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [sports, setSports] = useState((profile?.sports ?? []).join(', '));
  const [disciplines, setDisciplines] = useState((profile?.disciplines ?? []).join(', '));
  const [peerYears, setPeerYears] = useState(profile?.peer_years?.toString() ?? '');
  const [availability, setAvailability] = useState(profile?.availability ?? '');
  const [accepting, setAccepting] = useState(profile?.accepting ?? true);
  const [listed, setListed] = useState(profile?.listed ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/para/mentors/me', {
        bio: bio || undefined,
        sports: sports ? sports.split(',').map((s) => s.trim()).filter(Boolean) : [],
        disciplines: disciplines ? disciplines.split(',').map((s) => s.trim()).filter(Boolean) : [],
        peer_years: peerYears ? parseInt(peerYears, 10) : undefined,
        availability: availability || undefined,
        accepting, listed,
      });
      onSaved?.();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <View style={{ gap: 12 }}>
      {err && <ErrorBox error={err} />}
      <T style={{ fontSize: 13, color: c.violet }}>{t('pam.bio_hint')}</T>
      <Field label={t('pam.bio')} value={bio} onChangeText={setBio} multiline maxLength={500} hint={t('pam.bio_hint')} />
      <Field label={t('pam.sports')} value={sports} onChangeText={setSports} hint="Comma-separated sport slugs" />
      <Field label={t('pam.disciplines')} value={disciplines} onChangeText={setDisciplines} hint="Comma-separated disciplines" />
      <Field label={t('pam.years_label')} value={peerYears} onChangeText={setPeerYears} keyboardType="numeric" maxLength={2} />
      <Field label={t('pam.availability')} value={availability} onChangeText={setAvailability} maxLength={100} />
      <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center', paddingVertical: 8 }}>
        <Pressable onPress={() => setAccepting((v) => !v)} accessibilityRole="switch" accessibilityLabel={t('pam.accepting')}
          style={{ width: 48, height: 28, borderRadius: 14, backgroundColor: accepting ? c.lime : c.cyanSoft, padding: 2 }}>
          <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.paper, transform: [{ translateX: accepting ? 20 : 0 }] }} />
        </Pressable>
        <T style={{ color: c.ink }}>{t('pam.accepting')}</T>
      </View>
      <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center', paddingVertical: 8 }}>
        <Pressable onPress={() => setListed((v) => !v)} accessibilityRole="switch" accessibilityLabel={t('pam.listed')}
          style={{ width: 48, height: 28, borderRadius: 14, backgroundColor: listed ? c.pink : c.cyanSoft, padding: 2 }}>
          <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.paper, transform: [{ translateX: listed ? 20 : 0 }] }} />
        </Pressable>
        <T style={{ color: c.ink }}>{t('pam.listed')}</T>
      </View>
      <Btn label={busy ? '…' : t('pam.save_profile')} onPress={save} disabled={busy} color={c.pink} style={{ marginTop: 4 }} />
    </View>
  );
}

// ─────────────────────────────────────────────────────────── MentorDashboardTab

function MentorDashboardTab({ userId }) {
  const { data: profile, busy: profileBusy, reload: reloadProfile } = useLoad(() => api.get(`/para/mentors/${userId}`).catch(() => null), [userId]);
  const inbound = usePaged('/para/mentorships', { role: 'mentor', status: 'requested' });
  const active = usePaged('/para/mentorships', { role: 'mentor', status: 'active' });
  const [viewing, setViewing] = useState(null);

  const metrics = [
    { label: t('pam.metric_requests'), value: inbound.items.length },
    { label: t('pam.metric_active'), value: active.items.length },
  ];

  if (profileBusy) return <Loading />;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <MetricStrip items={metrics} />

      <Card style={{ marginBottom: 18 }}>
        <H2>{t('pam.my_mentor_profile')}</H2>
        <MentorProfileEditor profile={profile} onSaved={reloadProfile} />
      </Card>

      {inbound.items.length > 0 && (
        <>
          <H2 style={{ marginBottom: 8 }}>{t('pam.incoming_requests')}</H2>
          {inbound.items.map((item) => (
            <MentorshipRow key={item.id} item={item} isMentor onView={setViewing} />
          ))}
        </>
      )}

      {active.items.length > 0 && (
        <>
          <H2 style={{ marginTop: 16, marginBottom: 8 }}>{t('pam.active_mentees')}</H2>
          {active.items.map((item) => (
            <MentorshipRow key={item.id} item={item} isMentor onView={setViewing} />
          ))}
        </>
      )}

      {viewing && (
        <MentorshipDetailSheet item={viewing} isMentor visible onClose={() => setViewing(null)} onChanged={() => { inbound.reload(); active.reload(); }} />
      )}
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────── ParaMentoring (default export)

export default function ParaMentoring() {
  const { user } = useSession();
  const { width } = useLayout();
  const isTablet = width >= 768;
  const [tab, setTab] = useState('discover');

  return (
    <Screen>
      <View style={{ padding: 16, paddingBottom: 0 }}>
        <H1>{t('pam.title')}</H1>
        <T style={{ fontSize: 13, color: c.violet, marginBottom: 10 }}>{t('pam.privacy_note')}</T>
        <Seg value={tab} onChange={setTab} color={c.pink} options={[
          { label: t('pam.discover'), value: 'discover' },
          { label: t('pam.my_mentorships'), value: 'mine' },
          { label: t('pam.mentor_dashboard'), value: 'dashboard' },
        ]} />
      </View>
      {tab === 'discover' && <DiscoverTab />}
      {tab === 'mine' && <MyMentorshipsTab userId={user?.id} />}
      {tab === 'dashboard' && <MentorDashboardTab userId={user?.id} />}
    </Screen>
  );
}
