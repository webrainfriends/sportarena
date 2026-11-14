import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { c } from '../theme';
import { FormSheet } from '../FormSheet';

const STATUS_COLORS = { draft: c.sun, published: c.pink, archived: c.mute };

export function StudioNews({ pageId }) {
  const [status, setStatus] = useState('draft');
  const news = useLoad(() => api.get('/admin/landing/pages/' + pageId + '/news', { status }), [pageId, status]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);

  if (news.loading && !news.data) return <Loading />;
  if (news.error) return <ErrorBox error={news.error} onRetry={news.reload} />;

  const list = news.data ? news.data.items : [];

  const publish = async (id) => {
    try { await api.post('/admin/landing/news/' + id + '/publish'); news.reload(); } catch (e) { /* silent */ }
  };
  const archive = async (id) => {
    try { await api.post('/admin/landing/news/' + id + '/archive'); news.reload(); } catch (e) { /* silent */ }
  };

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <T weight="800" size={18}>Editorial News</T>
        <Btn small title="+ New story" onPress={() => setCreating(true)} />
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        {['draft', 'published', 'archived'].map((s) => (
          <Btn key={s} small title={s} color={status === s ? c.pink : c.paper} ink={status === s ? '#fff' : c.mute} onPress={() => setStatus(s)} />
        ))}
      </View>

      {list.length === 0
        ? <Empty emoji="📰" title="No stories" sub={'No ' + status + ' stories.'} />
        : list.map((item) => (
          <Card key={item.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <T weight="700" size={14}>{item.headline}</T>
                {item.deck ? <T size={12} color={c.mute}>{item.deck}</T> : null}
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
                  <Tag label={item.category} color={c.cyanSoft} />
                  {item.published_at && <Tag label={new Date(item.published_at).toLocaleDateString()} color={c.violetSoft} />}
                </View>
              </View>
              <Tag label={item.status} color={STATUS_COLORS[item.status] || c.violetSoft} />
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setEditing(item)} />
              {item.status === 'draft' && <Btn small title="Publish" onPress={() => publish(item.id)} />}
              {item.status !== 'archived' && <Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => archive(item.id)} />}
            </View>
          </Card>
        ))}

      <FormSheet visible={creating} onClose={() => setCreating(false)} title="New story"
        submitLabel="Create"
        fields={[
          { key: 'headline', label: 'Headline' },
          { key: 'deck', label: 'Deck / sub-headline', optional: true },
          { key: 'category', label: 'Category', placeholder: 'e.g. football, results, analysis' },
          { key: 'body_md', label: 'Body (Markdown)', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          await api.post('/admin/landing/pages/' + pageId + '/news', v);
          news.reload();
          return 'Story created';
        }}
      />

      <FormSheet visible={!!editing} onClose={() => setEditing(null)} title="Edit story"
        submitLabel="Save"
        initial={editing ? { headline: editing.headline, deck: editing.deck || '', category: editing.category, body_md: editing.body_md || '' } : {}}
        fields={[
          { key: 'headline', label: 'Headline' },
          { key: 'deck', label: 'Deck / sub-headline', optional: true },
          { key: 'category', label: 'Category' },
          { key: 'body_md', label: 'Body (Markdown)', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          await api.patch('/admin/landing/news/' + editing.id, v);
          news.reload();
          setEditing(null);
          return 'Story updated';
        }}
      />
    </View>
  );
}
