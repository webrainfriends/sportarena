import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { Btn, Card, Chip, Empty, GradCard, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';

const RISK_COLOR = { low: c.mintSoft, medium: c.sunSoft, high: '#FFCDD2', immediate: '#EF9A9A' };
const STATUS_COLOR = { received: c.violetSoft, in_triage: c.sunSoft, assigned: c.sunSoft, active: c.sunSoft, escalated: '#FFCDD2', referred: c.mintSoft, awaiting_closure: c.mintSoft, closed: undefined };

function typeLabel(v) { return t(`osg.type_${v}`) || v; }
function riskLabel(v) { return t(`osg.risk_${v}`) || v; }
function statusLabel(v) { return t(`osg.status_${v.replace(/_/g, '_')}`) || v; }

// ── Welfare officer KPI strip ──────────────────────────────────────────────────

function KpiStrip({ ov }) {
  if (!ov) return null;
  const tiles = [
    { label: t('osg.kpi_open'), value: ov.open ?? '< 5' },
    { label: t('osg.kpi_unassigned'), value: ov.unassigned ?? '< 5', warn: ov.unassigned > 0 },
    { label: t('osg.kpi_escalated'), value: ov.escalated ?? '< 5', warn: ov.escalated > 0 },
    { label: t('osg.kpi_closed_month'), value: ov.closed_this_month ?? '< 5' },
    { label: t('osg.kpi_median_days'), value: ov.median_days != null ? `${ov.median_days}d` : '—' },
  ];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
      {tiles.map((tile) => (
        <Card key={tile.label} pad={12} style={{ flex: 1, minWidth: 80, alignItems: 'center' }}>
          <T size={22} weight="800" color={tile.warn ? '#E53935' : c.ink}>{tile.value}</T>
          <T size={11} color={c.mute} style={{ textAlign: 'center', marginTop: 2 }}>{tile.label}</T>
        </Card>
      ))}
    </View>
  );
}

// ── Cases list ─────────────────────────────────────────────────────────────────

