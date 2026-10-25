// Agreements: pick a standard template, tailor parties, dates, fees and wording (optionally with AI), review it as a PDF or Word overview,
// submit for approval, and keep the signed copy. The server enforces who may do what; the screen only hides what a role cannot use.
import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Stepper } from '../pickers';
import { countryName } from '../country-picker';
import { moneyIn } from '../vtime';
import { c, day } from '../theme';
import { explain } from '../access';
import { pickDocument } from './insurance';
import { openPdf } from '../open-file';

export const STATUS_TONE = { draft: c.violetSoft, submitted: c.sunSoft, changes_requested: c.orangeSoft, approved: c.mint, rejected: c.orangeSoft, signed: c.mint };
const STEPS = ['Type', 'Parties & term', 'Wording', 'Review'];
const BLANK = { template_key: 'participation', auto_renew: false };

/** Download a protected file: the web saves it, a device hands it to the share sheet. */
export async function saveProtectedFile(path, name, mime) {
  if (mime === 'application/pdf') return openPdf(path, name);
  const blob = await api.download(path);
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 60000); return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const f = new File(Paths.cache, name.replace(/[^A-Za-z0-9._-]/g, '_'));
  f.create({ overwrite: true }); f.write(new Uint8Array(await new Response(blob).arrayBuffer()));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open files from here. Open the agreement in the web app.');
  await Sharing.shareAsync(f.uri, { mimeType: mime, dialogTitle: name });
}

