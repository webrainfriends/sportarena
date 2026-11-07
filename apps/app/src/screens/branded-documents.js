// Document designer (issue #249): brand kits (logo, colours, contact text), versioned PDF templates, and issued document library.
// Works for every role; organisation kits/templates are for the organisation's owners and admins (the server enforces it).
// Documents are generated from a canonical record (invoice, booking, coaching plan, etc.), never typed here.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { useLayout } from '../layout';
import { PageCanvas, TemplateEditor } from './doc-editor';
import { KitEditor } from './brand-kit-editor';
import { DocumentLibrary } from './document-library';
import { c } from '../theme';
import { t } from '../i18n';

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

const TABS = [
  { value: 'documents', label: t('documents.hub.my_documents') },
  { value: 'templates', label: t('documents.hub.templates') },
  { value: 'kits', label: t('documents.hub.brand_kits') },
];

export function BrandedDocuments({ navigation }) {
  const { toast } = useSession();
  const [tab, setTab] = useState('documents');
  const famData = useLoad(() => api.get('/branded-documents/families'), []);
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
  const myOrgs = (orgs.data ?? []).filter((o) => o.my_status === 'active');
  const here = (x) => (orgId ?? null) === (x.organisation_id ?? null) && (orgId ? true : !!x.owner_user_id);
  const myKits = (kits.data ?? []).filter(here);
  const myTpls = (tpls.data ?? []).filter(here);
  return (
    <Screen>
      <H1>{t('documents.hub.title')}</H1>
      <T color={c.mute} style={{ marginTop: 4, marginBottom: 12 }}>{t('documents.hub.subtitle')}</T>
      <View style={{ marginBottom: 14 }}>
        <Seg options={TABS} value={tab} onChange={setTab} color={c.pink} />
      </View>

      {tab === 'documents' ? (
        <DocumentLibrary navigation={navigation} embedded />
      ) : tab === 'kits' ? (
        <>
          {kits.error ? <ErrorBox error={kits.error} onRetry={kits.reload} /> : !kits.data ? <Loading /> : (
            <>
              {myOrgs.length ? <View style={{ marginBottom: 10 }}><Seg options={[{ value: null, label: 'Me' }, ...myOrgs.map((o) => ({ value: o.id, label: o.name }))]} value={orgId} onChange={setOrgId} color={c.mint} /></View> : null}
              <Section title={t('documents.hub.brand_kits')} action={t('documents.brand_kit.new')} onAction={() => setKitSheet({})}>
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
                )) : <Empty emoji="🎨" title={t('documents.brand_kit.empty_title')} sub={t('documents.brand_kit.empty_sub')} />}
              </Section>
            </>
          )}
        </>
      ) : (
        <>
          {famData.error || tpls.error ? <ErrorBox error={famData.error || tpls.error} onRetry={() => { famData.reload(); reload(); }} /> : !famData.data || !tpls.data ? <Loading /> : (
            <>
              {myOrgs.length ? <View style={{ marginBottom: 10 }}><Seg options={[{ value: null, label: 'Me' }, ...myOrgs.map((o) => ({ value: o.id, label: o.name }))]} value={orgId} onChange={setOrgId} color={c.mint} /></View> : null}
              <Section title={t('documents.hub.templates')} action={t('documents.templates.create')} onAction={() => setStarting(true)}>
                {myTpls.length ? myTpls.map((tpl) => (
                  <Card key={tpl.id} pad={12}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{ flex: 1 }}><T weight="700">{tpl.name}</T><T size={12} color={c.mute}>{famData.data.families.find((f) => f.family === tpl.family)?.label ?? tpl.family}{tpl.latest_version ? ` · published v${tpl.latest_version}` : ' · not published'}</T></View>
                      <Tag label={tpl.status} color={tpl.status === 'published' ? c.mint : tpl.status === 'retired' ? c.violetSoft : c.sun} />
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                      <Btn small title={t('documents.templates.edit')} color={c.violet} onPress={() => setEditing(tpl)} />
                      <Btn small title={tpl.latest_version ? t('documents.templates.publish_new') : t('documents.templates.publish')} color={c.mint} ink={c.ink} onPress={() => run(() => api.post(`/document-templates/${tpl.id}/publish`, { row_version: tpl.row_version }), t('documents.templates.published_ok'))} />
                      {tpl.status !== 'retired' ? <Btn small title={t('documents.templates.retire')} color={c.paper} ink={c.red} onPress={() => run(() => api.post(`/document-templates/${tpl.id}/retire`), t('documents.templates.retired_ok'))} /> : null}
                    </View>
                  </Card>
                )) : <Empty emoji="📄" title={t('documents.templates.empty_title')} sub={t('documents.templates.empty_sub')} />}
              </Section>
              <Section title={t('documents.hub.what_can_be_branded')} color={c.sun}>
                {famData.data.families.map((f) => <T key={f.family} size={13} color={f.source.available ? c.ink : c.mute}>{f.source.available ? '✓' : '•'} {f.label}{f.source.available ? '' : ` (${t('documents.families.coming_soon')})`}</T>)}
              </Section>
            </>
          )}
        </>
      )}

      {kitSheet ? <KitEditor kit={kitSheet.id ? kitSheet : null} orgId={kitSheet.organisation_id ?? orgId} onClose={() => setKitSheet(null)} onSaved={(saved) => { if (saved?.id && !kitSheet.id && editing) setPickedKit(saved.id); setKitSheet(null); reload(); }} /> : null}
      {starting && famData.data ? <TemplateStart orgId={orgId} families={famData.data.families} starters={famData.data.starter_layouts} kits={myKits} onClose={() => setStarting(false)} onCreated={(tpl) => { setStarting(false); setEditing(tpl); reload(); }} /> : null}
      {editing ? <TemplateEditor key={editing.id} tpl={editing} pickedKit={pickedKit} kits={(kits.data ?? []).filter((k) => (editing.organisation_id ?? null) === (k.organisation_id ?? null))} onNewKit={() => setKitSheet({ organisation_id: editing.organisation_id ?? null })} onClose={() => { setEditing(null); setPickedKit(null); reload(); }} onPublished={() => { setEditing(null); setPickedKit(null); reload(); toast(t('documents.templates.published_ok')); }} /> : null}
    </Screen>
  );
}
