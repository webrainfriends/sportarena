// Brand kit editor (issue #249): a live letterhead preview beside / above grouped fields. The logo can be chosen before the first save
// (it is uploaded right after the kit is created). Kits are never deleted, only archived.
import React, { useEffect, useRef, useState } from 'react';
import { Image, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { Btn, Chip, Field, T } from '../ui';
import { c } from '../theme';
import { BlockPreview, useLogo } from './doc-editor';

const SWATCHES = ['#A8628F', '#047857', '#1D4ED8', '#0E7490', '#26415E', '#BE185D', '#B91C1C', '#B45309', '#444441', '#111827'];
const hexOk = (v) => /^#[0-9A-Fa-f]{6}$/.test(v ?? '');
const luma = (h) => { const n = parseInt(h.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
const PREVIEW_LAYOUT = { style: 'classic', paper: 'A4', orientation: 'portrait', margin_mm: 18 };

/** Choose a PNG/JPEG. Resolves to { blob, uri } (uri is for showing it before it is uploaded) or null. */
export function pickLogo() {
  if (Platform.OS !== 'web') return import('expo-image-picker').then(async (P) => {
    const r = await P.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    return r.canceled || !r.assets?.[0] ? null : { blob: await (await fetch(r.assets[0].uri)).blob(), uri: r.assets[0].uri };
  });
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png,image/jpeg';
    input.onchange = () => { const f = input.files?.[0]; resolve(f ? { blob: f, uri: URL.createObjectURL(f) } : null); };
    input.click();
  });
}

const Card = ({ title, help, children }) => (
  <View style={{ backgroundColor: c.paper, borderRadius: 18, borderWidth: 1, borderColor: c.line, padding: 14, gap: 10 }}>
    <View><T weight="800">{title}</T>{help ? <T size={12} color={c.mute}>{help}</T> : null}</View>
    {children}
  </View>
);

function Swatches({ label, value, onChange }) {
  const [custom, setCustom] = useState(false);
  const preset = SWATCHES.some((x) => x.toUpperCase() === (value ?? '').toUpperCase());
  return (
    <View style={{ gap: 8 }}>
      <T weight="700" size={13}>{label}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {SWATCHES.map((s) => {
          const on = s.toUpperCase() === (value ?? '').toUpperCase();
          return (
            <Pressable key={s} accessibilityRole="button" accessibilityLabel={`${label} ${s}`} onPress={() => { setCustom(false); onChange(s); }} style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: s, alignItems: 'center', justifyContent: 'center', borderWidth: on ? 3 : 1, borderColor: on ? c.ink : c.line }}>
              {on ? <T size={16} color="#fff" weight="800">✓</T> : null}
            </Pressable>
          );
        })}
        <Chip label="Custom" active={custom || !preset} onPress={() => setCustom(true)} />
      </View>
      {custom || !preset ? <Field value={value} onChangeText={(x) => onChange(x.startsWith('#') ? x : `#${x}`)} placeholder="#RRGGBB" maxLength={7} hint={hexOk(value) ? undefined : 'Six characters, like #A8628F'} /> : null}
    </View>
  );
}

function Letterhead({ v, logo, width }) {
  const accent = hexOk(v.primary_color) ? v.primary_color : '#A8628F', ink = hexOk(v.secondary_color) ? v.secondary_color : '#444441';
  const pt = (width / 210) * (25.4 / 72);
  const kit = { display_name: v.display_name?.trim() || null, address: v.address?.trim(), contact_email: v.contact_email?.trim(), footer_text: v.footer_text?.trim() };
  const shown = kit.display_name ? kit : null;
  return (
    <View style={{ width, backgroundColor: '#fff', borderRadius: 4, padding: width * 0.08, gap: 10, shadowColor: '#0F172A', shadowOpacity: 0.16, shadowRadius: 10, elevation: 3, ...(Platform.OS === 'web' ? { boxShadow: '0 6px 24px rgba(15,23,42,0.16)' } : {}) }}>
      <BlockPreview b={{ type: 'header' }} kit={shown} logo={logo} pt={pt} accent={accent} ink={ink} layout={PREVIEW_LAYOUT} />
      <View style={{ height: 22 }} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        {kit.footer_text ? <T size={Math.max(4, pt * 8)} color={ink} numberOfLines={1} style={{ flex: 1 }}>{kit.footer_text}</T> : <View style={{ width: '40%', height: Math.max(3, pt * 5), borderRadius: 2, backgroundColor: '#E3E5EA' }} />}
        <T size={Math.max(4, pt * 8)} color={ink}>Page 1 of 1</T>
      </View>
    </View>
  );
}

