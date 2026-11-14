import React, { useState } from 'react'
import { View, ScrollView, TouchableOpacity, TextInput } from 'react-native'
import { useLoad } from '../hooks'
import { useSession } from '../session'
import { useNav } from '../nav'
import { useTheme } from '../theme'
import { Btn, Chip, Empty, Loading, Row, Screen, T } from '../ui'
import { FormSheet } from '../FormSheet'
import { MenuField, MultiMenuField } from '../menu-field'
import { api } from '../api'
import { t } from '../i18n'

const STATE_COLOURS = {
  pending: null, viewed: 'cyan', understood: 'lime', question: 'orange', resolved: 'violet',
}

function msToMmSs(ms) {
  if (!ms && ms !== 0) return ''
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function mmSsToMs(str) {
  const parts = str.split(':')
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10) || 0
    const s = parseInt(parts[1], 10) || 0
    return (m * 60 + s) * 1000
  }
  return 0
}

function AssignmentChip({ assignment }) {
  const c = useTheme()
  const col = STATE_COLOURS[assignment.review_state]
  const stateKey = `vclip.state.${assignment.review_state ?? 'pending'}`
  return (
    <Row style={{ gap: 6, alignItems: 'center', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <T style={{ color: c.ink, flex: 1, fontSize: 13 }}>{assignment.athlete_name}</T>
      <Chip label={t(stateKey)} colour={col ? c[col] : c.mute} />
    </Row>
  )
}

function ClipCard({ clip, onPress }) {
  const c = useTheme()
  return (
    <TouchableOpacity
      onPress={() => onPress(clip)}
      accessibilityRole="button"
      accessibilityLabel={clip.title}
      style={{ backgroundColor: c.paper, borderRadius: 12, padding: 14, marginBottom: 10 }}
    >
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <T style={{ color: c.ink, fontWeight: '600' }} numberOfLines={1}>{clip.title}</T>
          <T style={{ color: c.mute, fontSize: 12, marginTop: 2 }}>
            {msToMmSs(clip.start_ms)} → {msToMmSs(clip.end_ms)}
            {clip.group_name ? `  ·  ${clip.group_name}` : ''}
          </T>
        </View>
        <Chip label={`${clip.assignment_count ?? 0} athletes`} colour={clip.assignment_count ? c.cyan : c.mute} />
      </Row>
    </TouchableOpacity>
  )
}

function ClipWorksheet({ orgId, groups, onCreated, onClose }) {
  const c = useTheme()
  const { toast } = useSession()
  const [title, setTitle] = useState('')
  const [startStr, setStartStr] = useState('00:00')
  const [endStr, setEndStr] = useState('00:30')
  const [sourceVideoId, setSourceVideoId] = useState(null)
  const [groupId, setGroupId] = useState(null)
  const [athletes, setAthletes] = useState([])
  const [coachNote, setCoachNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')

  const { data: videosData } = useLoad(orgId ? `/organisations/${orgId}/video/clip-sessions` : null)
  const { data: athletesData } = useLoad(orgId ? `/organisations/${orgId}/members?role=athlete` : null)

  const videoOptions = (videosData?.clips ?? []).map((v) => ({ label: v.title, value: v.video_id }))
  const athleteOptions = (athletesData?.members ?? []).map((a) => ({ label: a.display_name, value: a.id }))
  const groupOptions = (groups ?? []).map((g) => ({ label: g.name, value: g.id }))

  async function save() {
    if (!title.trim()) { toast('Title required'); return }
    setSaving(true)
    try {
      const res = await api.post(`/organisations/${orgId}/video/clip-sessions`, {
        title: title.trim(),
        video_id: sourceVideoId,
        start_ms: mmSsToMs(startStr),
        end_ms: mmSsToMs(endStr),
        group_id: groupId,
      })
      if (athletes.length) {
        await api.post(`/video/clip-sessions/${res.id}/assignments`, {
          athlete_ids: athletes,
          coaching_note: coachNote,
        })
      }
      toast(t('vclip.new') + ' ✓')
      onCreated()
    } catch {
      toast(t('error.generic'))
    } finally {
      setSaving(false)
    }
  }

  async function createGroup() {
    if (!newGroupName.trim()) return
    try {
      await api.post(`/organisations/${orgId}/video/clip-groups`, { name: newGroupName.trim() })
      toast('Group created')
      setShowNewGroup(false)
      setNewGroupName('')
    } catch {
      toast(t('error.generic'))
    }
  }

  return (
    <View style={{ gap: 14 }}>
      <T style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>Title</T>
      <TextInput value={title} onChangeText={setTitle} placeholder="Clip title" placeholderTextColor={c.mute}
        style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, fontSize: 14 }} accessibilityLabel="Title" />
      <MenuField label="Source Video" value={sourceVideoId} onChange={setSourceVideoId} options={videoOptions} />
      <Row style={{ gap: 12 }}>
        <View style={{ flex: 1 }}>
          <T style={{ color: c.mute, fontSize: 12, marginBottom: 4 }}>{t('vclip.trim.start')}</T>
          <TextInput value={startStr} onChangeText={setStartStr} placeholder="00:00" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, fontSize: 14 }} accessibilityLabel={t('vclip.trim.start')} />
        </View>
        <View style={{ flex: 1 }}>
          <T style={{ color: c.mute, fontSize: 12, marginBottom: 4 }}>{t('vclip.trim.end')}</T>
          <TextInput value={endStr} onChangeText={setEndStr} placeholder="00:30" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, fontSize: 14 }} accessibilityLabel={t('vclip.trim.end')} />
        </View>
      </Row>
      <Row style={{ gap: 8, alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <MenuField label={t('vclip.group')} value={groupId} onChange={setGroupId} options={groupOptions} />
        </View>
        <TouchableOpacity onPress={() => setShowNewGroup(true)} accessibilityRole="button"
          style={{ backgroundColor: c.pinkTint, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginTop: 20 }}>
          <T style={{ color: c.pink, fontSize: 13 }}>+ {t('vclip.group.new')}</T>
        </TouchableOpacity>
      </Row>
      <MultiMenuField label={t('vclip.assign')} value={athletes} onChange={setAthletes} options={athleteOptions} />
      {athletes.length > 0 && (
        <>
          <T style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('vclip.note')}</T>
          <TextInput value={coachNote} onChangeText={setCoachNote} placeholder={t('vclip.note')} placeholderTextColor={c.mute}
            multiline style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, fontSize: 14, minHeight: 72 }} accessibilityLabel={t('vclip.note')} />
        </>
      )}
      <Btn label={t('common.save')} onPress={save} loading={saving} />
      <FormSheet visible={showNewGroup} onClose={() => setShowNewGroup(false)} title={t('vclip.group.new')}>
        <TextInput value={newGroupName} onChangeText={setNewGroupName} placeholder="Group name" placeholderTextColor={c.mute}
          style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, marginBottom: 12 }} accessibilityLabel="Group name" />
        <Btn label={t('common.save')} onPress={createGroup} />
      </FormSheet>
    </View>
  )
}

