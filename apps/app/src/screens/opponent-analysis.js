import React, { useState } from 'react'
import { View, ScrollView, TouchableOpacity, TextInput } from 'react-native'
import { useLoad } from '../hooks'
import { useSession } from '../session'
import { useTheme } from '../theme'
import { Btn, Chip, Empty, Loading, Row, Screen, T } from '../ui'
import { FormSheet } from '../FormSheet'
import { api } from '../api'
import { t } from '../i18n'

const THREAT_COLOURS = { high: 'red', medium: 'orange', low: 'cyan' }
const RESULT_COLOURS = { W: 'lime', D: null, L: 'red' }
const SET_PIECE_KINDS = ['corner_attack', 'corner_defence', 'freekick_attack', 'freekick_defence', 'throw_in']

function GameChip({ game }) {
  const c = useTheme()
  const col = RESULT_COLOURS[game.result]
  return (
    <View style={{ backgroundColor: col ? c[`${col}Tint`] ?? c.line : c.line, borderRadius: 10, padding: 10, alignItems: 'center', minWidth: 72 }}>
      <T style={{ color: col ? c[col] : c.mute, fontWeight: '800', fontSize: 16 }}>{game.result ?? '?'}</T>
      <T style={{ color: c.ink, fontSize: 11, fontWeight: '600' }} numberOfLines={1}>{game.opponent_short ?? game.opponent}</T>
      <T style={{ color: c.mute, fontSize: 10 }}>{game.score}</T>
    </View>
  )
}

function KeyPlayerCard({ player, onEdit }) {
  const c = useTheme()
  const col = THREAT_COLOURS[player.threat_level] ?? null
  return (
    <TouchableOpacity
      onPress={() => onEdit(player)}
      accessibilityRole="button"
      accessibilityLabel={player.name}
      style={{ backgroundColor: c.paper, borderRadius: 10, padding: 12, marginBottom: 8 }}
    >
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Row style={{ gap: 8, alignItems: 'center' }}>
            {player.shirt_number && (
              <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}>
                <T style={{ color: c.on, fontSize: 11, fontWeight: '700' }}>{player.shirt_number}</T>
              </View>
            )}
            <T style={{ color: c.ink, fontWeight: '700' }}>{player.name}</T>
          </Row>
          <T style={{ color: c.mute, fontSize: 12, marginTop: 3 }}>{player.position}</T>
          {player.notes && <T style={{ color: c.mute, fontSize: 12, marginTop: 2 }} numberOfLines={2}>{player.notes}</T>}
        </View>
        {col && <Chip label={t(`opp.threat.${player.threat_level}`)} colour={c[col]} />}
      </Row>
    </TouchableOpacity>
  )
}

function SetPieceRow({ item, expanded, onToggle }) {
  const c = useTheme()
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: c.line }}>
      <TouchableOpacity onPress={onToggle} accessibilityRole="button" accessibilityLabel={t(`opp.sp.${item.kind}`)}>
        <Row style={{ paddingVertical: 12, justifyContent: 'space-between', alignItems: 'center' }}>
          <T style={{ color: c.ink, fontWeight: '600' }}>{t(`opp.sp.${item.kind}`)}</T>
          <T style={{ color: c.mute }}>{expanded ? '▲' : '▼'}</T>
        </Row>
      </TouchableOpacity>
      {expanded && (
        <View style={{ paddingBottom: 12 }}>
          {item.pattern_notes ? <T style={{ color: c.mute, fontSize: 13 }}>{item.pattern_notes}</T> : <T style={{ color: c.line }}>No notes yet.</T>}
          {item.clip_title && (
            <View style={{ backgroundColor: c.line, borderRadius: 8, padding: 8, marginTop: 6 }}>
              <T style={{ color: c.mute, fontSize: 12 }}>▶ {item.clip_title}</T>
            </View>
          )}
        </View>
      )}
    </View>
  )
}