/** Full-screen brand kit editor. `kit` null = new kit. onSaved(saved?) always closes the editor (saved is the kit, or undefined after archiving). */
export function KitEditor({ kit, orgId, onClose, onSaved }) {
  const { toast } = useSession();
  const L = useLayout();
  const ins = useSafeAreaInsets();
  const wide = L.width >= 900;
  const [v, setV] = useState(() => ({ name: '', display_name: '', legal_name: '', address: '', contact_email: '', phone: '', website: '', tax_id: '', footer_text: '', primary_color: '#A8628F', secondary_color: '#444441', ...Object.fromEntries(Object.entries(kit ?? {}).map(([k, x]) => [k, x ?? ''])) }));
  const [nameTouched, setNameTouched] = useState(!!kit);
  const [pending, setPending] = useState(null); // { blob, uri }
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(!!(kit && (kit.legal_name || kit.phone || kit.website || kit.tax_id)));
  const logo = useLogo(kit, pending?.uri);
  const set = (k) => (x) => setV((p) => ({ ...p, [k]: x, ...(k === 'display_name' && !nameTouched ? { name: x } : {}) }));
  const ok = v.name.trim() && v.display_name.trim() && hexOk(v.primary_color) && hexOk(v.secondary_color);
  const uriRef = useRef(null);
  useEffect(() => { uriRef.current = pending?.uri; }, [pending]);
  useEffect(() => () => { if (Platform.OS === 'web' && uriRef.current?.startsWith('blob:')) URL.revokeObjectURL(uriRef.current); }, []);

  const save = async () => {
    setBusy(true);
    try {
      const text = ['legal_name', 'address', 'contact_email', 'phone', 'website', 'tax_id', 'footer_text'];
      const body = { name: v.name.trim(), display_name: v.display_name.trim(), primary_color: v.primary_color, secondary_color: v.secondary_color, ...Object.fromEntries(text.map((k) => [k, (v[k] ?? '').trim() || null])) };
      let saved = kit ? await api.patch(`/brand-kits/${kit.id}`, { ...body, row_version: kit.row_version }) : await api.post('/brand-kits', { ...body, ...(orgId ? { organisation_id: orgId } : {}) });
      if (pending) {
        try { const r = await api.upload(`/brand-kits/${saved.id}/logo`, pending.blob); toast(r.warnings?.[0] ?? 'Brand kit saved with logo'); }
        catch (e) { toast(`Kit saved, but the logo was not: ${e.message}`); }
      } else toast('Brand kit saved');
      onSaved(saved);
    } catch (e) { toast(e.status === 409 ? 'Someone else changed this kit: close and reopen it' : e.message); } finally { setBusy(false); }
  };
  const archive = async () => {
    try { await api.patch(`/brand-kits/${kit.id}`, { row_version: kit.row_version, archived: true }); toast('Brand kit archived'); onSaved(); }
    catch (e) { toast(e.message); }
  };
  const choose = async () => { try { const f = await pickLogo(); if (f) setPending(f); } catch (e) { toast(e.message); } };

  const form = (
    <View style={{ gap: 12 }}>
      <Card title="Logo" help="PNG or JPEG, up to 2 MB. 500 px or wider prints sharply.">
        <Pressable accessibilityRole="button" accessibilityLabel="Choose logo" onPress={choose} style={{ height: 110, borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.violet, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center', gap: 4, overflow: 'hidden' }}>
          {logo ? <Image source={logo} resizeMode="contain" style={{ width: '70%', height: 80 }} /> : <T size={26}>🖼️</T>}
          <T size={12} weight="700" color={c.violet}>{logo ? 'Replace logo' : 'Add your logo'}</T>
        </Pressable>
        {pending && !kit ? <T size={12} color={c.mute}>It will be uploaded when you save.</T> : null}
      </Card>
      <Card title="Name" help="What appears at the top of your documents.">
        <Field label="Name shown on documents" value={v.display_name} onChangeText={set('display_name')} maxLength={120} />
        <Field label="Kit name (just for you)" value={v.name} onChangeText={(x) => { setNameTouched(true); setV((p) => ({ ...p, name: x })); }} maxLength={80} />
      </Card>
      <Card title="Colours" help="Used for the title, table header and lines.">
        <Swatches label="Main colour" value={v.primary_color} onChange={set('primary_color')} />
        {hexOk(v.primary_color) && luma(v.primary_color) > 0.65 ? <T size={12} color={c.red}>This colour is light: the white table heading text will be hard to read.</T> : null}
        <Swatches label="Text colour" value={v.secondary_color} onChange={set('secondary_color')} />
      </Card>
      <Card title="Contact" help="Shown under your name. All optional.">
        <Field label="Address" value={v.address} onChangeText={set('address')} maxLength={400} multiline />
        <Field label="Email" value={v.contact_email} onChangeText={set('contact_email')} maxLength={200} keyboardType="email-address" />
        {more ? (
          <>
            <Field label="Phone" value={v.phone} onChangeText={set('phone')} maxLength={40} keyboardType="phone-pad" />
            <Field label="Website" value={v.website} onChangeText={set('website')} maxLength={200} keyboardType="url" />
            <Field label="Legal name" value={v.legal_name} onChangeText={set('legal_name')} maxLength={200} />
            <Field label="Tax / registration number" value={v.tax_id} onChangeText={set('tax_id')} maxLength={60} />
          </>
        ) : <Chip label="+ Phone, website, legal name, tax number" active={false} onPress={() => setMore(true)} />}
      </Card>
      <Card title="Footer" help="One line at the bottom of every page.">
        <Field value={v.footer_text} onChangeText={set('footer_text')} maxLength={300} placeholder="e.g. Thank you for your business" hint={`${(v.footer_text ?? '').length}/300`} />
      </Card>
      {kit ? <Btn title="Archive this kit" color={c.paper} ink={c.red} onPress={archive} style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  );
  const pw = wide ? 380 : Math.min(L.width - 32, 340);
  const preview = <View style={{ alignItems: 'center' }}><Letterhead v={v} logo={logo} width={pw} /></View>;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#EEF0F4' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.paper, borderBottomWidth: 1, borderColor: c.line, paddingTop: ins.top + 8, paddingBottom: 8, paddingHorizontal: 12 }}>
          <Btn small title="‹ Back" color={c.paper} ink={c.ink} onPress={onClose} />
          <T weight="800" size={16} style={{ flex: 1 }}>{kit ? 'Edit brand kit' : 'New brand kit'}</T>
          <Btn small title="Save" onPress={save} loading={busy} disabled={!ok} color={c.mint} ink={c.ink} />
        </View>
        {wide ? (
          <View style={{ flex: 1, flexDirection: 'row' }}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, maxWidth: 640, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">{form}</ScrollView>
            <View style={{ width: 440, flexGrow: 0, flexShrink: 0, padding: 20, borderLeftWidth: 1, borderColor: c.line, backgroundColor: '#EEF0F4' }}>{preview}<T size={12} color={c.mute} style={{ textAlign: 'center', marginTop: 12 }}>Live preview of your letterhead</T></View>
          </View>
        ) : (
          <>
            <View style={{ paddingVertical: 12, backgroundColor: '#EEF0F4', borderBottomWidth: 1, borderColor: c.line }}>{preview}</View>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 + ins.bottom }} keyboardShouldPersistTaps="handled">{form}</ScrollView>
          </>
        )}
      </View>
    </Modal>
  );
}
