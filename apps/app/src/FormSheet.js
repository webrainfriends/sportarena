import React, { useState } from 'react';
import { View } from 'react-native';
import { Btn, Chip, Field, Sheet, T, Seg } from './ui';
import { c } from './theme';
import { useSession } from './session';

/**
 * fields: [{ key, label, type?: 'text'|'secret'|'multiline'|'number'|'choice', options?, hint?, optional? }]
 * onSubmit(values) -> Promise; throws to show an error.
 */
export function FormSheet({ visible, onClose, title, fields, initial = {}, submitLabel = 'Save', onSubmit, color = c.pink }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { toast } = useSession();
  const set = (k, x) => setV((p) => ({ ...p, [k]: x }));

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const out = {};
      for (const f of fields) {
        let x = f.type === 'choice' ? (v[f.key] ?? f.options[0]?.value ?? f.options[0]) : v[f.key];
        if (x === '' || x === undefined) { if (!f.optional) throw new Error(`${f.label} is required`); continue; }
        out[f.key] = f.type === 'number' ? Number(x) : x;
      }
      const msg = await onSubmit(out);
      setV(initial); onClose(); if (typeof msg === 'string') toast(msg);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      {fields.map((f) => f.type === 'choice' ? (
        <View key={f.key} style={{ gap: 6 }}><T weight="800" size={13}>{f.label}</T><Seg options={f.options} value={v[f.key] ?? f.options[0]?.value ?? f.options[0]} onChange={(x) => set(f.key, x)} color={c.pink} /></View>
      ) : (
        <Field key={f.key} label={f.label + (f.optional ? ' (optional)' : '')} value={String(v[f.key] ?? '')} onChangeText={(x) => set(f.key, x)} secure={f.type === 'secret'} multiline={f.type === 'multiline'} keyboardType={f.type === 'number' ? 'numeric' : undefined} hint={f.hint} placeholder={f.placeholder} />
      ))}
      {err ? <T color={c.red} weight="800">{err}</T> : null}
      <Btn title={submitLabel} onPress={submit} loading={busy} color={color} />
    </Sheet>
  );
}
