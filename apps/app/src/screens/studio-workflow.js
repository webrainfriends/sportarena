import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, ErrorBox, Loading, T, Tag } from '../ui';
import { c, r } from '../theme';

const STATUS_COLORS = { draft: c.sun, review: c.violet, approved: c.pink, published: c.cyanSoft, archived: c.mute };
const STATUS_ORDER = ['draft', 'review', 'approved', 'published', 'archived'];

export function StudioWorkflow({ pageId }) {
  const page = useLoad(() => api.get('/admin/landing/pages/' + pageId), [pageId]);
  const versions = useLoad(() => api.get('/admin/landing/pages/' + pageId + '/versions'), [pageId]);
  const [acting, setActing] = useState(null);
  const [error, setError] = useState(null);

  if (page.loading && !page.data) return <Loading />;
  if (page.error) return <ErrorBox error={page.error} onRetry={page.reload} />;

  const p = page.data || {};
  const vList = versions.data ? versions.data.versions : [];

  const transition = async (action, endpoint) => {
    setActing(action);
    setError(null);
    try {
      await api.post('/admin/landing/pages/' + pageId + '/' + endpoint);
      page.reload();
      versions.reload();
    } catch (e) {
      setError(e.message || 'Action failed');
    } finally {
      setActing(null);
    }
  };

  const curIdx = STATUS_ORDER.indexOf(p.status);

  return (
    <View style={{ gap: 14 }}>
      <T weight="800" size={18}>Publish Workflow</T>

      <Card>
        <T size={11} color={c.mute} weight="700" style={{ marginBottom: 8 }}>CURRENT STATUS</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Tag label={p.status || 'draft'} color={STATUS_COLORS[p.status] || c.sun} />
          {p.published_at && <T size={12} color={c.mute}>{'Published ' + new Date(p.published_at).toLocaleDateString()}</T>}
        </View>
      </Card>

      <Card>
        <T size={11} color={c.mute} weight="700" style={{ marginBottom: 10 }}>STATUS PIPELINE</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {STATUS_ORDER.map((s, i) => (
            <React.Fragment key={s}>
              <View style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: r.pill, backgroundColor: i <= curIdx ? c.pink : c.line }}>
                <T size={11} weight="700" color={i <= curIdx ? '#fff' : c.mute}>{s}</T>
              </View>
              {i < STATUS_ORDER.length - 1 && <T size={12} color={c.mute}>{'→'}</T>}
            </React.Fragment>
          ))}
        </View>
      </Card>

      <Card>
        <T size={11} color={c.mute} weight="700" style={{ marginBottom: 10 }}>ACTIONS</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {p.status === 'draft' && (
            <Btn title="Submit for review" loading={acting === 'review'} onPress={() => transition('review', 'submit-review')} />
          )}
          {p.status === 'review' && (
            <>
              <Btn title="Approve" loading={acting === 'approve'} onPress={() => transition('approve', 'approve')} />
              <Btn title="Return to draft" color={c.paper} ink={c.mute} loading={acting === 'draft'} onPress={() => transition('draft', 'return-draft')} />
            </>
          )}
          {p.status === 'approved' && (
            <Btn title="Publish live" loading={acting === 'publish'} onPress={() => transition('publish', 'publish')} />
          )}
          {p.status === 'published' && (
            <Btn title="Unpublish" color={c.paper} ink={c.red} loading={acting === 'unpublish'} onPress={() => transition('unpublish', 'unpublish')} />
          )}
          {p.status !== 'archived' && (
            <Btn title="Archive" color={c.paper} ink={c.red} loading={acting === 'archive'} onPress={() => transition('archive', 'archive')} />
          )}
        </View>
        {error && <T size={13} color={c.red} style={{ marginTop: 8 }}>{error}</T>}
      </Card>

      {vList.length > 0 && (
        <Card>
          <T size={11} color={c.mute} weight="700" style={{ marginBottom: 10 }}>VERSION HISTORY</T>
          {vList.map((v) => (
            <View key={v.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
              <View>
                <T size={13} weight="700">{'v' + v.version_number + (v.is_live ? ' — LIVE' : '')}</T>
                <T size={11} color={c.mute}>{new Date(v.created_at).toLocaleString()}</T>
              </View>
              {v.is_live && <Tag label="Live" color={c.pink} />}
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}
