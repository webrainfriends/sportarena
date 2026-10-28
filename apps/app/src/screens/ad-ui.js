// Small shared pieces of the advertising screens: the status tag and the budget meter.
import React from 'react';
import { View } from 'react-native';
import { Tag } from '../ui';
import { c } from '../theme';

export const STATUS = {
  draft: [c.violetSoft, 'Draft'], submitted: [c.sun, 'In review'], rejected: [c.red, 'Rejected'], approved: [c.cyan, 'Approved'], scheduled: [c.cyan, 'Scheduled'],
  active: [c.mint, 'Live'], paused: [c.sun, 'Paused'], ended: [c.violetSoft, 'Ended'], withdrawn: [c.violetSoft, 'Withdrawn'],
};
export const StatusTag = ({ s, held }) => <Tag label={held ? 'Paused by the platform' : STATUS[s]?.[1] ?? s} color={STATUS[s]?.[0] ?? c.violetSoft} />;

/** A thin meter: how much of the budget has been spent. */
export function Meter({ spent, of, color = c.pink }) {
  const pct = of > 0 ? Math.min(100, Math.round((spent / of) * 100)) : 0;
  return (
    <View accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }} style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }}>
      <View style={{ width: `${pct}%`, height: 8, backgroundColor: color }} />
    </View>
  );
}
