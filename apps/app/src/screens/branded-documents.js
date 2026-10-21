// Document designer (issue #249): brand kits (logo, colours, contact text) and versioned PDF templates. Works for every role;
// organisation kits/templates are for the organisation's owners and admins (the server enforces it).
// Documents are generated from a canonical record (today: an invoice), never typed here.
import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { useLayout } from '../layout';
import { PageCanvas, TemplateEditor } from './doc-editor';
import { c } from '../theme';

const SWATCHES = ['#0F6E56', '#1D4ED8', '#7C3AED', '#BE185D', '#B45309', '#B91C1C', '#0E7490', '#444441', '#111827'];
const hex = (v) => /^#[0-9A-Fa-f]{6}$/.test(v ?? '');

function openBlob(blob) {
  if (Platform.OS !== 'web') return false;
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return true;
}

function pickLogo() {
  if (Platform.OS !== 'web') return import('expo-image-picker').then(async (P) => {
    const r = await P.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    return r.canceled || !r.assets?.[0] ? null : (await fetch(r.assets[0].uri)).blob();
  });
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png,image/jpeg';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function Colour({ label, value, onChange }) {
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{label}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {SWATCHES.map((s) => (
          <Pressable key={s} accessibilityRole="button" accessibilityLabel={`${label} ${s}`} onPress={() => onChange(s)} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: s, borderWidth: value?.toUpperCase() === s.toUpperCase() ? 3 : 1, borderColor: value?.toUpperCase() === s.toUpperCase() ? c.ink : c.line }} />
        ))}
      </View>
      <Field value={value} onChangeText={onChange} placeholder="#RRGGBB" maxLength={7} hint={hex(value) ? undefined : 'Pick a swatch or type a colour like #0F6E56'} />
    </View>
  );
}

const KIT_TEXT = [['display_name', 'Name shown on documents', 120], ['legal_name', 'Legal name (optional)', 200], ['address', 'Address (optional)', 400], ['contact_email', 'Contact email (optional)', 200], ['phone', 'Phone (optional)', 40], ['website', 'Website (optional)', 200], ['tax_id', 'Tax / registration number (optional)', 60], ['footer_text', 'Footer line (optional)', 300]];

function KitSheet({ kit, orgId, onClose, onSaved }) {
  const { toast } = useSession();
  const [v, setV] = useState(() => ({ name: '', display_name: '', primary_color: '#0F6E56', secondary_color: '#444441', ...(kit ?? {}) }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (x) => setV((p) => ({ ...p, [k]: x }));
  const ok = v.name.trim() && v.display_name.trim() && hex(v.primary_color) && hex(v.secondary_color);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: v.name.trim(), display_name: v.display_name.trim(), primary_color: v.primary_color, secondary_color: v.secondary_color, ...Object.fromEntries(KIT_TEXT.slice(1).map(([k]) => [k, (v[k] ?? '').trim() || null])) };
      const saved = kit ? await api.patch(`/brand-kits/${kit.id}`, { ...body, row_version: kit.row_version }) : await api.post('/brand-kits', { ...body, ...(orgId ? { organisation_id: orgId } : {}) });
      onSaved(saved);
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const logo = async () => {
    try {
      const blob = await pickLogo();
      if (!blob) return;
      const r = await api.upload(`/brand-kits/${kit.id}/logo`, blob);
      toast(r.warnings?.[0] ?? 'Logo saved');
      onSaved();
    } catch (e) { toast(e.message); }
  };
  return (
    <Sheet visible onClose={onClose} title={kit ? 'Edit brand kit' : 'New brand kit'}>
      <Field label="Kit name (for you)" value={v.name} onChangeText={set('name')} maxLength={80} />
      {KIT_TEXT.map(([k, label, max]) => <Field key={k} label={label} value={v[k] ?? ''} onChangeText={set(k)} maxLength={max} multiline={k === 'address'} keyboardType={k === 'contact_email' ? 'email-address' : k === 'phone' ? 'phone-pad' : k === 'website' ? 'url' : undefined} />)}
      <Colour label="Main colour" value={v.primary_color} onChange={set('primary_color')} />
      <Colour label="Second colour" value={v.secondary_color} onChange={set('secondary_color')} />
      {kit ? <View style={{ gap: 6 }}>
        <T weight="800" size={13}>Logo</T>
        <T size={12} color={c.mute}>PNG or JPEG, up to 2 MB, 32–4000 px on each side (500 px or more prints sharply). {kit.logo_asset_id ? 'A logo is set; choosing another replaces it for new documents.' : 'No logo yet.'}</T>
        <Btn small title={kit.logo_asset_id ? 'Replace logo' : 'Upload logo'} color={c.violet} onPress={logo} style={{ alignSelf: 'flex-start' }} />
      </View> : <T size={12} color={c.mute}>Save the kit first, then add its logo.</T>}
      <Btn title="Save brand kit" onPress={save} loading={busy} disabled={!ok} />
      {kit ? <Btn title="Archive this kit" color={c.paper} ink={c.red} onPress={async () => { try { await api.patch(`/brand-kits/${kit.id}`, { row_version: kit.row_version, archived: true }); onSaved(); } catch (e) { toast(e.message); } }} /> : null}
    </Sheet>
  );
}

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
                  <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: k.primary_color }} />
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
      {kitSheet ? <KitSheet kit={kitSheet.id ? kitSheet : null} orgId={kitSheet.organisation_id ?? orgId} onClose={() => setKitSheet(null)} onSaved={(saved) => { if (saved?.id && !kitSheet.id && editing) setPickedKit(saved.id); setKitSheet(saved?.id ? saved : null); reload(); if (saved?.id) toast('Brand kit saved'); }} /> : null}
      {starting ? <TemplateStart orgId={orgId} families={fam.data.families} starters={fam.data.starter_layouts} kits={myKits} onClose={() => setStarting(false)} onCreated={(t) => { setStarting(false); setEditing(t); reload(); }} /> : null}
      {editing ? <TemplateEditor key={editing.id} tpl={editing} pickedKit={pickedKit} kits={(kits.data ?? []).filter((k) => (editing.organisation_id ?? null) === (k.organisation_id ?? null))} onNewKit={() => setKitSheet({ organisation_id: editing.organisation_id ?? null })} onClose={() => { setEditing(null); setPickedKit(null); reload(); }} onPublished={() => { setEditing(null); setPickedKit(null); reload(); toast('Published. Invoices can now use it.'); }} /> : null}
    </Screen>
  );
}
