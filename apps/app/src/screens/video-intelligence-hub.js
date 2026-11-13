import React, { useState } from 'react'
import { View, ScrollView, TouchableOpacity, Platform } from 'react-native'
import { useLoad } from '../load'
import { useSession } from '../session'
import { useNav } from '../nav'
import { useTheme } from '../theme'
import { Btn, Chip, Empty, H1, Loading, Row, Screen, Seg, T, Tag } from '../ui'
import { FormSheet } from '../FormSheet'
import { api } from '../api'
import { t } from '../i18n'

const PROVIDERS = ['Hudl', 'Veo', 'Catapult', 'StatsPerform', 'YouTube', 'Vimeo']

function ProviderStrip({ orgId }) {
  const c = useTheme()
  const { data } = useLoad(`/organisations/${orgId}/video/providers/status`)
  if (!data?.providers?.length) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 36, marginBottom: 8 }}>
      <Row style={{ gap: 8, paddingHorizontal: 16 }}>
        {data.providers.map((p) => (
          <Row key={p.name} style={{ gap: 4, alignItems: 'center' }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.connected ? c.lime : c.mute }} />
            <T style={{ fontSize: 11, color: c.mute }}>{p.name}</T>
          </Row>
        ))}
      </Row>
    </ScrollView>
  )
}

function AiBadge({ count }) {
  const c = useTheme()
  if (!count) return null
  return (
    <View style={{ backgroundColor: c.sunTint, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 }}>
      <T style={{ fontSize: 11, color: c.sun, fontWeight: '600' }}>{t('vhub.ai_pending', { n: count })}</T>
    </View>
  )
}

function ClipCard({ item, onPress }) {
  const c = useTheme()
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={item.title}
      style={{ backgroundColor: c.paper, borderRadius: 12, padding: 12, marginBottom: 10 }}
    >
      <View style={{ backgroundColor: c.line, borderRadius: 8, height: 90, marginBottom: 8, alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ color: c.mute, fontSize: 11 }}>{item.duration_label ?? '—'}</T>
      </View>
      <T style={{ color: c.ink, fontWeight: '600', marginBottom: 4 }} numberOfLines={1}>{item.title}</T>
      <Row style={{ gap: 6, flexWrap: 'wrap' }}>
        {item.match_linked && <Chip label="Match" colour={c.cyan} />}
        <Chip label={item.tagged ? 'Tagged' : 'Untagged'} colour={item.tagged ? c.lime : c.mute} />
        {item.ai_pending > 0 && <AiBadge count={item.ai_pending} />}
      </Row>
    </TouchableOpacity>
  )
}

function LibraryTab({ orgId }) {
  const c = useTheme()
  const nav = useNav()
  const { data, loading, error, reload } = useLoad(`/organisations/${orgId}/video/clip-sessions`)
  const [showUpload, setShowUpload] = useState(false)
  const { toast } = useSession()

  if (loading) return <Loading />
  if (error) return <Empty label={t('error.generic')} action={reload} />
  const items = data?.clips ?? []

  return (
    <View style={{ flex: 1 }}>
      {!items.length
        ? <Empty label={t('vhub.empty.library')} action={() => setShowUpload(true)} actionLabel={t('vhub.upload')} />
        : (
          <ScrollView contentContainerStyle={{ padding: 16, gap: 0 }}>
            {items.map((item) => (
              <ClipCard
                key={item.id}
                item={item}
                onPress={() => nav.push('VideoMatchTags', { videoId: item.video_id, orgId })}
              />
            ))}
          </ScrollView>
        )
      }
      <TouchableOpacity
        onPress={() => setShowUpload(true)}
        accessibilityLabel={t('vhub.upload')}
        style={{
          position: 'absolute', bottom: 24, insetInlineEnd: 24,
          width: 56, height: 56, borderRadius: 28,
          backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center',
          shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
        }}
      >
        <T style={{ color: c.on, fontSize: 28, lineHeight: 32 }}>+</T>
      </TouchableOpacity>
      <FormSheet visible={showUpload} onClose={() => setShowUpload(false)} title={t('vhub.upload')}>
        <T style={{ color: c.mute, marginBottom: 16 }}>Upload a video file or link a provider video to get started.</T>
        <Btn label="Choose File" onPress={() => { setShowUpload(false); toast('Upload coming soon') }} />
      </FormSheet>
    </View>
  )
}