/** New agreement, or (with `edit`) a draft / sent-back agreement being changed. */
export function AgreementWizard({ o, edit, revise, onClose, onDone }) {
  const { toast } = useSession();
  const first = edit || revise ? 1 : 0;
  const [step, setStep] = useState(first);
  const [v, setV] = useState(() => (edit ? {
    template_key: edit.template_key ?? 'blank', title: edit.title, body: edit.body, counterparty: edit.counterparty ?? undefined, effective_from: edit.effective_from?.slice(0, 10), effective_to: edit.effective_to?.slice(0, 10), auto_renew: edit.auto_renew,
    governing_country: edit.governing_country ?? undefined, brand_kit_id: edit.brand_kit_id ?? undefined, kind: edit.kind, ai_assisted: edit.ai_assisted,
  } : revise ? { ...BLANK, template_key: 'blank', title: revise.title, body: revise.body, kind: revise.kind, policy_id: revise.id } : BLANK));
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [aiUsed, setAiUsed] = useState(!!edit?.ai_assisted);
  const tpls = useLoad(() => api.get('/agreement-templates'), []);
  const kits = useLoad(() => api.get('/brand-kits').catch(() => []), []);
  const tpl = (tpls.data ?? []).find((t) => t.key === v.template_key);
  const orgKits = (kits.data ?? []).filter((k) => k.organisation_id === o.id);
  const next = (patch) => { setV((x) => ({ ...x, ...patch })); setStep((s) => s + 1); };
  const back = () => setStep((s) => Math.max(first, s - 1));

  const terms = () => ({ template_key: v.template_key, counterparty: v.counterparty || v.party__pick?.label || undefined, effective_from: v.effective_from, effective_to: v.effective_to, auto_renew: !!v.effective_to && !!v.auto_renew, governing_country: v.governing_country, fee_minor: v.fee_minor || undefined, currency: v.fee_minor ? v.currency : undefined });
  const draft = async (use_ai) => {
    setBusy(true);
    try {
      const r = await api.post(`/organisations/${o.id}/agreements/draft-text`, { id: o.id, ...terms(), instructions: instructions.trim() || undefined, use_ai });
      setV((x) => ({ ...x, body: r.body }));
      if (r.ai) setAiUsed(true);
      toast(use_ai ? (r.ai ? 'Tailored with AI. Read it through before submitting.' : r.ai_available ? 'AI could not help this time, so the standard wording is filled in' : 'AI is not switched on here, so the standard wording is filled in') : 'Standard wording filled in');
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const save = async (submit) => {
    setBusy(true);
    try {
      const t = terms();
      const parties = t.counterparty ? [{ role: tpl?.other_party ?? 'Other party', name: t.counterparty, ...(v.party__pick?.id ? { user_id: v.party__pick.id } : {}) }] : [];
      const body = { title: v.title || tpl?.title, body: v.body, counterparty: t.counterparty, parties, effective_from: v.effective_from, effective_to: v.effective_to, auto_renew: t.auto_renew, governing_country: v.governing_country, brand_kit_id: v.brand_kit_id, ai_assisted: aiUsed };
      let a;
      if (edit) a = await api.patch(`/org-agreements/${edit.id}`, { ...body, effective_from: v.effective_from ?? null, effective_to: v.effective_to ?? null, brand_kit_id: v.brand_kit_id ?? null, governing_country: v.governing_country ?? '', counterparty: t.counterparty ?? '' });
      else a = await api.post(`/organisations/${o.id}/agreements`, { id: o.id, kind: v.policy_id ? v.kind : tpl?.kind ?? v.kind ?? 'other', template_key: v.template_key === 'blank' && v.policy_id ? undefined : v.template_key, policy_id: v.policy_id, ...body });
      if (submit) await api.post(`/org-agreements/${a.id}/submit`);
      toast(submit ? 'Submitted for approval' : 'Draft saved');
      onDone(a); onClose();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const fee = v.fee_minor ? moneyIn(v.fee_minor, v.currency ?? 'USD') : null;
  const kit = orgKits.find((k) => k.id === v.brand_kit_id);
  return (
    <Sheet visible onClose={onClose} title={edit ? `Edit · ${edit.title}` : 'New agreement'}>
      <Stepper steps={STEPS} current={step} onJump={(i) => i >= first && i <= step && setStep(i)} />
      {step === 0 ? (
        tpls.error ? <ErrorBox error={tpls.error} onRetry={tpls.reload} /> : !tpls.data ? <Loading /> : (
          <FormSheet inline visible initial={v} submitLabel="Next: parties and term" onClose={() => {}}
            fields={[{ key: 'template_key', label: 'Start from a standard template', type: 'chips', options: tpls.data.map((t) => ({ value: t.key, label: t.title })), hint: (x) => tpl && x.template_key === tpl.key ? `${tpl.summary} Covers: ${tpl.sections.join(', ')}.` : tpls.data.find((t) => t.key === x.template_key)?.summary }]}
            onSubmit={async (x) => next({ ...x, title: v.title && v.template_key === x.template_key ? v.title : tpls.data.find((t) => t.key === x.template_key)?.title })} />
        )
      ) : null}
      {step === 1 ? (
        <FormSheet inline visible initial={v} submitLabel="Next: wording" onBack={edit ? undefined : back} onClose={() => {}}
          fields={[
            { key: 'title', label: 'Agreement title' },
            { key: 'party', label: `${tpl?.other_party ?? 'Other party'} (registered person)`, type: 'entity', entityKind: 'person', optional: true, onPick: (p) => setV((x) => ({ ...x, party__pick: p })), hint: 'Search for a person on Gotmygame, or type a name below.' },
            { key: 'counterparty', label: `${tpl?.other_party ?? 'Other party'} name`, optional: true, hint: 'A person, family, company or club. Defaults to the person picked above.' },
            { key: 's1', type: 'section', label: 'Term' },
            { key: 'effective_from', label: 'Effective from → ends', type: 'daterange', toKey: 'effective_to', optional: true },
            { key: 'auto_renew', label: 'Renew automatically', type: 'switch', show: (x) => !!x.effective_to },
            { key: 'governing_country', label: 'Governing law (country)', type: 'country', optional: true },
            { key: 's2', type: 'section', label: 'Fees (optional)' },
            { key: 'currency', label: 'Currency', type: 'currency', optional: true },
            { key: 'fee_minor', label: 'Fee', type: 'money', currency: (x) => x.currency ?? 'USD', optional: true },
          ]}
          onSubmit={async (x) => next(x)} />
      ) : null}
      {step === 2 ? (
        <View style={{ gap: 12 }}>
          <T size={12} color={c.mute}>Start from the standard wording for {tpl?.title ?? 'this template'}, or ask AI to tailor it. AI never sees personal names. Always read the result: it is wording to review, not legal advice.</T>
          <Btn title={v.body ? 'Replace with the standard wording' : 'Fill in the standard wording'} color={c.paper} ink={c.ink} onPress={() => draft(false)} loading={busy} />
          <Field label="Tell AI what to add or change (optional)" value={instructions} onChangeText={setInstructions} multiline placeholder="e.g. Add that kit is not refundable once worn" maxLength={800} />
          <Btn title="Tailor with AI" color={c.violet} onPress={() => draft(true)} loading={busy} />
          <Field label="Agreement text" minHeight={320} value={v.body ?? ''} onChangeText={(x) => setV((y) => ({ ...y, body: x }))} multiline hint="Numbered headings (1. Heading) become sections in the PDF. You can edit anything." />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title="Back" color={c.paper} ink={c.ink} onPress={back} style={{ flex: 1 }} />
            <Btn title="Next: review" onPress={() => setStep(3)} disabled={(v.body ?? '').trim().length < 50} style={{ flex: 2 }} />
          </View>
        </View>
      ) : null}
      {step === 3 ? (
        <View style={{ gap: 10 }}>
          {orgKits.length ? (
            <View style={{ gap: 6 }}>
              <T weight="800" size={13}>Logo and letterhead (brand kit)</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <Chip label="Organisation details" active={!v.brand_kit_id} onPress={() => setV((x) => ({ ...x, brand_kit_id: undefined }))} />
                {orgKits.map((k) => <Chip key={k.id} label={k.name} active={v.brand_kit_id === k.id} onPress={() => setV((x) => ({ ...x, brand_kit_id: k.id }))} />)}
              </View>
            </View>
          ) : <T size={12} color={c.mute}>No brand kit yet, so the letterhead uses the organisation's details. Add a kit with your logo under Branded documents and it is picked up here.</T>}
          <Row title={v.title ?? tpl?.title} sub={tpl?.title} />
          <Row title="Parties" sub={[`${o.legal_name || o.name}`, terms().counterparty].filter(Boolean).join(' and ')} />
          <Row title="Term" sub={`${v.effective_from ? day(v.effective_from) : 'On signature'}${v.effective_to ? ` → ${day(v.effective_to)}${v.auto_renew ? ' · renews' : ''}` : ' · until ended by notice'}`} />
          {v.governing_country ? <Row title="Governing law" sub={countryName(v.governing_country)} /> : null}
          {fee ? <Row title="Fee" sub={fee} /> : null}
          {kit ? <Row title="Letterhead" sub={kit.name} /> : null}
          <Row title="Wording" sub={`${(v.body ?? '').trim().split(/\s+/).length} words${aiUsed ? ' · drafted with AI help' : ''}`} />
          <T size={12} color={c.mute}>Save as a draft to export it as a PDF or Word file and share it. Submitting sends it to an owner for approval; after approval you can upload the signed copy.</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn title="Back" color={c.paper} ink={c.ink} onPress={back} style={{ flex: 1 }} />
            <Btn title="Save draft" color={c.violet} onPress={() => save(false)} loading={busy} style={{ flex: 1 }} />
            <Btn title="Submit for approval" onPress={() => save(true)} loading={busy} style={{ flex: 2 }} />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

const nice = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const sizeKb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

/** One agreement: overview, text, files, and the actions the person's role and the status allow. */
export function AgreementSheet({ id, o, role, archived, onClose, onChanged }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/org-agreements/${id}`), [id]);
  const [edit, setEdit] = useState(false), [decide, setDecide] = useState(null), [busy, setBusy] = useState(false);
  const a = q.data;
  const changed = () => { q.reload(); onChanged?.(); };
  const run = async (fn, msg) => { setBusy(true); try { await fn(); if (msg) toast(msg); changed(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const fileOut = (path, name, mime) => saveProtectedFile(path, name, mime).catch((e) => toast(e.message ?? explain(e)));
  const upload = (kind) => run(async () => {
    const f = await pickDocument();
    if (!f) return;
    await api.upload(`/org-agreements/${id}/files`, f.blob, { kind, label: kind === 'signed' ? 'Signed copy' : (f.name ?? '').slice(0, 100) });
  }, kind === 'signed' ? 'Signed copy saved' : 'File added');
  const editable = a && ['draft', 'changes_requested'].includes(a.status) && !archived;
  const slug = a ? `${a.ref}-${a.title.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30)}` : 'agreement';
  return (
    <Sheet visible onClose={onClose} title={a?.title ?? 'Agreement'}>
      {q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : !a ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={a.status_label} color={STATUS_TONE[a.status]} /><Tag label={a.ref} /></View>
          {a.decision_note ? <Row title={a.status === 'changes_requested' ? 'Changes requested' : 'Decision note'} sub={a.decision_note} color={c.sunSoft} /> : null}
          <Row title="Term" sub={`${a.effective_from ? day(a.effective_from) : 'On signature'}${a.effective_to ? ` → ${day(a.effective_to)}${a.auto_renew ? ' · renews' : ''}` : ' · until ended by notice'}`} />
          {a.parties.length ? <Row title="Parties" sub={[o.legal_name || o.name, ...a.parties.map((p) => `${p.name} (${p.role})`)].join(' · ')} /> : null}
          {a.policy_id ? <T size={12} color={c.mute}>Published as an agreement families can acknowledge.</T> : null}
          <T size={13} style={{ lineHeight: 20 }}>{a.body}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title="Export PDF" color={c.paper} ink={c.ink} onPress={() => fileOut(`/org-agreements/${id}/export?format=pdf`, `${slug}.pdf`, 'application/pdf')} />
            <Btn small title="Export Word" color={c.paper} ink={c.ink} onPress={() => fileOut(`/org-agreements/${id}/export?format=doc`, `${slug}.doc`, 'application/msword')} />
            {editable ? <Btn small title="Edit" color={c.violet} onPress={() => setEdit(true)} /> : null}
            {editable ? <Btn small title="Submit for approval" onPress={() => run(() => api.post(`/org-agreements/${id}/submit`), 'Submitted for approval')} loading={busy} /> : null}
          </View>
          {a.status === 'submitted' ? (
            role === 'owner' ? (
              <View style={{ gap: 8 }}>
                <T weight="800" size={13}>Your decision</T>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Btn small title="Approve" onPress={() => run(() => api.post(`/org-agreements/${id}/decision`, { decision: 'approve' }), 'Approved')} loading={busy} />
                  <Btn small title="Request changes" color={c.violet} onPress={() => setDecide('request_changes')} />
                  <Btn small title="Reject" color={c.orange} onPress={() => setDecide('reject')} />
                </View>
              </View>
            ) : <T size={12} color={c.mute}>Waiting for an owner of the organisation to approve it.</T>
          ) : null}
          <T weight="800" size={13}>Signed copies and files</T>
          {a.files.length ? a.files.map((f) => (
            <Row key={f.id} title={f.label || nice(f.kind)} sub={`${nice(f.kind)} · ${sizeKb(f.size_bytes)} · ${day(f.created_at)}`}
              right={<View style={{ flexDirection: 'row', gap: 6 }}>
                <Btn small title="Download" color={c.paper} ink={c.ink} onPress={() => fileOut(`/org-agreement-files/${f.id}`, `${slug}-${f.kind}.${f.content_type === 'application/pdf' ? 'pdf' : f.content_type.split('/')[1]}`, f.content_type)} />
                {!archived ? <Btn small title="Hide" color={c.paper} ink={c.ink} onPress={() => run(() => api.del(`/org-agreement-files/${f.id}`), 'File hidden — kept on record')} /> : null}
              </View>} />
          )) : <T size={12} color={c.mute}>{['approved', 'signed'].includes(a.status) ? 'Download the PDF, have it signed, then upload the signed copy.' : 'A signed copy can be uploaded once the agreement is approved.'}</T>}
          {!archived && ['approved', 'signed'].includes(a.status) ? <Btn title="Upload signed copy" onPress={() => upload('signed')} loading={busy} /> : null}
          {!archived && !['draft', 'rejected'].includes(a.status) ? <Btn small title="Add a supporting file" color={c.paper} ink={c.ink} onPress={() => upload('supporting')} style={{ alignSelf: 'flex-start' }} /> : null}
          {!archived && a.status !== 'submitted' ? <Btn small title="Archive" color={c.paper} ink={c.orange} onPress={() => run(async () => { await api.del(`/org-agreements/${id}`); onClose(); }, 'Archived — kept on record')} style={{ alignSelf: 'flex-start' }} /> : null}
        </View>
      )}
      {edit && a ? <AgreementWizard o={o} edit={a} onClose={() => setEdit(false)} onDone={changed} /> : null}
      <FormSheet visible={!!decide} onClose={() => setDecide(null)} title={decide === 'reject' ? 'Reject this agreement' : 'Request changes'} submitLabel={decide === 'reject' ? 'Reject' : 'Send back'}
        fields={[{ key: 'note', label: 'What should change?', type: 'multiline' }]}
        onSubmit={async (x) => { await api.post(`/org-agreements/${id}/decision`, { decision: decide, note: x.note }); changed(); return decide === 'reject' ? 'Rejected' : 'Sent back to the author'; }} />
    </Sheet>
  );
}

/** The list of agreements with the wizard entry point. */
export function AgreementList({ o, archived, role }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/agreements`, { limit: 100 }), [o.id]);
  const [make, setMake] = useState(false), [open, setOpen] = useState(null);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <T weight="800" size={16}>Agreements</T>
        {!archived ? <Btn small title="＋ New agreement" onPress={() => setMake(true)} accessibilityLabel="Create a new agreement" /> : null}
      </View>
      <T size={12} color={c.mute}>Draft from a standard template, export as PDF or Word, submit for approval, then keep the signed copy here. Approved participant agreements are published for families to acknowledge.</T>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((a) => (
        <Row key={a.id} title={a.title} sub={`${nice(a.kind)} · ${a.counterparty ?? 'no other party'}${a.effective_to ? ` · to ${day(a.effective_to)}` : ''}`} right={<Tag label={a.status_label} color={STATUS_TONE[a.status]} />} onPress={() => setOpen(a.id)} accessibilityLabel={`${a.title}, ${a.status_label}`} />
      )) : <Empty emoji="📜" title="No agreements yet" sub="Start with a template: participation terms, code of conduct, coaching, player registration, venue hire and more." />}
      {make ? <AgreementWizard o={o} onClose={() => setMake(false)} onDone={(a) => { list.reload(); setOpen(a.id); }} /> : null}
      {open ? <AgreementSheet id={open} o={o} role={role} archived={archived} onClose={() => setOpen(null)} onChanged={list.reload} /> : null}
    </View>
  );
}