function OpponentWorkspace({ profile, orgId, onClose }) {
  const c = useTheme()
  const { toast } = useSession()
  const { data, loading, reload } = useLoad(`/organisations/${orgId}/opponent-analysis/${profile.id}`)
  const [expandedSp, setExpandedSp] = useState(null)
  const [showAddPlayer, setShowAddPlayer] = useState(false)
  const [showEditPlayer, setShowEditPlayer] = useState(null)
  const [showAddGame, setShowAddGame] = useState(false)
  const [playerForm, setPlayerForm] = useState({ name: '', position: '', shirt_number: '', threat_level: 'medium', notes: '' })
  const [gameForm, setGameForm] = useState({ opponent: '', result: 'W', score: '', formation_used: '' })
  const [saving, setSaving] = useState(false)

  const detail = data?.profile ?? profile
  const games = data?.games ?? []
  const players = data?.key_players ?? []
  const setpieces = data?.set_pieces ?? []
  const clips = data?.clips ?? []

  async function addPlayer() {
    if (!playerForm.name.trim()) { toast('Name required'); return }
    setSaving(true)
    try {
      await api.post(`/organisations/${orgId}/opponent-analysis/${profile.id}/key-players`, playerForm)
      toast('Player added')
      setShowAddPlayer(false)
      setPlayerForm({ name: '', position: '', shirt_number: '', threat_level: 'medium', notes: '' })
      reload()
    } catch { toast(t('error.generic')) } finally { setSaving(false) }
  }

  async function addGame() {
    if (!gameForm.opponent.trim()) { toast('Opponent required'); return }
    setSaving(true)
    try {
      await api.post(`/organisations/${orgId}/opponent-analysis/${profile.id}/games`, gameForm)
      toast('Game added')
      setShowAddGame(false)
      setGameForm({ opponent: '', result: 'W', score: '', formation_used: '' })
      reload()
    } catch { toast(t('error.generic')) } finally { setSaving(false) }
  }

  async function exportAnalysis() {
    try {
      await api.get(`/organisations/${orgId}/opponent-analysis/${profile.id}/export`)
      toast(t('opp.export') + ' ✓')
    } catch { toast(t('error.generic')) }
  }

  if (loading) return <Loading />

  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity onPress={onClose} accessibilityRole="button" style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <T style={{ color: c.pink, fontWeight: '600' }}>‹ {t('opp.title')}</T>
      </TouchableOpacity>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Profile header */}
        <View style={{ backgroundColor: c.paper, borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View>
              <T style={{ color: c.ink, fontWeight: '800', fontSize: 18 }}>{detail.opponent_name}</T>
              <T style={{ color: c.mute, fontSize: 13 }}>{detail.season}</T>
              {detail.analyst_name && <T style={{ color: c.mute, fontSize: 12 }}>{t('opp.analyst')}: {detail.analyst_name}</T>}
            </View>
            {detail.formation && <Chip label={detail.formation} colour={c.violet} />}
          </Row>
        </View>

        {/* Recent games */}
        <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <T style={{ color: c.ink, fontWeight: '600' }}>{t('opp.games')}</T>
          <TouchableOpacity onPress={() => setShowAddGame(true)} accessibilityRole="button"
            style={{ backgroundColor: c.pinkTint, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
            <T style={{ color: c.pink, fontSize: 12 }}>+ Add</T>
          </TouchableOpacity>
        </Row>
        {!games.length
          ? <T style={{ color: c.mute, marginBottom: 16 }}>No games recorded.</T>
          : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
              <Row style={{ gap: 8 }}>
                {games.map((g) => <GameChip key={g.id} game={g} />)}
              </Row>
            </ScrollView>
          )
        }

        {/* Key players */}
        <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <T style={{ color: c.ink, fontWeight: '600' }}>{t('opp.key_players')}</T>
          <TouchableOpacity onPress={() => setShowAddPlayer(true)} accessibilityRole="button"
            style={{ backgroundColor: c.pinkTint, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
            <T style={{ color: c.pink, fontSize: 12 }}>+ Add</T>
          </TouchableOpacity>
        </Row>
        {!players.length && <T style={{ color: c.mute, marginBottom: 16 }}>No key players yet.</T>}
        {players.map((p) => <KeyPlayerCard key={p.id} player={p} onEdit={setShowEditPlayer} />)}

        {/* Set pieces */}
        <T style={{ color: c.ink, fontWeight: '600', marginTop: 8, marginBottom: 4 }}>{t('opp.set_pieces')}</T>
        {setpieces.length === 0 && SET_PIECE_KINDS.map((kind) => (
          <SetPieceRow key={kind} item={{ kind, pattern_notes: null }} expanded={expandedSp === kind} onToggle={() => setExpandedSp(expandedSp === kind ? null : kind)} />
        ))}
        {setpieces.map((sp) => (
          <SetPieceRow key={sp.id} item={sp} expanded={expandedSp === sp.id} onToggle={() => setExpandedSp(expandedSp === sp.id ? null : sp.id)} />
        ))}

        {/* Video playlist */}
        {clips.length > 0 && (
          <View style={{ marginTop: 16 }}>
            <T style={{ color: c.ink, fontWeight: '600', marginBottom: 8 }}>{t('opp.playlist')}</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Row style={{ gap: 8 }}>
                {clips.map((clip) => (
                  <View key={clip.id} style={{ width: 100, backgroundColor: c.paper, borderRadius: 8, padding: 8 }}>
                    <View style={{ width: '100%', height: 60, backgroundColor: c.line, borderRadius: 6, marginBottom: 4 }} />
                    <T style={{ color: c.ink, fontSize: 11, textAlign: 'center' }} numberOfLines={1}>{clip.title}</T>
                  </View>
                ))}
              </Row>
            </ScrollView>
          </View>
        )}

        <Btn label={t('opp.export')} onPress={exportAnalysis} style={{ marginTop: 20 }} secondary />
      </ScrollView>

      {/* Add player */}
      <FormSheet visible={showAddPlayer} onClose={() => setShowAddPlayer(false)} title={`Add ${t('opp.key_players')}`}>
        <View style={{ gap: 10 }}>
          {[['name', 'Player Name'], ['position', 'Position'], ['shirt_number', 'Shirt #']].map(([k, pl]) => (
            <TextInput key={k} value={playerForm[k]} onChangeText={(v) => setPlayerForm((f) => ({ ...f, [k]: v }))}
              placeholder={pl} placeholderTextColor={c.mute}
              style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel={pl} />
          ))}
          <T style={{ color: c.ink, fontWeight: '600' }}>Threat</T>
          <Row style={{ gap: 8 }}>
            {['high', 'medium', 'low'].map((tl) => (
              <TouchableOpacity key={tl} onPress={() => setPlayerForm((f) => ({ ...f, threat_level: tl }))} accessibilityRole="button">
                <Chip label={t(`opp.threat.${tl}`)} colour={playerForm.threat_level === tl ? c[THREAT_COLOURS[tl]] : c.mute} />
              </TouchableOpacity>
            ))}
          </Row>
          <TextInput value={playerForm.notes} onChangeText={(v) => setPlayerForm((f) => ({ ...f, notes: v }))}
            placeholder="Notes" placeholderTextColor={c.mute} multiline
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, minHeight: 60 }} accessibilityLabel="Notes" />
          <Btn label="Add Player" onPress={addPlayer} loading={saving} />
        </View>
      </FormSheet>

      {/* Add game */}
      <FormSheet visible={showAddGame} onClose={() => setShowAddGame(false)} title={`Add ${t('opp.games')}`}>
        <View style={{ gap: 10 }}>
          <TextInput value={gameForm.opponent} onChangeText={(v) => setGameForm((f) => ({ ...f, opponent: v }))}
            placeholder="Opponent" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Opponent" />
          <Row style={{ gap: 8 }}>
            {['W', 'D', 'L'].map((r) => (
              <TouchableOpacity key={r} onPress={() => setGameForm((f) => ({ ...f, result: r }))} accessibilityRole="button">
                <Chip label={r} colour={gameForm.result === r ? c[RESULT_COLOURS[r]] ?? c.mute : c.mute} />
              </TouchableOpacity>
            ))}
          </Row>
          <TextInput value={gameForm.score} onChangeText={(v) => setGameForm((f) => ({ ...f, score: v }))}
            placeholder="Score (e.g. 2-1)" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Score" />
          <Btn label="Add Game" onPress={addGame} loading={saving} />
        </View>
      </FormSheet>
    </View>
  )
}

export function OpponentAnalysisScreen({ route }) {
  const { params = {} } = route ?? {}
  const { orgId, season } = params
  const c = useTheme()
  const { toast } = useSession()
  const [selected, setSelected] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ opponent_name: '', season: season ?? '', formation: '', style_notes: '' })
  const [saving, setSaving] = useState(false)

  const { data, loading, error, reload } = useLoad(
    orgId ? `/organisations/${orgId}/opponent-analysis${season ? `?season=${season}` : ''}` : null
  )
  const profiles = data?.profiles ?? []

  async function create() {
    if (!form.opponent_name.trim()) { toast('Opponent name required'); return }
    setSaving(true)
    try {
      await api.post(`/organisations/${orgId}/opponent-analysis`, form)
      toast(t('opp.new') + ' ✓')
      setShowNew(false)
      setForm({ opponent_name: '', season: season ?? '', formation: '', style_notes: '' })
      reload()
    } catch { toast(t('error.generic')) } finally { setSaving(false) }
  }

  if (loading) return <Loading />
  if (error) return <Empty label={t('error.generic')} action={reload} />
  if (selected) return <OpponentWorkspace profile={selected} orgId={orgId} onClose={() => setSelected(null)} />

  return (
    <Screen>
      <Row style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <T style={{ color: c.ink, fontSize: 18, fontWeight: '700' }}>{t('opp.title')}</T>
      </Row>
      {!profiles.length
        ? <Empty label={t('opp.empty')} action={() => setShowNew(true)} actionLabel={t('opp.new')} />
        : (
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {profiles.map((p) => (
              <TouchableOpacity key={p.id} onPress={() => setSelected(p)} accessibilityRole="button"
                style={{ backgroundColor: c.paper, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <T style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>{p.opponent_name}</T>
                    <T style={{ color: c.mute, fontSize: 12, marginTop: 2 }}>{p.season}</T>
                    <T style={{ color: c.mute, fontSize: 12 }}>{p.analyst_name}</T>
                  </View>
                  <Row style={{ gap: 6 }}>
                    {p.formation && <Chip label={p.formation} colour={c.violet} />}
                    <T style={{ color: c.mute }}> ›</T>
                  </Row>
                </Row>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )
      }
      {/* FAB */}
      <TouchableOpacity
        onPress={() => setShowNew(true)}
        accessibilityLabel={t('opp.new')}
        style={{ position: 'absolute', bottom: 24, insetInlineEnd: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}
      >
        <T style={{ color: c.on, fontSize: 28 }}>+</T>
      </TouchableOpacity>
      <FormSheet visible={showNew} onClose={() => setShowNew(false)} title={t('opp.new')}>
        <View style={{ gap: 10 }}>
          <TextInput value={form.opponent_name} onChangeText={(v) => setForm((f) => ({ ...f, opponent_name: v }))}
            placeholder="Opponent name" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Opponent name" />
          <TextInput value={form.season} onChangeText={(v) => setForm((f) => ({ ...f, season: v }))}
            placeholder="Season (e.g. 2026/27)" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Season" />
          <TextInput value={form.formation} onChangeText={(v) => setForm((f) => ({ ...f, formation: v }))}
            placeholder="Formation (e.g. 4-3-3)" placeholderTextColor={c.mute}
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink }} accessibilityLabel="Formation" />
          <TextInput value={form.style_notes} onChangeText={(v) => setForm((f) => ({ ...f, style_notes: v }))}
            placeholder="Style notes" placeholderTextColor={c.mute} multiline
            style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, minHeight: 60 }} accessibilityLabel="Style notes" />
          <Btn label={t('common.save')} onPress={create} loading={saving} />
        </View>
      </FormSheet>
    </Screen>
  )
}
