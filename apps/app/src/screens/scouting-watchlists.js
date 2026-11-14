import React, { useState } from 'react'
import { View, ScrollView, TouchableOpacity, TextInput } from 'react-native'
import { useLoad } from '../hooks'
import { useSession } from '../session'
import { useTheme } from '../theme'
import { Btn, Chip, Empty, Loading, Row, Screen, T } from '../ui'
import { FormSheet } from '../FormSheet'
import { MenuField } from '../menu-field'
import { api } from '../api'
import { t } from '../i18n'

const PRIORITIES = ['hot', 'warm', 'watch', 'passed']
const PRIORITY_COLOURS = { hot: 'red', warm: 'orange', watch: 'cyan', passed: null }

function PriorityChip({ priority }) {
  const c = useTheme()
  const col = PRIORITY_COLOURS[priority]
  const key = `scout.watch.priority.${priority ?? 'watch'}`
  return <Chip label={t(key)} colour={col ? c[col] : c.mute} />
}

function MemberRow({ member, onLongPress }) {
  const c = useTheme()
  return (
    <TouchableOpacity
      onLongPress={() => onLongPress(member)}
      accessibilityRole="button"
      accessibilityLabel={member.name}
      style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line }}
    >
      <Row style={{ gap: 10, alignItems: 'center' }}>
        <PriorityChip priority={member.priority} />
        <View style={{ flex: 1 }}>
          <T style={{ color: c.ink, fontWeight: '600' }}>{member.name}</T>
          <T style={{ color: c.mute, fontSize: 12 }}>
            {[member.position, member.club, member.age ? `Age ${member.age}` : null].filter(Boolean).join('  ·  ')}
          </T>
        </View>
      </Row>
    </TouchableOpacity>
  )
}

function WatchlistCard({ watchlist, onPress }) {
  const c = useTheme()
  return (
    <TouchableOpacity
      onPress={() => onPress(watchlist)}
      accessibilityRole="button"
      accessibilityLabel={watchlist.name}
      style={{ backgroundColor: c.paper, borderRadius: 12, padding: 14, marginBottom: 10 }}
    >
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <T style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>{watchlist.name}</T>
          <T style={{ color: c.mute, fontSize: 12, marginTop: 2 }}>
            {watchlist.season}{watchlist.sport_name ? `  ·  ${watchlist.sport_name}` : ''}
          </T>
        </View>
        <Row style={{ gap: 6, alignItems: 'center' }}>
          {watchlist.shared && (
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.lime }} />
          )}
          <Chip label={t('scout.watch.members', { n: watchlist.member_count ?? 0 })} colour={c.cyan} />
        </Row>
      </Row>
    </TouchableOpacity>
  )
}

