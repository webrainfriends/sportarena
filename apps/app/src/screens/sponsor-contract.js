import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { countryName } from '../country-picker';

const STATE = {
  draft: ['Draft — not signed', 'sun'], awaiting_signatures: ['Awaiting signatures — not yet binding', 'cyan'],
  signed: ['Signed', 'mint'], voided: ['Replaced', 'violetSoft'],
};
const stamp = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Open a protected PDF (it needs the sign-in header, so it is fetched as a blob). Web opens a tab; a phone saves it to the cache and hands it to the share / open sheet. */
async function openPdf(url, name) {
  const blob = await api.download(url.replace('/api/v1', ''));
  if (Platform.OS === 'web' && typeof window !== 'undefined') { const u = URL.createObjectURL(blob); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 120000); return; }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const file = new File(Paths.cache, `${name}.pdf`);
  file.create({ overwrite: true });
  file.write(new Uint8Array(await new Response(blob).arrayBuffer()));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open PDF files from here. Open the agreement on the web app.');
  await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: name });
}

/**
 * The contract section of the agreement screen (#295): issue a draft of the CURRENT terms, name the signatories, send for signature, sign, and
 * download the draft or the signed copy. A draft is always labelled as not signed; the server decides who may do what, this only hides what it would refuse.
 */
