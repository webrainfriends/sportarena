// Referee Education, Exams & Progression (issue #1011)
// Course catalogue, enrolment, structured exam engine, attendance, practical evaluation,
// certificate issuance, licence-progression contribution, prerequisite reminders.
// Four-tab layout: Catalogue | My Courses | Exams | Certificates
// Responsive: phone/tablet/desktop. RTL-safe. Light/dark/system theme.
import React, { useState, useRef } from 'react';
import { View, Pressable, ScrollView, TextInput, Platform, Share } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../MenuField';
import { c, grad } from '../theme';
import { Metric, money, Banner } from '../federation-ui';
import { t } from '../i18n';
import { openPdf } from '../open-file';

const LEVEL_COLOR = { foundation: c.info, developing: c.ok, performance: c.warning, elite: c.accent, national: c.error };
const OUTCOME_COLOR = { pass: c.ok, fail: c.error, distinction: c.accent, merit: c.info, competent: c.ok, not_yet_competent: c.error, pending: c.muted };
const STATUS_COLOR = { enrolled: c.info, attending: c.ok, completed: c.ok, failed: c.error, withdrawn: c.muted, waitlisted: c.warning, applied: c.muted };

export function OfficialsEducation({ route }) {
  const { params } = route ?? {};
  const { user } = useSession();
  const { go } = useNav();
  const { tablet } = useLayout();
  const [tab, setTab] = useState(params?.tab ?? 'catalogue');

  return (
    <Screen>
      <View style={{ flex: 1 }}>
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'catalogue', label: t('refEdu.tab.catalogue') },
            { value: 'myCourses', label: t('refEdu.tab.myCourses') },
            { value: 'exams', label: t('refEdu.tab.exams') },
            { value: 'certificates', label: t('refEdu.tab.certificates') },
          ]}
        />
        {tab === 'catalogue' && <CatalogueTab user={user} go={go} tablet={tablet} bodyId={params?.bodyId} />}
        {tab === 'myCourses' && <MyCoursesTab user={user} go={go} tablet={tablet} />}
        {tab === 'exams' && <ExamsTab user={user} go={go} tablet={tablet} />}
        {tab === 'certificates' && <CertificatesTab user={user} go={go} tablet={tablet} />}
      </View>
    </Screen>
  );
}

// ------------------------------------------------------------------ Catalogue Tab

function CatalogueTab({ user, go, tablet, bodyId: defaultBodyId }) {
  const [bodyId, setBodyId] = useState(defaultBodyId ?? null);
  const [sportId, setSportId] = useState(null);
  const [level, setLevel] = useState(null);
  const [kind, setKind] = useState(null);
  const [selected, setSelected] = useState(null);
  const [enrolling, setEnrolling] = useState(null);

  const { data, loading, error, reload } = useLoad(
    () => bodyId ? api.get(`/officials-education/bodies/${bodyId}/courses`, { sport_id: sportId, level, kind }) : Promise.resolve([]),
    [bodyId, sportId, level, kind]
  );

  const courses = data ?? [];

  if (!bodyId) return (
    <View style={{ flex: 1, padding: 20 }}>
      <T style={{ color: c.muted, textAlign: 'center', marginTop: 40 }}>{t('refEdu.selectBody')}</T>
    </View>
  );

  return (
    <ScrollView contentContainerStyle={{ padding: tablet ? 24 : 16 }}>
      {/* Filters */}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <MenuField
          label={t('refEdu.filter.level')}
          value={level}
          onChange={setLevel}
          options={[
            { value: null, label: t('refEdu.allLevels') },
            { value: 'foundation', label: t('refEdu.level.foundation') },
            { value: 'developing', label: t('refEdu.level.developing') },
            { value: 'performance', label: t('refEdu.level.performance') },
            { value: 'elite', label: t('refEdu.level.elite') },
            { value: 'national', label: t('refEdu.level.national') },
          ]}
        />
        <MenuField
          label={t('refEdu.filter.kind')}
          value={kind}
          onChange={setKind}
          options={[
            { value: null, label: t('refEdu.allKinds') },
            { value: 'theory', label: t('refEdu.kind.theory') },
            { value: 'practical', label: t('refEdu.kind.practical') },
            { value: 'blended', label: t('refEdu.kind.blended') },
            { value: 'online', label: t('refEdu.kind.online') },
            { value: 'assessment', label: t('refEdu.kind.assessment') },
          ]}
        />
      </View>

      {loading && <Loading />}
      {error && <T style={{ color: c.error }}>{error.message}</T>}

      {!loading && courses.length === 0 && (
        <Empty
          icon="📚"
          title={t('refEdu.catalogue.empty.title')}
          body={t('refEdu.catalogue.empty.body')}
        />
      )}

      <View style={tablet ? { flexDirection: 'row', flexWrap: 'wrap', gap: 16 } : { gap: 12 }}>
        {courses.map(course => (
          <CourseCard
            key={course.id}
            course={course}
            tablet={tablet}
            onPress={() => setSelected(course)}
          />
        ))}
      </View>

      {selected && (
        <CourseDetailSheet
          course={selected}
          onClose={() => setSelected(null)}
          onEnrol={run => { setSelected(null); setEnrolling(run); }}
        />
      )}
      {enrolling && (
        <EnrolmentSheet
          run={enrolling}
          onClose={() => setEnrolling(null)}
          onSuccess={() => { setEnrolling(null); reload(); }}
        />
      )}
    </ScrollView>
  );
}

