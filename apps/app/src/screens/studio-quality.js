import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, ErrorBox, Loading, T, Tag } from '../ui';
import { c, r } from '../theme';

const CHECKS = [
  { key: 'seo_title', label: 'SEO meta title set', category: 'SEO' },
  { key: 'seo_desc', label: 'SEO meta description set', category: 'SEO' },
  { key: 'seo_slug', label: 'URL slug set', category: 'SEO' },
  { key: 'hero_block', label: 'Cinematic hero block present', category: 'Content' },
  { key: 'chapter_blocks', label: 'At least one chapter showcase block', category: 'Content' },
  { key: 'cta_block', label: 'CTA strip block present', category: 'Content' },
  { key: 'all_locales', label: 'All 12 locales have strings', category: 'i18n' },
  { key: 'reviewed_strings', label: 'All strings marked reviewed', category: 'i18n' },
  { key: 'asset_alt_text', label: 'All assets have alt text', category: 'Accessibility' },
  { key: 'cta_routes', label: 'All CTAs have valid route keys', category: 'Functionality' },
];

export function StudioQuality({ pageId }) {
  const quality = useLoad(() => api.get('/admin/landing/pages/' + pageId + '/quality'), [pageId]);

  if (quality.loading && !quality.data) return <Loading />;
  if (quality.error) return <ErrorBox error={quality.error} onRetry={quality.reload} />;

  const results = quality.data ? quality.data.checks : {};
  const passed = CHECKS.filter((c) => results[c.key]);
  const failed = CHECKS.filter((c) => !results[c.key]);
  const score = Math.round((passed.length / CHECKS.length) * 100);

  const scoreColor = score === 100 ? c.pink : score >= 70 ? c.sun : c.red;
  const categories = [...new Set(CHECKS.map((c) => c.category))];

  return (
    <View style={{ gap: 14 }}>
      <T weight="800" size={18}>Quality Gate</T>

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: scoreColor + '22', alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: scoreColor }}>
            <T weight="900" size={20} color={scoreColor}>{score + '%'}</T>
          </View>
          <View>
            <T weight="800" size={16}>{score === 100 ? 'Ready to publish' : 'Issues found'}</T>
            <T size={13} color={c.mute}>{passed.length + '/' + CHECKS.length + ' checks passed'}</T>
          </View>
        </View>
      </Card>

      {categories.map((cat) => {
        const catChecks = CHECKS.filter((ch) => ch.category === cat);
        return (
          <Card key={cat}>
            <T size={12} weight="700" color={c.mute} style={{ marginBottom: 8 }}>{cat.toUpperCase()}</T>
            {catChecks.map((ch) => {
              const ok = !!results[ch.key];
              return (
                <View key={ch.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
                  <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: ok ? c.pink : c.red, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={11} color="#fff" weight="700">{ok ? '✓' : '✗'}</T>
                  </View>
                  <T size={13} color={ok ? c.ink : c.red}>{ch.label}</T>
                </View>
              );
            })}
          </Card>
        );
      })}

      <Btn title="Re-check" onPress={quality.reload} color={c.paper} ink={c.mute} />
    </View>
  );
}
