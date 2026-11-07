// Academy OS P2 / Gap 21 (#801): Placement Pathways screen.
// Staff side: AcademyPlacement — advisor action queue, athlete list, opportunity detail.
// Family/athlete side: FamilyPlacement — my opportunities, sharing consent, evidence upload.
// API-first: all state lives in the placement capability; this module only calls it.
// Cross-platform: phone (single-column), tablet (two-pane), desktop (three-pane + side rail).
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { explain } from '../access';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { when } from './academy-ui';
import { Block, Kpi, Meter } from './academy-ui';

// ── Shared constants ──────────────────────────────────────────────────────────

const KINDS = [
  { value: 'university_place',      label: t('pl.kind.university_place') },
  { value: 'scholarship',           label: t('pl.kind.scholarship') },
  { value: 'grant',                 label: t('pl.kind.grant') },
  { value: 'professional_contract', label: t('pl.kind.professional_contract') },
];
const EV_KINDS = [
  { value: 'academic_transcript', label: t('pl.ev.kind.academic_transcript') },
  { value: 'sport_cv',            label: t('pl.ev.kind.sport_cv') },
  { value: 'performance_video',   label: t('pl.ev.kind.performance_video') },
  { value: 'reference_letter',    label: t('pl.ev.kind.reference_letter') },
  { value: 'passport',            label: t('pl.ev.kind.passport') },
  { value: 'ranking_cert',        label: t('pl.ev.kind.ranking_cert') },
  { value: 'medical_clearance',   label: t('pl.ev.kind.medical_clearance') },
  { value: 'other',               label: t('pl.ev.kind.other') },
];
const REF_ROLES = [
  { value: 'coach',    label: t('pl.ref.role.coach') },
  { value: 'academic', label: t('pl.ref.role.academic') },
  { value: 'advisor',  label: t('pl.ref.role.advisor') },
  { value: 'personal', label: t('pl.ref.role.personal') },
  { value: 'other',    label: t('pl.ref.role.other') },
];
const STAGE_ORDER = ['identified','eligibility_check','evidence_gathering','applied','offer_received','outcome'];
const STAGE_TONE  = { identified: undefined, eligibility_check: c.cyanSoft, evidence_gathering: c.pinkSoft, applied: c.sunSoft, offer_received: c.limeSoft, outcome: c.limeSoft };
const STAGE_LABEL = {
  identified: t('pl.stage.identified'), eligibility_check: t('pl.stage.eligibility_check'),
  evidence_gathering: t('pl.stage.evidence_gathering'), applied: t('pl.stage.applied'),
  offer_received: t('pl.stage.offer_received'), outcome: t('pl.stage.outcome'),
};

function StageChip({ status }) {
  return <Tag label={STAGE_LABEL[status] ?? status} color={STAGE_TONE[status]} />;
}

