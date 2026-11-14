import React, { useState } from 'react'
import { View, ScrollView, TouchableOpacity, TextInput, Platform } from 'react-native'
import { useLoad } from '../hooks'
import { useSession } from '../session'
import { useTheme } from '../theme'
import { Btn, Chip, Empty, Loading, Row, Screen, T } from '../ui'
import { FormSheet } from '../FormSheet'
import { api } from '../api'
import { t } from '../i18n'

const TOOLS = [
  { key: 'line', label: t => t('vtele.tools.line') },
  { key: 'arrow', label: t => t('vtele.tools.arrow') },
  { key: 'zone', label: t => t('vtele.tools.zone') },
  { key: 'marker', label: t => t('vtele.tools.marker') },
  { key: 'text', label: t => t('vtele.tools.text') },
  { key: 'freeze', label: t => t('vtele.tools.freeze') },
]

const COLOURS = ['#ef4444', '#3b82f6', '#eab308', '#ffffff', '#22c55e']

function ToolBtn({ tool, active, onPress }) {
  const c = useTheme()
  return (
    <TouchableOpacity
      onPress={() => onPress(tool.key)}
      accessibilityRole="button"
      accessibilityLabel={tool.label(t)}
      style={{
        backgroundColor: active ? c.pink : c.paper,
        borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
        marginBottom: 6, alignItems: 'center',
      }}
    >
      <T style={{ color: active ? c.on : c.ink, fontWeight: active ? '700' : '400', fontSize: 13 }}>
        {tool.label(t)}
      </T>
    </TouchableOpacity>
  )
}

function ColourSwatch({ colour, active, onPress }) {
  const c = useTheme()
  return (
    <TouchableOpacity
      onPress={() => onPress(colour)}
      accessibilityRole="button"
      accessibilityLabel={`Colour ${colour}`}
      style={{
        width: 28, height: 28, borderRadius: 14, backgroundColor: colour,
        borderWidth: active ? 3 : 1,
        borderColor: active ? c.pink : c.line,
      }}
    />
  )
}

function ShapeRow({ shape }) {
  const c = useTheme()
  return (
    <Row style={{ gap: 8, alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: shape.colour ?? '#3b82f6' }} />
      <T style={{ color: c.ink, flex: 1, fontSize: 13 }}>{shape.shape_type ?? 'shape'}</T>
      <T style={{ color: c.mute, fontSize: 11 }}>Layer {shape.layer ?? 1}</T>
    </Row>
  )
}