export function VideoClipsScreen({ route }) {
  const { params = {} } = route ?? {}
  const { orgId } = params
  const c = useTheme()
  const { toast } = useSession()
  const [showNew, setShowNew] = useState(false)
  const [selectedClip, setSelectedClip] = useState(null)

  const { data, loading, error, reload } = useLoad(orgId ? `/organisations/${orgId}/video/clip-sessions` : null)
  const { data: groupsData, reload: reloadGroups } = useLoad(orgId ? `/organisations/${orgId}/video/clip-groups` : null)
  const { data: assignData } = useLoad(selectedClip ? `/video/clip-sessions/${selectedClip.id}/assignments` : null)

  const clips = data?.clips ?? []
  const groups = groupsData?.groups ?? []
  const assignments = assignData?.assignments ?? []

  if (loading) return <Loading />
  if (error) return <Empty label={t('error.generic')} action={reload} />

  return (
    <Screen>
      <Row style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <T style={{ color: c.ink, fontSize: 18, fontWeight: '700' }}>{t('vclip.title')}</T>
      </Row>
      {!clips.length
        ? <Empty label={t('vclip.empty')} action={() => setShowNew(true)} actionLabel={t('vclip.new')} />
        : (
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {clips.map((clip) => (
              <ClipCard key={clip.id} clip={clip} onPress={setSelectedClip} />
            ))}
          </ScrollView>
        )
      }
      {/* FAB */}
      <TouchableOpacity
        onPress={() => setShowNew(true)}
        accessibilityLabel={t('vclip.new')}
        style={{
          position: 'absolute', bottom: 24, insetInlineEnd: 24,
          width: 56, height: 56, borderRadius: 28,
          backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center',
        }}
      >
        <T style={{ color: c.on, fontSize: 28 }}>+</T>
      </TouchableOpacity>

      {/* New clip sheet */}
      <FormSheet visible={showNew} onClose={() => setShowNew(false)} title={t('vclip.new')}>
        <ClipWorksheet orgId={orgId} groups={groups} onCreated={() => { setShowNew(false); reload(); reloadGroups() }} onClose={() => setShowNew(false)} />
      </FormSheet>

      {/* Clip detail sheet */}
      <FormSheet visible={!!selectedClip} onClose={() => setSelectedClip(null)} title={selectedClip?.title ?? t('vclip.title')}>
        {selectedClip && (
          <View>
            <T style={{ color: c.mute, fontSize: 12, marginBottom: 12 }}>
              {msToMmSs(selectedClip.start_ms)} → {msToMmSs(selectedClip.end_ms)}
              {selectedClip.group_name ? `  ·  ${selectedClip.group_name}` : ''}
            </T>
            <T style={{ color: c.ink, fontWeight: '600', marginBottom: 8 }}>{t('vclip.assign')} ({assignments.length})</T>
            {!assignments.length && <T style={{ color: c.mute }}>{t('vclip.empty')}</T>}
            {assignments.map((a) => <AssignmentChip key={a.id} assignment={a} />)}
          </View>
        )}
      </FormSheet>
    </Screen>
  )
}