export function ScoutingWatchlistsScreen({ route }) {
  const { params = {} } = route ?? {}
  const { orgId } = params
  const c = useTheme()
  const { toast } = useSession()
  const [selectedWatchlist, setSelectedWatchlist] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [showAddMember, setShowAddMember] = useState(false)
  const [showAssignScout, setShowAssignScout] = useState(false)
  const [showMemberAction, setShowMemberAction] = useState(null)
  const [form, setForm] = useState({ name: '', season: '', sport_id: null, description: '' })
  const [memberForm, setMemberForm] = useState({ athlete_id: null, name: '', club: '', priority: 'watch' })
  const [saving, setSaving] = useState(false)

  const { data, loading, error, reload } = useLoad(orgId ? `/organisations/${orgId}/scouting/watchlists` : null)
  const { data: membersData, reload: reloadMembers } = useLoad(
    selectedWatchlist ? `/organisations/${orgId}/scouting/watchlists/${selectedWatchlist.id}/members` : null
  )
  const { data: sportsData } = useLoad('/sports')
  const { data: scoutsData } = useLoad(orgId ? `/organisations/${orgId}/members?role=scout` : null)

  const watchlists = data?.watchlists ?? []
  const members = membersData?.members ?? []
  const sportOptions = (sportsData?.sports ?? []).map((s) => ({ label: s.name, value: s.id }))
  const scoutOptions = (scoutsData?.members ?? []).map((s) => ({ label: s.display_name, value: s.id }))

  async function createWatchlist() {
    if (!form.name.trim()) { toast('Name required'); return }
    setSaving(true)
    try {
      await api.post(`/organisations/${orgId}/scouting/watchlists`, form)
      toast(t('scout.watch.new') + ' ✓')
      setShowNew(false)
      setForm({ name: '', season: '', sport_id: null, description: '' })
      reload()
    } catch { toast(t('error.generic')) } finally { setSaving(false) }
  }

  async function addMember() {
    if (!selectedWatchlist) return
    setSaving(true)
    try {
      await api.post(`/organisations/${orgId}/scouting/watchlists/${selectedWatchlist.id}/members`, memberForm)
      toast(t('scout.watch.add_member') + ' ✓')
      setShowAddMember(false)
      setMemberForm({ athlete_id: null, name: '', club: '', priority: 'watch' })
      reloadMembers()
    } catch { toast(t('error.generic')) } finally { setSaving(false) }
  }

  async function changePriority(member, priority) {
    try {
      await api.patch(`/organisations/${orgId}/scouting/watchlists/${selectedWatchlist.id}/members/${member.id}`, { priority })
      reloadMembers()
      setShowMemberAction(null)
    } catch { toast(t('error.generic')) }
  }

  if (loading) return <Loading />
  if (error) return <Empty label={t('error.generic')} action={reload} />

  return (
    <Screen>
      <Row style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <T style={{ color: c.ink, fontSize: 18, fontWeight: '700' }}>{t('scout.watch.title')}</T>
        <Btn label={t('scout.watch.new')} onPress={() => setShowNew(true)} small />
      </Row>

      {!selectedWatchlist ? (
        !watchlists.length
          ? <Empty label={t('scout.watch.empty')} action={() => setShowNew(true)} actionLabel={t('scout.watch.new')} />
          : (
            <ScrollView contentContainerStyle={{ padding: 16 }}>
              {watchlists.map((wl) => (
                <WatchlistCard key={wl.id} watchlist={wl} onPress={setSelectedWatchlist} />
              ))}
            </ScrollView>
          )
      ) : (
        <View style={{ flex: 1 }}>
          <TouchableOpacity onPress={() => setSelectedWatchlist(null)} accessibilityRole="button" style={{ paddingHorizontal: 16, paddingTop: 8 }}>
            <T style={{ color: c.pink, fontWeight: '600' }}>‹ {t('scout.watch.title')}</T>
          </TouchableOpacity>
          <Row style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <T style={{ color: c.ink, fontWeight: '700', fontSize: 16 }}>{selectedWatchlist.name}</T>
              <T style={{ color: c.mute, fontSize: 12 }}>{selectedWatchlist.season}</T>
            </View>
            <Row style={{ gap: 8 }}>
              <Btn label={t('scout.watch.add_member')} onPress={() => setShowAddMember(true)} small />
              {scoutOptions.length > 0 && (
                <Btn label={t('scout.watch.assign_scout')} onPress={() => setShowAssignScout(true)} small secondary />
              )}
            </Row>
          </Row>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
            {!members.length && <T style={{ color: c.mute }}>{t('scout.watch.empty')}</T>}
            {members.map((m) => (
              <MemberRow key={m.id} member={m} onLongPress={(mem) => setShowMemberAction(mem)} />
            ))}
          </ScrollView>
        </View>
      )}

      {/* New watchlist */}
      <FormSheet visible={showNew} onClose={() => setShowNew(false)} title={t('scout.watch.new')}>
        <View style={{ gap: 12 }}>
          <TextInput value={form.name} onChangeText={(v) => setForm((f) => ({ ...f, name: v }))}
            placeholder="Watchlist name" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Name" />
          <TextInput value={form.season} onChangeText={(v) => setForm((f) => ({ ...f, season: v }))}
            placeholder="Season (e.g. 2026/27)" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Season" />
          <MenuField label="Sport" value={form.sport_id} onChange={(v) => setForm((f) => ({ ...f, sport_id: v }))} options={sportOptions} />
          <TextInput value={form.description} onChangeText={(v) => setForm((f) => ({ ...f, description: v }))}
            placeholder="Description (optional)" placeholderTextColor={c.mute} multiline
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, minHeight: 60 }} accessibilityLabel="Description" />
          <Btn label={t('common.save')} onPress={createWatchlist} loading={saving} />
        </View>
      </FormSheet>

      {/* Add member */}
      <FormSheet visible={showAddMember} onClose={() => setShowAddMember(false)} title={t('scout.watch.add_member')}>
        <View style={{ gap: 12 }}>
          <TextInput value={memberForm.name} onChangeText={(v) => setMemberForm((f) => ({ ...f, name: v }))}
            placeholder="Athlete name" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Name" />
          <TextInput value={memberForm.club} onChangeText={(v) => setMemberForm((f) => ({ ...f, club: v }))}
            placeholder="Club" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Club" />
          <T style={{ color: c.ink, fontWeight: '600' }}>Priority</T>
          <Row style={{ gap: 8 }}>
            {PRIORITIES.map((p) => (
              <TouchableOpacity key={p} onPress={() => setMemberForm((f) => ({ ...f, priority: p }))} accessibilityRole="button" accessibilityLabel={p}>
                <Chip label={t(`scout.watch.priority.${p}`)} colour={memberForm.priority === p ? c[PRIORITY_COLOURS[p]] ?? c.mute : c.line} />
              </TouchableOpacity>
            ))}
          </Row>
          <Btn label={t('scout.watch.add_member')} onPress={addMember} loading={saving} />
        </View>
      </FormSheet>

      {/* Member action sheet */}
      <FormSheet visible={!!showMemberAction} onClose={() => setShowMemberAction(null)} title={showMemberAction?.name ?? ''}>
        <T style={{ color: c.ink, fontWeight: '600', marginBottom: 8 }}>Set Priority</T>
        <Row style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {PRIORITIES.map((p) => (
            <TouchableOpacity key={p} onPress={() => changePriority(showMemberAction, p)} accessibilityRole="button" accessibilityLabel={p}>
              <Chip label={t(`scout.watch.priority.${p}`)} colour={c[PRIORITY_COLOURS[p]] ?? c.mute} />
            </TouchableOpacity>
          ))}
        </Row>
      </FormSheet>

      {/* Assign scout */}
      <FormSheet visible={showAssignScout} onClose={() => setShowAssignScout(false)} title={t('scout.watch.assign_scout')}>
        <MenuField label="Scout" value={null} onChange={async (scoutId) => {
          try {
            await api.post(`/organisations/${orgId}/scouting/watchlists/${selectedWatchlist?.id}/scouts`, { scout_id: scoutId })
            toast(t('scout.watch.assign_scout') + ' ✓')
            setShowAssignScout(false)
          } catch { toast(t('error.generic')) }
        }} options={scoutOptions} />
      </FormSheet>
    </Screen>
  )
}
