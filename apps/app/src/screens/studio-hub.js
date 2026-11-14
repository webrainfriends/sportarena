import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Btn, T } from '../ui';
import { c, r } from '../theme';
import { StudioPages } from './studio-pages';
import { StudioBlocks } from './studio-blocks';
import { StudioBlockEditor } from './studio-block-editor';
import { StudioAssets } from './studio-assets';
import { StudioNews } from './studio-news';
import { StudioPreview } from './studio-preview';
import { StudioLocalisations } from './studio-localisations';
import { StudioSeo } from './studio-seo';
import { StudioWorkflow } from './studio-workflow';
import { StudioQuality } from './studio-quality';

const TABS = [
  { key: 'pages', label: 'Pages', icon: '📄' },
  { key: 'blocks', label: 'Blocks', icon: '🧱' },
  { key: 'assets', label: 'Assets', icon: '🖼️' },
  { key: 'news', label: 'News', icon: '📰' },
  { key: 'preview', label: 'Preview', icon: '👁' },
  { key: 'localisations', label: 'i18n', icon: '🌐' },
  { key: 'seo', label: 'SEO', icon: '🔍' },
  { key: 'workflow', label: 'Workflow', icon: '🚀' },
  { key: 'quality', label: 'Quality', icon: '✅' },
];

export function StudioHub() {
  const [tab, setTab] = useState('pages');
  const [pageId, setPageId] = useState(null);
  const [editBlock, setEditBlock] = useState(null);

  const goToPage = (page) => {
    setPageId(page.id);
    setTab('blocks');
  };

  const goToBlockEditor = (block) => {
    setEditBlock(block);
    setTab('block-editor');
  };

  const renderContent = () => {
    if (tab === 'block-editor' && editBlock) {
      return (
        <View style={{ gap: 14 }}>
          <Btn small title="← Back to blocks" color={c.paper} ink={c.mute} onPress={() => { setEditBlock(null); setTab('blocks'); }} />
          <StudioBlockEditor block={editBlock} pageId={pageId} onSaved={() => { setEditBlock(null); setTab('blocks'); }} />
        </View>
      );
    }
    switch (tab) {
      case 'pages': return <StudioPages onSelect={goToPage} />;
      case 'blocks': return pageId
        ? <StudioBlocks pageId={pageId} onSelect={goToBlockEditor} />
        : (
          <View style={{ padding: 24, alignItems: 'center' }}>
            <T size={14} color={c.mute}>Select a page from the Pages tab first.</T>
          </View>
        );
      case 'assets': return <StudioAssets />;
      case 'news': return pageId ? <StudioNews pageId={pageId} /> : (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <T size={14} color={c.mute}>Select a page from the Pages tab first.</T>
        </View>
      );
      case 'preview': return pageId ? <StudioPreview pageId={pageId} /> : (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <T size={14} color={c.mute}>Select a page from the Pages tab first.</T>
        </View>
      );
      case 'localisations': return pageId ? <StudioLocalisations pageId={pageId} /> : (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <T size={14} color={c.mute}>Select a page from the Pages tab first.</T>
        </View>
      );
      case 'seo': return pageId ? <StudioSeo pageId={pageId} /> : (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <T size={14} color={c.mute}>Select a page from the Pages tab first.</T>
        </View>
      );
      case 'workflow': return pageId ? <StudioWorkflow pageId={pageId} /> : (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <T size={14} color={c.mute}>Select a page from the Pages tab first.</T>
        </View>
      );
      case 'quality': return pageId ? <StudioQuality pageId={pageId} /> : (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <T size={14} color={c.mute}>Select a page from the Pages tab first.</T>
        </View>
      );
      default: return null;
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingVertical: 10 }}>
        {TABS.map((t) => (
          <Btn key={t.key} small title={t.icon + ' ' + t.label}
            color={tab === t.key ? c.pink : c.paper}
            ink={tab === t.key ? '#fff' : c.mute}
            onPress={() => setTab(t.key)} />
        ))}
      </ScrollView>
      {pageId && tab !== 'pages' && (
        <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
          <Btn small title="← All pages" color={c.paper} ink={c.mute} onPress={() => { setPageId(null); setTab('pages'); }} />
        </View>
      )}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        {renderContent()}
      </ScrollView>
    </View>
  );
}
