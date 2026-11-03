// One renderer for the sections of a frozen coaching report (text, items and bar charts), shared by the coach's preview, the published view and the
// screen an organisation reads a shared report on. Pure presentation: every word and number comes from the server's snapshot.
import React from 'react';
import { View } from 'react-native';
import { Card, Section, T } from '../ui';
import { c } from '../theme';

export function BarRows({ rows }) {
  return (
    <View style={{ gap: 8, marginTop: 6 }}>
      {rows.map((r, i) => {
        const min = r.min ?? 0, frac = r.value == null ? 0 : Math.max(0, Math.min(1, (r.value - min) / ((r.max - min) || 1)));
        return (
          <View key={i} accessible accessibilityLabel={[r.label, r.value ?? '-', r.note].filter(Boolean).join(', ')} style={{ gap: 3 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <T size={13} weight="700" style={{ flexShrink: 1 }}>{r.label}</T>
              <T size={12} color={c.mute}>{[r.value ?? '-', r.note].filter((x) => x !== undefined && x !== null && x !== '').join('  ·  ')}</T>
            </View>
            <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ height: 8, width: `${Math.round(frac * 100)}%`, backgroundColor: c.cyan }} /></View>
          </View>
        );
      })}
    </View>
  );
}

const TONE = { 'Needs attention': c.red, Watch: c.sun, 'Going well': c.mint, Note: c.mute };

function Items({ items }) {
  return items.map((it, n) => (
    <View key={n} style={{ marginTop: 8, gap: 2 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <T weight="700" size={14} style={{ flexShrink: 1 }}>{it.title}</T>
        {it.value ? <T weight="800" size={16}>{it.value}</T> : null}
      </View>
      {it.meta ? <T size={11} weight="700" color={TONE[it.meta] ?? c.mute}>{it.meta}</T> : null}
      {it.body ? <T size={13}>{it.body}</T> : null}
    </View>
  ));
}

/** @param {{ sections: Array<any>, cards?: boolean }} p  cards: wrap each section in a card (the coach's preview); otherwise titled sections. */
export function ReportSections({ sections, cards }) {
  return sections.map((sec) => {
    const body = sec.kind === 'text' ? <T size={14}>{sec.body}</T> : sec.kind === 'bars' ? <BarRows rows={sec.rows} /> : <Items items={sec.items} />;
    return cards
      ? <Card key={sec.key} pad={12} style={{ marginBottom: 8 }}><T weight="800">{sec.title}</T>{body}</Card>
      : <Section key={sec.key} title={sec.title}>{body}</Section>;
  });
}
