// Small helpers shared by the front-desk screens: money entry, sharing a receipt, and the "ask a manager" retry loop.
import React, { useState } from 'react';
import { Platform, Share } from 'react-native';
import { Btn, Field, Sheet, T } from '../ui';
import { c } from '../theme';

export const digitsOf = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
export const toMinor = (text, cur) => { if (String(text ?? '').trim() === '') return null; const n = Number(String(text).replace(/,/g, '')); return n >= 0 && Number.isFinite(n) ? Math.round(n * 10 ** digitsOf(cur)) : null; };
export const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const shareText = async (message, toast) => {
  try {
    if (Platform.OS === 'web') {
      if (navigator.share) await navigator.share({ text: message });
      else { await navigator.clipboard.writeText(message); toast('Copied — paste it into a message'); }
    } else await Share.share({ message });
  } catch { /* the person closed the share sheet */ }
};

/** Asks for a manager's code up front (before anything is created) and resolves with it; rejects if the person backs out. */
export const askApproval = (run, kind) => run((a) => (a ? Promise.resolve(a) : Promise.reject(Object.assign(new Error('A manager approval is needed'), { code: 'approval_required', details: { kind } }))));

/** Runs an action; if the server says a manager must approve it, asks for the manager's 6-digit code and tries again with it. */
export function useApproval() {
  const [ask, setAsk] = useState(null);
  const [code, setCode] = useState('');
  const run = async (fn) => {
    try { return await fn(undefined); } catch (e) {
      if (e.code !== 'approval_required' && e.code !== 'approval_invalid') throw e;
      setCode('');
      const got = await new Promise((resolve) => setAsk({ resolve, kind: e.details?.kind, wrong: e.code === 'approval_invalid' }));
      setAsk(null);
      if (!got) throw e;
      return fn(got);
    }
  };
  const sheet = (
    <Sheet visible={!!ask} onClose={() => ask?.resolve(null)} title="Manager approval">
      <T color={c.mute} size={13}>{ask?.wrong ? 'That code did not work (it may be used, expired or too small). ' : ''}A manager needs to approve this {String(ask?.kind ?? 'action').replace('_', '-')}. Ask them to open Front desk → Rules → Approve, then type the 6-digit code they show you.</T>
      <Field label="Approval code" value={code} onChangeText={(x) => setCode(x.replace(/[^0-9]/g, '').slice(0, 6))} keyboardType="number-pad" maxLength={6} accessibilityLabel="Manager approval code" />
      <Btn title="Use this approval" disabled={code.length !== 6} onPress={() => ask?.resolve(code)} />
    </Sheet>
  );
  return [run, sheet];
}

