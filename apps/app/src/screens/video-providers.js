import React, { useState } from 'react'
import { View, ScrollView, TouchableOpacity, TextInput } from 'react-native'
import { useLoad } from '../hooks'
import { useSession } from '../session'
import { useTheme } from '../theme'
import { Btn, Chip, Empty, Loading, Row, Screen, T } from '../ui'
import { FormSheet } from '../FormSheet'
import { api } from '../api'
import { t } from '../i18n'

const PROVIDERS = [
  { key: 'hudl', name: 'Hudl', category: 'Video Analysis' },
  { key: 'veo', name: 'Veo', category: 'AI Camera' },
  { key: 'catapult', name: 'Catapult', category: 'Performance' },
  { key: 'statsperform', name: 'StatsPerform', category: 'Data & AI' },
  { key: 'youtube', name: 'YouTube', category: 'Video' },
  { key: 'vimeo', name: 'Vimeo', category: 'Video' },
]

function ProviderCard({ provider, status, orgId, onConnect, onSync, onDisconnect }) {
  const c = useTheme()
  const connected = status?.connected ?? false
  const syncing = status?.syncing ?? false
  const lastSynced = status?.last_synced_label

  return (
    <View style={{ backgroundColor: c.paper, borderRadius: 12, padding: 14, marginBottom: 10 }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <View>
          <Row style={{ gap: 8, alignItems: 'center' }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: connected ? c.lime : c.mute }} />
            <T style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>{provider.name}</T>
          </Row>
          <T style={{ color: c.mute, fontSize: 12, marginTop: 2 }}>{provider.category}</T>
          {lastSynced && <T style={{ color: c.mute, fontSize: 11 }}>{t('vprov.last_synced', { time: lastSynced })}</T>}
        </View>
        <Chip label={connected ? t('vhub.provider.connected') : 'Not connected'} colour={connected ? c.lime : c.mute} />
      </Row>
      <Row style={{ gap: 8 }}>
        {!connected && (
          <Btn label={t('vprov.connect')} onPress={() => onConnect(provider)} small />
        )}
        {connected && (
          <>
            <Btn label={syncing ? t('vprov.syncing') : t('vprov.sync')} onPress={() => onSync(provider)} small disabled={syncing} />
            <Btn label={t('vprov.disconnect')} onPress={() => onDisconnect(provider)} small secondary />
          </>
        )}
      </Row>
    </View>
  )
}