function TaggingTab({ orgId }) {
  const c = useTheme()
  const nav = useNav()
  const { data, loading, error, reload } = useLoad(`/organisations/${orgId}/video/clip-sessions?untagged=true`)

  if (loading) return <Loading />
  if (error) return <Empty label={t('error.generic')} action={reload} />
  const items = data?.clips ?? []

  if (!items.length) return <Empty label={t('vhub.empty.tagging')} />

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      {items.map((item) => (
        <TouchableOpacity
          key={item.id}
          onPress={() => nav.push('VideoMatchTags', { videoId: item.video_id, orgId })}
          accessibilityRole="button"
          style={{ backgroundColor: c.paper, borderRadius: 12, padding: 14, marginBottom: 10 }}
        >
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T style={{ color: c.ink, fontWeight: '600' }} numberOfLines={1}>{item.title}</T>
              <T style={{ color: c.mute, fontSize: 12, marginTop: 2 }}>{item.match_label ?? item.duration_label}</T>
            </View>
            <Row style={{ gap: 6 }}>
              <Chip label={`${item.tag_count ?? 0} tags`} colour={item.tag_count ? c.cyan : c.mute} />
              {item.ai_pending > 0 && <AiBadge count={item.ai_pending} />}
              <T style={{ color: c.mute }}> ›</T>
            </Row>
          </Row>
        </TouchableOpacity>
      ))}
    </ScrollView>
  )
}

function ScoutingTab({ orgId }) {
  const c = useTheme()
  const nav = useNav()
  const { data, loading, error, reload } = useLoad(`/organisations/${orgId}/video/clip-sessions?scouting=true`)

  if (loading) return <Loading />
  if (error) return <Empty label={t('error.generic')} action={reload} />
  const items = data?.clips ?? []

  if (!items.length) {
    return (
      <Empty
        label={t('vhub.empty.scouting')}
        action={() => nav.push('ScoutingWatchlists', { orgId })}
        actionLabel={t('scout.watch.title')}
      />
    )
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      {items.map((item) => (
        <TouchableOpacity
          key={item.id}
          onPress={() => nav.push('VideoMatchTags', { videoId: item.video_id, orgId })}
          accessibilityRole="button"
          style={{ backgroundColor: c.paper, borderRadius: 12, padding: 14, marginBottom: 10 }}
        >
          <T style={{ color: c.ink, fontWeight: '600' }} numberOfLines={1}>{item.title}</T>
          {item.prospect_name && <T style={{ color: c.mute, fontSize: 12, marginTop: 2 }}>Prospect: {item.prospect_name}</T>}
          <Row style={{ gap: 6, marginTop: 6 }}>
            {item.campaign_name && <Chip label={item.campaign_name} colour={c.violet} />}
            <Chip label={`${item.tag_count ?? 0} tags`} colour={item.tag_count ? c.cyan : c.mute} />
          </Row>
        </TouchableOpacity>
      ))}
    </ScrollView>
  )
}

export function VideoIntelligenceHub({ route }) {
  const { params = {} } = route ?? {}
  const orgId = params.orgId
  const c = useTheme()
  const nav = useNav()
  const [tab, setTab] = useState(0)
  const TABS = [t('vhub.tab.library'), t('vhub.tab.tagging'), t('vhub.tab.scouting')]

  return (
    <Screen>
      <Row style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, justifyContent: 'space-between', alignItems: 'center' }}>
        <H1>{t('vhub.title')}</H1>
        <Row style={{ gap: 8 }}>
          <TouchableOpacity onPress={() => nav.push('VideoProviders', { orgId })} accessibilityRole="button" accessibilityLabel="Providers">
            <T style={{ color: c.pink, fontWeight: '600', fontSize: 13 }}>Providers</T>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => nav.push('VideoClips', { orgId })} accessibilityRole="button" accessibilityLabel="Clips">
            <T style={{ color: c.pink, fontWeight: '600', fontSize: 13 }}>Clips</T>
          </TouchableOpacity>
        </Row>
      </Row>
      <ProviderStrip orgId={orgId} />
      <Seg items={TABS} value={tab} onChange={setTab} style={{ marginHorizontal: 16, marginBottom: 8 }} />
      <View style={{ flex: 1 }}>
        {tab === 0 && <LibraryTab orgId={orgId} />}
        {tab === 1 && <TaggingTab orgId={orgId} />}
        {tab === 2 && <ScoutingTab orgId={orgId} />}
      </View>
    </Screen>
  )
}
