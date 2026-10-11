// The history of one appointment or coaching session, as both parties see it (reads the append-only timeline capability).
import React from 'react';
import { View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { Empty, ErrorBox, Loading, Sheet, T } from './ui';
import { c, when } from './theme';

const VERB = { confirmed: 'confirmed it', completed: 'marked it complete', cancelled: 'cancelled it' };

/** What happened, in plain words, for one timeline entry. */
export function describe(e, meId) {
  if (e.from_status === null) return e.backfilled ? 'Recorded before history was kept' : `${e.actor_id === meId ? 'You' : e.actor_name ?? 'Someone'} requested it`;
  if (e.to_status === 'expired') return 'Expired — nobody confirmed it before the start time';
  const who = e.actor_id === meId ? 'You' : e.actor_name ?? 'Someone';
  return `${who} ${VERB[e.to_status] ?? e.to_status}`;
}

export function TimelineSheet({ kind, id, title = 'History', meId, onClose }) {
  const path = kind === 'appointment' ? `/appointments/${id}/timeline` : `/hires/${id}/timeline`;
  const tl = useLoad(() => api.get(path, { limit: 100 }), [path]);
  const entries = tl.data?.entries ?? [];
  return (
    <Sheet visible onClose={onClose} title={title}>
      {tl.loading && !tl.data ? <Loading /> : tl.error ? <ErrorBox error={tl.error} onRetry={tl.reload} />
        : !entries.length ? <Empty emoji="🕘" title="Nothing recorded yet" sub="Every change to this booking will appear here for both of you." />
        : (
          <View accessibilityRole="list" accessibilityLabel="Booking history" style={{ gap: 12 }}>
            {entries.map((e, i) => {
              const refunded = e.to_status !== 'requested' && e.payment_status === 'refunded';
              return (
                <View key={e.id} accessible accessibilityLabel={`${describe(e, meId)}, ${when(e.at)}${e.reason ? `. Reason: ${e.reason}` : ''}${refunded ? '. Payment refunded' : ''}`} style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ alignItems: 'center', width: 14 }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, marginTop: 5, backgroundColor: i === entries.length - 1 ? c.pink : c.violet }} />
                    {i < entries.length - 1 ? <View style={{ flex: 1, width: 2, backgroundColor: c.line, marginTop: 2 }} /> : null}
                  </View>
                  <View style={{ flex: 1, paddingBottom: 4 }}>
                    <T weight="800" size={14}>{describe(e, meId)}</T>
                    <T size={12} color={c.mute}>{when(e.at)}</T>
                    {e.reason ? <T size={13} style={{ marginTop: 2 }}>“{e.reason}”</T> : null}
                    {refunded ? <T size={12} color={c.mute}>Payment refunded</T> : null}
                  </View>
                </View>
              );
            })}
          </View>
        )}
    </Sheet>
  );
}
