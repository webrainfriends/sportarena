import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, ErrorBox, Field, Loading, T, Tag } from '../ui';
import { c } from '../theme';

export function StudioSeo({ pageId }) {
  const seo = useLoad(() => api.get('/admin/landing/pages/' + pageId + '/seo'), [pageId]);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [slug, setSlug] = useState('');
  const [canonical, setCanonical] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  if (seo.loading && !seo.data) return <Loading />;
  if (seo.error) return <ErrorBox error={seo.error} onRetry={seo.reload} />;

  const data = seo.data || {};

  const startEdit = () => {
    setTitle(data.meta_title || '');
    setDesc(data.meta_description || '');
    setSlug(data.slug || '');
    setCanonical(data.canonical_url || '');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch('/admin/landing/pages/' + pageId + '/seo', { meta_title: title, meta_description: desc, slug, canonical_url: canonical });
      seo.reload();
      setEditing(false);
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <View style={{ gap: 14 }}>
        <T weight="800" size={18}>SEO Metadata</T>
        <Field label="Meta title" value={title} onChangeText={setTitle} placeholder="GotMyGame — The world's smartest sports platform" hint="Ideal: 50–60 characters" />
        <Field label="Meta description" value={desc} onChangeText={setDesc} placeholder="Elite sports management for academies, clubs and athletes." type="multiline" hint="Ideal: 120–160 characters" />
        <Field label="URL slug" value={slug} onChangeText={setSlug} placeholder="gotmygame" hint="Your page will be served at /landing/<slug>" />
        <Field label="Canonical URL" value={canonical} onChangeText={setCanonical} placeholder="https://gotmygame.com/" optional />
        {error && <T size={13} color={c.red}>{error}</T>}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn title="Save" loading={saving} onPress={save} />
          <Btn title="Cancel" color={c.paper} ink={c.mute} onPress={() => setEditing(false)} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T weight="800" size={18}>SEO Metadata</T>
        <Btn small title="Edit" onPress={startEdit} />
      </View>

      <Card>
        <T size={11} color={c.mute} weight="700">META TITLE</T>
        <T size={14} style={{ marginTop: 4 }}>{data.meta_title || <T size={14} color={c.red}>Not set</T>}</T>
        {data.meta_title && (
          <View style={{ marginTop: 6, flexDirection: 'row', gap: 6 }}>
            <Tag label={data.meta_title.length + ' chars'} color={data.meta_title.length > 60 ? c.sun : c.cyanSoft} />
          </View>
        )}
      </Card>

      <Card>
        <T size={11} color={c.mute} weight="700">META DESCRIPTION</T>
        <T size={14} style={{ marginTop: 4 }}>{data.meta_description || <T size={14} color={c.red}>Not set</T>}</T>
        {data.meta_description && (
          <Tag label={data.meta_description.length + ' chars'} color={data.meta_description.length > 160 ? c.sun : c.cyanSoft} style={{ marginTop: 6 }} />
        )}
      </Card>

      <Card>
        <T size={11} color={c.mute} weight="700">SLUG</T>
        <T size={14} style={{ marginTop: 4 }}>{data.slug ? '/landing/' + data.slug : <T size={14} color={c.red}>Not set</T>}</T>
      </Card>

      {data.canonical_url ? (
        <Card>
          <T size={11} color={c.mute} weight="700">CANONICAL URL</T>
          <T size={14} style={{ marginTop: 4 }}>{data.canonical_url}</T>
        </Card>
      ) : null}
    </View>
  );
}
