// Durable encrypted offline queue for the referee (R08). Follows the offline.js player-draft pattern.
// Items stored in refereeStore: { id: UUID, client_key, op_type, payload, payload_enc, fixture_id, occurred_at, seq, status }
// On reconnect: flushes all queued items in one batch POST to /fixtures/:id/referee-sync.
import { AppState, Platform } from 'react-native';
import { refereeStore } from './offline-store';
import { api } from './api';

const MAX_BATCH = 200;
const listeners = new Set();

function notifyAll(state) { for (const fn of listeners) fn(state); }

function getDeviceId() {
  try {
    const k = 'sa_device_id';
    if (Platform.OS !== 'web') {
      // native: generate once and keep in memory per session (secure-store handles persistence in the main queue)
      if (!getDeviceId._native) getDeviceId._native = typeof crypto !== 'undefined' ? crypto.randomUUID() : `d-${Date.now()}`;
      return getDeviceId._native;
    }
    let v = typeof localStorage !== 'undefined' && localStorage.getItem(k);
    if (!v) {
      v = typeof crypto !== 'undefined' ? crypto.randomUUID() : `d-${Date.now()}`;
      try { localStorage.setItem(k, v); } catch { /* private mode */ }
    }
    return v;
  } catch { return 'device-unknown'; }
}

class RefereeQueue {
  constructor() {
    this._seq = 0;
    this._flushing = false;
    this._online = true;
    this._setupConnectivity();
  }

  _setupConnectivity() {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('online', () => { this._online = true; this.flush(); });
      window.addEventListener('offline', () => { this._online = false; notifyAll({ online: false }); });
      this._online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    }
    AppState.addEventListener('change', (s) => {
      if (s === 'active') { this._online = true; this.flush(); }
    });
  }

  async enqueue(fixtureId, opType, payload) {
    const clientKey = `${opType}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const storeId = typeof crypto !== 'undefined' ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const item = {
      id: storeId,
      client_key: clientKey,
      op_type: opType,
      payload,
      fixture_id: fixtureId,
      occurred_at: new Date().toISOString(),
      seq: ++this._seq,
      status: 'queued',
    };
    await refereeStore.write(item);
    notifyAll({ enqueued: clientKey, fixtureId });
    if (this._online) this.flush();
    return clientKey;
  }

  async flush(fixtureId) {
    if (this._flushing) return;
    this._flushing = true;
    try {
      const all = await refereeStore.readAll();
      const queued = all.filter((x) => x.status === 'queued' && (!fixtureId || x.fixture_id === fixtureId));
      if (!queued.length) return;

      const byFixture = {};
      for (const item of queued) {
        (byFixture[item.fixture_id] = byFixture[item.fixture_id] || []).push(item);
      }

      for (const [fxId, items] of Object.entries(byFixture)) {
        const batch = items.sort((a, b) => a.seq - b.seq).slice(0, MAX_BATCH);
        try {
          const res = await api.post(`/fixtures/${fxId}/referee-sync`, {
            device_id: getDeviceId(),
            pack_version: 0,
            device_time: new Date().toISOString(),
            ops: batch.map((x) => ({
              client_key: x.client_key,
              op_type: x.op_type,
              payload_enc: x.payload_enc ?? JSON.stringify(x.payload ?? {}),
              occurred_at: x.occurred_at,
              seq: x.seq,
            })),
          });
          if (res.data?.outcomes) {
            for (const outcome of res.data.outcomes) {
              const item = batch.find((x) => x.client_key === outcome.client_key);
              if (!item) continue;
              if (outcome.status === 'conflict') {
                await refereeStore.write({ ...item, status: 'conflict', conflict_data: outcome.conflict_data });
              } else {
                await refereeStore.erase(item.id);
              }
            }
          }
          notifyAll({ flushed: fxId, clock_drift_ms: res.data?.clock_drift_ms });
        } catch (e) {
          if (e?.response?.data?.code === 'device_revoked') {
            await refereeStore.eraseAll();
            notifyAll({ device_revoked: true });
            return;
          }
          // network error: leave items queued, will retry on next reconnect
        }
      }
    } finally { this._flushing = false; }
  }

  async getStatus(fixtureId) {
    const all = await refereeStore.readAll();
    const mine = all.filter((x) => !fixtureId || x.fixture_id === fixtureId);
    return {
      queued: mine.filter((x) => x.status === 'queued').length,
      conflicts: mine.filter((x) => x.status === 'conflict').length,
      total: mine.length,
      online: this._online,
    };
  }

  async getConflicts(fixtureId) {
    const all = await refereeStore.readAll();
    return all.filter((x) => x.status === 'conflict' && (!fixtureId || x.fixture_id === fixtureId));
  }

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  async beforeSignOut() {
    if (this._online) {
      await Promise.race([this.flush(), new Promise((r) => setTimeout(r, 6000))]);
    }
    await refereeStore.eraseAll();
  }
}

export const refereeQueue = new RefereeQueue();
