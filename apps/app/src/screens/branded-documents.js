// Document designer (issue #249): brand kits (logo, colours, contact text) and versioned PDF templates. Works for every role;
// organisation kits/templates are for the organisation's owners and admins (the server enforces it).
// Documents are generated from a canonical record (today: an invoice), never typed here.
import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { Counter } from '../pickers';
import { c } from '../theme';

const SWATCHES = ['#0F6E56', '#1D4ED8', '#7C3AED', '#BE185D', '#B45309', '#B91C1C', '#0E7490', '#444441', '#111827'];
const BLOCK_LABEL = { header: 'Header (logo and business name)', title: 'Title and number', parties: 'Seller and buyer', lines: 'Line items', totals: 'Totals', text: 'Your own text', footer: 'Footer' };
const REQUIRED = { invoice: ['title', 'parties', 'lines', 'totals'] };
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

function TemplateSheet({ tpl, orgId, kits, families, starters, onClose, onSaved }) {
  const { toast } = useSession();
  const avail = families.filter((f) => f.source.available);
  const [family, setFamily] = useState(tpl?.family ?? avail[0]?.family);
  const [name, setName] = useState(tpl?.name ?? '');
  const [kitId, setKitId] = useState(tpl?.kit_id ?? null);
  const [layout, setLayout] = useState(tpl?.draft ?? null);
  const [busy, setBusy] = useState(false);
  const fixed = REQUIRED[family] ?? [];
  const blocks = layout?.blocks ?? [];
  const usable = kits.filter((k) => (orgId ?? null) === (k.organisation_id ?? null));
  const edit = (patch) => setLayout((l) => ({ ...l, ...patch }));
  const move = (i, d) => { const b = [...blocks]; const [x] = b.splice(i, 1); b.splice(i + d, 0, x); edit({ blocks: b }); };
  const setText = (i, text) => edit({ blocks: blocks.map((b, n) => (n === i ? { ...b, text } : b)) });
  const missing = fixed.filter((t) => !blocks.some((b) => b.type === t));
  const ok = name.trim() && layout && !missing.length && blocks.every((b) => b.type !== 'text' || b.text?.trim());
  const save = async () => {
    setBusy(true);
    try {
      const saved = tpl ? await api.patch(`/document-templates/${tpl.id}`, { row_version: tpl.row_version, name: name.trim(), kit_id: kitId, layout })
        : await api.post('/document-templates', { family, name: name.trim(), kit_id: kitId ?? undefined, layout, ...(orgId ? { organisation_id: orgId } : {}) });
      onSaved(saved);
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const preview = async () => {
    try {
      const blob = await api.postBlob('/branded-documents/preview', { layout, ...(kitId ? { kit_id: kitId } : {}) });
      if (!openBlob(blob)) toast('Open the web app to preview the PDF');
    } catch (e) { toast(e.message); }
  };
  return (
    <Sheet visible onClose={onClose} title={tpl ? 'Edit template' : 'New template'}>
      <Field label="Template name" value={name} onChangeText={setName} maxLength={80} />
      {!tpl && avail.length > 1 ? <View style={{ gap: 6 }}><T weight="800" size={13}>Document</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{avail.map((f) => <Chip key={f.family} label={f.label} active={f.family === family} onPress={() => setFamily(f.family)} />)}</View></View> : null}
      {!layout ? (
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Start from</T>
          <View style={{ flexDirection: 'row', gap: 6 }}>{Object.keys(starters).map((s) => <Chip key={s} label={s === 'modern' ? 'Modern' : 'Classic'} active={false} onPress={() => setLayout(JSON.parse(JSON.stringify(starters[s])))} />)}</View>
        </View>
      ) : null}
      {layout ? (
        <>
          <View style={{ gap: 6 }}><T weight="800" size={13}>Look</T><Seg options={[{ value: 'classic', label: 'Classic' }, { value: 'modern', label: 'Modern' }]} value={layout.style} onChange={(x) => edit({ style: x })} /></View>
          <View style={{ gap: 6 }}><T weight="800" size={13}>Paper</T><Seg options={['A4', 'Letter']} value={layout.paper} onChange={(x) => edit({ paper: x })} /></View>
          <View style={{ gap: 6 }}><T weight="800" size={13}>Orientation</T><Seg options={[{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]} value={layout.orientation} onChange={(x) => edit({ orientation: x })} /></View>
          <Counter label="Page margin" value={layout.margin_mm} onChange={(x) => edit({ margin_mm: x })} min={10} max={30} suffix="mm" />
          <View style={{ gap: 6 }}>
            <T weight="800" size={13}>Brand kit</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Chip label="None" active={!kitId} onPress={() => setKitId(null)} />
              {usable.map((k) => <Chip key={k.id} label={k.name} active={k.id === kitId} onPress={() => setKitId(k.id)} />)}
            </View>
            {!usable.length ? <T size={12} color={c.mute}>Create a brand kit above to add your logo and colours.</T> : null}
          </View>
          <T weight="800" size={13}>Page layout, top to bottom</T>
          <T size={12} color={c.mute}>Amounts, numbers and names always come from the invoice itself. You choose where things sit and add your own wording.</T>
          {blocks.map((b, i) => (
            <Card key={`${b.type}${i}`} pad={10}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ flex: 1 }}><T weight="700" size={13}>{BLOCK_LABEL[b.type]}</T>{fixed.includes(b.type) ? <T size={11} color={c.mute}>Required</T> : null}</View>
                <Btn small title="↑" color={c.paper} ink={c.ink} disabled={i === 0} onPress={() => move(i, -1)} />
                <Btn small title="↓" color={c.paper} ink={c.ink} disabled={i === blocks.length - 1} onPress={() => move(i, 1)} />
                {fixed.includes(b.type) ? null : <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => edit({ blocks: blocks.filter((_, n) => n !== i) })} />}
              </View>
              {b.type === 'text' ? <View style={{ marginTop: 8 }}><Field value={b.text ?? ''} onChangeText={(x) => setText(i, x)} multiline maxLength={2000} placeholder="Plain text, e.g. payment terms" /></View> : null}
            </Card>
          ))}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {['header', 'text', 'footer'].concat(fixed).filter((t, i, a) => a.indexOf(t) === i && (t === 'text' || !blocks.some((b) => b.type === t))).map((t) => <Chip key={t} label={`+ ${BLOCK_LABEL[t].split(' (')[0]}`} active={false} onPress={() => edit({ blocks: [...blocks, t === 'text' ? { type: t, text: '' } : { type: t }] })} />)}
          </View>
          <Btn title="Preview PDF (sample data)" color={c.violet} onPress={preview} disabled={!ok} />
        </>
      ) : null}
      <Btn title="Save draft" onPress={save} loading={busy} disabled={!ok} />
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
  const [tplSheet, setTplSheet] = useState(null);
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
          <Section title="Templates" action="New template" onAction={() => setTplSheet({})}>
            {myTpls.length ? myTpls.map((t) => (
              <Card key={t.id} pad={12}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ flex: 1 }}><T weight="700">{t.name}</T><T size={12} color={c.mute}>{fam.data.families.find((f) => f.family === t.family)?.label ?? t.family}{t.latest_version ? ` · published v${t.latest_version}` : ' · not published'}</T></View>
                  <Tag label={t.status} color={t.status === 'published' ? c.mint : t.status === 'retired' ? c.violetSoft : c.sun} />
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  <Btn small title="Edit" color={c.violet} onPress={() => setTplSheet(t)} />
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
      {kitSheet ? <KitSheet kit={kitSheet.id ? kitSheet : null} orgId={orgId} onClose={() => setKitSheet(null)} onSaved={(saved) => { setKitSheet(saved?.id ? saved : null); reload(); if (saved?.id) toast('Brand kit saved'); }} /> : null}
      {tplSheet ? <TemplateSheet tpl={tplSheet.id ? tplSheet : null} orgId={tplSheet.id ? tplSheet.organisation_id : orgId} kits={kits.data ?? []} families={fam.data.families} starters={fam.data.starter_layouts} onClose={() => setTplSheet(null)} onSaved={() => { setTplSheet(null); reload(); toast('Draft saved. Publish it to use it.'); }} /> : null}
    </Screen>
  );
}