function CourseCard({ course, tablet, onPress }) {
  return (
    <Pressable onPress={onPress} style={[{ borderRadius: 12, overflow: 'hidden' }, tablet && { width: '47%' }]}>
      <GradCard grad={grad.card} style={{ padding: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <View style={{ flex: 1, marginEnd: 8 }}>
            <T style={{ fontWeight: '700', fontSize: 15 }}>{course.title}</T>
            {course.sport_name && <T style={{ color: c.muted, fontSize: 12, marginTop: 2 }}>{course.sport_name}</T>}
          </View>
          <Tag style={{ backgroundColor: LEVEL_COLOR[course.level] + '22' }}>
            <T style={{ color: LEVEL_COLOR[course.level], fontSize: 11, fontWeight: '600' }}>
              {t(`refEdu.level.${course.level}`)}
            </T>
          </Tag>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <Chip>{t(`refEdu.kind.${course.kind}`)}</Chip>
          {course.cpd_hours > 0 && <Chip>⏱ {course.cpd_hours} {t('refEdu.cpdHoursShort')}</Chip>}
          {course.price_amount > 0 && <Chip>{money(course.price_amount, course.price_currency)}</Chip>}
          {course.validity_months && <Chip>🕐 {t('refEdu.validMonths', { n: course.validity_months })}</Chip>}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {course.next_run_date
            ? <T style={{ color: c.info, fontSize: 12 }}>📅 {t('refEdu.nextRun')}: {course.next_run_date}</T>
            : <T style={{ color: c.muted, fontSize: 12 }}>{t('refEdu.noUpcomingRun')}</T>}
          {course.active_run_count > 0 && (
            <T style={{ color: c.ok, fontSize: 12 }}>{course.active_run_count} {t('refEdu.openRuns')}</T>
          )}
        </View>
      </GradCard>
    </Pressable>
  );
}

function CourseDetailSheet({ course, onClose, onEnrol }) {
  const { data: detail } = useLoad(() => api.get(`/officials-education/courses/${course.id}`), [course.id]);
  const { data: runs } = useLoad(() => api.get(`/officials-education/courses/${course.id}/runs`, { status: 'open' }), [course.id]);

  if (!detail) return null;
  return (
    <Sheet onClose={onClose} title={detail.title}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {/* Overview metrics */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Metric label={t('refEdu.level.label')} value={t(`refEdu.level.${detail.level}`)} />
          <Metric label={t('refEdu.kind.label')} value={t(`refEdu.kind.${detail.kind}`)} />
          {detail.cpd_hours > 0 && <Metric label={t('refEdu.cpdHours')} value={`${detail.cpd_hours}h`} />}
          {detail.duration_hours && <Metric label={t('refEdu.duration')} value={`${detail.duration_hours}h`} />}
          {detail.pass_mark && <Metric label={t('refEdu.passMark')} value={`${detail.pass_mark}%`} />}
          {detail.price_amount > 0 && <Metric label={t('refEdu.price')} value={money(detail.price_amount, detail.price_currency)} />}
        </View>

        {/* Prerequisites */}
        {detail.prerequisites?.length > 0 && (
          <Section title={t('refEdu.prerequisites')}>
            {detail.prerequisites.map(p => (
              <View key={p.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <T>🔑</T>
                <T style={{ flex: 1, fontSize: 13 }}>
                  {p.required_course_title ?? p.required_credential_kind}
                  {p.validity_months ? ` (${t('refEdu.validWithin', { n: p.validity_months })})` : ''}
                </T>
              </View>
            ))}
          </Section>
        )}

        {/* Learning objectives */}
        {detail.learning_objectives?.length > 0 && (
          <Section title={t('refEdu.objectives')}>
            {detail.learning_objectives.map((obj, i) => (
              <T key={i} style={{ fontSize: 13, marginBottom: 4 }}>• {obj}</T>
            ))}
          </Section>
        )}

        {/* Upcoming runs */}
        {runs?.length > 0 && (
          <Section title={t('refEdu.upcomingRuns')}>
            {runs.map(run => (
              <Card key={run.id} style={{ marginBottom: 8, padding: 12 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View>
                    <T style={{ fontWeight: '600', fontSize: 14 }}>{run.run_code ?? run.start_date}</T>
                    <T style={{ color: c.muted, fontSize: 12 }}>{run.start_date} → {run.end_date}</T>
                    {run.venue_name_at_time && <T style={{ color: c.muted, fontSize: 12 }}>📍 {run.venue_name_at_time}</T>}
                    <T style={{ color: c.muted, fontSize: 12 }}>{t(`refEdu.delivery.${run.delivery_mode}`)}</T>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 6 }}>
                    {run.max_enrolments && (
                      <T style={{ fontSize: 11, color: parseInt(run.enrolled_count) >= run.max_enrolments ? c.error : c.ok }}>
                        {run.enrolled_count}/{run.max_enrolments}
                      </T>
                    )}
                    <Btn
                      label={t('refEdu.enrolNow')}
                      onPress={() => onEnrol(run)}
                      disabled={run.enrolment_deadline < new Date().toISOString().slice(0, 10)}
                      style={{ paddingVertical: 6 }}
                    />
                  </View>
                </View>
              </Card>
            ))}
          </Section>
        )}

        {runs?.length === 0 && (
          <Empty icon="📅" title={t('refEdu.noRunsAvailable')} body={t('refEdu.noRunsBody')} />
        )}
      </ScrollView>
    </Sheet>
  );
}

function EnrolmentSheet({ run, onClose, onSuccess }) {
  const { user } = useSession();
  const [licenceId, setLicenceId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [prereqResult, setPrereqResult] = useState(null);
  const { data: licences } = useLoad(() => api.get('/officials/my-licences'), []);

  const licOpts = (licences ?? []).map(l => ({ value: l.id, label: `${l.type_name} (${l.licence_no})` }));

  async function apply() {
    if (!licenceId) return;
    setBusy(true);
    try {
      const res = await api.post(`/officials-education/runs/${run.id}/enrolments`, { licence_id: licenceId });
      if (!res.prerequisite_check.met) {
        setPrereqResult(res.prerequisite_check);
      } else {
        onSuccess();
      }
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} title={t('refEdu.enrolIn', { run: run.run_code ?? run.start_date })}>
      <View style={{ padding: 16, gap: 16 }}>
        {prereqResult && (
          <Banner kind="error" title={t('refEdu.prereqNotMet')}>
            {prereqResult.missing.map((p, i) => (
              <T key={i} style={{ fontSize: 13, color: c.error }}>
                • {p.title ?? p.credential_kind}
                {p.validity_months ? ` (${t('refEdu.mustBeWithin', { n: p.validity_months })})` : ''}
              </T>
            ))}
          </Banner>
        )}
        <Field label={t('refEdu.yourLicence')}>
          <MenuField
            value={licenceId}
            onChange={setLicenceId}
            options={licOpts}
            placeholder={t('refEdu.pickLicence')}
          />
        </Field>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn label={t('common.cancel')} onPress={onClose} secondary style={{ flex: 1 }} />
          <Btn label={t('refEdu.confirmEnrol')} onPress={apply} loading={busy} disabled={!licenceId} style={{ flex: 1 }} />
        </View>
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ My Courses Tab

function MyCoursesTab({ user, go, tablet }) {
  const [statusFilter, setStatusFilter] = useState(null);
  const [selected, setSelected] = useState(null);
  const { data, loading, error, reload } = useLoad(() => api.get('/officials-education/my-enrolments', { status: statusFilter }), [statusFilter]);
  const enrolments = data ?? [];

  const statuses = [
    { value: null, label: t('refEdu.allStatuses') },
    { value: 'enrolled', label: t('refEdu.status.enrolled') },
    { value: 'attending', label: t('refEdu.status.attending') },
    { value: 'completed', label: t('refEdu.status.completed') },
    { value: 'failed', label: t('refEdu.status.failed') },
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: tablet ? 24 : 16 }}>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
        {statuses.map(s => (
          <Pressable key={s.value ?? 'all'} onPress={() => setStatusFilter(s.value)}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: statusFilter === s.value ? c.accent : c.card }}>
            <T style={{ color: statusFilter === s.value ? '#fff' : c.text, fontSize: 12 }}>{s.label}</T>
          </Pressable>
        ))}
      </View>

      {loading && <Loading />}
      {!loading && enrolments.length === 0 && (
        <Empty icon="📋" title={t('refEdu.myCourses.empty.title')} body={t('refEdu.myCourses.empty.body')} />
      )}

      <View style={{ gap: 12 }}>
        {enrolments.map(enr => (
          <Pressable key={enr.id} onPress={() => setSelected(enr)}>
            <Card style={{ padding: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <View style={{ flex: 1, marginEnd: 8 }}>
                  <T style={{ fontWeight: '700', fontSize: 15 }}>{enr.course_title}</T>
                  {enr.body_name && <T style={{ color: c.muted, fontSize: 12 }}>{enr.body_name}</T>}
                  <T style={{ color: c.muted, fontSize: 12 }}>{enr.start_date} – {enr.end_date}</T>
                </View>
                <Tag style={{ backgroundColor: (STATUS_COLOR[enr.status] ?? c.muted) + '22' }}>
                  <T style={{ color: STATUS_COLOR[enr.status] ?? c.muted, fontSize: 11, fontWeight: '600' }}>
                    {t(`refEdu.status.${enr.status}`)}
                  </T>
                </Tag>
              </View>
              {/* Attendance progress bar */}
              {parseInt(enr.sessions_total) > 0 && (
                <View style={{ marginBottom: 8 }}>
                  <T style={{ fontSize: 11, color: c.muted, marginBottom: 3 }}>
                    {t('refEdu.attendance')}: {enr.sessions_present}/{enr.sessions_total}
                  </T>
                  <View style={{ height: 4, backgroundColor: c.card, borderRadius: 2 }}>
                    <View style={{ height: 4, borderRadius: 2, backgroundColor: c.ok, width: `${Math.min(100, Math.round(parseInt(enr.sessions_present) / parseInt(enr.sessions_total) * 100))}%` }} />
                  </View>
                </View>
              )}
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Chip>{t(`refEdu.kind.${enr.kind}`)}</Chip>
                {enr.cpd_hours > 0 && <Chip>⏱ {enr.cpd_hours}{t('refEdu.cpdHoursShort')}</Chip>}
                {enr.certificate && <Chip style={{ backgroundColor: c.ok + '22' }}>🏅 {t('refEdu.certified')}</Chip>}
                {enr.final_score != null && (
                  <Chip style={{ backgroundColor: (OUTCOME_COLOR[enr.outcome] ?? c.muted) + '22' }}>
                    {enr.final_score}% — {t(`refEdu.outcome.${enr.outcome}`)}
                  </Chip>
                )}
              </View>
            </Card>
          </Pressable>
        ))}
      </View>

      {selected && (
        <EnrolmentDetailSheet
          enrolment={selected}
          onClose={() => setSelected(null)}
          onReload={reload}
        />
      )}
    </ScrollView>
  );
}

function EnrolmentDetailSheet({ enrolment, onClose, onReload }) {
  const { data: attempts } = useLoad(() => api.get(`/officials-education/enrolments/${enrolment.id}/exam-attempts`), [enrolment.id]);
  const { data: evals } = useLoad(() => api.get(`/officials-education/enrolments/${enrolment.id}/practical-evaluations`), [enrolment.id]);

  return (
    <Sheet onClose={onClose} title={enrolment.course_title}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Metric label={t('refEdu.status.label')} value={t(`refEdu.status.${enrolment.status}`)} />
          {enrolment.final_score != null && <Metric label={t('refEdu.finalScore')} value={`${enrolment.final_score}%`} />}
          {enrolment.completion_date && <Metric label={t('refEdu.completedOn')} value={enrolment.completion_date} />}
        </View>

        {attempts?.length > 0 && (
          <Section title={t('refEdu.examAttempts')}>
            {attempts.map(a => (
              <Card key={a.id} style={{ padding: 10, marginBottom: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <T style={{ fontWeight: '600', fontSize: 13 }}>{a.exam_title}</T>
                  <Tag style={{ backgroundColor: (OUTCOME_COLOR[a.outcome ?? 'pending']) + '22' }}>
                    <T style={{ color: OUTCOME_COLOR[a.outcome ?? 'pending'], fontSize: 11 }}>
                      {t(`refEdu.outcome.${a.outcome ?? 'pending'}`)}
                    </T>
                  </Tag>
                </View>
                <T style={{ color: c.muted, fontSize: 12 }}>
                  {t('refEdu.attempt')} #{a.attempt_number} · {a.final_score != null ? `${a.final_score}%` : t('refEdu.awaitingGrade')}
                </T>
              </Card>
            ))}
          </Section>
        )}

        {evals?.length > 0 && (
          <Section title={t('refEdu.practicalEvals')}>
            {evals.map(ev => (
              <Card key={ev.id} style={{ padding: 10, marginBottom: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <T style={{ fontWeight: '600', fontSize: 13 }}>{ev.evaluated_at}</T>
                  <Tag style={{ backgroundColor: (OUTCOME_COLOR[ev.outcome ?? 'pending']) + '22' }}>
                    <T style={{ color: OUTCOME_COLOR[ev.outcome ?? 'pending'], fontSize: 11 }}>
                      {ev.outcome ? t(`refEdu.outcome.${ev.outcome}`) : t('refEdu.outcome.pending')}
                    </T>
                  </Tag>
                </View>
                {ev.overall_score != null && <T style={{ color: c.muted, fontSize: 12 }}>{t('refEdu.score')}: {ev.overall_score}%</T>}
                {ev.status === 'submitted' && (
                  <Btn label={t('refEdu.acknowledge')} onPress={async () => {
                    await api.post(`/officials-education/practical-evaluations/${ev.id}/acknowledge`, {});
                    onReload();
                  }} style={{ marginTop: 6, paddingVertical: 6 }} />
                )}
              </Card>
            ))}
          </Section>
        )}

        {enrolment.certificate && (
          <Section title={t('refEdu.certificate')}>
            <Card style={{ padding: 12 }}>
              <T style={{ fontWeight: '600' }}>{enrolment.certificate.certificate_number}</T>
              <T style={{ color: c.muted, fontSize: 12 }}>{t('refEdu.issuedOn')}: {enrolment.certificate.issued_at?.slice(0,10)}</T>
              {enrolment.certificate.expires_at && (
                <T style={{ color: new Date(enrolment.certificate.expires_at) < new Date() ? c.error : c.ok, fontSize: 12 }}>
                  {t('refEdu.expiresOn')}: {enrolment.certificate.expires_at?.slice(0,10)}
                </T>
              )}
              <Btn label={t('refEdu.viewCertificate')} style={{ marginTop: 8 }} onPress={() => {
                // Share or open
                const url = `${api.base}/officials-education/certificates/${enrolment.certificate.id}`;
                if (Platform.OS === 'web') { window.open(url, '_blank'); } else { Share.share({ url }); }
              }} />
            </Card>
          </Section>
        )}
      </ScrollView>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Exams Tab

function ExamsTab({ user, go, tablet }) {
  const [activeAttempt, setActiveAttempt] = useState(null);
  const { data: enrolments } = useLoad(() => api.get('/officials-education/my-enrolments', { status: 'enrolled' }), []);

  if (activeAttempt) {
    return <ExamAttemptFlow attempt={activeAttempt} onDone={() => setActiveAttempt(null)} />;
  }

  const active = (enrolments ?? []).filter(e => ['enrolled', 'attending'].includes(e.status));

  return (
    <ScrollView contentContainerStyle={{ padding: tablet ? 24 : 16 }}>
      {active.length === 0 && (
        <Empty icon="📝" title={t('refEdu.exams.empty.title')} body={t('refEdu.exams.empty.body')} />
      )}
      {active.map(enr => (
        <EnrolmentExams key={enr.id} enrolment={enr} onStartAttempt={setActiveAttempt} tablet={tablet} />
      ))}
    </ScrollView>
  );
}

function EnrolmentExams({ enrolment, onStartAttempt, tablet }) {
  const { data: courseDetail } = useLoad(() => api.get(`/officials-education/courses/${enrolment.course_id}`), [enrolment.course_id]);
  const { data: attempts } = useLoad(() => api.get(`/officials-education/enrolments/${enrolment.id}/exam-attempts`), [enrolment.id]);
  const exams = courseDetail?.exams ?? [];

  if (!exams.length) return null;

  return (
    <Section title={enrolment.course_title} style={{ marginBottom: 20 }}>
      {exams.map(exam => {
        const myAttempts = (attempts ?? []).filter(a => a.exam_id === exam.id && !a.voided_at);
        const best = myAttempts.reduce((b, a) => (!b || (a.final_score ?? 0) > (b.final_score ?? 0)) ? a : b, null);
        const remaining = exam.max_attempts - myAttempts.length;
        const canAttempt = remaining > 0 && !myAttempts.some(a => a.outcome === 'pass');

        return (
          <Card key={exam.id} style={{ padding: 12, marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
              <View style={{ flex: 1, marginEnd: 8 }}>
                <T style={{ fontWeight: '600', fontSize: 14 }}>{exam.title}</T>
                <T style={{ color: c.muted, fontSize: 12 }}>
                  {t(`refEdu.kind.${exam.kind}`)}
                  {exam.time_limit_minutes ? ` · ⏱ ${exam.time_limit_minutes} ${t('refEdu.minutes')}` : ''}
                  {exam.pass_mark ? ` · ${t('refEdu.pass')}: ${exam.pass_mark}%` : ''}
                </T>
              </View>
              {best && (
                <Tag style={{ backgroundColor: (OUTCOME_COLOR[best.outcome ?? 'pending']) + '22' }}>
                  <T style={{ color: OUTCOME_COLOR[best.outcome ?? 'pending'], fontSize: 11, fontWeight: '600' }}>
                    {best.outcome === 'pending' ? t('refEdu.outcome.pending') : `${best.final_score ?? '?'}%`}
                  </T>
                </Tag>
              )}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T style={{ color: c.muted, fontSize: 12 }}>
                {t('refEdu.attemptsRemaining')}: {remaining}/{exam.max_attempts}
              </T>
              {canAttempt && (
                <Btn
                  label={myAttempts.length === 0 ? t('refEdu.startExam') : t('refEdu.retryExam')}
                  onPress={async () => {
                    const res = await api.post(`/officials-education/exams/${exam.id}/attempts`, { enrolment_id: enrolment.id });
                    onStartAttempt({ ...res, exam });
                  }}
                  style={{ paddingVertical: 6 }}
                />
              )}
              {!canAttempt && best?.outcome === 'pass' && (
                <T style={{ color: c.ok, fontSize: 12, fontWeight: '600' }}>✓ {t('refEdu.passed')}</T>
              )}
            </View>
          </Card>
        );
      })}
    </Section>
  );
}

function ExamAttemptFlow({ attempt, onDone }) {
  const { attempt: attemptData, questions: qs } = attempt;
  const [answers, setAnswers] = useState({});
  const [current, setCurrent] = useState(0);
  const [submitted, setSubmitted] = useState(null);
  const [busy, setBusy] = useState(false);
  const timeLimit = attempt.exam?.time_limit_minutes;

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post(`/officials-education/exam-attempts/${attemptData.id}/submit`, { answers });
      setSubmitted(res);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <T style={{ fontSize: 48, marginBottom: 16 }}>{submitted.outcome === 'pass' ? '🏅' : submitted.outcome === 'fail' ? '❌' : '⏳'}</T>
        <T style={{ fontSize: 20, fontWeight: '700', marginBottom: 8 }}>
          {submitted.outcome === 'pass' ? t('refEdu.examPassed') : submitted.outcome === 'fail' ? t('refEdu.examFailed') : t('refEdu.examPending')}
        </T>
        {submitted.auto_score != null && (
          <T style={{ fontSize: 32, fontWeight: '700', color: submitted.outcome === 'pass' ? c.ok : c.error, marginBottom: 8 }}>
            {Math.round(submitted.auto_score)}%
          </T>
        )}
        {submitted.outcome === 'pending' && (
          <T style={{ color: c.muted, textAlign: 'center' }}>{t('refEdu.awaitingManualGrade')}</T>
        )}
        <Btn label={t('common.done')} onPress={onDone} style={{ marginTop: 24 }} />
      </View>
    );
  }

  const q = qs?.[current];
  const total = qs?.length ?? 0;

  return (
    <View style={{ flex: 1 }}>
      {/* Progress bar */}
      <View style={{ height: 4, backgroundColor: c.card }}>
        <View style={{ height: 4, backgroundColor: c.accent, width: `${Math.round((current / Math.max(total, 1)) * 100)}%` }} />
      </View>
      <View style={{ padding: 16, flexDirection: 'row', justifyContent: 'space-between' }}>
        <T style={{ color: c.muted }}>{t('refEdu.questionOf', { n: current + 1, total })}</T>
        {timeLimit && <ExamTimer minutes={timeLimit} onExpire={submit} />}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, flexGrow: 1 }}>
        {q && (
          <View style={{ gap: 16 }}>
            <T style={{ fontSize: 16, fontWeight: '600', lineHeight: 24 }}>{q.stem}</T>
            {q.kind === 'mcq' && (q.options ?? []).map(opt => (
              <Pressable
                key={opt.key}
                onPress={() => setAnswers(a => ({ ...a, [q.id]: opt.key }))}
                style={{ padding: 12, borderRadius: 10, borderWidth: 2, borderColor: answers[q.id] === opt.key ? c.accent : c.border }}>
                <T>{opt.text}</T>
              </Pressable>
            ))}
            {q.kind === 'true_false' && (
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {['true', 'false'].map(v => (
                  <Pressable
                    key={v}
                    onPress={() => setAnswers(a => ({ ...a, [q.id]: v }))}
                    style={{ flex: 1, padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 2, borderColor: answers[q.id] === v ? c.accent : c.border }}>
                    <T style={{ fontWeight: '600' }}>{v === 'true' ? t('common.yes') : t('common.no')}</T>
                  </Pressable>
                ))}
              </View>
            )}
            {(q.kind === 'short_answer' || q.kind === 'scenario') && (
              <TextInput
                multiline
                value={answers[q.id] ?? ''}
                onChangeText={text => setAnswers(a => ({ ...a, [q.id]: text }))}
                placeholder={t('refEdu.yourAnswer')}
                style={{ minHeight: 100, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, color: c.text, textAlignVertical: 'top' }}
                accessible
                accessibilityLabel={t('refEdu.yourAnswer')}
              />
            )}
          </View>
        )}
      </ScrollView>

      <View style={{ padding: 16, flexDirection: 'row', gap: 12 }}>
        {current > 0 && <Btn label={t('common.back')} onPress={() => setCurrent(c => c - 1)} secondary style={{ flex: 1 }} />}
        {current < total - 1
          ? <Btn label={t('common.next')} onPress={() => setCurrent(c => c + 1)} style={{ flex: 1 }} />
          : <Btn label={t('refEdu.submitExam')} onPress={submit} loading={busy} style={{ flex: 1 }} />}
      </View>
    </View>
  );
}

function ExamTimer({ minutes, onExpire }) {
  const [secs, setSecs] = React.useState(minutes * 60);
  React.useEffect(() => {
    const iv = setInterval(() => setSecs(s => { if (s <= 1) { clearInterval(iv); onExpire(); return 0; } return s - 1; }), 1000);
    return () => clearInterval(iv);
  }, []);
  const m = Math.floor(secs / 60), s = secs % 60;
  const color = secs < 300 ? c.error : secs < 600 ? c.warning : c.muted;
  return <T style={{ color, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{m}:{String(s).padStart(2,'0')}</T>;
}

// ------------------------------------------------------------------ Certificates Tab

function CertificatesTab({ user, go, tablet }) {
  const { data, loading } = useLoad(() => api.get('/officials-education/my-certificates'), []);
  const certs = data ?? [];
  const now = new Date();

  return (
    <ScrollView contentContainerStyle={{ padding: tablet ? 24 : 16 }}>
      {loading && <Loading />}
      {!loading && certs.length === 0 && (
        <Empty icon="🏅" title={t('refEdu.certs.empty.title')} body={t('refEdu.certs.empty.body')} />
      )}
      <View style={tablet ? { flexDirection: 'row', flexWrap: 'wrap', gap: 16 } : { gap: 12 }}>
        {certs.map(cert => {
          const expires = cert.expires_at ? new Date(cert.expires_at) : null;
          const daysLeft = expires ? Math.round((expires - now) / 86400000) : null;
          const expColor = daysLeft == null ? c.ok : daysLeft < 30 ? c.error : daysLeft < 90 ? c.warning : c.ok;

          return (
            <Card key={cert.id} style={[{ padding: 16 }, tablet && { width: '47%' }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <View style={{ flex: 1, marginEnd: 8 }}>
                  <T style={{ fontWeight: '700', fontSize: 15, marginBottom: 2 }}>{cert.course_title}</T>
                  <T style={{ color: c.muted, fontSize: 12 }}>{cert.body_name}</T>
                </View>
                <T style={{ fontSize: 28 }}>🏅</T>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                <Chip>{t(`refEdu.level.${cert.level}`)}</Chip>
                {cert.sport_name && <Chip>{cert.sport_name}</Chip>}
              </View>
              <T style={{ color: c.muted, fontSize: 12 }}>#{cert.certificate_number}</T>
              <T style={{ color: c.muted, fontSize: 12 }}>{t('refEdu.issuedOn')}: {cert.issued_at?.slice(0,10)}</T>
              {expires && (
                <T style={{ color: expColor, fontSize: 12, fontWeight: '600' }}>
                  {daysLeft > 0
                    ? t('refEdu.expiresIn', { n: daysLeft })
                    : t('refEdu.expired')}
                </T>
              )}
              <Btn
                label={t('refEdu.viewCertificate')}
                style={{ marginTop: 10 }}
                onPress={() => {
                  const url = `${api.base}/officials-education/certificates/${cert.id}`;
                  if (Platform.OS === 'web') { window.open(url, '_blank'); } else { Share.share({ url }); }
                }}
              />
            </Card>
          );
        })}
      </View>
    </ScrollView>
  );
}
