import React, { useState } from 'react'
import { View, ScrollView, TouchableOpacity, TextInput } from 'react-native'
import { useLoad } from '../load'
import { useSession } from '../session'
import { useTheme } from '../theme'
import { Btn, Chip, Empty, Loading, Row, Screen, T } from '../ui'
import { FormSheet } from '../FormSheet'
import { MenuField } from '../menu-field'
import { api } from '../api'
import { t } from '../i18n'

const DECISIONS = ['enrol', 'reserve', 'monitor', 'decline']
const DECISION_COLOURS = { enrol: 'lime', reserve: 'cyan', monitor: 'orange', decline: 'red' }
const STATUS_COLOURS = { draft: null, submitted: 'cyan', approved: 'lime', declined: 'red' }
const EVIDENCE_KINDS = ['video', 'doc', 'stats', 'report']

function StatusBanner({ status }) {
  const c = useTheme()
  if (!status) return null
  const col = STATUS_COLOURS[status]
  const key = `scout.rec.status.${status}`
  return (
    <View style={{ backgroundColor: col ? c[`${col}Tint`] ?? c.pinkTint : c.line, borderRadius: 8, padding: 10, marginBottom: 12 }}>
      <T style={{ color: col ? c[col] : c.mute, fontWeight: '700', textAlign: 'center' }}>{t(key)}</T>
    </View>
  )
}

function EvidenceRow({ item }) {
  const c = useTheme()
  const kindIcons = { video: '▶', doc: '📄', stats: '📊', report: '📋' }
  return (
    <Row style={{ gap: 10, alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <T style={{ fontSize: 18 }}>{kindIcons[item.kind] ?? '📎'}</T>
      <View style={{ flex: 1 }}>
        <T style={{ color: c.ink, fontSize: 13 }} numberOfLines={1}>{item.title ?? item.ref_id}</T>
        <T style={{ color: c.mute, fontSize: 11 }}>{item.kind}</T>
      </View>
    </Row>
  )
}

function ConfidenceStepper({ value, onChange }) {
  const c = useTheme()
  return (
    <Row style={{ alignItems: 'center', gap: 16 }}>
      <TouchableOpacity onPress={() => onChange(Math.max(1, value - 1))} accessibilityRole="button" accessibilityLabel="Decrease confidence"
        style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ color: c.ink, fontSize: 20, fontWeight: '700' }}>−</T>
      </TouchableOpacity>
      <View style={{ alignItems: 'center' }}>
        <T style={{ color: c.pink, fontSize: 28, fontWeight: '800' }}>{value}</T>
        <T style={{ color: c.mute, fontSize: 10 }}>/ 10</T>
      </View>
      <TouchableOpacity onPress={() => onChange(Math.min(10, value + 1))} accessibilityRole="button" accessibilityLabel="Increase confidence"
        style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ color: c.ink, fontSize: 20, fontWeight: '700' }}>+</T>
      </TouchableOpacity>
    </Row>
  )
}