function SourceRow({ source, provider, orgId, onImport }) {
  const c = useTheme()
  return (
    <Row style={{ gap: 10, alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <View style={{ flex: 1 }}>
        <T style={{ color: c.ink, fontSize: 13 }} numberOfLines={1}>{source.title ?? source.external_id}</T>
        <T style={{ color: c.mute, fontSize: 11 }}>{source.duration_label} · {source.sync_state}</T>
      </View>
      {!source.imported && (
        <TouchableOpacity onPress={() => onImport(source)} accessibilityRole="button"
          style={{ backgroundColor: c.pinkTint, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
          <T style={{ color: c.pink, fontSize: 12 }}>{t('vprov.import')}</T>
        </TouchableOpacity>
      )}
      {source.imported && <Chip label="Imported" colour={c.lime} />}
    </Row>
  )
}

export function VideoProvidersScreen({ route }) {
  const { params = {} } = route ?? {}
  const { orgId } = params
  const c = useTheme()
  const { toast } = useSession()
  const [connectingProvider, setConnectingProvider] = useState(null)
  const [token, setToken] = useState('')
  const [selectedProvider, setSelectedProvider] = useState(null)
  const [savingConnect, setSavingConnect] = useState(false)
  const [syncingKey, setSyncingKey] = useState(null)

  const { data: statusData, loading, error, reload } = useLoad(orgId ? `/organisations/${orgId}/video/providers/status` : null)
  const { data: sourcesData, reload: reloadSources } = useLoad(
    selectedProvider && orgId ? `/organisations/${orgId}/video/providers/${selectedProvider}/sources` : null
  )

  const statuses = statusData?.providers ?? {}
  const sources = sourcesData?.sources ?? []

  async function connect(provider) {
    if (!token.trim()) { toast(t('vprov.token') + ' required'); return }
    setSavingConnect(true)
    try {
      await api.post(`/organisations/${orgId}/video/providers/${provider.key}/connect`, { token })
      toast(t('vprov.connect') + ' ✓')
      setConnectingProvider(null)
      setToken('')
      reload()
    } catch { toast(t('error.generic')) } finally { setSavingConnect(false) }
  }

  async function disconnect(provider) {
    try {
      await api.post(`/organisations/${orgId}/video/providers/${provider.key}/disconnect`, {})
      toast(t('vprov.disconnect') + ' ✓')
      reload()
    } catch { toast(t('error.generic')) }
  }

  async function sync(provider) {
    setSyncingKey(provider.key)
    try {
      await api.post(`/organisations/${orgId}/video/providers/${provider.key}/sync`, {})
      toast(t('vprov.sync') + ' started')
      reload()
    } catch { toast(t('error.generic')) } finally { setSyncingKey(null) }
  }

  async function importSource(source) {
    try {
      await api.post(`/organisations/${orgId}/video/providers/${selectedProvider}/import`, { external_id: source.external_id })
      toast(t('vprov.import') + ' ✓')
      reloadSources()
    } catch { toast(t('error.generic')) }
  }

  if (loading) return <Loading />
  if (error) return <Empty label={t('error.generic')} action={reload} />

  return (
    <Screen>
      <T style={{ color: c.ink, fontSize: 18, fontWeight: '700', marginHorizontal: 16, marginTop: 16, marginBottom: 12 }}>{t('vprov.title')}</T>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
        {PROVIDERS.map((prov) => {
          const status = statuses[prov.key] ?? {}
          return (
            <ProviderCard
              key={prov.key}
              provider={prov}
              status={{ ...status, syncing: syncingKey === prov.key }}
              orgId={orgId}
              onConnect={(p) => { setConnectingProvider(p); setToken('') }}
              onSync={sync}
              onDisconnect={disconnect}
            />
          )
        })}

        {/* Sources section */}
        <T style={{ color: c.ink, fontWeight: '600', marginTop: 8, marginBottom: 8 }}>{t('vprov.sources')}</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
          <Row style={{ gap: 8 }}>
            {PROVIDERS.filter((p) => statuses[p.key]?.connected).map((p) => (
              <TouchableOpacity
                key={p.key}
                onPress={() => setSelectedProvider(selectedProvider === p.key ? null : p.key)}
                accessibilityRole="button"
                style={{ backgroundColor: selectedProvider === p.key ? c.pink : c.paper, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7 }}
              >
                <T style={{ color: selectedProvider === p.key ? c.on : c.ink, fontSize: 13 }}>{p.name}</T>
              </TouchableOpacity>
            ))}
          </Row>
        </ScrollView>
        {selectedProvider && (
          sources.length === 0
            ? <T style={{ color: c.mute }}>{t('vprov.empty')}</T>
            : sources.map((s) => <SourceRow key={s.external_id} source={s} provider={selectedProvider} orgId={orgId} onImport={importSource} />)
        )}
        {!selectedProvider && !PROVIDERS.some((p) => statuses[p.key]?.connected) && (
          <T style={{ color: c.mute }}>{t('vprov.empty')}</T>
        )}
      </ScrollView>

      {/* Connect sheet */}
      <FormSheet visible={!!connectingProvider} onClose={() => setConnectingProvider(null)} title={`${t('vprov.connect')} ${connectingProvider?.name ?? ''}`}>
        <T style={{ color: c.mute, marginBottom: 10 }}>
          Enter your {connectingProvider?.name} API token or key. It is stored encrypted and never returned in responses.
        </T>
        <T style={{ color: c.ink, fontWeight: '600', marginBottom: 6 }}>{t('vprov.token')}</T>
        <TextInput
          value={token}
          onChangeText={setToken}
          placeholder={t('vprov.token')}
          placeholderTextColor={c.mute}
          secureTextEntry
          style={{ backgroundColor: c.bg, borderRadius: 8, padding: 10, color: c.ink, marginBottom: 14 }}
          accessibilityLabel={t('vprov.token')}
        />
        <Btn label={t('vprov.connect')} onPress={() => connect(connectingProvider)} loading={savingConnect} />
      </FormSheet>
    </Screen>
  )
}
