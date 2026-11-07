// Document viewer: metadata, PDF preview, sharing and regeneration for a single issued document.
// Part of the branded documents feature (issue #249).
import React, { useCallback, useState } from 'react';
import { Alert, Linking, Platform, Pressable, ScrollView, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, ErrorBox, H1, Loading, Screen, T, Tag } from '../ui';
import { c, fam, font, r } from '../theme';
import { t } from '../i18n';

const EXPIRY_OPTIONS = [
  { label: t('documents.share.expiry_24h'), hours: 24 },
  { label: t('documents.share.expiry_72h'), hours: 72 },
  { label: t('documents.share.expiry_7d'), hours: 168 },
  { label: t('documents.share.expiry_30d'), hours: 720 },
];

const FAMILY_ABBR = (family = '') => family.replace(/_/g, ' ').split(' ').map((w) => w[0] ?? '').join('').toUpperCase().slice(0, 2);

function MetaRow({ label, value }) {
  if (!value) return null;
  const col = c(false);
  return (
    <View style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: col.line ?? '#E5EAF5' }}>
      <T style={{ width: 130, fontSize: 12, color: col.mute, fontFamily: fam.medium }}>{label}</T>
      <T style={{ flex: 1, fontSize: 12, color: col.ink }}>{value}</T>
    </View>
  );
}

function ShareRow({ share, onRevoke }) {
  const col = c(false);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: col.line ?? '#E5EAF5' }}>
      <View style={{ flex: 1 }}>
        <T style={{ fontSize: 12, color: col.ink, fontFamily: fam.medium }}>{share.shared_with_email ?? 'Open link'}</T>
        <T style={{ fontSize: 11, color: col.mute }}>{t('documents.share.expires')}: {new Date(share.expires_at).toLocaleDateString()}</T>
        <T style={{ fontSize: 11, color: col.mute }}>{share.accessed_count} accesses</T>
      </View>
      <Pressable
        onPress={() => onRevoke(share.id)}
        style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#B42318', marginLeft: 8 }}
      >
        <T style={{ fontSize: 12, color: '#B42318' }}>{t('documents.viewer.revoke')}</T>
      </Pressable>
    </View>
  );
}

