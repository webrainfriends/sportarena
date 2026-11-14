import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { ErrorBox, Loading, T } from '../ui';
import { c, r } from '../theme';
import { ShowcaseLanding } from './landing-showcase';

export function StudioPreview({ pageId }) {
  const preview = useLoad(() => api.get('/admin/landing/pages/' + pageId + '/preview'), [pageId]);

  if (preview.loading && !preview.data) return <Loading />;
  if (preview.error) return <ErrorBox error={preview.error} onRetry={preview.reload} />;

  return (
    <View style={{ gap: 0 }}>
      <View style={{ backgroundColor: c.sun, paddingVertical: 10, paddingHorizontal: 16, borderRadius: r.card, marginBottom: 12 }}>
        <T weight="700" size={12} color="#fff">PREVIEW MODE — This is a live preview of your unpublished changes. CTAs are disabled.</T>
      </View>
      <ShowcaseLanding manifest={preview.data} onNavigate={() => {}} previewMode />
    </View>
  );
}