/** Horizontal stage progress bar */
function StagePip({ status }) {
  const idx = STAGE_ORDER.indexOf(status);
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', gap: 3 }}>
        {STAGE_ORDER.map((s, i) => (
          <View key={s} style={{ flex: 1, height: 5, borderRadius: 999,
            backgroundColor: i < idx ? c.lime : i === idx ? c.pink : c.line }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T size={10} color={c.mute}>{STAGE_LABEL.identified}</T>
        <T size={10} color={idx === STAGE_ORDER.indexOf('applied') ? c.pink : c.mute} weight={idx === STAGE_ORDER.indexOf('applied') ? '800' : '400'}>{STAGE_LABEL[status]}</T>
        <T size={10} color={c.mute}>{STAGE_LABEL.outcome}</T>
      </View>
    </View>
  );
}

/** Evidence completion summary chip */
function EvidenceChip({ done, total }) {
  if (!total) return null;
  const pct = Math.round((done / total) * 100);
  const color = done === total ? c.limeSoft : pct >= 50 ? c.sunSoft : c.pinkSoft;
  return <Tag label={`${t('pl.ev.label')}: ${done}/${total}`} color={color} />;
}

/** Initials avatar */
function Av({ name = '', size = 36, style }) {
  const initials = name.split(' ').slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
  return (
    <View accessible={false} style={[{ width: size, height: size, borderRadius: 999, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }, style]}>
      <T size={size * 0.36} weight="800" color="#fff">{initials}</T>
    </View>
  );
}

// ── Opportunity card (list view) ──────────────────────────────────────────────
function OppCard({ opp, onPress }) {
  const urgent = opp.deadline && new Date(opp.deadline) <= new Date(Date.now() + 7 * 86400e3);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${opp.title}, ${STAGE_LABEL[opp.status]}`}
      style={{ backgroundColor: urgent ? c.sunSoft : c.paper, borderRadius: 18, padding: 14,
               borderWidth: 1, borderColor: urgent ? c.sun : c.line,
               borderLeftWidth: 4, borderLeftColor: STAGE_TONE[opp.status] ?? c.pink, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800" size={15}>{opp.title}</T>
          {opp.athlete_name ? <T size={12} color={c.mute}>{opp.athlete_name}</T> : null}
          {opp.institution_name ? <T size={12} color={c.mute}>{opp.institution_name}</T> : null}
        </View>
        <StageChip status={opp.status} />
      </View>
      <StagePip status={opp.status} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <EvidenceChip done={Number(opp.evidence_done ?? 0)} total={Number(opp.evidence_total ?? 0)} />
        {opp.deadline ? <Tag label={`⏰ ${when(opp.deadline)}`} color={urgent ? c.sunSoft : c.bg} /> : null}
      </View>
    </Pressable>
  );
}

// ── Evidence checklist ────────────────────────────────────────────────────────
function EvidenceList({ items, onUpdate, toast }) {
  const statusIcon = (s) => ({ uploaded: '✓', verified: '✓', waived: '—', requested: '…', pending: '' }[s] ?? '');
  const statusColor = (s) => ({ uploaded: c.lime, verified: c.lime, waived: c.mute, requested: c.sun }[s] ?? c.line);

  return (
    <Block title={t('pl.ev.section')}>
      {items.length === 0 ? <T size={13} color={c.mute}>{t('pl.ev.empty')}</T> : null}
      {items.map((item) => (
        <View key={item.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10,
                                     padding: 10, borderRadius: 12,
                                     backgroundColor: item.status === 'pending' && item.required ? c.pinkSoft : c.bg }}>
          <View accessible={false} style={{ width: 22, height: 22, borderRadius: 7, borderWidth: 2,
                                            borderColor: statusColor(item.status),
                                            backgroundColor: ['uploaded','verified'].includes(item.status) ? statusColor(item.status) : c.paper,
                                            alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
            <T size={11} color="#fff" weight="800">{statusIcon(item.status)}</T>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T weight="700" size={13}>{item.label}</T>
            {item.note ? <T size={11} color={c.mute}>{item.note}</T> : null}
            <T size={11} color={item.status === 'pending' && item.required ? c.orange : c.mute}>{EV_KINDS.find((k) => k.value === item.kind)?.label ?? item.kind} · {item.status}</T>
          </View>
          {item.status === 'pending' && onUpdate ? (
            <Btn small title={t('pl.ev.request')}
              onPress={async () => {
                try {
                  await api.patch(`/academy/placement/evidence/${item.id}`, { status: 'requested' });
                  toast(t('pl.ev.requested'));
                  onUpdate();
                } catch (e) { toast(explain(e)); }
              }} />
          ) : null}
        </View>
      ))}
    </Block>
  );
}

// ── Reference list ────────────────────────────────────────────────────────────
function ReferenceList({ refs, oppId, onUpdate, toast }) {
  const [addRef, setAddRef] = useState(false);
  return (
    <Block title={t('pl.ref.section')}>
      {refs.map((r) => (
        <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
                                  padding: 10, borderRadius: 12,
                                  backgroundColor: r.status === 'submitted' ? c.limeSoft : r.due_on && new Date(r.due_on) <= new Date(Date.now() + 3 * 86400e3) ? c.sunSoft : c.bg }}>
          <Av name={r.referee_name} size={30} />
          <View style={{ flex: 1, gap: 1 }}>
            <T weight="800" size={13}>{r.referee_name}</T>
            <T size={11} color={c.mute}>{r.purpose}</T>
            <Tag label={r.status} color={r.status === 'submitted' ? c.limeSoft : r.status === 'declined' ? c.redSoft : undefined} />
          </View>
          {r.due_on ? <T size={11} color={c.mute}>⏰ {when(r.due_on)}</T> : null}
          {r.status === 'requested' ? (
            <Btn small title={t('pl.ref.remind')}
              onPress={async () => {
                try {
                  await api.patch(`/academy/placement/references/${r.id}`, { row_version: r.row_version ?? 1, status: 'reminded' });
                  toast(t('pl.ref.reminded'));
                  onUpdate();
                } catch (e) { toast(explain(e)); }
              }} />
          ) : null}
        </View>
      ))}
      <Btn small title={t('pl.ref.add')} color={c.paper} ink={c.pink} onPress={() => setAddRef(true)} />
      <FormSheet visible={addRef} onClose={() => setAddRef(false)} title={t('pl.ref.add')} submitLabel={t('pl.ref.send')}
        fields={[
          { key: 'referee_id', label: t('pl.ref.f_referee'), type: 'entity', entityKind: 'person' },
          { key: 'referee_role', label: t('pl.ref.f_role'), type: 'chips', options: REF_ROLES },
          { key: 'purpose', label: t('pl.ref.f_purpose') },
          { key: 'due_on', label: t('pl.ref.f_due'), type: 'date', optional: true },
          { key: 'instructions', label: t('pl.ref.f_instructions'), type: 'text', optional: true },
        ]}
        onSubmit={async (v) => {
          await api.post(`/academy/placement/${oppId}/references`, { ...v });
          onUpdate();
          return t('pl.ref.sent');
        }} />
    </Block>
  );
}

// ── Sharing consent sheet (athlete/guardian) ──────────────────────────────────
function SharingConsentSheet({ visible, opp, athleteId, onClose, onDone, toast }) {
  const [fields, setFields] = useState({ sport_performance: true, academic: false, dev_plan: true, health_summary: false, contact: true });
  const toggleField = (k) => setFields((prev) => ({ ...prev, [k]: !prev[k] }));
  const [busy, setBusy] = useState(false);

  const FIELD_OPTS = [
    { key: 'sport_performance', label: t('pl.sh.f_sport'), sub: t('pl.sh.f_sport_sub') },
    { key: 'academic',          label: t('pl.sh.f_academic'), sub: t('pl.sh.f_academic_sub') },
    { key: 'dev_plan',          label: t('pl.sh.f_devplan'), sub: t('pl.sh.f_devplan_sub') },
    { key: 'health_summary',    label: t('pl.sh.f_health'), sub: t('pl.sh.f_health_sub') },
    { key: 'contact',           label: t('pl.sh.f_contact'), sub: t('pl.sh.f_contact_sub') },
  ];

  return (
    <Sheet visible={visible} onClose={onClose} title={t('pl.sh.title')}>
      <View style={{ gap: 14 }}>
        <View style={{ backgroundColor: c.pinkSoft, borderRadius: 14, padding: 14, gap: 4 }}>
          <T weight="800">{opp?.institution_name ?? ''}</T>
          <T size={12} color={c.mute}>{t('pl.sh.revoke_hint')}</T>
        </View>

        <T weight="800" size={12} color={c.mute} style={{ letterSpacing: 0.8 }}>{t('pl.sh.what_to_share').toUpperCase()}</T>
        <View style={{ backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.line }}>
          {FIELD_OPTS.map((f, i) => (
            <Pressable key={f.key} onPress={() => toggleField(f.key)} accessibilityRole="switch" accessibilityState={{ checked: fields[f.key] }} accessibilityLabel={f.label}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12,
                       borderBottomWidth: i < FIELD_OPTS.length - 1 ? 1 : 0, borderBottomColor: c.line }}>
              <View style={{ flex: 1, gap: 1 }}>
                <T weight="700" size={13}>{f.label}</T>
                <T size={11} color={c.mute}>{f.sub}</T>
              </View>
              <View style={{ width: 44, height: 26, borderRadius: 999, backgroundColor: fields[f.key] ? c.pink : c.line, justifyContent: 'center', padding: 3 }}>
                <View style={{ width: 20, height: 20, borderRadius: 999, backgroundColor: '#fff',
                               alignSelf: fields[f.key] ? 'flex-end' : 'flex-start',
                               shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 2 }} />
              </View>
            </Pressable>
          ))}
        </View>

        <View style={{ backgroundColor: c.sunSoft, borderRadius: 12, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <T size={16}>ℹ️</T>
          <T size={12} color={c.ink} style={{ flex: 1 }}>{t('pl.sh.youth_note')}</T>
        </View>

        <Btn title={t('pl.sh.grant')} loading={busy}
          onPress={async () => {
            setBusy(true);
            try {
              const params = athleteId ? { athlete_id: athleteId } : {};
              await api.post(`/me/placement/${opp?.id}/sharing`, { ...params, institution_name: opp?.institution_name ?? '', fields });
              toast(t('pl.sh.granted'));
              onDone?.();
            } catch (e) { toast(explain(e)); } finally { setBusy(false); }
          }} />
        <Btn title={t('common.cancel')} color={c.paper} ink={c.ink} onPress={onClose} />
      </View>
    </Sheet>
  );
}

// ── Opportunity detail panel ──────────────────────────────────────────────────
function OppDetail({ oppId, orgId, isStaff, toast, onBack, athleteId }) {
  // A guardian opens a ward's opportunity by naming the athlete; the server re-checks the live guardian link on every call.
  const d = useLoad(() => isStaff ? api.get(`/academy/placement/${oppId}`) : api.get(`/me/placement/${oppId}`, athleteId ? { athlete_id: athleteId } : {}), [oppId, isStaff, athleteId]);
  const [shareSheet, setShareSheet] = useState(false);

  if (!d.data) return d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : <Loading />;

  const { opportunity: opp, evidence, references, shares } = d.data;
  const liveShare = shares?.find((s) => !s.revoked_at);

  return (
    <ScrollView contentContainerStyle={{ gap: 14, padding: 14 }}>
      {onBack ? <Btn small title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} /> : null}

      <View style={{ gap: 6 }}>
        <T weight="800" size={20}>{opp.title}</T>
        {opp.institution_name ? <T size={13} color={c.mute}>{opp.institution_name}</T> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <StageChip status={opp.status} />
          <Tag label={KINDS.find((k) => k.value === opp.kind)?.label ?? opp.kind} />
          {opp.sport ? <Tag label={opp.sport} /> : null}
        </View>
      </View>

      <Card pad={14}>
        <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.8, marginBottom: 8 }}>{t('pl.stage.track').toUpperCase()}</T>
        <StagePip status={opp.status} />
      </Card>

      <EvidenceList items={evidence} onUpdate={d.reload} toast={toast} />

      {isStaff ? <ReferenceList refs={references} oppId={oppId} onUpdate={d.reload} toast={toast} /> : (
        <Block title={t('pl.ref.section')}>
          {references.map((r) => (
            <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 12, backgroundColor: c.bg }}>
              <Av name={r.referee_name} size={28} />
              <View style={{ flex: 1 }}><T weight="700" size={13}>{r.referee_name}</T><T size={11} color={c.mute}>{r.purpose}</T></View>
              <Tag label={r.status} color={r.status === 'submitted' ? c.limeSoft : undefined} />
            </View>
          ))}
          {references.length === 0 ? <T size={12} color={c.mute}>{t('pl.ref.none')}</T> : null}
        </Block>
      )}

      <Block title={t('pl.sh.section')}>
        {liveShare ? (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T weight="700" size={13} style={{ flex: 1 }}>{liveShare.institution_name}</T>
              <Tag label={t('pl.sh.active')} color={c.limeSoft} />
            </View>
            <T size={12} color={c.mute}>{t('pl.sh.fields_shared')}: {Object.entries(liveShare.fields ?? {}).filter(([,v]) => v).map(([k]) => k.replace(/_/g, ' ')).join(' · ')}</T>
            {!isStaff ? (
              <Btn small title={t('pl.sh.revoke')} color={c.redSoft} ink={c.red}
                onPress={async () => {
                  try {
                    await api.post(`/me/placement/shares/${liveShare.id}/revoke`, athleteId ? { athlete_id: athleteId } : {});
                    toast(t('pl.sh.revoked'));
                    d.reload();
                  } catch (e) { toast(explain(e)); }
                }} />
            ) : null}
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <T size={13} color={c.mute}>{t('pl.sh.none')}</T>
            {!isStaff ? <Btn small title={t('pl.sh.grant')} onPress={() => setShareSheet(true)} /> : null}
          </View>
        )}
      </Block>

      {opp.deadline ? (
        <Card pad={12} style={{ borderColor: new Date(opp.deadline) <= new Date(Date.now() + 7 * 86400e3) ? c.sun : c.line, backgroundColor: new Date(opp.deadline) <= new Date(Date.now() + 7 * 86400e3) ? c.sunSoft : c.paper }}>
          <T weight="800" size={13}>{t('pl.opp.deadline')}: {when(opp.deadline)}</T>
        </Card>
      ) : null}

      <SharingConsentSheet visible={shareSheet} opp={opp} athleteId={athleteId} onClose={() => setShareSheet(false)}
        onDone={() => { setShareSheet(false); d.reload(); }} toast={toast} />
    </ScrollView>
  );
}

// ── STAFF: add opportunity form ───────────────────────────────────────────────
function AddOppSheet({ orgId, visible, onClose, onDone, toast }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('pl.opp.add')} submitLabel={t('pl.opp.create')}
      fields={[
        { key: 'athlete_id', label: t('pl.opp.f_athlete'), type: 'entity', entityKind: 'person' },
        { key: 'kind', label: t('pl.opp.f_kind'), type: 'chips', options: KINDS },
        { key: 'title', label: t('pl.opp.f_title') },
        { key: 'institution_name', label: t('pl.opp.f_institution'), optional: true },
        { key: 'sport', label: t('pl.opp.f_sport'), optional: true },
        { key: 'deadline', label: t('pl.opp.f_deadline'), type: 'date', optional: true },
        { key: 'amount_minor', label: t('pl.opp.f_amount'), type: 'stepper', min: 0, step: 100, optional: true, description: t('pl.opp.f_amount_hint') },
        { key: 'currency', label: t('pl.opp.f_currency'), optional: true, description: 'ISO code e.g. USD, EUR, GBP' },
        { key: 'intake_year', label: t('pl.opp.f_intake_year'), type: 'stepper', min: 2024, max: 2040, optional: true },
      ]}
      onSubmit={async (v) => {
        await api.post(`/organisations/${orgId}/academy/placement`, { id: orgId, ...v });
        onDone?.();
        return t('pl.opp.created');
      }} />
  );
}

// ── STAFF: action queue panel ─────────────────────────────────────────────────
function ActionQueue({ data, onSelect, toast }) {
  const { refs_due = [], evidence_incomplete = [], consent_pending = [], deadlines_soon = [] } = data;
  const urgent = [...refs_due, ...evidence_incomplete, ...consent_pending];

  if (!urgent.length && !deadlines_soon.length) {
    return <Empty emoji="✅" title={t('pl.q.empty')} sub={t('pl.q.empty_sub')} />;
  }
  return (
    <View style={{ gap: 10 }}>
      {urgent.length > 0 ? (
        <>
          <T weight="800" size={11} color={c.mute} style={{ letterSpacing: 0.8 }}>{t('pl.q.urgent').toUpperCase()} · {urgent.length}</T>
          {refs_due.map((r) => (
            <Pressable key={r.id} onPress={() => onSelect?.(r.opportunity_id)} accessibilityRole="button"
              style={{ backgroundColor: c.sunSoft, borderRadius: 14, padding: 12, flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderWidth: 1, borderColor: c.sun }}>
              <T size={22}>⏰</T>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <T weight="800" size={13} style={{ flex: 1 }}>{t('pl.q.ref_due')}</T>
                  <Tag label={t('pl.q.urgent')} color={c.sunSoft} />
                </View>
                <T size={12} color={c.mute}>{r.athlete_name} · {r.title}</T>
                <T size={11} color={c.mute}>{r.referee_name} · {r.purpose}{r.due_on ? ` · ⏰ ${when(r.due_on)}` : ''}</T>
              </View>
            </Pressable>
          ))}
          {evidence_incomplete.map((e) => (
            <Pressable key={e.opportunity_id} onPress={() => onSelect?.(e.opportunity_id)} accessibilityRole="button"
              style={{ backgroundColor: c.pinkSoft, borderRadius: 14, padding: 12, flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderWidth: 1, borderColor: c.pink }}>
              <T size={22}>📋</T>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <T weight="800" size={13} style={{ flex: 1 }}>{t('pl.q.evidence_missing', { n: e.missing_count })}</T>
                  <Tag label={`${e.missing_count} ${t('pl.q.items')}`} color={c.pinkSoft} />
                </View>
                <T size={12} color={c.mute}>{e.athlete_name} · {e.title}</T>
                <T size={11} color={c.mute}>{(e.missing_items ?? []).slice(0, 3).join(' · ')}</T>
              </View>
            </Pressable>
          ))}
          {consent_pending.map((s) => (
            <Pressable key={s.share_id} onPress={() => onSelect?.(s.opportunity_id)} accessibilityRole="button"
              style={{ backgroundColor: c.cyanSoft, borderRadius: 14, padding: 12, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
              <T size={22}>🤝</T>
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="800" size={13}>{t('pl.q.consent_pending')}</T>
                <T size={12} color={c.mute}>{s.athlete_name} · {s.institution_name}</T>
              </View>
            </Pressable>
          ))}
        </>
      ) : null}
      {deadlines_soon.length > 0 ? (
        <>
          <T weight="800" size={11} color={c.mute} style={{ letterSpacing: 0.8, marginTop: 4 }}>{t('pl.q.deadlines').toUpperCase()} · {deadlines_soon.length}</T>
          {deadlines_soon.map((d) => (
            <Pressable key={d.id} onPress={() => onSelect?.(d.id)} accessibilityRole="button"
              style={{ backgroundColor: c.paper, borderRadius: 12, padding: 10, flexDirection: 'row', gap: 10, alignItems: 'center', borderWidth: 1, borderColor: c.line }}>
              <View style={{ flex: 1 }}><T weight="700" size={13}>{d.athlete_name}</T><T size={11} color={c.mute}>{d.title}</T></View>
              <T size={12} color={c.sun} weight="800">⏰ {when(d.deadline)}</T>
            </Pressable>
          ))}
        </>
      ) : null}
    </View>
  );
}

// ── STAFF: analytics panel ────────────────────────────────────────────────────
function PlacementAnalytics({ orgId }) {
  const d = useLoad(() => api.get(`/organisations/${orgId}/academy/placement/analytics`), [orgId]);
  if (!d.data) return d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : <Loading />;
  const { funnel = [], by_sport = [], by_kind = [], scholarships = [], outcomes = [] } = d.data;
  const total = funnel.reduce((s, r) => s + Number(r.n), 0);

  return (
    <ScrollView contentContainerStyle={{ gap: 14, padding: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Kpi label={t('pl.an.total')} value={String(total)} />
        <Kpi label={t('pl.an.offers')} value={String(funnel.find((f) => f.status === 'offer_received')?.n ?? 0)} />
        <Kpi label={t('pl.an.scholarships')} value={String(scholarships.length)} />
        <Kpi label={t('pl.an.outcomes')} value={String(funnel.find((f) => f.status === 'outcome')?.n ?? 0)} />
      </View>

      <Card pad={14}>
        <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.8, marginBottom: 10 }}>{t('pl.an.funnel').toUpperCase()}</T>
        {['identified','eligibility_check','evidence_gathering','applied','offer_received','outcome'].map((s) => {
          const n = Number(funnel.find((f) => f.status === s)?.n ?? 0);
          const pct = total ? Math.round((n / total) * 100) : 0;
          return (
            <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <T size={12} style={{ width: 130 }}>{STAGE_LABEL[s]}</T>
              <T size={13} weight="800" style={{ width: 24, textAlign: 'right' }}>{n}</T>
              <View style={{ flex: 1, height: 6, borderRadius: 999, backgroundColor: c.bg }}>
                <View style={{ width: `${pct}%`, height: 6, borderRadius: 999, backgroundColor: s === 'outcome' ? c.lime : c.pink }} />
              </View>
            </View>
          );
        })}
      </Card>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Card pad={14} style={{ flex: 1 }}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.8, marginBottom: 10 }}>{t('pl.an.by_sport').toUpperCase()}</T>
          {by_sport.slice(0, 6).map((r) => (
            <View key={r.sport} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <T size={12} style={{ flex: 1 }}>{r.sport}</T>
              <T size={13} weight="800">{r.n}</T>
            </View>
          ))}
          {by_sport.length === 0 ? <T size={12} color={c.mute}>{t('empty.nothing')}</T> : null}
        </Card>
        <Card pad={14} style={{ flex: 1 }}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.8, marginBottom: 10 }}>{t('pl.an.by_kind').toUpperCase()}</T>
          {by_kind.map((r) => (
            <View key={r.kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <T size={12} style={{ flex: 1 }}>{KINDS.find((k) => k.value === r.kind)?.label ?? r.kind}</T>
              <T size={13} weight="800">{r.n}</T>
            </View>
          ))}
          {by_kind.length === 0 ? <T size={12} color={c.mute}>{t('empty.nothing')}</T> : null}
        </Card>
      </View>

      {scholarships.length > 0 ? (
        <Card pad={14}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.8, marginBottom: 10 }}>{t('pl.an.scholarships_attr').toUpperCase()}</T>
          {scholarships.map((s) => (
            <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 10, backgroundColor: c.bg, marginBottom: 4 }}>
              <View style={{ flex: 1 }}>
                <T weight="700" size={13}>{s.athlete_name}</T>
                <T size={11} color={c.mute}>{s.sponsor_name} · {s.opportunity_title}</T>
              </View>
              <Tag label={`${s.amount_cents != null ? (s.amount_cents / 100).toLocaleString() : '?'} ${s.currency ?? ''}`} color={c.limeSoft} />
            </View>
          ))}
        </Card>
      ) : null}
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STAFF MAIN: AcademyPlacement
// ═══════════════════════════════════════════════════════════════════
export function AcademyPlacement({ o, role, toast }) {
  const { tablet } = useLayout();
  const [subTab, setSubTab] = useState('queue');
  const [selectedId, setSelectedId] = useState(null);
  const [addOpp, setAddOpp] = useState(false);

  const queueLoad = useLoad(() => api.get(`/organisations/${o.id}/academy/placement/queue`), [o.id]);
  const listLoad  = useLoad(() => api.get(`/organisations/${o.id}/academy/placement`), [o.id]);

  const urgentCount = queueLoad.data
    ? (queueLoad.data.refs_due?.length ?? 0) + (queueLoad.data.evidence_incomplete?.length ?? 0) + (queueLoad.data.consent_pending?.length ?? 0)
    : 0;

  const TABS = [
    { value: 'queue',     label: `${t('pl.nav.queue')}${urgentCount ? ` (${urgentCount})` : ''}` },
    { value: 'athletes',  label: t('pl.nav.athletes') },
    { value: 'analytics', label: t('pl.nav.analytics') },
  ];

  const leftPanel = (
    <View style={{ flex: tablet ? undefined : 1, width: tablet ? 340 : '100%', gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" size={18} style={{ flex: 1 }}>{t('pl.nav.title')}</T>
        <Btn small title={t('pl.opp.add')} onPress={() => setAddOpp(true)} />
      </View>
      <Seg value={subTab} onChange={setSubTab} color={c.violet} options={TABS} />

      {subTab === 'queue' ? (
        queueLoad.error ? <ErrorBox error={queueLoad.error} onRetry={queueLoad.reload} /> :
        queueLoad.data ? <ActionQueue data={queueLoad.data} onSelect={setSelectedId} toast={toast} /> : <Loading />
      ) : subTab === 'athletes' ? (
        listLoad.error ? <ErrorBox error={listLoad.error} onRetry={listLoad.reload} /> :
        listLoad.data ? (
          listLoad.data.length === 0
            ? <Empty emoji="🎓" title={t('pl.list.empty')} sub={t('pl.list.empty_sub')} />
            : listLoad.data.map((opp) => (
                <OppCard key={opp.id} opp={opp} onPress={() => setSelectedId(opp.id)} />
              ))
        ) : <Loading />
      ) : null}
    </View>
  );

  if (subTab === 'analytics') {
    return (
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T weight="800" size={18} style={{ flex: 1 }}>{t('pl.nav.title')}</T>
          <Btn small title={t('pl.opp.add')} onPress={() => setAddOpp(true)} />
        </View>
        <Seg value={subTab} onChange={setSubTab} color={c.violet} options={TABS} />
        <PlacementAnalytics orgId={o.id} />
        <AddOppSheet orgId={o.id} visible={addOpp} onClose={() => setAddOpp(false)} toast={toast}
          onDone={() => { setAddOpp(false); listLoad.reload(); }} />
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      {tablet && selectedId ? (
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <ScrollView style={{ width: 340 }} contentContainerStyle={{ gap: 12 }}>
            <T weight="800" size={18}>{t('pl.nav.title')}</T>
            <Seg value={subTab} onChange={setSubTab} color={c.violet} options={TABS} />
            {subTab === 'queue' ? (
              queueLoad.data ? <ActionQueue data={queueLoad.data} onSelect={setSelectedId} toast={toast} /> : <Loading />
            ) : (
              listLoad.data ? listLoad.data.map((opp) => (
                <OppCard key={opp.id} opp={{ ...opp, selected: opp.id === selectedId }} onPress={() => setSelectedId(opp.id)} />
              )) : <Loading />
            )}
          </ScrollView>
          <View style={{ flex: 1, borderRadius: 18, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
            <OppDetail oppId={selectedId} orgId={o.id} isStaff toast={toast} onBack={() => setSelectedId(null)} />
          </View>
        </View>
      ) : selectedId ? (
        <OppDetail oppId={selectedId} orgId={o.id} isStaff toast={toast} onBack={() => setSelectedId(null)} />
      ) : (
        leftPanel
      )}
      <AddOppSheet orgId={o.id} visible={addOpp} onClose={() => setAddOpp(false)} toast={toast}
        onDone={() => { setAddOpp(false); listLoad.reload(); }} />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════
// FAMILY/ATHLETE: FamilyPlacement
// ═══════════════════════════════════════════════════════════════════
export function FamilyPlacement({ athleteId, toast }) {
  const d = useLoad(() => api.get('/me/placement', athleteId ? { athlete_id: athleteId } : {}), [athleteId]);
  const [selectedId, setSelectedId] = useState(null);
  const { tablet } = useLayout();

  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data)  return <Loading />;

  const opps = d.data;
  // Any opportunity where sharing is requested but guardian hasn't approved
  const consentPending = opps.filter((o) => o.status === 'identified'); // simplified; real check needs share detail

  if (selectedId) {
    return <OppDetail oppId={selectedId} isStaff={false} toast={toast} onBack={() => setSelectedId(null)} athleteId={athleteId} />;
  }

  return (
    <View style={{ gap: 12 }}>
      <T weight="800" size={18}>{t('pl.nav.my_title')}</T>

      {opps.length === 0 ? (
        <Empty emoji="🎓" title={t('pl.list.my_empty')} sub={t('pl.list.my_empty_sub')} />
      ) : (
        opps.map((opp) => <OppCard key={opp.id} opp={opp} onPress={() => setSelectedId(opp.id)} />)
      )}
    </View>
  );
}
