import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { c, r } from '../theme';
import { FormSheet } from '../FormSheet';

const STATUS_COLORS = { draft: c.sun, review: c.cyan, approved: c.mint, published: c.pink, archived: c.mute };

export function StudioPages({ onSelect }) {
  const pages = useLoad(() => api.get('/admin/landing/pages'), []);
  const [creating, setCreating] = useState(false);

  if (pages.loading && !pages.data) return <Loading />;
  if (pages.error) return <ErrorBox error={pages.error} onRetry={pages.reload} />;

  const list = pages.data?.pages ?? [];

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <T weight="800" size={18}>Page Inventory</T>
        <Btn small title="+ New page" onPress={() => setCreating(true)} />
      </View>

      {list.length === 0
        ? <Empty emoji="📄" title="No pages yet" sub="Create your first landing page to get started." />
        : list.map((p) => (
          <Row key={p.id} onPress={() => onSelect(p.id)}
            title={p.title}
            sub={`/${p.slug} · v${p.latest_version ?? 0} · ${new Date(p.updated_at).toLocaleDateString()}`}
            right={<Tag label={p.status} color={STATUS_COLORS[p.status] ?? c.violetSoft} />}
          />
        ))}

      <FormSheet visible={creating} onClose={() => setCreating(false)} title="New page"
        submitLabel="Create"
        fields={[
          { key: 'title', label: 'Title', placeholder: 'e.g. Home' },
          { key: 'slug', label: 'Slug', placeholder: 'e.g. home', hint: 'URL-safe, lowercase, no spaces' },
        ]}
        onSubmit={async (v) => {
          await api.post('/admin/landing/pages', v);
          pages.reload();
          return 'Page created';
        }}
      />
    </View>
  );
}
