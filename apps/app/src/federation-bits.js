// Federation OS (#475): small layout pieces shared by the workspace screens (hero, two-column, pager, list rows, switches).
import React from 'react';
import { Pressable, Switch, View } from 'react-native';
import { Btn, Card, GradCard, T, Tag } from './ui';
import { useLayout } from './layout';
import { StatusTag, LEVEL_LABEL, jurisdiction, ROLE_LABEL } from './federation-ui';
import { c, grad } from './theme';

/** Phone: stacked. Tablet and desktop: side by side. */
export function Cols({ a, b, ratio = [1, 1] }) {
  const { tablet } = useLayout();
  if (!tablet) return <View style={{ gap: 12 }}>{a}{b}</View>;
  return <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}><View style={{ flex: ratio[0], gap: 12 }}>{a}</View><View style={{ flex: ratio[1], gap: 12 }}>{b}</View></View>;
}

export function Hero({ body, me, children }) {
  const roles = [...(me?.admin ? ['Owner / admin'] : []), ...(me?.roles ?? []).map((r) => ROLE_LABEL[r] ?? r)];
  return (
    <GradCard colors={grad.hero} pad={20}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Tag label={LEVEL_LABEL[body.level] ?? body.level} color={c.cyan} />
        <Tag label={body.abbreviation} color={c.violetSoft} />
        {body.status !== 'active' ? <StatusTag status={body.status} /> : null}
      </View>
      <T size={26} weight="800" color="#fff" style={{ marginTop: 10, letterSpacing: -0.6 }} accessibilityRole="header">{body.name}</T>
      {jurisdiction(body) ? <T size={13} color="rgba(255,255,255,0.78)" style={{ marginTop: 2 }}>{jurisdiction(body)}</T> : null}
      {roles.length ? <T size={12} color="rgba(255,255,255,0.78)" style={{ marginTop: 8 }}>You: {roles.join(' · ')}{me?.read_only_via_parent ? ' (read-only view from a body above)' : ''}</T> : null}
      {children}
    </GradCard>
  );
}

export function Pager({ total, offset, limit, onOffset, busy }) {
  if (!total || total <= limit) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Btn small title="Previous" color={c.paper} ink={c.ink} disabled={offset === 0 || busy} onPress={() => onOffset(Math.max(0, offset - limit))} />
      <T size={12} color={c.mute} accessibilityLiveRegion="polite">{offset + 1}–{Math.min(offset + limit, total)} of {total}</T>
      <Btn small title="Next" color={c.paper} ink={c.ink} disabled={offset + limit >= total || busy} onPress={() => onOffset(offset + limit)} />
    </View>
  );
}

/** One record in a list: title, a line of facts, tags on the right. */
export function ListCard({ title, sub, sub2, status, statusLabel, right, onPress, label, tone }) {
  return (
    <Card color={tone ?? c.paper} onPress={onPress} pad={14} accessibilityLabel={label ?? [title, sub, status].filter(Boolean).join('. ')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <T weight="700" size={15}>{title}</T>
          {sub ? <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{sub}</T> : null}
          {sub2 ? <T size={12} color={c.mute} style={{ marginTop: 1 }}>{sub2}</T> : null}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 6 }}>{status ? <StatusTag status={status} label={statusLabel} /> : null}{right}</View>
      </View>
    </Card>
  );
}

export function SwitchRow({ label, sub, value, onChange }) {
  return (
    <Pressable onPress={() => onChange(!value)} accessibilityRole="switch" accessibilityState={{ checked: !!value }} accessibilityLabel={label} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1 }}><T weight="600" size={14}>{label}</T>{sub ? <T size={12} color={c.mute}>{sub}</T> : null}</View>
      <Switch value={!!value} onValueChange={onChange} trackColor={{ true: c.pink }} />
    </Pressable>
  );
}

export const Row2 = ({ k, v }) => (v === null || v === undefined || v === '' ? null : (
  <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 4 }} accessible accessibilityLabel={`${k}: ${v}`}>
    <T size={12.5} color={c.mute} style={{ width: 118 }}>{k}</T><T size={13.5} weight="600" style={{ flex: 1 }}>{String(v)}</T>
  </View>));

/** A horizontal bar for simple breakdowns (no chart library). */
export function Bar({ label, value, max, sub }) {
  return (
    <View style={{ gap: 4 }} accessible accessibilityLabel={`${label}: ${value}${sub ? `, ${sub}` : ''}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={13} weight="600" style={{ flex: 1 }}>{label}</T><T size={13} weight="700">{value}</T></View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: c.line }}><View style={{ height: 6, borderRadius: 3, backgroundColor: c.pink, width: `${max ? Math.max(3, Math.round((value / max) * 100)) : 0}%` }} /></View>
      {sub ? <T size={11} color={c.mute}>{sub}</T> : null}
    </View>
  );
}
