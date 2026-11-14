import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { countryName } from '../country-picker';
import { t } from '../i18n';

const STATE = {
  draft: ['Draft — not signed', 'sun'], awaiting_signatures: ['Awaiting signatures', 'cyan'],
  signed: ['Signed', 'mint'], voided: ['Replaced', 'violetSoft'],
};

const LEVEL_COLOR = { simple: c.sunSoft, advanced: c.cyanSoft, qualified: c.mintSoft };

const stamp = (iso) => iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const daysUntil = (iso) => { if (!iso) return null; const d = Math.ceil((new Date(iso) - Date.now()) / 86400000); return d; };

const EVENT_ICON = { created: '📄', sent: '📤', signed: '✍️', declined: '❌', voided: '🚫', reminded: '🔔', deadline_extended: '📅', certificate_issued: '🏆', reminder_scheduled: '⏰' };

/** Open a protected PDF — web opens a tab; native saves and shares. */
async function openPdf(url, name) {
  const blob = await api.download(url.replace('/api/v1', ''));
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const u = URL.createObjectURL(blob); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 120000); return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const file = new File(Paths.cache, `${name}.pdf`);
  file.create({ overwrite: true });
  file.write(new Uint8Array(await new Response(blob).arrayBuffer()));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open PDF files from here. Open the agreement on the web app.');
  await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: name });
}

/** Single stat pill for the metric strip. */
function StatPill({ label, value, color, ink = c.ink }) {
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={`${label}: ${value}`}
      style={{ backgroundColor: color, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, alignItems: 'center', flex: 1, minWidth: 72 }}>
      <T size={18} weight="900" color={ink}>{value}</T>
      <T size={10} weight="700" color={ink} style={{ opacity: 0.7, textAlign: 'center' }} numberOfLines={1}>{label}</T>
    </View>
  );
}

/** Per-signatory row in the status board. */
function SignatoryRow({ sig, canRemind, onRemind, loading }) {
  const sigColor = sig.status === 'signed' ? c.mint : sig.status === 'declined' ? c.red : c.sunSoft;
  const sigLabel = sig.status === 'signed' ? `✓ ${stamp(sig.signed_at)}` : sig.status === 'declined' ? t('spnc.declined') : t('spnc.waiting');
  return (
    <View accessible accessibilityRole="text"
      accessibilityLabel={`${sig.name}, ${sig.side === 'sponsor' ? t('spnc.side_sponsor') : t('spnc.side_recipient')}, ${sig.status === 'signed' ? `signed ${stamp(sig.signed_at)}` : sig.status}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: sig.side === 'sponsor' ? c.cyanSoft : c.pinkSoft, justifyContent: 'center', alignItems: 'center' }}>
        <T size={15} weight="900">{(sig.name || '?')[0].toUpperCase()}</T>
      </View>
      <View style={{ flex: 1 }}>
        <T size={13} weight="800">{sig.name}</T>
        <T size={11} color={c.mute}>{sig.side === 'sponsor' ? t('spnc.side_sponsor') : t('spnc.side_recipient')}{sig.capacity ? ` · ${sig.capacity}` : ''}{sig.provider ? ` · ${sig.provider}` : ''}</T>
      </View>
      <Tag label={sigLabel} color={sigColor} />
      {canRemind && sig.status === 'pending' ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Send reminder to ${sig.name}`} onPress={() => onRemind(sig.id)}
          style={{ padding: 6, borderRadius: 8, backgroundColor: c.sunSoft }}>
          {loading === sig.id ? <Loading small /> : <T size={14}>🔔</T>}
        </Pressable>) : null}
    </View>
  );
}

/**
 * Elite-grade contract section of the agreement screen (#295, #386): issue/send/sign/void workflow,
 * metric strip, per-signatory status board, audit trail, Adobe Sign + DocuSign + internal,
 * signing order, deadline, reminders, completion certificate.
 */
