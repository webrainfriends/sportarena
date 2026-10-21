// Document designer (issue #249): brand kits (logo, colours, contact text) and versioned PDF templates. Works for every role;
// organisation kits/templates are for the organisation's owners and admins (the server enforces it).
// Documents are generated from a canonical record (today: an invoice), never typed here.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { useLayout } from '../layout';
import { PageCanvas, TemplateEditor } from './doc-editor';
import { KitEditor } from './brand-kit-editor';
import { c } from '../theme';

function TemplateStart({ orgId, families, starters, kits, onClose, onCreated }) {
  const { toast } = useSession();
  const L = useLayout();
  const avail = families.filter((f) => f.source.available);
  const [family, setFamily] = useState(avail[0]?.family);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const make = async (starter) => {
    if (!name.trim()) { toast('Give the template a name first'); return; }
    setBusy(true);
    try { onCreated(await api.post('/document-templates', { family, name: name.trim(), starter, ...(kits[0] ? { kit_id: kits[0].id } : {}), ...(orgId ? { organisation_id: orgId } : {}) })); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const tw = Math.min(150, (Math.min(L.width, 580) - 80) / 2);
  return (
    <Sheet visible onClose={onClose} title="New template">
      <Field label="Template name" value={name} onChangeText={setName} maxLength={80} />
      {avail.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{avail.map((f) => <Chip key={f.family} label={f.label} active={f.family === family} onPress={() => setFamily(f.family)} />)}</View> : null}
      <T weight="800" size={13}>Pick a starting design, then change anything in the editor</T>
      <View style={{ flexDirection: 'row', gap: 14, justifyContent: 'center' }}>
        {Object.keys(starters).map((k) => (
          <Pressable key={k} disabled={busy} onPress={() => make(k)} accessibilityRole="button" accessibilityLabel={`Start from ${k}`} style={{ alignItems: 'center', gap: 6 }}>
            <PageCanvas layout={starters[k]} kit={kits[0] ?? null} width={tw} />
            <T weight="700">{k === 'modern' ? 'Modern' : 'Classic'}</T>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

export function BrandedDocuments() {
  const { toast } = useSession();
  const fam = useLoad(() => api.get('/branded-documents/families'), []);
  const orgs = useLoad(() => api.get('/organisations'), []);
  const [orgId, setOrgId] = useState(null);
  const kits = useLoad(() => api.get('/brand-kits'), []);
  const tpls = useLoad(() => api.get('/document-templates', { limit: 100 }), []);
  const [kitSheet, setKitSheet] = useState(null);
  const [starting, setStarting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [pickedKit, setPickedKit] = useState(null);
  const reload = () => { kits.reload(); tpls.reload(); };
  const run = async (fn, ok) => { try { await fn(); if (ok) toast(ok); reload(); } catch (e) { toast(e.message); } };
  const err = fam.error || kits.error || tpls.error;
  const myOrgs = (orgs.data ?? []).filter((o) => o.my_status === 'active');
  const here = (x) => (orgId ?? null) === (x.organisation_id ?? null) && (orgId ? true : !!x.owner_user_id);
  const myKits = (kits.data ?? []).filter(here);
  const myTpls = (tpls.data ?? []).filter(here);
  return (
    <Screen>
      <H1>Document designer</H1>
      <T color={c.mute} style={{ marginTop: 4 }}>Put your logo, colours and wording on the PDFs you issue. Today invoices and credit notes can be branded; other documents appear here as soon as they can be created in the app.</T>
      {err ? <ErrorBox error={err} onRetry={() => { fam.reload(); reload(); }} /> : !fam.data || !kits.data || !tpls.data ? <Loading /> : (
        <>
          {myOrgs.length ? <View style={{ marginTop: 10 }}><Seg options={[{ value: null, label: 'Me' }, ...myOrgs.map((o) => ({ value: o.id, label: o.name }))]} value={orgId} onChange={setOrgId} color={c.mint} /></View> : null}
          <Section title="Brand kits" action="New kit" onAction={() => setKitSheet({})}>
            {myKits.length ? myKits.map((k) => (
              <Card key={k.id} pad={12} onPress={() => setKitSheet(k)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 44, height: 56, borderRadius: 4, backgroundColor: '#fff', borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
                    <View style={{ height: 6, backgroundColor: k.primary_color }} />
                    <View style={{ margin: 5, gap: 3 }}><View style={{ height: 4, width: '70%', borderRadius: 2, backgroundColor: k.primary_color }} /><View style={{ height: 3, width: '45%', borderRadius: 2, backgroundColor: k.secondary_color, opacity: 0.5 }} /></View>
                  </View>
                  <View style={{ flex: 1 }}><T weight="700">{k.name}</T><T size={12} color={c.mute}>{k.display_name}{k.logo_asset_id ? ' · logo set' : ' · no logo'}</T></View>
                </View>
              </Card>
            )) : <Empty emoji="🎨" title="No brand kit yet" sub="A kit holds your logo, colours and contact details. Create one, then use it in a template." />}
          </Section>
          <Section title="Templates" action="New template" onAction={() => setStarting(true)}>
            {myTpls.length ? myTpls.map((t) => (
              <Card key={t.id} pad={12}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ flex: 1 }}><T weight="700">{t.name}</T><T size={12} color={c.mute}>{fam.data.families.find((f) => f.family === t.family)?.label ?? t.family}{t.latest_version ? ` · published v${t.latest_version}` : ' · not published'}</T></View>
                  <Tag label={t.status} color={t.status === 'published' ? c.mint : t.status === 'retired' ? c.violetSoft : c.sun} />
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  <Btn small title="Edit" color={c.violet} onPress={() => setEditing(t)} />
                  <Btn small title={t.latest_version ? 'Publish new version' : 'Publish'} color={c.mint} ink={c.ink} onPress={() => run(() => api.post(`/document-templates/${t.id}/publish`, { row_version: t.row_version }), 'Published')} />
                  {t.status !== 'retired' ? <Btn small title="Retire" color={c.paper} ink={c.red} onPress={() => run(() => api.post(`/document-templates/${t.id}/retire`), 'Template retired')} /> : null}
                </View>
              </Card>
            )) : <Empty emoji="📄" title="No templates yet" sub="Start from a classic or modern layout, preview it, then publish. Invoices pick it up from the invoice screen." />}
          </Section>
          <Section title="What can be branded" color={c.sun}>
            {fam.data.families.map((f) => <T key={f.family} size={13} color={f.source.available ? c.ink : c.mute}>{f.source.available ? '✓' : '•'} {f.label}{f.source.available ? '' : ' (coming soon)'}</T>)}
          </Section>
        </>
      )}
      {kitSheet ? <KitEditor kit={kitSheet.id ? kitSheet : null} orgId={kitSheet.organisation_id ?? orgId} onClose={() => setKitSheet(null)} onSaved={(saved) => { if (saved?.id && !kitSheet.id && editing) setPickedKit(saved.id); setKitSheet(null); reload(); }} /> : null}
      {starting ? <TemplateStart orgId={orgId} families={fam.data.families} starters={fam.data.starter_layouts} kits={myKits} onClose={() => setStarting(false)} onCreated={(t) => { setStarting(false); setEditing(t); reload(); }} /> : null}
      {editing ? <TemplateEditor key={editing.id} tpl={editing} pickedKit={pickedKit} kits={(kits.data ?? []).filter((k) => (editing.organisation_id ?? null) === (k.organisation_id ?? null))} onNewKit={() => setKitSheet({ organisation_id: editing.organisation_id ?? null })} onClose={() => { setEditing(null); setPickedKit(null); reload(); }} onPublished={() => { setEditing(null); setPickedKit(null); reload(); toast('Published. Invoices can now use it.'); }} /> : null}
    </Screen>
  );
}
