// Officials Development & Assessment (#486): the small pieces the person screens and the body console share. The server decides every rule; this only
// shows what it returns. Colours come from the app theme tokens, so light and dark both follow the current scheme.
import React from 'react';
import { View } from 'react-native';
import { Card, T, Tag } from './ui';
import { c } from './theme';

export const REC = { maintain_grade: ['Maintain grade', c.mint], ready_for_review: ['Ready for review', c.cyan], further_observation: ['Further observation', c.sun] };
export const REC_OPTIONS = [
  { value: 'maintain_grade', label: 'Maintain grade' }, { value: 'ready_for_review', label: 'Ready for review' }, { value: 'further_observation', label: 'Further observation required' },
];
export const PURPOSE_OPTIONS = [
  { value: 'routine', label: 'Routine' }, { value: 'promotion', label: 'Promotion' }, { value: 'mentoring', label: 'Mentoring' }, { value: 'probation', label: 'Probation' }, { value: 'return', label: 'Return to officiating' }, { value: 'other', label: 'Other' },
];
export const PURPOSE = Object.fromEntries(PURPOSE_OPTIONS.map((o) => [o.value, o.label]));
export const ROLE_OPTIONS = [{ value: 'referee', label: 'Referee' }, { value: 'umpire', label: 'Umpire' }, { value: 'linesman', label: 'Assistant referee' }, { value: 'scorer', label: 'Scorer' }];
export const ROLE_NAME = Object.fromEntries(ROLE_OPTIONS.map((o) => [o.value, o.label]));
// Generic starting points a body can tap in when it builds a rubric; they are only labels, the body decides what each means.
export const DIMENSION_IDEAS = ['Application of the laws', 'Positioning and movement', 'Decision process', 'Communication', 'Teamwork and crew management', 'Match control', 'Administration and reporting'];

const STATE = {
  draft: ['Draft', c.violetSoft], submitted: ['Awaiting review', c.sun], published: ['Published', c.mint], voided: ['Voided', c.pinkSoft],
  assigned: ['Waiting for you', c.sun], accepted: ['Accepted', c.mint], declined: ['Declined', c.violetSoft], completed: ['Completed', c.mint], cancelled: ['Cancelled', c.violetSoft],
  lodged: ['Lodged', c.sun], under_review: ['In review', c.cyan], upheld: ['Upheld', c.mint], partly_upheld: ['Partly upheld', c.cyan], dismissed: ['Dismissed', c.violetSoft], withdrawn: ['Withdrawn', c.violetSoft],
  active: ['Active', c.mint], suspended: ['Suspended', c.orange], revoked: ['Revoked', c.pinkSoft], expired: ['Expired', c.pinkSoft], lapsed: ['Licence lapsed', c.orange], pending: ['Not started', c.sun],
  proposed: ['Proposed', c.sun], ended: ['Ended', c.violetSoft], recorded: ['Awaiting verification', c.sun], verified: ['Verified', c.mint], rejected: ['Not accepted', c.pinkSoft],
  valid: ['Valid', c.mint], expiring: ['Expiring soon', c.sun], failed: ['Not passed', c.pinkSoft], missing: ['No result', c.violetSoft], voided_result: ['Voided', c.pinkSoft],
};
export const stateLabel = (s) => STATE[s]?.[0] ?? String(s).replace(/_/g, ' ');
export const StateTag = ({ status, label }) => <Tag label={label ?? stateLabel(status)} color={STATE[status]?.[1] ?? c.violetSoft} />;
export const RecTag = ({ value }) => (value ? <Tag label={REC[value]?.[0] ?? value} color={REC[value]?.[1] ?? c.violetSoft} /> : null);

export const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const whenTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** A labelled progress line with an accessible spoken equivalent. */
export function Progress({ label, value, target, unit = '', sub, tone = c.pink }) {
  const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 100;
  return (
    <View style={{ gap: 5 }} accessible accessibilityLabel={`${label}: ${value}${unit} of ${target}${unit}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={13} weight="700" style={{ flex: 1 }}>{label}</T><T size={13} weight="800">{value}{unit} / {target}{unit}</T></View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }}><View style={{ height: 8, borderRadius: 4, backgroundColor: pct >= 100 ? c.mint : tone, width: `${Math.max(pct, 3)}%` }} /></View>
      {sub ? <T size={11.5} color={c.mute}>{sub}</T> : null}
    </View>
  );
}

/** A bulleted list of private notes (strengths, development areas, actions). */
export function Notes({ title, items, tone = c.paper }) {
  if (!items?.length) return null;
  return (
    <Card color={tone} pad={14}>
      <T weight="800" size={13.5}>{title}</T>
      <View style={{ gap: 6, marginTop: 8 }}>
        {items.map((t, i) => (
          <View key={`${i}-${t}`} style={{ flexDirection: 'row', gap: 8 }}><T color={c.pink} weight="800">•</T><T size={13.5} style={{ flex: 1 }}>{t}</T></View>))}
      </View>
    </Card>
  );
}