export function SponsorContract({ deal, can, onChanged }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get(`/sponsorships/${deal.id}/contracts`), [deal.id, deal.terms_version]);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(null);
  const [fail, setFail] = useState(null);
  const [remindBusy, setRemindBusy] = useState(null);
  const audit = useLoad(() => (sheet === 'audit' && live ? api.get(`/sponsorship-contracts/${live.id}/audit`) : Promise.resolve(null)), [sheet, list.data]);
  const sponsor = deal.role === 'sponsor';
  const manage = deal.role === 'recipient' || (sponsor && can('contract'));
  const open = ['proposed', 'active'].includes(deal.status);
  const data = list.data;
  const live = data?.contracts.find((x) => x.status !== 'voided');
  const replaced = data ? data.contracts.filter((x) => x.status === 'voided').length : 0;
  const done = async (fn, msg, key = 'x') => {
    if (busy) return;
    setBusy(key); setFail(null);
    try { await fn(); toast(msg); list.reload(); onChanged?.(); } catch (e) { setFail({ error: { ...e, message: explain(e) }, retry: () => done(fn, msg, key) }); list.reload(); } finally { setBusy(null); }
  };
  const templates = useLoad(() => (manage && open ? api.get('/document-templates', { family: 'sponsorship_agreement' }) : Promise.resolve([])), [deal.id, manage, open]);
  const policy = useLoad(() => (sheet === 'send' ? api.get('/signature-policy') : Promise.resolve(null)), [sheet]);
  const signers = useLoad(() => (sheet === 'signers' ? api.get(`/sponsorships/${deal.id}/contract-signers`) : Promise.resolve(null)), [sheet, deal.id]);
  if (!deal.lines.length && !data?.contracts.length) return null;

  const signed = live?.signatories.filter((s) => s.status === 'signed').length ?? 0;
  const totalSig = live?.signatories.length ?? 0;
  const daysLeft = live?.deadline_at ? daysUntil(live.deadline_at) : null;
  const providerLabel = live?.signature_request?.provider_label ?? null;

  const sendReminder = async (signatoryId) => {
    setRemindBusy(signatoryId);
    try {
      await api.post(`/sponsorship-contracts/${live.id}/remind`, signatoryId ? { signatory_id: signatoryId } : {});
      toast(t('spnc.reminded'));
      list.reload();
    } catch (e) { toast(explain(e)); } finally { setRemindBusy(null); }
  };

  return (
    <Section title={t('spnc.section_title')} color={c.cyan}>
      {list.loading && !data ? <Loading /> : list.error ? <LoadError error={list.error} onRetry={list.reload} /> : (
        <>
          {!live ? (
            <Empty emoji="📝" title={t('spnc.no_contract')} sub={open ? t('spnc.no_contract_sub') : `This agreement is ${deal.status}, so a contract can no longer be issued.`} />
          ) : (
            <Card color={live.status === 'signed' ? c.limeSoft : c.paper} accessibilityLabel={`Contract for terms version ${live.terms_version}: ${STATE[live.status][0]}`}>
              {/* Header row */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 2 }}>
                <T weight="900" style={{ flex: 1 }}>{t('spnc.terms_v', { v: live.terms_version })}</T>
                <View accessible accessibilityRole="text" accessibilityLabel={`Status: ${STATE[live.status][0]}`}><Tag label={STATE[live.status][0]} color={c[STATE[live.status][1]] ?? c.paper} /></View>
              </View>
              <T size={12} color={c.mute} selectable>{t('spnc.fingerprint', { fp: live.snapshot_sha256.slice(0, 16) })} · {t('spnc.issued', { d: stamp(live.created_at) })}</T>

              {/* Metric strip — shown when awaiting or signed */}
              {['awaiting_signatures', 'signed'].includes(live.status) && totalSig > 0 ? (
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  <StatPill label={t('spnc.signed_label')} value={`${signed}/${totalSig}`} color={c.mintSoft} />
                  {live.status === 'awaiting_signatures' ? <StatPill label={t('spnc.pending_label')} value={String(totalSig - signed)} color={c.sunSoft} /> : null}
                  {daysLeft !== null ? <StatPill label={daysLeft >= 0 ? t('spnc.days_left_label') : t('spnc.overdue_label')} value={`${Math.abs(daysLeft)}d`} color={daysLeft >= 3 ? c.cyanSoft : daysLeft >= 0 ? c.sunSoft : c.pinkSoft} /> : null}
                  {providerLabel ? <StatPill label={t('spnc.provider_label')} value={providerLabel} color={c.violetSoft} ink={c.ink} /> : null}
                </View>) : null}

              {/* Jurisdiction / level banner */}
              {live.signing_level ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, backgroundColor: LEVEL_COLOR[live.signing_level] ?? c.sunSoft, borderRadius: 8, padding: 8 }}>
                  <T size={12} weight="800">{t(`spnc.level.${live.signing_level}`)}</T>
                  {live.signature_request?.jurisdiction ? <T size={12} color={c.mute}>· {countryName(live.signature_request.jurisdiction)} rules</T> : null}
                </View>) : null}

              {/* Stale warning */}
              {live.stale ? (
                <View accessibilityRole="alert" style={{ backgroundColor: c.pinkSoft, borderRadius: 12, padding: 10, marginTop: 8, gap: 6 }}>
                  <T weight="800" size={13}>{t('spnc.stale_warning', { v: deal.terms_version })}</T>
                  {manage && open ? <Btn small title={t('spnc.issue_new', { v: deal.terms_version })} color={c.pink} onPress={() => setSheet('issue')} /> : null}
                </View>) : null}

              {/* Signed detail */}
              {live.status === 'signed' ? <T size={12} color={c.mute}>{t('spnc.signed_at', { d: stamp(live.signed_at) })} · {t('spnc.sealed_fp', { fp: live.signed_sha256?.slice(0, 16) ?? '—' })}{live.accepted_terms_version === live.terms_version ? ' · ' + t('spnc.accepted_version') : ''}</T> : null}

              {/* Signatories board */}
              {live.signatories.length > 0 ? (
                <View style={{ marginTop: 10 }}>
                  <T size={11} weight="800" color={c.mute} style={{ marginBottom: 4 }}>{t('spnc.signatories_heading').toUpperCase()}</T>
                  {live.signatories.map((s) => (
                    <SignatoryRow key={s.id} sig={s} canRemind={live.can.manage && live.status === 'awaiting_signatures'} onRemind={sendReminder} loading={remindBusy} />))}
                </View>) : (
                <T size={13} color={c.mute} style={{ marginTop: 8 }}>{t('spnc.no_signatories')}</T>)}

              {/* Signing order badge */}
              {live.signing_order && live.status === 'awaiting_signatures' ? (
                <T size={11} color={c.mute} style={{ marginTop: 6 }}>{live.signing_order === 'sequential' ? t('spnc.order_sequential') : t('spnc.order_parallel')}</T>) : null}

              {/* Deadline */}
              {live.deadline_at ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <T size={12} color={c.mute}>📅 {t('spnc.deadline')}: {stamp(live.deadline_at)}</T>
                  {live.can.manage && live.status === 'awaiting_signatures' ? <Btn tiny title={t('spnc.extend')} color={c.sunSoft} ink={c.ink} onPress={() => setSheet('deadline')} /> : null}
                </View>) : null}

              {/* Action buttons */}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                <Btn small title={t('spnc.view_draft')} loading={busy === 'draft'} color={c.paper} ink={c.ink} onPress={() => done(() => openPdf(live.draft_url, `contract-${live.terms_version}-draft`), t('spnc.opened'), 'draft')} accessibilityLabel="View the unsigned draft PDF" />
                {live.signed_url ? <Btn small title={t('spnc.view_signed')} loading={busy === 'signed'} color={c.mint} ink={c.ink} onPress={() => done(() => openPdf(live.signed_url, `contract-${live.terms_version}-signed`), t('spnc.opened'), 'signed')} accessibilityLabel="View the signed PDF" /> : null}
                {live.status === 'signed' ? <Btn small title={t('spnc.certificate')} color={c.limeSoft} ink={c.ink} onPress={() => setSheet('certificate')} accessibilityLabel="View completion certificate" /> : null}
                {live.can.sign ? <Btn small title={t('spnc.review_sign')} color={c.pink} onPress={() => setSheet('sign')} accessibilityLabel="Review and sign this contract" /> : null}
                {live.can.manage && live.status === 'draft' && !live.stale ? <Btn small title={t('spnc.name_signatories')} color={c.violet} onPress={() => setSheet('signers')} /> : null}
                {live.can.manage && live.status === 'draft' && !live.stale ? <Btn small title={t('spnc.send_for_sig')} color={c.mint} ink={c.ink} disabled={live.signatories.length < 2} onPress={() => setSheet('send')} /> : null}
                {live.status === 'awaiting_signatures' && live.can.manage ? <Btn small title={t('spnc.send_all_reminder')} color={c.sunSoft} ink={c.ink} loading={remindBusy === 'all'} onPress={async () => { setRemindBusy('all'); try { await api.post(`/sponsorship-contracts/${live.id}/remind`, {}); toast(t('spnc.reminded')); list.reload(); } catch (e) { toast(explain(e)); } finally { setRemindBusy(null); } }} /> : null}
                {live.status !== 'voided' && live.status !== 'signed' && live.can.manage ? <Btn small title={t('spnc.audit_btn')} color={c.paper} ink={c.ink} onPress={() => setSheet('audit')} /> : null}
                {live.can.manage ? <Btn small title={live.status === 'draft' ? t('spnc.replace') : t('spnc.withdraw')} color={c.paper} ink={c.red} onPress={() => setSheet(live.status === 'draft' ? 'issue' : 'void')} /> : null}
              </View>

              {live.status === 'draft' && live.signatories.length < 2 && !live.stale ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('spnc.min_signatories_hint')}</T> : null}
              {live.signature_request && live.status === 'awaiting_signatures' && live.signature_request.status === 'declined' ? (
                <View accessibilityRole="alert" style={{ marginTop: 8, backgroundColor: c.pinkSoft, borderRadius: 8, padding: 8 }}><T size={13} weight="800">{t('spnc.declined_warning')}</T></View>) : null}
              {live.status === 'awaiting_signatures' && !live.can.sign && !live.stale && !live.signatories.some((x) => x.id === live.my_signatory_id) ? <T size={12} color={c.mute} accessibilityRole="text" style={{ marginTop: 4 }}>{t('spnc.not_signatory')}</T> : null}
            </Card>)}

          {fail ? <View accessibilityRole="alert"><ErrorBox error={fail.error} onRetry={fail.retry} /></View> : null}
          {replaced ? <T size={12} color={c.mute}>{t('spnc.replaced_count', { n: replaced })}</T> : null}
          {manage && open && (!live || live.status === 'voided') ? <Btn title={t('spnc.issue_draft', { v: deal.terms_version })} color={c.cyan} ink={c.ink} onPress={() => setSheet('issue')} /> : null}
          {sponsor && !manage ? <T size={12} color={c.mute} accessibilityRole="text">{t('spnc.role_hint', { role: deal.my_sponsor_role })}</T> : null}
        </>)}

      {/* Issue sheet */}
      <FormSheet visible={sheet === 'issue'} onClose={() => setSheet(null)} title={t('spnc.issue_title', { v: deal.terms_version })} submitLabel={t('spnc.issue_submit')}
        fields={[{ key: 'template_id', label: t('spnc.template_field'), type: 'chips', optional: true, hint: t('spnc.template_hint'), options: (templates.data ?? []).filter((t) => t.latest_version).map((t) => ({ value: t.id, label: `${t.name} v${t.latest_version}` })) }]}
        onSubmit={async (v) => { await api.post(`/sponsorships/${deal.id}/contracts`, { version: deal.terms_version, ...(v.template_id ? { template_id: v.template_id } : {}) }); list.reload(); onChanged?.(); return t('spnc.issue_success'); }} />

      {/* Send for signature sheet — enhanced with Adobe Sign, signing order, deadline, reminder schedule */}
      <FormSheet visible={sheet === 'send'} onClose={() => setSheet(null)} title={t('spnc.send_title')} submitLabel={t('spnc.send_submit')}
        initial={{ provider: 'internal', signing_order: 'parallel', deadline_at: null, reminder_days: [7, 3, 1] }}
        fields={[
          { key: 'provider', label: t('spnc.provider_field'), type: 'chips', hint: t('spnc.provider_hint'), options: (policy.data?.providers ?? [{ id: 'internal', label: 'GotMyGame', level: 'simple', enabled: true }]).filter((p) => p.enabled && p.id !== 'webhook').map((p) => ({ value: p.id, label: `${p.label} (${t(`spnc.level.${p.level}`) ?? p.level})` })) },
          { key: 'signing_order', label: t('spnc.signing_order'), type: 'chips', options: [{ value: 'parallel', label: t('spnc.parallel') }, { value: 'sequential', label: t('spnc.sequential') }] },
          { key: 'deadline_at', label: t('spnc.deadline'), type: 'date', optional: true, hint: t('spnc.deadline_hint') },
          { key: 'reminder_days', label: t('spnc.reminders'), type: 'chips', optional: true, multiSelect: true, hint: t('spnc.reminders_hint'), options: [{ value: 7, label: t('spnc.remind_d7') }, { value: 3, label: t('spnc.remind_d3') }, { value: 1, label: t('spnc.remind_d1') }] },
          { key: 'jurisdiction', label: t('spnc.jurisdiction_field'), type: 'country', optional: true, hint: (v) => { if (!v.jurisdiction) return t('spnc.jurisdiction_hint'); const r = policy.data?.rules?.[v.jurisdiction] ?? policy.data?.default_rule; return r ? `${r.law ? `${r.law}: ` : ''}${r.note}` : null; } }]}
        onSubmit={async (v) => {
          const body = { row_version: live.row_version, provider: v.provider || 'internal', signing_order: v.signing_order || 'parallel', ...(v.jurisdiction ? { jurisdiction: v.jurisdiction } : {}), ...(v.deadline_at ? { deadline_at: new Date(v.deadline_at).toISOString() } : {}), ...(v.reminder_days?.length ? { reminder_schedule: { days: v.reminder_days } } : {}) };
          await api.post(`/sponsorship-contracts/${live.id}/request-signatures`, body); list.reload(); onChanged?.();
          return v.provider !== 'internal' ? t('spnc.send_success_vendor', { p: v.provider === 'adobe_sign' ? 'Adobe Sign' : 'DocuSign' }) : t('spnc.send_success_internal');
        }} />

      {/* Signatories sheet */}
      <FormSheet visible={sheet === 'signers'} onClose={() => setSheet(null)} title={t('spnc.signers_title')} submitLabel={t('spnc.signers_submit')}
        initial={{ sponsor: live?.signatories.filter((s) => s.side === 'sponsor').map((s) => s.user_id) ?? [], recipient: live?.signatories.filter((s) => s.side === 'recipient').map((s) => s.user_id) ?? [] }}
        fields={[
          { key: 'sponsor', label: t('spnc.signers_sponsor'), type: 'multi', hint: t('spnc.signers_sponsor_hint'), options: (signers.data?.sponsor ?? []).map((p) => ({ value: p.user_id, label: p.name })) },
          { key: 'recipient', label: t('spnc.signers_recipient'), type: 'multi', hint: t('spnc.signers_recipient_hint'), options: (signers.data?.recipient ?? []).map((p) => ({ value: p.user_id, label: p.name })) }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-contracts/${live.id}/signatories`, { row_version: live.row_version, signatories: [...v.sponsor.map((user_id) => ({ user_id, side: 'sponsor' })), ...v.recipient.map((user_id) => ({ user_id, side: 'recipient' }))] }); list.reload(); return t('spnc.signers_success'); }} />

      {/* Sign sheet */}
      <FormSheet visible={sheet === 'sign'} onClose={() => setSheet(null)} title={t('spnc.sign_title')} submitLabel={t('spnc.sign_submit')}
        fields={[
          { key: 'info', type: 'section', label: `${t('spnc.terms_v', { v: live?.terms_version ?? '' })} · ${t('spnc.fingerprint', { fp: live?.snapshot_sha256.slice(0, 16) ?? '' })}…` },
          { key: 'agree', label: t('spnc.sign_agree'), type: 'switch' }]}
        onSubmit={async (v) => {
          if (!v.agree) throw new Error(t('spnc.sign_confirm_required'));
          const r = await api.post(`/sponsorship-contracts/${live.id}/sign`, { document_sha256: live.snapshot_sha256, agree: true });
          list.reload(); onChanged?.();
          return r.contract_status === 'signed' ? t('spnc.sign_complete') : t('spnc.sign_waiting');
        }} />

      {/* Void sheet */}
      <FormSheet visible={sheet === 'void'} onClose={() => setSheet(null)} title={t('spnc.void_title')} submitLabel={t('spnc.void_submit')} fields={[{ key: 'reason', label: t('spnc.void_reason'), type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-contracts/${live.id}/void`, { reason: v.reason }); list.reload(); return t('spnc.void_success'); }} />

      {/* Certificate sheet */}
      <FormSheet visible={sheet === 'certificate'} onClose={() => setSheet(null)} title={t('spnc.cert_title')} submitLabel={t('spnc.cert_download')}
        fields={[{ key: 'info', type: 'section', label: `${t('spnc.cert_body', { v: live?.terms_version ?? '', d: stamp(live?.signed_at) })}` }]}
        onSubmit={async () => {
          const cert = await api.get(`/sponsorship-contracts/${live.id}/certificate`);
          await openPdf(cert.download_url, `contract-${live?.terms_version}-certificate`);
          return t('spnc.cert_opened');
        }} />

      {/* Extend deadline sheet */}
      <FormSheet visible={sheet === 'deadline'} onClose={() => setSheet(null)} title={t('spnc.extend_title')} submitLabel={t('spnc.extend_submit')}
        initial={{ deadline_at: live?.deadline_at ?? null, reminder_days: live?.reminder_schedule?.days ?? [7, 3, 1] }}
        fields={[
          { key: 'deadline_at', label: t('spnc.deadline'), type: 'date', hint: t('spnc.deadline_hint') },
          { key: 'reminder_days', label: t('spnc.reminders'), type: 'chips', optional: true, multiSelect: true, options: [{ value: 7, label: t('spnc.remind_d7') }, { value: 3, label: t('spnc.remind_d3') }, { value: 1, label: t('spnc.remind_d1') }] }]}
        onSubmit={async (v) => {
          if (!v.deadline_at) throw new Error(t('spnc.deadline_required'));
          await api.patch(`/sponsorship-contracts/${live.id}/deadline`, { deadline_at: new Date(v.deadline_at).toISOString(), ...(v.reminder_days?.length ? { reminder_schedule: { days: v.reminder_days } } : {}) });
          list.reload(); return t('spnc.extend_success');
        }} />

      {/* Audit trail sheet */}
      <FormSheet visible={sheet === 'audit'} onClose={() => setSheet(null)} title={t('spnc.audit_title')} submitLabel={null}
        fields={audit.data?.events?.length ? audit.data.events.map((e, i) => ({
          key: `ev_${i}`, type: 'section',
          label: `${EVENT_ICON[e.event_type] ?? '•'} ${t(`spnc.event.${e.event_type}`) ?? e.event_type}${e.actor_name ? ` · ${e.actor_name}` : ''}\n${stamp(e.created_at)}${e.ip_address ? ` · ${e.ip_address}` : ''}`,
        })) : [{ key: 'empty', type: 'section', label: audit.loading ? t('spnc.loading') : t('spnc.audit_empty') }]}
        onSubmit={null} />
    </Section>
  );
}