export function SponsorContract({ deal, can, onChanged }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get(`/sponsorships/${deal.id}/contracts`), [deal.id, deal.terms_version]);
  const [sheet, setSheet] = useState(null); // 'issue' | 'signers' | 'sign' | 'void'
  const [busy, setBusy] = useState(null); // the action in flight, so a double tap cannot fire it twice
  const [fail, setFail] = useState(null); // { error, retry } of the last failed action
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
                <View accessible accessibilityRole="text" accessibilityLabel={`Status: ${STATE[live.status][0]}`}><Tag label={STATE[live.status][0]} color={c[STATE[live.status][1]] ?? c.paper} /></View>
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
                  <View key={s.id} accessible accessibilityRole="text" accessibilityLabel={`${s.name}, ${s.side === 'sponsor' ? 'for the sponsor' : 'for the recipient'}, ${s.status === 'signed' ? `signed ${stamp(s.signed_at)}` : 'has not signed yet'}`} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <T size={13} style={{ flex: 1 }}>{s.name} · {s.side === 'sponsor' ? 'for the sponsor' : 'for the recipient'}{s.capacity ? `, ${s.capacity}` : ''}</T>
                    <T size={12} weight="800" color={s.status === 'signed' ? c.ink : c.mute}>{s.status === 'signed' ? `✓ ${stamp(s.signed_at)}` : 'waiting'}</T>
                  </View>)) : <T size={13} color={c.mute}>No signatories named yet.</T>}
              </View>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <Btn small title="View draft PDF" loading={busy === 'draft'} color={c.paper} ink={c.ink} onPress={() => done(() => openPdf(live.draft_url, `contract-${live.terms_version}-draft`), 'Opened', 'draft')} accessibilityLabel="View the unsigned draft PDF" />
                {live.signed_url ? <Btn small title="View signed PDF" loading={busy === 'signed'} color={c.mint} ink={c.ink} onPress={() => done(() => openPdf(live.signed_url, `contract-${live.terms_version}-signed`), 'Opened', 'signed')} accessibilityLabel="View the signed PDF" /> : null}
                {live.can.sign ? <Btn small title="Review & sign" color={c.pink} onPress={() => setSheet('sign')} accessibilityLabel="Review and sign this contract" /> : null}
                {live.can.manage && live.status === 'draft' && !live.stale ? <Btn small title="Name signatories" color={c.violet} onPress={() => setSheet('signers')} /> : null}
                {live.can.manage && live.status === 'draft' && !live.stale ? <Btn small title="Send for signature" color={c.mint} ink={c.ink} disabled={live.signatories.length < 2} onPress={() => setSheet('send')} /> : null}
                {live.can.manage ? <Btn small title={live.status === 'draft' ? 'Replace draft' : 'Withdraw'} color={c.paper} ink={c.red} onPress={() => setSheet(live.status === 'draft' ? 'issue' : 'void')} /> : null}
              </View>
              {live.status === 'draft' && live.signatories.length < 2 && !live.stale ? <T size={12} color={c.mute}>Name at least one signatory on each side before sending.</T> : null}
              {live.signature_request ? <T size={12} color={c.mute}>Sent with {live.signature_request.provider_label} ({live.signature_request.level} e-signature{live.signature_request.jurisdiction ? `, ${countryName(live.signature_request.jurisdiction)} rules` : ''}){live.status === 'awaiting_signatures' && live.signature_request.status === 'sent' ? '. Each signatory is emailed by the service; this card updates when they sign.' : live.signature_request.status === 'declined' ? '. A signatory declined — withdraw this contract and issue a new one.' : ''}</T> : null}
              {live.status === 'awaiting_signatures' && !live.can.sign && !live.stale ? <T size={12} color={c.mute}>Waiting for the people above to sign. Until everyone has, this is not a signed contract.</T> : null}
            </Card>)}
          {fail ? <View accessibilityRole="alert"><ErrorBox error={fail.error} onRetry={fail.retry} /></View> : null}
          {replaced ? <T size={12} color={c.mute}>{replaced} earlier draft{replaced === 1 ? '' : 's'} replaced — kept for the record.</T> : null}
          {manage && open && (!live || live.status === 'voided') ? <Btn title={`Issue draft contract (terms v${deal.terms_version})`} color={c.cyan} ink={c.ink} onPress={() => setSheet('issue')} /> : null}
          {sponsor && !manage ? <T size={12} color={c.mute} accessibilityRole="text">Your role ({deal.my_sponsor_role}) cannot issue or send contracts. Ask a Manager, Legal or Approver colleague.</T> : null}
          {live && live.status === 'awaiting_signatures' && !live.can.sign && !live.stale && !live.signatories.some((x) => x.id === live.my_signatory_id) ? <T size={12} color={c.mute} accessibilityRole="text">You are not a named signatory of this contract, so you can read it but not sign it.</T> : null}
        </>)}

      <FormSheet visible={sheet === 'issue'} onClose={() => setSheet(null)} title={`Issue a draft of terms v${deal.terms_version}`} submitLabel="Issue draft"
        fields={[{ key: 'template_id', label: 'Template', type: 'chips', optional: true, hint: 'Your published sponsorship agreement templates. Without one the plain layout is used.', options: (templates.data ?? []).filter((t) => t.latest_version).map((t) => ({ value: t.id, label: `${t.name} v${t.latest_version}` })) }]}
        onSubmit={async (v) => { await api.post(`/sponsorships/${deal.id}/contracts`, { version: deal.terms_version, ...(v.template_id ? { template_id: v.template_id } : {}) }); list.reload(); onChanged?.(); return 'Draft issued — it is not signed'; }} />
      <FormSheet visible={sheet === 'send'} onClose={() => setSheet(null)} title="Send for signature" submitLabel="Send"
        initial={{ provider: 'internal' }}
        fields={[
          { key: 'provider', label: 'How should they sign?', type: 'chips', hint: 'Only ways that are set up are offered. Signing in Sportarena is a simple e-signature; an external service gives an advanced one and emails each signatory.', options: (policy.data?.providers ?? [{ id: 'internal', label: 'Sportarena', level: 'simple', enabled: true }]).filter((p) => p.enabled && p.id !== 'webhook').map((p) => ({ value: p.id, label: `${p.label} (${p.level})` })) },
          { key: 'jurisdiction', label: 'Whose rules apply', type: 'country', optional: true, hint: (v) => { if (!v.jurisdiction) return 'Pick the country whose law governs this agreement to check the signature is strong enough.'; const r = policy.data?.rules?.[v.jurisdiction] ?? policy.data?.default_rule; return r ? `${r.law ? `${r.law}: ` : ''}${r.note}` : null; } }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-contracts/${live.id}/request-signatures`, { row_version: live.row_version, provider: v.provider || 'internal', ...(v.jurisdiction ? { jurisdiction: v.jurisdiction } : {}) }); list.reload(); onChanged?.(); return v.provider === 'docusign' ? 'Sent — signatories are emailed by the service' : 'Sent for signature'; }} />
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