function CaseRow({ item, onPress }) {
  return (
    <Card pad={12} onPress={() => onPress(item)} accessibilityLabel={`Case ${item.ref}, ${typeLabel(item.type)}, ${riskLabel(item.risk_level)}`} style={{ marginBottom: 6 }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <T size={13} weight="800" color={c.violet}>{item.ref}</T>
          <Tag label={typeLabel(item.type)} color={c.violetSoft} />
          <Tag label={riskLabel(item.risk_level)} color={RISK_COLOR[item.risk_level]} />
          <Tag label={statusLabel(item.status)} color={STATUS_COLOR[item.status]} />
        </View>
        {item.fixture ? <T size={12} color={c.mute}>{item.fixture}</T> : null}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <T size={12} color={c.mute}>{item.assigned_to ? `→ ${item.assigned_to}` : t('osg.kpi_unassigned')}</T>
          <T size={12} color={c.mute}>{item.days_open}d</T>
        </View>
      </View>
    </Card>
  );
}

// ── Safety flags list ──────────────────────────────────────────────────────────

function FlagsTab() {
  const flags = useLoad(() => api.get('/official-safeguarding/safety-flags'), []);
  if (flags.loading) return <Loading />;
  const list = flags.data?.flags ?? [];
  if (!list.length) return <Empty message={t('osg.empty_flags')} />;
  return (
    <Section title={t('osg.tab_flags')} color={c.pink}>
      {list.map((f) => (
        <Card key={f.id} pad={12} style={{ marginBottom: 6 }}>
          <View style={{ gap: 4 }}>
            <T weight="800" size={14}>🚨 {f.fixture}</T>
            <T size={12} color={c.mute}>{t('osg.case_reporter')}: {f.raised_by}</T>
            <T size={12} color={c.mute}>{new Date(f.created_at).toLocaleString()}</T>
          </View>
        </Card>
      ))}
    </Section>
  );
}

// ── Officers tab ───────────────────────────────────────────────────────────────

function OfficersTab() {
  return (
    <Section title={t('osg.tab_officers')} color={c.violet}>
      <Card pad={14}>
        <T size={13} color={c.mute}>{t('osg.welfare_contacts_title')}</T>
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>To designate or view welfare officers for a specific organisation, open the organisation's Safety settings.</T>
      </Card>
    </Section>
  );
}

// ── Policy tab ─────────────────────────────────────────────────────────────────

function PolicyTab() {
  return (
    <Section title={t('osg.tab_policy')} color={c.violet}>
      <Card pad={14}>
        <T size={14} weight="700">{t('osg.policy_title')}</T>
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>To configure the safeguarding policy (anonymous reporting, response deadlines, mandatory reporting law), use the Admin area of your organisation's Safety settings or call the configure_sg_policy API.</T>
      </Card>
    </Section>
  );
}

// ── Main desk ──────────────────────────────────────────────────────────────────

export function OfficialSafeguardingDesk() {
  const [deskTab, setDeskTab] = useState('cases');
  const [selectedCase, setSelectedCase] = useState(null);
  const { toast } = useSession();

  const overview = useLoad(() => api.get('/official-safeguarding/overview').catch(() => null), []);
  const cases = useLoad(() => api.get('/official-safeguarding/cases'), [deskTab]);

  const list = cases.data?.cases ?? [];

  return (
    <View style={{ flex: 1 }}>
      <Section title={t('osg.title')} color={c.violet}>
        <Card pad={10}>
          <T size={12} color={c.mute}>{t('osg.subtitle')}</T>
        </Card>
        <KpiStrip ov={overview.data} />
      </Section>
      <Seg
        options={[
          { value: 'cases', label: t('osg.tab_cases') },
          { value: 'flags', label: t('osg.tab_flags') },
          { value: 'officers', label: t('osg.tab_officers') },
          { value: 'policy', label: t('osg.tab_policy') },
        ]}
        value={deskTab}
        onChange={setDeskTab}
      />
      {deskTab === 'cases' ? (
        <Section color={c.violet}>
          {cases.loading ? <Loading /> : !list.length ? <Empty message={t('osg.empty_cases')} /> : (
            list.map((item) => (
              <CaseRow key={item.id} item={item} onPress={setSelectedCase} />
            ))
          )}
        </Section>
      ) : deskTab === 'flags' ? <FlagsTab />
        : deskTab === 'officers' ? <OfficersTab />
        : <PolicyTab />}
      {selectedCase ? (
        <OfficialSgCaseDetail caseId={selectedCase.id} visible onClose={() => setSelectedCase(null)} />
      ) : null}
    </View>
  );
}

// ── Case detail sheet ──────────────────────────────────────────────────────────

export function OfficialSgCaseDetail({ caseId, visible, onClose }) {
  const { toast } = useSession();
  const [actionOpen, setActionOpen] = useState(false);
  const detail = useLoad(() => caseId ? api.get(`/official-safeguarding/cases/${caseId}`) : Promise.resolve(null), [caseId]);
  const d = detail.data;

  const handleAction = async (vals) => {
    try {
      await api.post(`/official-safeguarding/cases/${caseId}/actions`, vals);
      toast('Action recorded');
      setActionOpen(false);
      await detail.reload();
    } catch (e) { toast(explain(e)); throw e; }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={d ? `${t('osg.case_detail_title')} ${d.ref}` : t('osg.case_detail_title')}>
      {detail.loading ? <Loading /> : !d ? null : (
        <ScrollView style={{ flex: 1 }}>
          <Card pad={12} style={{ borderLeftWidth: 3, borderLeftColor: '#E53935', marginBottom: 8 }}>
            <T size={12} weight="700" color="#C62828">{t('osg.not_a_finding')}</T>
          </Card>
          <Card pad={14} style={{ marginBottom: 8 }}>
            <View style={{ gap: 8 }}>
              <Row label={t('osg.case_ref')} value={d.ref} />
              <Row label={t('osg.case_type')} value={typeLabel(d.type)} />
              <Row label={t('osg.case_risk')} value={riskLabel(d.risk_level)} />
              <Row label={t('osg.case_status')} value={statusLabel(d.status)} />
              {d.outcome ? <Row label={t('osg.case_outcome')} value={d.outcome} /> : null}
              <Row label={t('osg.case_reporter')} value={d.reporter === 'anonymous' ? t('osg.case_reporter_anonymous') : t('osg.case_reporter_identified')} />
              {d.fixture ? <Row label="Fixture" value={d.fixture.label} /> : null}
              {d.assigned_to ? <Row label={t('osg.case_assigned')} value={d.assigned_to} /> : null}
              <Row label={t('osg.case_raised')} value={new Date(d.raised_at).toLocaleString()} />
            </View>
          </Card>
          <Section title={t('osg.case_narrative')} color={c.violet}>
            <Card pad={14}>
              <T size={13} style={{ lineHeight: 20 }}>{d.narrative}</T>
              <T size={11} color={c.mute} style={{ marginTop: 8 }}>{t('osg.narrative_notice')}</T>
            </Card>
          </Section>
          {d.actions?.length ? (
            <Section title="Actions" color={c.violet}>
              {d.actions.map((a) => (
                <Card key={a.id} pad={10} style={{ marginBottom: 4 }}>
                  <T size={13} weight="700">{t(`osg.action_${a.kind}`) || a.kind}</T>
                  <T size={12} color={c.mute}>{a.actor} · {new Date(a.created_at).toLocaleString()}</T>
                  {a.outcome ? <T size={12} color={c.mute}>Outcome: {a.outcome}</T> : null}
                </Card>
              ))}
            </Section>
          ) : null}
          {d.status !== 'closed' ? (
            <View style={{ padding: 16, gap: 10 }}>
              <Btn title={t('osg.action_acknowledge')} onPress={() => setActionOpen('acknowledge')} style={{ minHeight: 48 }} />
              <Btn title={t('osg.action_add_note')} onPress={() => setActionOpen('add_note')} style={{ minHeight: 48 }} />
              <Btn title={t('osg.action_close')} onPress={() => setActionOpen('close')} style={{ minHeight: 48 }} />
            </View>
          ) : null}
        </ScrollView>
      )}
      <FormSheet
        visible={!!actionOpen}
        onClose={() => setActionOpen(false)}
        title={actionOpen ? (t(`osg.action_${actionOpen}`) || actionOpen) : ''}
        submitLabel="Submit"
        onSubmit={(v) => handleAction({ id: caseId, action: actionOpen, ...v })}
        fields={[
          { key: 'note', label: 'Note', type: 'multiline', optional: actionOpen !== 'close' },
          ...(actionOpen === 'close' ? [
            { key: 'outcome', label: 'Outcome', type: 'chips', options: ['upheld', 'partially_upheld', 'not_upheld', 'no_further_action', 'referred_external', 'withdrawn'].map((v) => ({ value: v, label: t(`osg.outcome_${v}`) || v })) },
            { key: 'reason', label: 'Closing reason', type: 'multiline' },
          ] : []),
        ]}
        initial={{ note: '', outcome: 'no_further_action', reason: '' }}
      />
    </Sheet>
  );
}

function Row({ label, value }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <T size={12} color={c.mute} style={{ width: 110 }}>{label}</T>
      <T size={13} style={{ flex: 1 }}>{value}</T>
    </View>
  );
}