export function DocumentViewer({ route, navigation }) {
  const { documentId } = route?.params ?? {};
  const col = c(false);

  const [shareExpiry, setShareExpiry] = useState(72);
  const [sharesOpen, setSharesOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const { data: meta, error: metaErr, loading: metaLoading, reload: reloadMeta } = useLoad(
    useCallback(() => api.get(`/documents/${documentId}`), [documentId])
  );
  const { data: sharesData, error: sharesErr, loading: sharesLoading, reload: reloadShares } = useLoad(
    useCallback(() => sharesOpen ? api.get(`/documents/${documentId}/shares`) : Promise.resolve({ shares: [] }), [documentId, sharesOpen])
  );

  const handleDownload = useCallback(async () => {
    const url = api.url(`/documents/${documentId}/file`);
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = url; a.download = meta?.filename ?? 'document.pdf'; a.click();
    } else {
      await Linking.openURL(url);
    }
  }, [documentId, meta]);

  const handleShare = useCallback(async () => {
    setCreating(true);
    try {
      const res = await api.post(`/documents/${documentId}/share`, { expires_in_hours: shareExpiry });
      const shareUrl = res.url ?? res.share_url;
      if (Platform.OS === 'web') {
        await navigator.clipboard?.writeText(shareUrl);
        Alert.alert(t('documents.share.created'), shareUrl);
      } else {
        await Share.share({ message: shareUrl, title: meta?.title });
      }
      reloadShares();
    } catch (e) {
      Alert.alert(t('documents.generate.error'), e.message);
    } finally {
      setCreating(false);
    }
  }, [documentId, shareExpiry, meta, reloadShares]);

  const handleRevoke = useCallback(async (shareId) => {
    try {
      await api.delete(`/documents/${documentId}/shares/${shareId}`);
      reloadShares();
    } catch (e) {
      Alert.alert(t('documents.generate.error'), e.message);
    }
  }, [documentId, reloadShares]);

  const handleRegenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      await api.post(`/documents/${documentId}/regenerate`, {});
      Alert.alert(t('documents.generate.in_progress'), 'A new version is being generated.');
      reloadMeta();
    } catch (e) {
      Alert.alert(t('documents.generate.error'), e.message);
    } finally {
      setRegenerating(false);
    }
  }, [documentId, reloadMeta]);

  const handlePreview = useCallback(async () => {
    const url = api.url(`/documents/${documentId}/file`);
    if (Platform.OS === 'web') {
      window.open(url, '_blank');
    } else {
      await Linking.openURL(url);
    }
  }, [documentId]);

  if (metaLoading) return <Screen><Loading /></Screen>;
  if (metaErr) return <Screen><ErrorBox error={metaErr} /></Screen>;

  const doc = meta;
  const abbr = FAMILY_ABBR(doc?.family);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: r(16) }}>
        {/* Title row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: r(16) }}>
          <View style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: col.pink, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
            <T style={{ color: '#FFF', fontFamily: fam.bold, fontSize: 15 }}>{abbr}</T>
          </View>
          <View style={{ flex: 1 }}>
            <H1 style={{ fontSize: 18, marginBottom: 2 }}>{doc?.title ?? doc?.family}</H1>
            <T style={{ color: col.mute, fontSize: 12 }}>{doc?.family?.replace(/_/g, ' ')}</T>
          </View>
        </View>

        {/* Action buttons */}
        <View style={{ flexDirection: 'row', gap: r(8), marginBottom: r(16) }}>
          <Btn label={t('documents.viewer.download')} onPress={handleDownload} style={{ flex: 1 }} />
          <Btn label={t('documents.viewer.share')} onPress={() => setSharesOpen(!sharesOpen)} variant="secondary" style={{ flex: 1 }} />
          <Btn label={t('documents.viewer.regenerate')} onPress={handleRegenerate} loading={regenerating} variant="secondary" style={{ flex: 1 }} />
        </View>

        {/* PDF preview button */}
        <Btn
          label={t('documents.viewer.pdf_preview')}
          onPress={handlePreview}
          variant="outline"
          style={{ marginBottom: r(16) }}
        />

        {/* Metadata */}
        <Card style={{ marginBottom: r(16) }}>
          <T style={{ fontFamily: fam.bold, fontSize: 13, color: col.pink, marginBottom: 8 }}>{t('documents.viewer.metadata')}</T>
          <MetaRow label="Family" value={doc?.family?.replace(/_/g, ' ')} />
          <MetaRow label="Source" value={doc?.source_type} />
          <MetaRow label={t('documents.viewer.template_version')} value={doc?.template_version_id?.slice(0, 8)} />
          <MetaRow label={t('documents.viewer.brand_kit')} value={doc?.brand_kit_name} />
          <MetaRow label="Created" value={doc?.created_at ? new Date(doc.created_at).toLocaleString() : null} />
          <MetaRow label={t('documents.viewer.pages')} value={doc?.pages} />
          <MetaRow label={t('documents.viewer.checksum')} value={doc?.checksum ? doc.checksum.slice(0, 20) + '…' : null} />
          <MetaRow label="Status" value={doc?.status} />
        </Card>

        {/* Share section */}
        {sharesOpen && (
          <Card style={{ marginBottom: r(16) }}>
            <T style={{ fontFamily: fam.bold, fontSize: 13, color: col.pink, marginBottom: 8 }}>{t('documents.viewer.active_shares')}</T>

            {/* Expiry selector */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {EXPIRY_OPTIONS.map((o) => (
                <Pressable
                  key={o.hours}
                  onPress={() => setShareExpiry(o.hours)}
                  style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, borderWidth: 1, borderColor: shareExpiry === o.hours ? col.pink : col.mute, backgroundColor: shareExpiry === o.hours ? col.pink : 'transparent' }}
                >
                  <T style={{ fontSize: 12, color: shareExpiry === o.hours ? '#FFF' : col.ink }}>{o.label}</T>
                </Pressable>
              ))}
            </View>

            <Btn
              label={t('documents.viewer.create_link')}
              onPress={handleShare}
              loading={creating}
              style={{ marginBottom: 12 }}
            />

            {sharesLoading && <Loading />}
            {sharesErr && <ErrorBox error={sharesErr} />}
            {!sharesLoading && !sharesErr && (sharesData?.shares ?? []).length === 0 && (
              <T style={{ color: col.mute, fontSize: 12, textAlign: 'center', paddingVertical: 8 }}>{t('documents.viewer.no_shares')}</T>
            )}
            {(sharesData?.shares ?? []).map((s) => (
              <ShareRow key={s.id} share={s} onRevoke={handleRevoke} />
            ))}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

export default DocumentViewer;
