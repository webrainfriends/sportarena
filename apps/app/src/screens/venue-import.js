// Venue bulk import wizard (#697): 5-step CSV/Excel import with column mapping, dry-run preview,
// per-row conflict resolution and idempotent commit. Extends the existing migration framework on the
// API side; the domain is 'venue' (not 'roster'). Nothing is overwritten without explicit confirmation.
import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { saveText } from '../evidence';
import { docMaxBytes, docMaxMb } from '../upload-limits';
import { MenuField } from '../menu-field';
import { Btn, Card, Empty, GradCard, H1, H2, Loading, Row, Screen, Seg, T, Tag } from '../ui';
import { c, grad, r } from '../theme';
import { t } from '../i18n';

// ------------------------------------------------------------------ constants
const VENUE_FIELDS = [
  { key: 'name', label: 'vimp.field_name', required: true },
  { key: 'city', label: 'vimp.field_city', required: true },
  { key: 'country', label: 'vimp.field_country' },
  { key: 'sports', label: 'vimp.field_sports' },
  { key: 'court_count', label: 'vimp.field_court_count' },
  { key: 'base_rate_minor', label: 'vimp.field_base_rate' },
  { key: 'currency', label: 'vimp.field_currency' },
  { key: 'hours_open', label: 'vimp.field_hours_open' },
  { key: 'hours_close', label: 'vimp.field_hours_close' },
  { key: 'timezone', label: 'vimp.field_timezone' },
  { key: 'description', label: 'vimp.field_description' },
];

const STEP_LABELS = ['vimp.step_upload', 'vimp.step_map', 'vimp.step_dryrun', 'vimp.step_conflicts', 'vimp.step_confirm'];
const ROW_STATUS_COLOR = { valid: c.lime, warning: c.sun, rejected: c.red, conflict: c.orange, duplicate: c.violetSoft, skipped: c.violetSoft };
// screen tab -> the API's check_status filter
const TAB_FILTER = { errors: 'rejected', conflicts: 'conflict', valid: 'valid', warning: 'warning' };

const exportCsvRows = async (rows, toast) => {
  const cell = (v) => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; return `"${x.replace(/"/g, '""')}"`; }; // a spreadsheet must never run a cell as a formula
  const csv = ['row_no,venue_name,status,message', ...rows.map((rw) => [rw.row_no, cell(rw.data?.name), rw.check_status, cell((rw.reasons ?? []).map((x) => x.message).join('; '))].join(','))].join('\n');
  try { await saveText('venue-import-errors.csv', csv); toast(t('vimp.errors_exported')); } catch (e) { toast(e.message); }
};

/** Pick a CSV or Excel file: the browser's file dialog on web, the Files picker on iOS, iPadOS and Android. Resolves { name, data (base64) } or null. */
async function chooseSheet() {
  const limit = docMaxBytes();
  const tooBig = () => new Error(`That file is over ${docMaxMb()} MB. Split it by region or facility type.`);
  if (Platform.OS === 'web') {
    return new Promise((resolve, reject) => {
      const el = document.createElement('input');
      el.type = 'file'; el.accept = '.csv,.tsv,.txt,.xlsx';
      el.onchange = () => {
        const f = el.files?.[0];
        if (!f) return resolve(null);
        if (f.size > limit) return reject(tooBig());
        const fr = new FileReader();
        fr.onload = () => resolve({ name: f.name, data: String(fr.result).split(',')[1] ?? '' });
        fr.onerror = () => reject(new Error('That file could not be read'));
        fr.readAsDataURL(f);
      };
      el.click();
    });
  }
  const DocumentPicker = await import('expo-document-picker');
  const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] });
  if (res.canceled || !res.assets?.[0]) return null;
  const a = res.assets[0];
  if ((a.size ?? 0) > limit) throw tooBig();
  const { File } = await import('expo-file-system');
  return { name: a.name, data: await new File(a.uri).base64() };
}

