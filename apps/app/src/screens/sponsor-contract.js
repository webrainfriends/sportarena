import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, Loading, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';

const STATE = {
  draft: ['Draft — not signed', 'sun'], awaiting_signatures: ['Awaiting signatures — not yet binding', 'cyan'],
  signed: ['Signed', 'mint'], voided: ['Replaced', 'violetSoft'],
};
const stamp = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Open a protected PDF (it needs the sign-in header, so it is fetched as a blob). Web opens a tab; on a phone the file is not viewable here yet. */
async function openPdf(url, toast) {
  const blob = await api.download(url.replace('/api/v1', ''));
  if (Platform.OS === 'web' && typeof window !== 'undefined') { const u = URL.createObjectURL(blob); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 120000); } else toast('Open this agreement on the web app to view the PDF');
}

/**
 * The contract section of the agreement screen (#295): issue a draft of the CURRENT terms, name the signatories, send for signature, sign, and
 * download the draft or the signed copy. A draft is always labelled as not signed; the server decides who may do what, this only hides what it would refuse.
 */
export function SponsorContract({ deal, can, onChanged }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get(`/sponsorships/${deal.id}/contracts`), [deal.id, deal.terms_version]);
  const [sheet, setSheet] = useState(null); // 'issue' | 'signers' | 'sign' | 'void'
  const sponsor = deal.role === 'sponsor';
  const manage = deal.role === 'recipient' || (sponsor && can('contract'));
  const open = ['proposed', 'active'].includes(deal.status);
  const data = list.data;
  const live = data?.contracts.find((x) => x.status !== 'voided');
  const replaced = data ? data.contracts.filter((x) => x.status === 'voided').length : 0;
  const done = async (fn, msg) => { try { await fn(); toast(msg); list.reload(); onChanged?.(); } catch (e) { toast(explain(e)); list.reload(); } };
  const templates = useLoad(() => (manage && open ? api.get('/document-templates', { family: 'sponsorship_agreement' }) : Promise.resolve([])), [deal.id, manage, open]);
  const signers = useLoad(() => (sheet === 'signers' ? api.get(`/sponsorships/${deal.id}/contract-signers`) : Promise.resolve(null)), [sheet, deal.id]);
  if (!deal.lines.length && !data?.contracts.length) return null;

  return (
    <Section title="Contract" color={c.cyan}>
      {list.loading && !data ? <Loading /> : list.error ? <LoadError error={list.error} onRetry={list.reload} /> : (
        <>
          {!live ? (
            <Empty emoji="📝" title="No contract yet" sub={open ? 'Issue a branded draft of these exact terms, name who signs, then send it for signature.' : `This agreement is ${deal.status}, so a contract can no longer be issued.`} />
          ) : (
            <Card color={live.status === 'signed' ? c.limeSoft : c.paper} accessibilityLabel={`Contract for terms version ${live.terms_version}: ${STATE[live.status][0]}`}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <T weight="900" style={{ flex: 1 }}>Terms v{live.terms_version}</T>
                <Tag label={STATE[live.status][0]} color={c[STATE[live.status][1]] ?? c.paper} />
              </View>
              <T size={12} color={c.mute} selectable>Fingerprint {live.snapshot_sha256.slice(0, 16)}… · issued {stamp(live.created_at)}</T>
              {live.stale ? (
                <View accessibilityRole="alert" style={{ backgroundColor: c.pinkSoft, borderRadius: 12, padding: 10, marginTop: 8, gap: 6 }}>
                  <T weight="800" size={13}>The terms moved on to v{deal.terms_version} after this contract was issued, so it can no longer be signed.</T>
                  {manage && open ? <Btn small title={`Issue a new contract for v${deal.terms_version}`} color={c.pink} onPress={() => setSheet('issue')} /> : null}
                </View>) : null}
              {live.status === 'signed' ? <T size={12} color={c.mute}>Signed {stamp(live.signed_at)} · sealed copy fingerprint {live.signed_sha256?.slice(0, 16)}… · terms v{live.terms_version}{live.accepted_terms_version === live.terms_version ? ' (the accepted version)' : ''}</T> : null}
              <View style={{ marginTop: 8, gap: 4 }}>
                {live.signatories.length ? live.signatories.map((s) => (
                  <View key={s.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <T size={13} style={{ flex: 1 }}>{s.name} · {s.side === 'sponsor' ? 'for the sponsor' : 'for the recipient'}{s.capacity ? `, ${s.capacity}` : ''}</T>
                    <T size={12} weight="800" color={s.status === 'signed' ? c.ink : c.mute}>{s.status === 'signed' ? `✓ ${stamp(s.signed_at)}` : 'waiting'}</T>
                  </View>)) : <T size={13} color={c.mute}>No signatories named yet.</T>}
              </View>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <Btn small title="View draft PDF" color={c.paper} ink={c.ink} onPress={() => done(() => openPdf(live.draft_url, toast), 'Opened')} accessibilityLabel="View the unsigned draft PDF" />
                {live.signed_url ? <Btn small title="View signed PDF" color={c.mint} ink={c.ink} onPress={() => done(() => openPdf(live.signed_url, toast), 'Opened')} accessibilityLabel="View the signed PDF" /> : null}
                {live.can.sign ? <Btn small title="Review & sign" color={c.pink} onPress={() => setSheet('sign')} accessibilityLabel="Review and sign this contract" /> : null}
                {live.can.manage && live.status === 'draft' && !live.stale ? <Btn small title="Name signatories" color={c.violet} onPress={() => setSheet('signers')} /> : null}
                {live.can.manage && live.status === 'draft' && !live.stale ? <Btn small title="Send for signature" color={c.mint} ink={c.ink} disabled={live.signatories.length < 2} onPress={() => done(() => api.post(`/sponsorship-contracts/${live.id}/request-signatures`, { row_version: live.row_version }), 'Sent for signature')} /> : null}
                {live.can.manage ? <Btn small title={live.status === 'draft' ? 'Replace draft' : 'Withdraw'} color={c.paper} ink={c.red} onPress={() => setSheet(live.status === 'draft' ? 'issue' : 'void')} /> : null}
              </View>
              {live.status === 'draft' && live.signatories.length < 2 && !live.stale ? <T size={12} color={c.mute}>Name at least one signatory on each side before sending.</T> : null}
              {live.status === 'awaiting_signatures' && !live.can.sign && !live.stale ? <T size={12} color={c.mute}>Waiting for the people above to sign. Until everyone has, this is not a signed contract.</T> : null}
            </Card>)}
          {replaced ? <T size={12} color={c.mute}>{replaced} earlier draft{replaced === 1 ? '' : 's'} replaced — kept for the record.</T> : null}
          {manage && open && (!live || live.status === 'voided') ? <Btn title={`Issue draft contract (terms v${deal.terms_version})`} color={c.cyan} ink={c.ink} onPress={() => setSheet('issue')} /> : null}
          {sponsor && !manage ? <T size={12} color={c.mute}>Your role cannot issue or send contracts. Ask a Manager, Legal or Approver colleague.</T> : null}
        </>)}

      <FormSheet visible={sheet === 'issue'} onClose={() => setSheet(null)} title={`Issue a draft of terms v${deal.terms_version}`} submitLabel="Issue draft"
        fields={[{ key: 'template_id', label: 'Template', type: 'chips', optional: true, hint: 'Your published sponsorship agreement templates. Without one the plain layout is used.', options: (templates.data ?? []).filter((t) => t.latest_version).map((t) => ({ value: t.id, label: `${t.name} v${t.latest_version}` })) }]}
        onSubmit={async (v) => { await api.post(`/sponsorships/${deal.id}/contracts`, { version: deal.terms_version, ...(v.template_id ? { template_id: v.template_id } : {}) }); list.reload(); onChanged?.(); return 'Draft issued — it is not signed'; }} />
      <FormSheet visible={sheet === 'signers'} onClose={() => setSheet(null)} title="Who signs" submitLabel="Save signatories"
        initial={{ sponsor: live?.signatories.filter((s) => s.side === 'sponsor').map((s) => s.user_id) ?? [], recipient: live?.signatories.filter((s) => s.side === 'recipient').map((s) => s.user_id) ?? [] }}
        fields={[
          { key: 'sponsor', label: 'For the sponsor', type: 'multi', hint: 'People who can bind the brand', options: (signers.data?.sponsor ?? []).map((p) => ({ value: p.user_id, label: p.name })) },
          { key: 'recipient', label: 'For the recipient', type: 'multi', hint: 'People who can bind the recipient', options: (signers.data?.recipient ?? []).map((p) => ({ value: p.user_id, label: p.name })) }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-contracts/${live.id}/signatories`, { row_version: live.row_version, signatories: [...v.sponsor.map((user_id) => ({ user_id, side: 'sponsor' })), ...v.recipient.map((user_id) => ({ user_id, side: 'recipient' }))] }); list.reload(); return 'Signatories saved'; }} />
      <FormSheet visible={sheet === 'sign'} onClose={() => setSheet(null)} title="Sign this contract" submitLabel="Sign"
        fields={[
          { key: 'info', type: 'section', label: `Terms v${live?.terms_version ?? ''} · fingerprint ${live?.snapshot_sha256.slice(0, 16) ?? ''}…` },
          { key: 'agree', label: 'I have read this exact contract (View draft PDF) and agree to be bound by it', type: 'switch' }]}
        onSubmit={async (v) => { if (!v.agree) throw new Error('Confirm that you have read the contract'); const r = await api.post(`/sponsorship-contracts/${live.id}/sign`, { document_sha256: live.snapshot_sha256, agree: true }); list.reload(); onChanged?.(); return r.contract_status === 'signed' ? 'Signed — the contract is now complete' : 'Signed — waiting for the other signatories'; }} />
      <FormSheet visible={sheet === 'void'} onClose={() => setSheet(null)} title="Withdraw this contract" submitLabel="Withdraw" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-contracts/${live.id}/void`, { reason: v.reason }); list.reload(); return 'Contract withdrawn'; }} />
    </Section>
  );
}
