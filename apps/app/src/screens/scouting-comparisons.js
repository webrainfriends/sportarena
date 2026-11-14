import React, { useState } from 'react'
import { View, ScrollView, TouchableOpacity } from 'react-native'
import { useLoad } from '../load'
import { useSession } from '../session'
import { useTheme } from '../theme'
import { Btn, Chip, Empty, Loading, Row, Screen, T } from '../ui'
import { FormSheet } from '../FormSheet'
import { MultiMenuField } from '../menu-field'
import { api } from '../api'
import { t } from '../i18n'

const RADAR_AXES = ['Speed', 'Technique', 'Tactical', 'Physical', 'Mental', 'Social']

function AvatarCircle({ name, colour }) {
  const c = useTheme()
  const initials = (name ?? '?').split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
  return (
    <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colour ?? c.pink, alignItems: 'center', justifyContent: 'center' }}>
      <T style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>{initials}</T>
    </View>
  )
}

function AthleteHeader({ athlete, colour }) {
  const c = useTheme()
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingVertical: 10 }}>
      <AvatarCircle name={athlete.name} colour={colour} />
      <T style={{ color: c.ink, fontWeight: '700', fontSize: 13, marginTop: 6, textAlign: 'center' }} numberOfLines={1}>{athlete.name}</T>
      <T style={{ color: c.mute, fontSize: 11, textAlign: 'center' }}>
        {[athlete.position, athlete.club, athlete.age ? `Age ${athlete.age}` : null].filter(Boolean).join(' · ')}
      </T>
    </View>
  )
}

function RadarChart({ athletes }) {
  const c = useTheme()
  const size = 160
  const cx = size / 2
  const cy = size / 2
  const r = 60
  const n = RADAR_AXES.length
  const colours = [c.pink, c.cyan]

  const polygonPoints = (scores) => {
    return RADAR_AXES.map((_, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2
      const score = scores?.[RADAR_AXES[i]] ?? 5
      const pct = score / 10
      const x = cx + r * pct * Math.cos(angle)
      const y = cy + r * pct * Math.sin(angle)
      return `${x},${y}`
    }).join(' ')
  }

  const axisPoints = RADAR_AXES.map((_, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), label: RADAR_AXES[i] }
  })

  return (
    <View style={{ alignItems: 'center', marginVertical: 12 }}>
      <T style={{ color: c.mute, fontSize: 11, marginBottom: 6 }}>{t('scout.comp.radar')}</T>
      {/* SVG-like placeholder using View */}
      <View style={{ width: size, height: size, position: 'relative' }}>
        {/* Axis lines */}
        {axisPoints.map((pt, i) => (
          <View key={i} style={{
            position: 'absolute', left: cx, top: cy, width: 1, height: Math.sqrt((pt.x - cx) ** 2 + (pt.y - cy) ** 2),
            backgroundColor: c.line,
            transform: [{ translateX: -0.5 }, { rotate: `${Math.atan2(pt.y - cy, pt.x - cx) + Math.PI / 2}rad` }, { translateY: 0 }],
          }} />
        ))}
        {/* Athlete score dots */}
        {athletes.map((ath, ai) =>
          RADAR_AXES.map((axis, i) => {
            const angle = (Math.PI * 2 * i) / n - Math.PI / 2
            const score = ath.scores?.[axis] ?? 5
            const pct = score / 10
            const x = cx + r * pct * Math.cos(angle) - 5
            const y = cy + r * pct * Math.sin(angle) - 5
            return (
              <View key={`${ai}-${i}`} style={{
                position: 'absolute', left: x, top: y, width: 10, height: 10, borderRadius: 5,
                backgroundColor: colours[ai % colours.length], opacity: 0.85,
              }} />
            )
          })
        )}
        {/* Axis labels */}
        {axisPoints.map((pt, i) => (
          <T key={i} style={{
            position: 'absolute',
            left: pt.x - 24, top: pt.y - 8, width: 48,
            color: c.mute, fontSize: 9, textAlign: 'center',
          }}>{RADAR_AXES[i]}</T>
        ))}
      </View>
    </View>
  )
}

function MetricTable({ athletes, criteria }) {
  const c = useTheme()
  return (
    <View style={{ marginBottom: 16 }}>
      <T style={{ color: c.mute, fontSize: 11, marginBottom: 6 }}>{t('scout.comp.table')}</T>
      {/* Header */}
      <Row style={{ borderBottomWidth: 2, borderBottomColor: c.line, paddingBottom: 4, marginBottom: 4 }}>
        <T style={{ flex: 2, color: c.mute, fontSize: 11 }}>Criterion</T>
        {athletes.map((a, i) => (
          <T key={i} style={{ flex: 1, color: c.mute, fontSize: 11, textAlign: 'center' }} numberOfLines={1}>{a.name?.split(' ')[0]}</T>
        ))}
        <T style={{ flex: 1, color: c.mute, fontSize: 11, textAlign: 'center' }}>Δ</T>
      </Row>
      {(criteria ?? RADAR_AXES).map((crit) => {
        const scores = athletes.map((a) => a.scores?.[crit] ?? 0)
        const delta = scores.length >= 2 ? scores[0] - scores[1] : null
        return (
          <Row key={crit} style={{ paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.line }}>
            <T style={{ flex: 2, color: c.ink, fontSize: 13 }}>{crit}</T>
            {scores.map((s, i) => (
              <T key={i} style={{ flex: 1, color: c.ink, fontSize: 13, fontWeight: '600', textAlign: 'center' }}>{s || '—'}</T>
            ))}
            <T style={{ flex: 1, color: delta > 0 ? c.lime : delta < 0 ? c.red : c.mute, fontSize: 13, textAlign: 'center', fontWeight: '600' }}>
              {delta !== null ? (delta > 0 ? `+${delta}` : `${delta}`) : '—'}
            </T>
          </Row>
        )
      })}
    </View>
  )
}