// ── Raise safety concern sheet (multi-step) ───────────────────────────────────

export function RaiseSafetyConcernSheet({ fixtureId, visible, onClose }) {
  const { toast } = useSession();
  const [step, setStep] = useState(1);
  const [vals, setVals] = useState({ type: '', risk_level: '', narrative: '', anonymous: false, wb: false });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const contacts = useLoad(() => fixtureId && visible ? api.get(`/fixtures/${fixtureId}/welfare-contacts`) : Promise.resolve({ welfare_officers: [], policy: { allow_anonymous: false } }), [fixtureId, visible]);
  const c_data = contacts.data ?? { welfare_officers: [], policy: { allow_anonymous: false } };

  const reset = () => { setStep(1); setVals({ type: '', risk_level: '', narrative: '', anonymous: false, wb: false }); setResult(null); };
  const handleClose = () => { reset(); onClose(); };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/fixtures/${fixtureId}/safety-concerns`, {
        id: fixtureId,
        type: vals.type,
        risk_level: vals.risk_level,
        narrative: vals.narrative,
        anonymous: vals.anonymous,
        request_whistleblower_protection: vals.wb,
      });
      setResult(r);
      setStep(7);
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };

  const TYPES = ['abuse', 'harassment', 'bullying', 'coercion', 'discrimination', 'other'];
  const RISKS = ['low', 'medium', 'high', 'immediate'];

  return (
    <Sheet visible={visible} onClose={handleClose} title={t('osg.raise_title')}>
      <ScrollView style={{ flex: 1, padding: 16 }}>
        {step === 1 && (
          <View style={{ gap: 12 }}>
            <T size={13} weight="700">{t('osg.raise_step_contacts')}</T>
            <T size={12} color={c.mute}>Before filing, note your welfare contacts below.</T>
            {contacts.loading ? <Loading /> : !c_data.welfare_officers.length ? (
              <Card pad={12}><T size={13} color={c.mute}>{t('osg.no_welfare_contacts')}</T></Card>
            ) : c_data.welfare_officers.map((o) => (
              <Card key={o.id} pad={12}>
                <T weight="700" size={14}>{o.name}</T>
                <T size={12} color={c.mute}>{o.role}{o.contact_channel ? ` · ${o.contact_channel}` : ''}</T>
              </Card>
            ))}
            <Btn title="Continue" onPress={() => setStep(2)} style={{ minHeight: 48, marginTop: 8 }} />
          </View>
        )}
        {step === 2 && (
          <View style={{ gap: 12 }}>
            <T size={13} weight="700">{t('osg.raise_step_type')}</T>
            {TYPES.map((tp) => (
              <Chip key={tp} label={typeLabel(tp)} selected={vals.type === tp} onPress={() => setVals((v) => ({ ...v, type: tp }))} style={{ minHeight: 44 }} />
            ))}
            <Btn title="Continue" disabled={!vals.type} onPress={() => setStep(3)} style={{ minHeight: 48 }} />
          </View>
        )}
        {step === 3 && (
          <View style={{ gap: 12 }}>
            <T size={13} weight="700">{t('osg.raise_step_risk')}</T>
            {RISKS.map((r) => (
              <Chip key={r} label={riskLabel(r)} selected={vals.risk_level === r} onPress={() => setVals((v) => ({ ...v, risk_level: r }))} style={{ minHeight: 44 }} />
            ))}
            <Btn title="Continue" disabled={!vals.risk_level} onPress={() => setStep(4)} style={{ minHeight: 48 }} />
          </View>
        )}
        {step === 4 && (
          <View style={{ gap: 12 }}>
            <T size={13} weight="700">{t('osg.raise_step_narrative')}</T>
            <T size={12} color={c.mute}>{t('osg.narrative_notice')}</T>
            <Card pad={10}>
              <T size={12} color={c.mute} style={{ marginBottom: 6 }}>{t('osg.narrative_label')}</T>
              <FormSheet.TextArea
                value={vals.narrative}
                onChangeText={(v) => setVals((x) => ({ ...x, narrative: v }))}
                placeholder={t('osg.narrative_placeholder')}
                minHeight={120}
              />
            </Card>
            <Btn title="Continue" disabled={vals.narrative.length < 10} onPress={() => setStep(5)} style={{ minHeight: 48 }} />
          </View>
        )}
        {step === 5 && (
          <View style={{ gap: 12 }}>
            <T size={13} weight="700">{t('osg.raise_step_anon')}</T>
            {c_data.policy.allow_anonymous ? (
              <>
                <T size={12} color={c.mute}>{t('osg.anon_explanation')}</T>
                <Chip label={t('osg.anon_toggle')} selected={vals.anonymous} onPress={() => setVals((v) => ({ ...v, anonymous: !v.anonymous }))} style={{ minHeight: 44 }} />
              </>
            ) : (
              <Card pad={12}><T size={12} color={c.mute}>{t('osg.anon_policy_off')}</T></Card>
            )}
            <Btn title="Continue" onPress={() => setStep(6)} style={{ minHeight: 48 }} />
          </View>
        )}
        {step === 6 && (
          <View style={{ gap: 12 }}>
            <T size={13} weight="700">{t('osg.raise_step_wb')}</T>
            <T size={12} color={c.mute}>{t('osg.wb_body')}</T>
            <Chip label={t('osg.wb_title')} selected={vals.wb} onPress={() => setVals((v) => ({ ...v, wb: !v.wb }))} style={{ minHeight: 44 }} />
            <Btn title={t('osg.submit')} onPress={submit} loading={busy} style={{ minHeight: 56 }} />
          </View>
        )}
        {step === 7 && result && (
          <View style={{ gap: 14 }}>
            <T size={18} weight="800">{t('osg.submitted_title')}</T>
            <Card pad={14} style={{ borderLeftWidth: 3, borderLeftColor: c.violet }}>
              <T size={13} color={c.mute}>{t('osg.submitted_ref')}</T>
              <T size={22} weight="800" color={c.violet}>{result.ref}</T>
            </Card>
            {result.anon_token ? (
              <Card pad={14} style={{ borderLeftWidth: 3, borderLeftColor: '#E53935' }}>
                <T size={13} weight="700" color="#C62828">{t('osg.submitted_anon_token')}</T>
                <T size={14} style={{ fontFamily: 'monospace', marginTop: 4 }}>{result.anon_token}</T>
              </Card>
            ) : null}
            <T size={13} color={c.mute}>{t('osg.submitted_next')}</T>
            <Btn title="Close" onPress={handleClose} style={{ minHeight: 48 }} />
          </View>
        )}
      </ScrollView>
    </Sheet>
  );
}

// ── Immediate safety flag button ───────────────────────────────────────────────

export function SafetyFlagButton({ fixtureId }) {
  const { toast } = useSession();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [raised, setRaised] = useState(false);
  const [officers, setOfficers] = useState([]);

  const openConfirm = async () => {
    try {
      const r = await api.get(`/fixtures/${fixtureId}/welfare-contacts`);
      setOfficers(r.welfare_officers ?? []);
    } catch {}
    setConfirmOpen(true);
  };

  const raiseFlag = async () => {
    setBusy(true);
    try {
      await api.post(`/fixtures/${fixtureId}/safety-flag`, { id: fixtureId });
      setRaised(true);
      setConfirmOpen(false);
      toast(t('osg.flag_raised'));
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };

  if (raised) {
    return (
      <Card pad={12} style={{ backgroundColor: '#FFEBEE', borderLeftWidth: 3, borderLeftColor: '#E53935' }}>
        <T weight="800" size={14} color="#C62828">🚨 {t('osg.flag_raised')}</T>
      </Card>
    );
  }

  return (
    <>
      <Btn
        title={`🚨 ${t('osg.flag_button')}`}
        onPress={openConfirm}
        style={{ minHeight: 56, backgroundColor: '#E53935' }}
        accessibilityLabel={t('osg.flag_button')}
      />
      <Sheet visible={confirmOpen} onClose={() => setConfirmOpen(false)} title={t('osg.flag_title')}>
        <View style={{ padding: 16, gap: 14 }}>
          <T size={13} color={c.mute}>{t('osg.flag_body')}</T>
          {officers.length ? (
            <Section title={t('osg.welfare_contacts_title')} color={c.violet}>
              {officers.map((o) => (
                <Card key={o.id} pad={10} style={{ marginBottom: 4 }}>
                  <T weight="700">{o.name}</T>
                  <T size={12} color={c.mute}>{o.role}{o.contact_channel ? ` · ${o.contact_channel}` : ''}</T>
                </Card>
              ))}
            </Section>
          ) : null}
          <Btn title={`🚨 ${t('osg.flag_confirm')}`} onPress={raiseFlag} loading={busy} style={{ minHeight: 56, backgroundColor: '#E53935' }} />
          <Btn title="Cancel" onPress={() => setConfirmOpen(false)} style={{ minHeight: 44 }} />
        </View>
      </Sheet>
    </>
  );
}