export function VideoTelestrationScreen({ route }) {
  const { params = {} } = route ?? {}
  const { videoId } = params
  const c = useTheme()
  const { toast } = useSession()
  const [activeTool, setActiveTool] = useState('arrow')
  const [activeColour, setActiveColour] = useState('#3b82f6')
  const [selectedFrameId, setSelectedFrameId] = useState(null)
  const [showAddFrame, setShowAddFrame] = useState(false)
  const [frameTitle, setFrameTitle] = useState('')
  const [timestampMs, setTimestampMs] = useState(0)
  const [saving, setSaving] = useState(false)

  const { data: framesData, loading, error, reload } = useLoad(
    videoId ? `/me/videos/${videoId}/telestration-frames` : null
  )
  const { data: shapesData, reload: reloadShapes } = useLoad(
    selectedFrameId ? `/video/telestration-frames/${selectedFrameId}/shapes` : null
  )

  const frames = framesData?.frames ?? []
  const shapes = shapesData?.shapes ?? []
  const isPhone = Platform.OS !== 'web'

  async function addFrame() {
    if (!frameTitle.trim()) return
    setSaving(true)
    try {
      const res = await api.post(`/me/videos/${videoId}/telestration-frames`, {
        timestamp_ms: timestampMs,
        title: frameTitle.trim(),
      })
      setSelectedFrameId(res.id)
      setFrameTitle('')
      setShowAddFrame(false)
      reload()
      toast(t('vtele.frame.add') + ' ✓')
    } catch {
      toast(t('error.generic'))
    } finally {
      setSaving(false)
    }
  }

  async function addShape() {
    if (!selectedFrameId) { toast('Select a frame first'); return }
    setSaving(true)
    try {
      await api.post(`/video/telestration-frames/${selectedFrameId}/shapes`, {
        shape_type: activeTool,
        coords_enc: JSON.stringify({ x1: 10, y1: 10, x2: 90, y2: 90 }),
        colour: activeColour,
        layer: 1,
      })
      reloadShapes()
      toast('Shape added')
    } catch {
      toast(t('error.generic'))
    } finally {
      setSaving(false)
    }
  }

  async function exportFrame() {
    if (!selectedFrameId) return
    try {
      await api.get(`/video/telestration-frames/${selectedFrameId}/export`)
      toast(t('vtele.export') + ' ✓')
    } catch {
      toast(t('error.generic'))
    }
  }

  if (loading) return <Loading />

  const toolPalette = (
    <View style={{ gap: 0, padding: 8 }}>
      <T style={{ color: c.mute, fontSize: 11, marginBottom: 4 }}>Tools</T>
      {TOOLS.map((tool) => (
        <ToolBtn key={tool.key} tool={tool} active={activeTool === tool.key} onPress={setActiveTool} />
      ))}
      <T style={{ color: c.mute, fontSize: 11, marginTop: 8, marginBottom: 4 }}>Colour</T>
      <Row style={{ gap: 6, flexWrap: 'wrap' }}>
        {COLOURS.map((col) => (
          <ColourSwatch key={col} colour={col} active={activeColour === col} onPress={setActiveColour} />
        ))}
      </Row>
    </View>
  )

  return (
    <Screen>
      <T style={{ color: c.ink, fontSize: 18, fontWeight: '700', marginHorizontal: 16, marginTop: 16, marginBottom: 8 }}>{t('vtele.title')}</T>
      {isPhone ? (
        // Phone: stacked layout
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          {/* Video player */}
          <View style={{ backgroundColor: '#111827', margin: 16, borderRadius: 12, aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ color: '#fff', fontSize: 24 }}>▶</T>
            {selectedFrameId && shapes.map((s) => (
              <View key={s.id} style={{ position: 'absolute', top: 20, left: 20, width: 20, height: 20, borderRadius: 2, borderWidth: 2, borderColor: s.colour ?? '#3b82f6' }} />
            ))}
          </View>
          {/* Tool palette row */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: 16, marginBottom: 8 }}>
            <Row style={{ gap: 6 }}>
              {TOOLS.map((tool) => (
                <TouchableOpacity
                  key={tool.key}
                  onPress={() => setActiveTool(tool.key)}
                  accessibilityRole="button"
                  accessibilityLabel={tool.label(t)}
                  style={{ backgroundColor: activeTool === tool.key ? c.pink : c.paper, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}
                >
                  <T style={{ color: activeTool === tool.key ? c.on : c.ink, fontSize: 13 }}>{tool.label(t)}</T>
                </TouchableOpacity>
              ))}
            </Row>
          </ScrollView>
          <Row style={{ gap: 6, marginHorizontal: 16, marginBottom: 12 }}>
            {COLOURS.map((col) => (
              <ColourSwatch key={col} colour={col} active={activeColour === col} onPress={setActiveColour} />
            ))}
          </Row>
          {framesPart()}
        </ScrollView>
      ) : (
        // Tablet/desktop: side-by-side
        <Row style={{ flex: 1, gap: 0 }}>
          <View style={{ width: 160, borderEndWidth: 1, borderEndColor: c.line }}>
            {toolPalette}
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ backgroundColor: '#111827', margin: 16, borderRadius: 12, aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center' }}>
              <T style={{ color: '#fff', fontSize: 32 }}>▶</T>
              {selectedFrameId && shapes.map((s) => (
                <View key={s.id} style={{ position: 'absolute', top: 20, left: 20, width: 20, height: 20, borderRadius: 2, borderWidth: 2, borderColor: s.colour ?? '#3b82f6' }} />
              ))}
            </View>
            <ScrollView>{framesPart()}</ScrollView>
          </View>
        </Row>
      )}

      <FormSheet visible={showAddFrame} onClose={() => setShowAddFrame(false)} title={t('vtele.frame.add')}>
        <T style={{ color: c.ink, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>{t('vtele.frame.title')}</T>
        <TextInput
          value={frameTitle}
          onChangeText={setFrameTitle}
          placeholder={t('vtele.frame.title')}
          placeholderTextColor={c.mute}
          style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, fontSize: 14, marginBottom: 12 }}
          accessibilityLabel={t('vtele.frame.title')}
        />
        <Btn label={t('vtele.frame.add')} onPress={addFrame} loading={saving} />
      </FormSheet>
    </Screen>
  )

  function framesPart() {
    return (
      <View style={{ paddingHorizontal: 16 }}>
        {/* Frame chips */}
        <Row style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {frames.map((f) => (
            <TouchableOpacity
              key={f.id}
              onPress={() => setSelectedFrameId(f.id)}
              accessibilityRole="button"
              accessibilityLabel={f.title}
              style={{ backgroundColor: selectedFrameId === f.id ? c.pink : c.paper, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 }}
            >
              <T style={{ color: selectedFrameId === f.id ? c.on : c.ink, fontSize: 12 }}>{f.title}</T>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            onPress={() => setShowAddFrame(true)}
            accessibilityRole="button"
            style={{ backgroundColor: c.pinkTint, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 }}
          >
            <T style={{ color: c.pink, fontSize: 12 }}>+ {t('vtele.frame.add')}</T>
          </TouchableOpacity>
        </Row>
        {!frames.length && <Empty label={t('vtele.empty')} />}
        {/* Shapes list */}
        {selectedFrameId && (
          <View>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <T style={{ color: c.mute, fontSize: 11 }}>Shapes ({shapes.length})</T>
              <Row style={{ gap: 8 }}>
                <TouchableOpacity onPress={addShape} accessibilityRole="button" style={{ backgroundColor: c.pinkTint, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
                  <T style={{ color: c.pink, fontSize: 12 }}>+ Add {activeTool}</T>
                </TouchableOpacity>
                <TouchableOpacity onPress={exportFrame} accessibilityRole="button" style={{ backgroundColor: c.cyanTint, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
                  <T style={{ color: c.cyan, fontSize: 12 }}>{t('vtele.export')}</T>
                </TouchableOpacity>
              </Row>
            </Row>
            {shapes.map((s) => <ShapeRow key={s.id} shape={s} />)}
          </View>
        )}
      </View>
    )
  }
}