function ComparisonView({ comparison, onClose }) {
  const c = useTheme()
  const { data, loading } = useLoad(`/organisations/${comparison.org_id}/scouting/comparisons/${comparison.id}`)
  const athletes = data?.athletes ?? comparison.athletes ?? []
  const colours = [c.pink, c.cyan, c.lime, c.orange]

  if (loading) return <Loading />

  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity onPress={onClose} accessibilityRole="button" style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <T style={{ color: c.pink, fontWeight: '600' }}>‹ {t('scout.comp.title')}</T>
      </TouchableOpacity>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {/* Athlete headers */}
        <Row style={{ gap: 8, marginBottom: 8 }}>
          {athletes.map((a, i) => (
            <AthleteHeader key={a.id ?? i} athlete={a} colour={colours[i % colours.length]} />
          ))}
        </Row>
        <RadarChart athletes={athletes} />
        <MetricTable athletes={athletes} criteria={comparison.criteria} />
        {/* Video evidence */}
        {athletes.some((a) => a.clips?.length) && (
          <View>
            <T style={{ color: c.mute, fontSize: 11, marginBottom: 6 }}>{t('scout.comp.evidence')}</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Row style={{ gap: 8 }}>
                {athletes.flatMap((a) => (a.clips ?? []).map((clip) => (
                  <View key={clip.id} style={{ width: 100, backgroundColor: c.paper, borderRadius: 8, padding: 8, alignItems: 'center' }}>
                    <View style={{ width: '100%', height: 60, backgroundColor: c.line, borderRadius: 6, marginBottom: 4 }} />
                    <T style={{ color: c.ink, fontSize: 11, textAlign: 'center' }} numberOfLines={1}>{clip.title}</T>
                    <T style={{ color: c.mute, fontSize: 10 }}>{a.name?.split(' ')[0]}</T>
                  </View>
                )))}
              </Row>
            </ScrollView>
          </View>
        )}
      </ScrollView>
    </View>
  )
}

export function ScoutingComparisonsScreen({ route }) {
  const { params = {} } = route ?? {}
  const { orgId } = params
  const c = useTheme()
  const { toast } = useSession()
  const [selected, setSelected] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [compName, setCompName] = useState('')
  const [athleteIds, setAthleteIds] = useState([])
  const [saving, setSaving] = useState(false)

  const { data, loading, error, reload } = useLoad(orgId ? `/organisations/${orgId}/scouting/comparisons` : null)
  const { data: athletesData } = useLoad(orgId ? `/organisations/${orgId}/members?role=athlete` : null)

  const comparisons = data?.comparisons ?? []
  const athleteOptions = (athletesData?.members ?? []).map((a) => ({ label: a.display_name, value: a.id }))

  async function create() {
    if (!compName.trim() || athleteIds.length < 2) { toast('Name and ≥2 athletes required'); return }
    setSaving(true)
    try {
      await api.post(`/organisations/${orgId}/scouting/comparisons`, { name: compName.trim(), athlete_ids: athleteIds })
      toast(t('scout.comp.new') + ' ✓')
      setShowNew(false)
      setCompName('')
      setAthleteIds([])
      reload()
    } catch { toast(t('error.generic')) } finally { setSaving(false) }
  }

  if (loading) return <Loading />
  if (error) return <Empty label={t('error.generic')} action={reload} />
  if (selected) return <ComparisonView comparison={selected} onClose={() => setSelected(null)} />

  return (
    <Screen>
      <Row style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <T style={{ color: c.ink, fontSize: 18, fontWeight: '700' }}>{t('scout.comp.title')}</T>
        <Btn label={t('scout.comp.new')} onPress={() => setShowNew(true)} small />
      </Row>
      {!comparisons.length
        ? <Empty label={t('scout.comp.empty')} action={() => setShowNew(true)} actionLabel={t('scout.comp.new')} />
        : (
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {comparisons.map((comp) => (
              <TouchableOpacity key={comp.id} onPress={() => setSelected(comp)} accessibilityRole="button"
                style={{ backgroundColor: c.paper, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                <T style={{ color: c.ink, fontWeight: '700' }}>{comp.name}</T>
                <T style={{ color: c.mute, fontSize: 12, marginTop: 2 }}>{comp.athlete_count ?? 0} athletes</T>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )
      }
      <FormSheet visible={showNew} onClose={() => setShowNew(false)} title={t('scout.comp.new')}>
        <View style={{ gap: 12 }}>
          <TextInput value={compName} onChangeText={setCompName} placeholder="Comparison name" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Name" />
          <MultiMenuField label="Athletes (select 2+)" value={athleteIds} onChange={setAthleteIds} options={athleteOptions} />
          <Btn label={t('scout.comp.new')} onPress={create} loading={saving} />
        </View>
      </FormSheet>
    </Screen>
  )
}