export function ScoutingRecommendationsScreen({ route }) {
  const { params = {} } = route ?? {}
  const { entryId, watchlistMemberId } = params
  const c = useTheme()
  const { toast } = useSession()
  const [decision, setDecision] = useState(null)
  const [confidence, setConfidence] = useState(7)
  const [notes, setNotes] = useState('')
  const [showAddEvidence, setShowAddEvidence] = useState(false)
  const [evidenceKind, setEvidenceKind] = useState('video')
  const [evidenceRef, setEvidenceRef] = useState('')
  const [saving, setSaving] = useState(false)

  const endpoint = entryId
    ? `/scouting/prospects/${entryId}/recommendations`
    : `/scouting/watchlist-members/${watchlistMemberId}/recommendations`
  const { data, loading, error, reload } = useLoad(endpoint)

  const rec = data?.recommendation
  const prospect = data?.prospect
  const evidence = data?.evidence ?? []
  const isAdmin = data?.is_admin ?? false

  const canSubmit = !!decision && notes.trim().length > 0

  async function save(action) {
    setSaving(true)
    try {
      if (!rec) {
        await api.post(endpoint, { decision, confidence, notes })
      } else if (action === 'submit') {
        await api.post(`/scouting/recommendations/${rec.id}/submit`, {})
      } else if (action === 'approve') {
        await api.post(`/scouting/recommendations/${rec.id}/approve`, {})
      } else if (action === 'decline') {
        await api.post(`/scouting/recommendations/${rec.id}/decline`, {})
      } else {
        await api.patch(`/scouting/recommendations/${rec.id}`, { decision, confidence, notes })
      }
      toast(t('common.save') + ' ✓')
      reload()
    } catch { toast(t('error.generic')) } finally { setSaving(false) }
  }

  async function addEvidence() {
    if (!rec || !evidenceRef.trim()) return
    setSaving(true)
    try {
      await api.post(`/scouting/recommendations/${rec.id}/evidence`, { kind: evidenceKind, ref_id: evidenceRef.trim() })
      toast(t('scout.rec.evidence') + ' added')
      setShowAddEvidence(false)
      setEvidenceRef('')
      reload()
    } catch { toast(t('error.generic')) } finally { setSaving(false) }
  }

  if (loading) return <Loading />
  if (error) return <Empty label={t('error.generic')} action={reload} />

  const currentDecision = decision ?? rec?.decision
  const currentConfidence = rec ? (rec.confidence ?? confidence) : confidence
  const currentNotes = notes || rec?.notes_plain || ''

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Prospect header */}
        {prospect && (
          <View style={{ backgroundColor: c.paper, borderRadius: 12, padding: 14, marginBottom: 16 }}>
            <T style={{ color: c.ink, fontWeight: '700', fontSize: 16 }}>{prospect.name}</T>
            {prospect.campaign_name && <Chip label={prospect.campaign_name} colour={c.violet} />}
            {prospect.position && <T style={{ color: c.mute, fontSize: 12, marginTop: 4 }}>{prospect.position}</T>}
          </View>
        )}

        <StatusBanner status={rec?.status} />

        {/* Decision chips */}
        <T style={{ color: c.ink, fontWeight: '600', marginBottom: 8 }}>{t('scout.rec.decision')}</T>
        <Row style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {DECISIONS.map((d) => {
            const col = DECISION_COLOURS[d]
            const on = currentDecision === d
            return (
              <TouchableOpacity
                key={d}
                onPress={() => setDecision(d)}
                accessibilityRole="button"
                accessibilityLabel={t(`scout.rec.decision.${d}`)}
                style={{
                  backgroundColor: on ? c[col] : c[`${col}Tint`] ?? c.line,
                  borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8,
                  borderWidth: on ? 0 : 1, borderColor: c[col] ?? c.line,
                }}
              >
                <T style={{ color: on ? '#fff' : c[col] ?? c.ink, fontWeight: '600' }}>
                  {t(`scout.rec.decision.${d}`)}
                </T>
              </TouchableOpacity>
            )
          })}
        </Row>

        {/* Confidence stepper */}
        <T style={{ color: c.ink, fontWeight: '600', marginBottom: 10 }}>{t('scout.rec.confidence')}</T>
        <ConfidenceStepper value={currentConfidence} onChange={setConfidence} />

        {/* Notes */}
        <Row style={{ marginTop: 16, marginBottom: 6, gap: 6, alignItems: 'center' }}>
          <T style={{ color: c.ink, fontWeight: '600' }}>{t('scout.rec.notes')}</T>
          <T style={{ color: c.mute, fontSize: 12 }}>🔒</T>
        </Row>
        <TextInput
          value={currentNotes}
          onChangeText={setNotes}
          placeholder={t('scout.rec.notes')}
          placeholderTextColor={c.mute}
          multiline
          editable={!rec || rec.status === 'draft'}
          style={{ backgroundColor: c.bg, borderRadius: 10, padding: 12, color: c.ink, fontSize: 14, minHeight: 100, marginBottom: 16 }}
          accessibilityLabel={t('scout.rec.notes')}
        />

        {/* Evidence */}
        <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <T style={{ color: c.ink, fontWeight: '600' }}>{t('scout.rec.evidence')}</T>
          {rec && rec.status === 'draft' && (
            <TouchableOpacity onPress={() => setShowAddEvidence(true)} accessibilityRole="button"
              style={{ backgroundColor: c.pinkTint, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
              <T style={{ color: c.pink, fontSize: 12 }}>+ Add</T>
            </TouchableOpacity>
          )}
        </Row>
        {!evidence.length && <T style={{ color: c.mute, fontSize: 13 }}>{t('scout.rec.empty')}</T>}
        {evidence.map((item) => <EvidenceRow key={item.id} item={item} />)}

        {/* Actions */}
        <View style={{ marginTop: 20, gap: 10 }}>
          {(!rec || rec.status === 'draft') && (
            <>
              <Btn label={t('common.save')} onPress={() => save('save')} loading={saving} secondary />
              <Btn label={t('scout.rec.submit')} onPress={() => save('submit')} loading={saving} disabled={!canSubmit} />
            </>
          )}
          {isAdmin && rec?.status === 'submitted' && (
            <Row style={{ gap: 10 }}>
              <Btn label={t('scout.rec.approve')} onPress={() => save('approve')} loading={saving} style={{ flex: 1 }} />
              <Btn label={t('scout.rec.decline_btn')} onPress={() => save('decline')} loading={saving} secondary style={{ flex: 1 }} />
            </Row>
          )}
        </View>
      </ScrollView>

      <FormSheet visible={showAddEvidence} onClose={() => setShowAddEvidence(false)} title={`Add ${t('scout.rec.evidence')}`}>
        <View style={{ gap: 12 }}>
          <T style={{ color: c.ink, fontWeight: '600' }}>Kind</T>
          <Row style={{ gap: 8, flexWrap: 'wrap' }}>
            {EVIDENCE_KINDS.map((k) => (
              <TouchableOpacity key={k} onPress={() => setEvidenceKind(k)} accessibilityRole="button" accessibilityLabel={k}>
                <Chip label={k} colour={evidenceKind === k ? c.pink : c.mute} />
              </TouchableOpacity>
            ))}
          </Row>
          <TextInput value={evidenceRef} onChangeText={setEvidenceRef} placeholder="Reference ID or title" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Reference" />
          <Btn label="Add Evidence" onPress={addEvidence} loading={saving} />
        </View>
      </FormSheet>
    </Screen>
  )
}
