import React, { useState, useRef } from 'react'
import { View, ScrollView, TouchableOpacity, TextInput } from 'react-native'
import { useLoad } from '../hooks'
import { useSession } from '../session'
import { useNav } from '../nav'
import { useTheme } from '../theme'
import { Btn, Chip, Empty, Loading, Row, Screen, T, Tag } from '../ui'
import { FormSheet } from '../FormSheet'
import { MenuField } from '../menu-field'
import { api } from '../api'
import { t } from '../i18n'

const TAG_COLOURS = {
  goal: '#22c55e', shot: '#3b82f6', save: '#6366f1', foul: '#ef4444',
  yellow_card: '#eab308', red_card: '#dc2626', possession: '#a855f7',
  substitution: '#f97316', tactical: '#8b5cf6', custom: '#6b7280',
}

function msToDisplay(ms) {
  if (!ms && ms !== 0) return '--:--'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function TagDot({ tag, totalMs, onPress }) {
  const c = useTheme()
  const pct = totalMs > 0 ? Math.min(100, (tag.timestamp_ms / totalMs) * 100) : 0
  const col = TAG_COLOURS[tag.event_code] ?? TAG_COLOURS.custom
  return (
    <TouchableOpacity
      onPress={() => onPress(tag)}
      accessibilityRole="button"
      accessibilityLabel={`${tag.event_label} at ${msToDisplay(tag.timestamp_ms)}`}
      style={{ position: 'absolute', left: `${pct}%`, top: 0, transform: [{ translateX: -6 }] }}
    >
      <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: col, borderWidth: 2, borderColor: c.paper }} />
    </TouchableOpacity>
  )
}

function Timeline({ tags, totalMs, onSelect }) {
  const c = useTheme()
  return (
    <View style={{ height: 36, backgroundColor: c.paper, borderRadius: 8, marginHorizontal: 16, marginBottom: 8, justifyContent: 'center', overflow: 'hidden' }}>
      <View style={{ height: 3, backgroundColor: c.line, marginHorizontal: 10, borderRadius: 2 }} />
      <View style={{ position: 'absolute', left: 10, right: 10, top: 0, bottom: 0 }}>
        {tags.map((tag) => (
          <TagDot key={tag.id} tag={tag} totalMs={totalMs} onPress={onSelect} />
        ))}
      </View>
    </View>
  )
}

function TagTypeBtn({ tmpl, onPress }) {
  const c = useTheme()
  const col = TAG_COLOURS[tmpl.event_code] ?? TAG_COLOURS.custom
  return (
    <TouchableOpacity
      onPress={() => onPress(tmpl)}
      accessibilityRole="button"
      accessibilityLabel={tmpl.name}
      style={{
        backgroundColor: c.paper, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
        marginBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 10,
        borderStartWidth: 4, borderStartColor: col,
      }}
    >
      <T style={{ color: c.ink, fontWeight: '600', flex: 1 }}>{tmpl.name}</T>
      <T style={{ color: c.mute, fontSize: 11 }}>{tmpl.code}</T>
    </TouchableOpacity>
  )
}

