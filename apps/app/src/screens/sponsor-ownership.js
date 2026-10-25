// Hand a sponsor brand over to a new owner (#340). One sheet, opened from the existing Sponsors screen ("Your brands") and the
// organisation's Sponsor tab; the server enforces who may hand over and who may receive. The new owner is picked, never typed:
// a brand run by an organisation offers that organisation's staff, an individual brand searches people with the sponsor role.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Field, Loading, Sheet, T, Tag } from '../ui';
import { EntityPicker } from '../entity-picker';
import { explain, LoadError } from '../access';
import { c, day } from '../theme';

const SPONSOR_STAFF = ['owner', 'admin', 'manager', 'finance', 'evaluator', 'legal', 'approver', 'auditor']; // an organisation role that carries a sponsor role

export function HandOverBrand({ brand, visible, onClose, onDone, toast }) {
  const own = useLoad(() => (visible && brand ? api.get(`/sponsors/${brand.id}/ownership`) : Promise.resolve(null)), [visible, brand?.id]);
  const staff = useLoad(() => (visible && brand?.organisation_id ? api.get(`/organisations/${brand.organisation_id}/members`, { limit: 100 }) : Promise.resolve(null)), [visible, brand?.organisation_id]);
  const [pick, setPick] = useState([]);
  const [note, setNote] = useState('');
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const o = own.data;
  const people = brand?.organisation_id ? (staff.data ?? []).filter((m) => SPONSOR_STAFF.includes(m.org_role) && !m.department_id && m.id !== o?.owner?.id) : undefined;
  const reset = () => { setPick([]); setNote(''); setSure(false); };
  const close = () => { reset(); onClose(); };
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/sponsors/${brand.id}/transfer`, { to_user_id: pick[0].id, expected_rev: o.owner_rev, note: note.trim() || undefined });
      toast(`${brand.name} now belongs to ${pick[0].label}`);
      reset(); onDone?.(); onClose();
    } catch (e) { toast(explain(e)); if (e.status === 409) { setSure(false); own.reload(); } } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={close} title={`Hand over ${brand?.name ?? 'brand'}`}>
      {own.error ? <LoadError error={own.error} onRetry={own.reload} /> : !o || (brand?.organisation_id && !staff.data) ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <View style={{ gap: 4 }}>
            <T size={12} weight="800" color={c.mute}>CURRENT OWNER</T>
            <T weight="900">{o.owner.display_name} <T size={13} color={c.mute}>@{o.owner.handle}</T></T>
          </View>
          {!o.can_transfer ? (
            <T size={13} color={c.mute}>{o.blocked ?? 'Only the brand owner or an owner or admin of its organisation can hand this brand over.'}</T>
          ) : !sure ? (
            <>
              <EntityPicker label="New owner" noun={brand?.organisation_id ? 'staff member' : 'sponsor'} role={brand?.organisation_id ? undefined : 'sponsor'} options={people} value={pick} onChange={setPick} />
              {brand?.organisation_id && !people?.length ? <T size={12} color={c.mute}>No other staff member can take it yet: invite someone with a sponsor role (not a coach, and not limited to one department) under People first.</T> : null}
              <Field label="Note for the record (optional)" value={note} onChangeText={setNote} multiline maxLength={300} />
              <View style={{ gap: 4 }}>
                <T size={12} color={c.mute}>• The new owner manages the whole brand, its deals and its contact details.</T>
                <T size={12} color={c.mute}>• {brand?.organisation_id ? 'You keep at least a manager role in the organisation.' : 'You lose access to this brand; the new owner can add you back through an organisation.'}</T>
                <T size={12} color={c.mute}>• Agreements, payments and history stay exactly as they are.</T>
              </View>
              <Btn title="Review hand-over" disabled={!pick.length} onPress={() => setSure(true)} />
            </>
          ) : (
            <>
              <T size={14}>Hand <T size={14} weight="900">{brand.name}</T> from <T size={14} weight="900">{o.owner.display_name}</T> to <T size={14} weight="900">{pick[0]?.label}</T>? They are told straight away, and so are the brand's managers.</T>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setSure(false)} style={{ flex: 1 }} />
                <Btn title="Hand over" color={c.red} loading={busy} onPress={go} style={{ flex: 1 }} />
              </View>
            </>
          )}
          {o.history.length ? (
            <View style={{ gap: 6 }}>
              <T size={12} weight="800" color={c.mute}>PREVIOUS HAND-OVERS</T>
              {o.history.map((h) => (
                <View key={h.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Tag label={day(h.created_at)} />
                  <T size={13}>{h.from_name} → {h.to_name}{h.note ? ` · ${h.note}` : ''}</T>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}