// ------------------------------------------------------------------ VenueImportScreen
export default function VenueImportScreen({ organisation_id }) {
  const nav = useNav();
  const { toast } = useSession();
  const orgs = useLoad(() => api.get('/organisations'), []);
  const admin = (orgs.data ?? []).filter((o) => ['owner', 'admin'].includes(o.my_role) && o.my_status === 'active');
  const [pickedOrg, setPickedOrg] = useState(null);
  const orgId = organisation_id ?? pickedOrg ?? (admin.length === 1 ? admin[0].id : null);
  const [step, setStep] = useState(1);
  const [projectId, setProjectId] = useState(null);
  const [project, setProject] = useState(null);
  const [mapping, setMapping] = useState({});
  const [runTab, setRunTab] = useState('errors');
  const [rows, setRows] = useState([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [checking, setChecking] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(null);

  // the project (headers, proposed mapping, outcome counts) and the rows of one tab
  const loadProject = async (pid = projectId) => {
    const d = await api.get(`/venue-imports/${pid}`);
    setProject(d);
    setSummary(d.summary ?? null);
    return d;
  };
  const loadRows = async (tab, pid = projectId) => {
    if (!pid) return;
    setRowsLoading(true);
    try {
      const filter = TAB_FILTER[tab];
      const d = await api.get(`/venue-imports/${pid}/rows`, { ...(filter ? { check_status: filter } : {}), limit: 100 });
      setRows(d.items ?? []);
    } catch (e) { toast(e.message); }
    setRowsLoading(false);
  };

  const pickFile = async (fileType) => {
    if (!orgId) { toast(t('vimp.upload_error', { msg: 'organisation' })); return; }
    try {
      const file = await chooseSheet();
      if (!file) return;
      const d = await api.post('/venue-imports', { organisation_id: orgId, source: fileType === 'excel' ? 'excel' : 'csv', file: file.data, encoding: 'base64', file_name: file.name });
      setProjectId(d.id);
      const full = await loadProject(d.id);
      setMapping(full.analysis?.mapping ?? d.mapping ?? {});
      setStep(2);
    } catch (e) {
      toast(t('vimp.upload_error', { msg: e.message }));
    }
  };

  const downloadTemplate = async () => {
    try {
      const d = await api.get('/venue-imports/template', { source: 'excel' });
      await saveText(d.filename ?? 'venue-import-template.csv', d.csv);
    } catch (e) {
      toast(e.message);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      const clean = Object.fromEntries(Object.entries(mapping).filter(([, h]) => !!h));
      await api.patch(`/venue-imports/${projectId}/mapping`, { mapping: clean });
      await api.post(`/venue-imports/${projectId}/check`);
      await loadProject();
      setRunTab('errors');
      await loadRows('errors');
      setStep(3);
    } catch (e) {
      toast(t('vimp.check_error', { msg: e.message }));
    } finally {
      setChecking(false);
    }
  };

  const resolveConflict = async (rowId, resolution) => {
    try {
      await api.patch(`/venue-imports/${projectId}/rows/${rowId}`, { conflict_decision: resolution });
      setRows((prev) => prev.map((rw) => (rw.id === rowId ? { ...rw, conflict_decision: resolution } : rw)));
      await loadProject(); // the counts decide whether the import can be confirmed
    } catch (e) {
      toast(e.message);
    }
  };

  const runImport = async () => {
    setRunning(true);
    try {
      await api.post(`/venue-imports/${projectId}/approve`);
      const result = await api.post(`/venue-imports/${projectId}/run`); // { created, updated, skipped, failed, pending_review, total }
      const d = await api.get(`/venue-imports/${projectId}/report`);
      setReport({ ...d, ...result });
    } catch (e) {
      toast(e.message);
    } finally {
      setRunning(false);
    }
  };

  const headers = project?.headers ?? [];
  const headerOptions = [t('vimp.unmapped'), ...headers];

  const errorRows = rows.filter((rw) => rw.check_status === 'rejected');
  const hasErrors = (summary?.rejected ?? 0) > 0;
  const hasConflicts = (summary?.conflicts ?? 0) > 0;
  const allConflictsResolved = (summary?.conflicts ?? 0) === (summary?.resolved ?? 0);

  return (
    <Screen onRefresh={undefined}>
      {/* Step indicator */}
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 20 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <View key={n} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: n <= step ? c.pink : c.line }} />
        ))}
      </View>
      <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.6, marginBottom: 16 }}>
        {t(STEP_LABELS[step - 1]).toUpperCase()} · {t('vimp.step_of', { n: step, total: 5 })}
      </T>

      {/* ---- STEP 1: Upload ---- */}
      {step === 1 && (
        <View style={{ gap: 14 }}>
          <H1>{t('vimp.title')}</H1>
          <T color={c.mute} weight="700">{t('vimp.subtitle')}</T>
          <GradCard colors={grad.hero}>
            <T size={11} color="rgba(255,255,255,0.75)" weight="600">{t('vimp.upload_formats')}</T>
            <T size={18} weight="800" color="#fff" style={{ marginTop: 6 }}>{t('vimp.upload_cta')}</T>
            <T size={12} color="rgba(255,255,255,0.75)" style={{ marginTop: 4 }}>{t('vimp.upload_limits')}</T>
          </GradCard>
          {orgs.loading && !orgs.data ? <Loading /> : null}
          {orgs.data && !admin.length ? <Empty emoji="🏢" title={t('vimp.title')} sub={t('vimp.subtitle')} /> : null}
          {!organisation_id && admin.length > 1 ? (
            <MenuField title={t('vimp.title')} value={orgId} onChange={setPickedOrg} options={admin.map((o) => ({ value: o.id, label: o.name, sub: o.city }))} />
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Btn title={t('vimp.choose_csv')} color={c.cyan} ink={c.ink} onPress={() => pickFile('csv')} style={{ flex: 1 }} accessibilityLabel={t('vimp.choose_csv')} />
            <Btn title={t('vimp.choose_excel')} color={c.violet} onPress={() => pickFile('excel')} style={{ flex: 1 }} accessibilityLabel={t('vimp.choose_excel')} />
          </View>
          <View style={{ backgroundColor: c.cyanSoft, borderRadius: r.card, borderLeftWidth: 3, borderLeftColor: c.cyan, padding: 14 }}>
            <T weight="700" size={13} color={c.cyan}>{t('vimp.migrate_hint')}</T>
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('vimp.migrate_hint_sub')}</T>
          </View>
          <Btn title={t('vimp.download_template')} color={c.paper} ink={c.ink} onPress={downloadTemplate} accessibilityLabel={t('vimp.download_template')} />
        </View>
      )}

      {/* ---- STEP 2: Column mapping ---- */}
      {step === 2 && project && (
        <View style={{ gap: 12 }}>
          <H2>{t('vimp.map_title')}</H2>
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T weight="700" size={14}>{project.file_name}</T>
              <Tag label={`${project.source_rows} ${t('vimp.rows')}`} color={c.cyan} />
            </View>
            {project.source && project.source !== 'csv' && project.source !== 'excel' ? (
              <View style={{ backgroundColor: c.limeSoft, borderRadius: 8, padding: 8, marginTop: 8 }}>
                <T size={12} color={c.lime}>{t('vimp.auto_detected', { src: project.source })}</T>
              </View>
            ) : null}
          </Card>
          <Card>
            <T weight="700" size={14}>{t('vimp.field_map_title')}</T>
            <T size={12} color={c.mute} style={{ marginTop: 2, marginBottom: 10 }}>{t('vimp.field_map_sub')}</T>
            {VENUE_FIELDS.map((field) => {
              const current = mapping[field.key];
              const autoDetected = project.analysis?.mapping?.[field.key];
              const isAuto = current === autoDetected && !!autoDetected;
              return (
                <View key={field.key} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <T size={13} weight={field.required ? '700' : '500'} color={field.required && !current ? c.red : c.ink}>
                      {t(field.label)}{field.required ? ' *' : ''}
                    </T>
                    {isAuto ? <T size={11} color={c.lime}>{t('vimp.auto')}</T> : null}
                  </View>
                  <T size={14} color={c.mute}>→</T>
                  <View style={{ flex: 1.2 }}>
                    {/* Native: simple pressable selector. We simulate a dropdown with a Seg on mobile. */}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${t(field.label)} mapping`}
                      onPress={() => {
                        // Cycle through headers on press (simple, good enough for mobile)
                        const idx = headerOptions.indexOf(current ?? t('vimp.unmapped'));
                        const next = headerOptions[(idx + 1) % headerOptions.length];
                        setMapping((prev) => ({ ...prev, [field.key]: next === t('vimp.unmapped') ? undefined : next }));
                      }}
                      style={{ borderRadius: 8, borderWidth: 1.5, borderColor: current ? (isAuto ? c.lime : c.pink) : c.line, backgroundColor: current ? (isAuto ? c.limeSoft : c.pinkSoft) : c.violetSoft, paddingHorizontal: 10, paddingVertical: 8, minHeight: 36 }}
                    >
                      <T size={13} weight="600" color={current ? (isAuto ? c.lime : c.pink) : c.mute} numberOfLines={1}>
                        {current ?? t('vimp.unmapped')}
                      </T>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </Card>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Btn title={t('vimp.back')} color={c.paper} ink={c.ink} onPress={() => setStep(1)} style={{ flex: 1 }} accessibilityLabel={t('vimp.back')} />
            <Btn title={t('vimp.run_dryrun')} loading={checking} onPress={runCheck} style={{ flex: 1 }} accessibilityLabel={t('vimp.run_dryrun')} />
          </View>
        </View>
      )}

      {/* ---- STEP 3: Dry-run preview ---- */}
      {step === 3 && (
        <View style={{ gap: 12 }}>
          <H2>{t('vimp.dryrun_title')}</H2>
          {summary ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[
                { label: t('vimp.will_create'), value: (summary.valid ?? 0) + (summary.warning ?? 0), color: c.lime },
                { label: t('vimp.conflicts'), value: summary.conflicts ?? 0, color: c.orange },
                { label: t('vimp.errors'), value: summary.rejected ?? 0, color: c.red },
                { label: t('vimp.warnings'), value: summary.warning ?? 0, color: c.sun },
              ].map((m) => (
                <View key={m.label} style={{ flex: 1, backgroundColor: c.paper, borderRadius: 14, padding: 10, borderWidth: 1, borderColor: c.line, alignItems: 'center' }}>
                  <T size={20} weight="800" color={m.color}>{String(m.value)}</T>
                  <T size={10} color={c.mute} style={{ marginTop: 2, textAlign: 'center' }}>{m.label}</T>
                </View>
              ))}
            </View>
          ) : null}

          <Seg
            options={['all', 'errors', 'conflicts', 'valid', 'warning'].map((k) => ({ value: k, label: t(`vimp.tab_${k}`) }))}
            value={runTab}
            onChange={(v) => { setRunTab(v); loadRows(v); }}
            color={c.violet}
          />

          {rowsLoading ? <Loading /> : rows.length === 0 ? (
            <Empty emoji="✅" title={t('vimp.no_rows_in_tab')} />
          ) : (
            <View style={{ gap: 6 }}>
              {rows.map((row) => (
                <View key={row.id ?? row.row_no} style={{ borderRadius: 12, borderLeftWidth: 3, borderLeftColor: ROW_STATUS_COLOR[row.check_status] ?? c.line, backgroundColor: c.paper, padding: 12 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <T size={12} weight="700" color={c.mute}>{t('vimp.row_n', { n: row.row_no })}</T>
                    <Tag label={row.check_status} color={ROW_STATUS_COLOR[row.check_status] ?? c.violetSoft} />
                  </View>
                  <T size={14} weight="700" style={{ marginTop: 4 }}>{row.data?.name ?? t('vimp.unnamed')}</T>
                  {row.reasons?.length ? row.reasons.map((reason, ri) => (
                    <T key={ri} size={12} color={c.mute} style={{ marginTop: 2 }}>• {reason.message ?? String(reason)}</T>
                  )) : null}
                </View>
              ))}
            </View>
          )}

          {hasErrors ? (
            <View style={{ gap: 10 }}>
              <View style={{ backgroundColor: c.redSoft, borderRadius: r.card, borderLeftWidth: 3, borderLeftColor: c.red, padding: 12 }}>
                <T size={13} color={c.red} weight="700">{t('vimp.fix_errors_note')}</T>
              </View>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Btn small title={t('vimp.download_errors')} color={c.paper} ink={c.ink} onPress={() => exportCsvRows(errorRows, toast)} style={{ flex: 1 }} accessibilityLabel={t('vimp.download_errors')} />
                <Btn small title={t('vimp.reupload')} color={c.pink} onPress={() => { setStep(1); setProjectId(null); setProject(null); setSummary(null); setRows([]); }} style={{ flex: 1 }} accessibilityLabel={t('vimp.reupload')} />
              </View>
            </View>
          ) : hasConflicts ? (
            <Btn title={t('vimp.review_conflicts')} onPress={() => { loadRows('conflicts'); setStep(4); }} accessibilityLabel={t('vimp.review_conflicts')} />
          ) : (
            <Btn title={t('vimp.go_confirm')} color={c.lime} onPress={() => setStep(5)} accessibilityLabel={t('vimp.go_confirm')} />
          )}
          <Btn title={t('vimp.back')} color={c.paper} ink={c.ink} onPress={() => setStep(2)} accessibilityLabel={t('vimp.back')} />
        </View>
      )}

      {/* ---- STEP 4: Conflict resolution ---- */}
      {step === 4 && (
        <View style={{ gap: 12 }}>
          <H2>{t('vimp.conflicts_title')}</H2>
          <T color={c.mute} size={13}>{t('vimp.conflicts_sub')}</T>
          <View style={{ backgroundColor: c.sunSoft, borderRadius: r.card, borderLeftWidth: 3, borderLeftColor: c.sun, padding: 12 }}>
            <T size={12} color={c.sun} weight="700">{t('vimp.no_overwrite_note')}</T>
          </View>
          {rowsLoading ? <Loading /> : rows.filter((rw) => rw.check_status === 'conflict').map((row) => (
            <Card key={row.id ?? row.row_no}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <T weight="700" size={14}>{row.data?.name ?? t('vimp.unnamed')}</T>
                <Tag label={t('vimp.tab_conflicts')} color={c.orange} />
              </View>
              <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('vimp.row_n', { n: row.row_no })} · {row.reasons?.[0]?.message}</T>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {[
                  { key: 'keep_existing', label: t('vimp.keep_existing'), color: c.lime },
                  { key: 'use_import', label: t('vimp.use_import'), color: c.sun },
                  { key: 'skip', label: t('vimp.skip'), color: c.paper },
                ].map((opt) => (
                  <Pressable key={opt.key} onPress={() => resolveConflict(row.id, opt.key)} accessibilityRole="radio" accessibilityState={{ checked: row.conflict_decision === opt.key }}
                    style={{ flex: 1, borderRadius: 10, borderWidth: row.conflict_decision === opt.key ? 2 : 1, borderColor: row.conflict_decision === opt.key ? opt.color : c.line, padding: 8, alignItems: 'center', backgroundColor: row.conflict_decision === opt.key ? opt.color + '33' : c.paper, minHeight: 44 }}>
                    <T size={12} weight="700" color={row.conflict_decision === opt.key ? opt.color : c.mute}>{opt.label}</T>
                  </Pressable>
                ))}
              </View>
            </Card>
          ))}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Btn title={t('vimp.back')} color={c.paper} ink={c.ink} onPress={() => { loadRows(runTab); setStep(3); }} style={{ flex: 1 }} accessibilityLabel={t('vimp.back')} />
            <Btn title={t('vimp.go_confirm')} disabled={!allConflictsResolved} onPress={() => setStep(5)} style={{ flex: 1 }} accessibilityLabel={t('vimp.go_confirm')} />
          </View>
        </View>
      )}

      {/* ---- STEP 5: Confirm & Run ---- */}
      {step === 5 && (
        <View style={{ gap: 14 }}>
          <H2>{t('vimp.confirm_title')}</H2>
          {!report ? (
            <>
              {summary ? (
                <GradCard colors={[c.lime, '#065F46']}>
                  <T size={12} color="rgba(255,255,255,0.75)">{t('vimp.ready_to_import')}</T>
                  <T size={22} weight="800" color="#fff" style={{ marginTop: 6 }}>{t('vimp.venues_count', { n: (summary.valid ?? 0) + (summary.warning ?? 0) })}</T>
                  <T size={13} color="rgba(255,255,255,0.75)" style={{ marginTop: 4 }}>
                    {t('vimp.confirm_summary', { errors: summary.rejected ?? 0, skipped: summary.skipped ?? 0 })}
                  </T>
                </GradCard>
              ) : null}
              <View style={{ backgroundColor: c.cyanSoft, borderRadius: r.card, borderLeftWidth: 3, borderLeftColor: c.cyan, padding: 12 }}>
                <T size={12} color={c.cyan}>{t('vimp.reversible_note')}</T>
              </View>
              <Btn title={running ? t('vimp.running') : t('vimp.run_import')} loading={running} onPress={runImport} accessibilityLabel={t('vimp.run_import')} />
              {running ? (
                <View style={{ alignItems: 'center', gap: 8, padding: 16 }}>
                  <ActivityIndicator color={c.pink} />
                  <T color={c.mute} size={13}>{t('vimp.importing_progress')}</T>
                </View>
              ) : null}
              <Btn title={t('vimp.back')} color={c.paper} ink={c.ink} onPress={() => setStep(hasConflicts ? 4 : 3)} accessibilityLabel={t('vimp.back')} />
            </>
          ) : (
            /* Post-import report */
            <View style={{ gap: 12 }}>
              <Card color={report.project?.status === 'completed' && !report.failed ? c.limeSoft : c.redSoft}>
                <T weight="800" size={18} color={report.project?.status === 'completed' && !report.failed ? c.lime : c.red}>
                  {report.project?.status === 'completed' && !report.failed ? t('vimp.import_complete') : t('vimp.import_failed')}
                </T>
              </Card>
              {report.created != null ? (
                <View style={{ gap: 8 }}>
                  <Row title={t('vimp.report_created')} right={<T weight="800">{String(report.created)}</T>} />
                  <Row title={t('vimp.report_skipped')} right={<T weight="800">{String(report.skipped ?? 0)}</T>} />
                  {report.failed > 0 ? <Row title={t('vimp.report_failed')} right={<T weight="800" color={c.red}>{String(report.failed)}</T>} /> : null}
                </View>
              ) : null}
              <Btn title={t('vimp.done')} onPress={() => nav.back()} accessibilityLabel={t('vimp.done')} />
              {report.project?.status === 'completed' && daysFromNow(report.project?.completed_at) <= 2 ? (
                <Btn title={t('vimp.rollback')} color={c.paper} ink={c.red} onPress={async () => {
                  try { await api.post(`/venue-imports/${projectId}/rollback`); toast(t('vimp.rolled_back')); nav.back(); } catch (e) { toast(e.message); }
                }} accessibilityLabel={t('vimp.rollback')} />
              ) : null}
            </View>
          )}
        </View>
      )}
    </Screen>
  );
}

function daysFromNow(iso) {
  if (!iso) return 999;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}