export function VideoMatchTagsScreen({ route }) {
  const { params = {} } = route ?? {}
  const { videoId, orgId, sportId } = params
  const c = useTheme()
  const { toast } = useSession()
  const [currentMs, setCurrentMs] = useState(0)
  const [selectedTag, setSelectedTag] = useState(null)
  const [showDetail, setShowDetail] = useState(false)
  const [showBulkImport, setShowBulkImport] = useState(false)
  const [showMatchLink, setShowMatchLink] = useState(false)
  const [saving, setSaving] = useState(false)
  const [noteText, setNoteText] = useState('')

  const { data: templates, loading: tplLoading } = useLoad(
    orgId ? `/organisations/${orgId}/video/tag-templates${sportId ? `?sport_id=${sportId}` : ''}` : null
  )
  const { data: tagData, loading: tagLoading, reload: reloadTags } = useLoad(
    videoId ? `/me/videos/${videoId}/tags` : null
  )

  const tmplList = templates?.templates ?? []
  const tags = tagData?.tags ?? []
  const totalMs = tagData?.duration_ms ?? 600000

  async function placeTag(tmpl) {
    if (!videoId) return
    setSaving(true)
    try {
      await api.post(`/me/videos/${videoId}/tags`, {
        event_code: tmpl.event_code,
        event_label: tmpl.name,
        timestamp_ms: currentMs,
        ai_suggested: false,
      })
      toast(t('vtag.add') + ' ✓')
      reloadTags()
    } catch {
      toast(t('error.generic'))
    } finally {
      setSaving(false)
    }
  }

  async function saveTagNote() {
    if (!selectedTag) return
    setSaving(true)
    try {
      await api.patch(`/me/videos/${videoId}/tags/${selectedTag.id}`, { notes: noteText })
      toast(t('common.save') + ' ✓')
      setShowDetail(false)
      reloadTags()
    } catch {
      toast(t('error.generic'))
    } finally {
      setSaving(false)
    }
  }

  if (tplLoading || tagLoading) return <Loading />

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {/* Video player placeholder */}
        <View style={{ backgroundColor: '#111827', margin: 16, borderRadius: 12, aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ color: '#fff', fontSize: 24, fontWeight: '700' }}>▶</T>
          <T style={{ color: '#9ca3af', fontSize: 13, marginTop: 6 }}>{msToDisplay(currentMs)}</T>
          <Row style={{ position: 'absolute', bottom: 12, left: 16, right: 16, justifyContent: 'space-between' }}>
            <TouchableOpacity onPress={() => setCurrentMs(Math.max(0, currentMs - 10000))} accessibilityRole="button" accessibilityLabel="-10s">
              <T style={{ color: '#fff', fontSize: 13 }}>-10s</T>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setCurrentMs(Math.min(totalMs, currentMs + 10000))} accessibilityRole="button" accessibilityLabel="+10s">
              <T style={{ color: '#fff', fontSize: 13 }}>+10s</T>
            </TouchableOpacity>
          </Row>
        </View>

        {/* Timeline */}
        <T style={{ color: c.mute, fontSize: 11, marginHorizontal: 16, marginBottom: 4 }}>{t('vtag.timeline')}</T>
        <Timeline tags={tags} totalMs={totalMs} onSelect={(tag) => { setSelectedTag(tag); setNoteText(tag.notes ?? ''); setShowDetail(true) }} />

        <Row style={{ paddingHorizontal: 16, gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <TouchableOpacity
            onPress={() => setShowMatchLink(true)}
            accessibilityRole="button"
            style={{ backgroundColor: c.cyanTint, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}
          >
            <T style={{ color: c.cyan, fontWeight: '600', fontSize: 13 }}>{t('vtag.link_match')}</T>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowBulkImport(true)}
            accessibilityRole="button"
            style={{ backgroundColor: c.pinkTint, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}
          >
            <T style={{ color: c.pink, fontWeight: '600', fontSize: 13 }}>{t('vtag.bulk_import')}</T>
          </TouchableOpacity>
        </Row>

        {/* Tag palette */}
        <T style={{ color: c.mute, fontSize: 11, marginHorizontal: 16, marginBottom: 6 }}>{t('vtag.palette')}</T>
        {!tmplList.length
          ? <Empty label={t('vtag.empty')} />
          : (
            <View style={{ paddingHorizontal: 16 }}>
              {tmplList.map((tmpl) => (
                <TagTypeBtn key={tmpl.id ?? tmpl.event_code} tmpl={tmpl} onPress={placeTag} />
              ))}
            </View>
          )
        }

        {/* Existing tags list */}
        {tags.length > 0 && (
          <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
            <T style={{ color: c.mute, fontSize: 11, marginBottom: 6 }}>Tags ({tags.length})</T>
            {tags.map((tag) => (
              <TouchableOpacity
                key={tag.id}
                onPress={() => { setSelectedTag(tag); setNoteText(tag.notes ?? ''); setShowDetail(true) }}
                accessibilityRole="button"
                style={{ backgroundColor: c.paper, borderRadius: 10, padding: 10, marginBottom: 6 }}
              >
                <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Row style={{ gap: 8, alignItems: 'center' }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: TAG_COLOURS[tag.event_code] ?? TAG_COLOURS.custom }} />
                    <T style={{ color: c.ink, fontWeight: '600' }}>{tag.event_label}</T>
                    {tag.ai_suggested && <Chip label={t('vtag.ai_suggested')} colour={c.sun} />}
                    {tag.verified && <Chip label={t('vtag.verified')} colour={c.lime} />}
                  </Row>
                  <T style={{ color: c.mute, fontSize: 12 }}>{msToDisplay(tag.timestamp_ms)}</T>
                </Row>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Tag detail sheet */}
      <FormSheet visible={showDetail} onClose={() => setShowDetail(false)} title={t('vtag.edit')}>
        {selectedTag && (
          <View style={{ gap: 12 }}>
            <Row style={{ gap: 8, flexWrap: 'wrap' }}>
              <Chip label={selectedTag.event_label} colour={TAG_COLOURS[selectedTag.event_code] ?? TAG_COLOURS.custom} />
              <Chip label={msToDisplay(selectedTag.timestamp_ms)} colour={c.mute} />
              {selectedTag.ai_suggested && <Chip label={t('vtag.ai_suggested')} colour={c.sun} />}
            </Row>
            {selectedTag.match_event_label && (
              <T style={{ color: c.mute, fontSize: 12 }}>{t('vtag.match_event')}: {selectedTag.match_event_label}</T>
            )}
            <T style={{ color: c.ink, fontSize: 13, fontWeight: '600' }}>{t('vtag.notes')}</T>
            <TextInput
              value={noteText}
              onChangeText={setNoteText}
              placeholder={t('vtag.notes')}
              placeholderTextColor={c.mute}
              multiline
              style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, minHeight: 72, fontSize: 14 }}
              accessibilityLabel={t('vtag.notes')}
            />
            <Btn label={t('common.save')} onPress={saveTagNote} loading={saving} />
          </View>
        )}
      </FormSheet>

      {/* Bulk import sheet */}
      <FormSheet visible={showBulkImport} onClose={() => setShowBulkImport(false)} title={t('vtag.bulk_import')}>
        <T style={{ color: c.mute }}>Import all events from the linked match and place them as tags at their recorded timestamps.</T>
        <Btn label={t('vtag.bulk_import')} onPress={async () => {
          try {
            await api.post(`/me/videos/${videoId}/tags/bulk-import`, { source: 'match_events' })
            toast(t('vtag.bulk_import') + ' ✓')
            setShowBulkImport(false)
            reloadTags()
          } catch { toast(t('error.generic')) }
        }} style={{ marginTop: 16 }} />
      </FormSheet>

      {/* Match link sheet */}
      <FormSheet visible={showMatchLink} onClose={() => setShowMatchLink(false)} title={t('vtag.link_match')}>
        <T style={{ color: c.mute }}>Link this video to a fixture to anchor tags to canonical match events.</T>
        <Btn label={t('vtag.link_match')} onPress={() => setShowMatchLink(false)} style={{ marginTop: 16 }} />
      </FormSheet>
    </Screen>
  )
}
