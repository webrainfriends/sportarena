// Shared analytic components for the Curriculum module (#782). Everything prints its numbers (never colour or length alone), is touch-sized,
// and uses the Dusk theme tokens only. No data is fetched here.
import React from 'react';
import { Pressable, View } from 'react-native';
import { Card, Chip, GradCard, T, Tag } from '../ui';
import { c, grad } from '../theme';
import { t } from '../i18n';
import { when } from './academy-ui';

export const PILLARS = ['technical', 'tactical', 'physical', 'mental', 'lifestyle'];
export const PILLAR_ICON = { technical: '🎯', tactical: '🧠', physical: '💪', mental: '🧘', lifestyle: '🌱' };
export const PRIORITIES = ['core', 'support', 'stretch'];
export const MASTERY = ['introduce', 'develop', 'consolidate', 'master'];
export const INTENSITIES = ['low', 'medium', 'high', 'peak'];
export const GAME_PHASES = ['in_possession', 'out_of_possession', 'transition_to_attack', 'transition_to_defence', 'set_play', 'general'];
export const INT_TONE = { low: c.cyanSoft, medium: c.sunSoft, high: c.orangeSoft, peak: c.pinkSoft };
export const STATE_TONE = { complete: c.lime, in_progress: c.sunSoft, planned: c.cyanSoft, not_planned: undefined };
/** Tagged template for composed labels (numbers + translated words), so the text reaches t()-built pieces only. */
export const lbl = (strs, ...vals) => String.raw({ raw: strs }, ...vals);
export const opt = (list, ns) => list.map((v) => ({ value: v, label: t(`${ns}.${v}`) }));

export const Panel = ({ children, style }) => <View style={[{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }, style]}>{children}</View>;
export const Eyebrow = ({ children }) => <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{String(children).toUpperCase()}</T>;

/** Dark hero strip with the headline figures, as on the coach home. */
export function Hero({ title, sub, stats }) {
  return (
    <GradCard colors={grad.hero} pad={18}>
      <T size={20} weight="800" color="#fff" style={{ letterSpacing: -0.4 }}>{title}</T>
      {sub ? <T size={13} color="rgba(255,255,255,0.78)">{sub}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
        {stats.map((x) => (
          <View key={x.label} accessible accessibilityLabel={lbl`${x.label}: ${x.value}. ${x.sub ?? ''}`} style={{ flexGrow: 1, flexBasis: 120, padding: 12, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' }}>
            <T size={10.5} weight="800" color="rgba(255,255,255,0.72)" style={{ letterSpacing: 1 }}>{x.label.toUpperCase()}</T>
            <T size={26} weight="800" color="#fff" style={{ letterSpacing: -1, fontVariant: ['tabular-nums'] }}>{x.value}</T>
            {x.sub ? <T size={11.5} color="rgba(255,255,255,0.72)">{x.sub}</T> : null}
          </View>
        ))}
      </View>
    </GradCard>
  );
}

/** Pillar balance: complete / in progress / remaining objectives per pillar, with the counts written out. */
export function PillarBars({ rows }) {
  return (
    <View style={{ gap: 10 }} accessible accessibilityLabel={rows.map((r) => `${t(`cur.pillar.${r.pillar}`)}: ${r.complete} ${t('cur.state.complete')}, ${r.in_progress} ${t('cur.state.in_progress')}, ${r.objectives} total`).join('. ')}>
      {rows.map((r) => {
        const rest = Math.max(0, r.objectives - r.complete - r.in_progress);
        return (
          <View key={r.pillar} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><T size={16}>{PILLAR_ICON[r.pillar]}</T><T size={13} weight="700" style={{ flex: 1 }}>{t(`cur.pillar.${r.pillar}`)}</T><T size={12} color={c.mute}>{r.complete}/{r.objectives} · {r.delivered}/{r.target} {t('cur.sessions_short')}</T></View>
            <View style={{ flexDirection: 'row', height: 10, borderRadius: 6, overflow: 'hidden', backgroundColor: c.violetSoft }}>
              <View style={{ flex: r.complete, backgroundColor: c.lime }} /><View style={{ flex: r.in_progress, backgroundColor: c.sun }} /><View style={{ flex: rest || (r.objectives ? 0 : 1) }} />
            </View>
          </View>
        );
      })}
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        {[[c.lime, 'complete'], [c.sun, 'in_progress'], [c.violetSoft, 'remaining']].map(([col, k]) => <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: col }} /><T size={11} color={c.mute}>{t(`cur.legend.${k}`)}</T></View>)}
      </View>
    </View>
  );
}

/** Six months of delivery: delivered vs deviated per month. */
export function TrendBars({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.mapped));
  return (
    <View accessible accessibilityLabel={rows.map((r) => `${r.month}: ${r.delivered} ${t('cur.ostate.delivered')}, ${r.deviated} ${t('cur.legend.deviated')}`).join('. ')} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, height: 120 }}>
      {rows.map((r) => (
        <View key={r.month} style={{ flex: 1, alignItems: 'center', gap: 3 }}>
          <T size={11} weight="800">{r.delivered}</T>
          <View style={{ width: '100%', maxWidth: 38, height: Math.max(6, (r.mapped / max) * 78), borderRadius: 6, overflow: 'hidden', backgroundColor: c.violetSoft, justifyContent: 'flex-end' }}>
            <View style={{ flex: r.deviated, backgroundColor: c.orange }} /><View style={{ flex: Math.max(0, r.mapped - r.deviated), backgroundColor: c.lime }} />
          </View>
          <T size={10} color={c.mute}>{r.month.slice(5)}/{r.month.slice(2, 4)}</T>
        </View>
      ))}
    </View>
  );
}

/** One cell per objective, shaded by state, so a coach sees the whole year in a glance. */
export function HeatStrip({ objectives }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }} accessible accessibilityLabel={objectives.map((o) => `${o.title}: ${t(`cur.state.${o.state}`)}`).join('. ')}>
      {objectives.map((o) => <View key={o.key} style={{ width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: o.state === 'complete' ? c.lime : o.state === 'in_progress' ? c.sun : o.state === 'planned' ? c.cyanSoft : c.violetSoft, borderWidth: o.priority === 'core' ? 1.5 : 0, borderColor: c.ink }}><T size={10}>{PILLAR_ICON[o.pillar] ?? ''}</T></View>)}
    </View>
  );
}

/** Mastery ladder: introduce → develop → consolidate → master, with the target level filled. */
export function Mastery({ level }) {
  const at = MASTERY.indexOf(level);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }} accessible accessibilityLabel={lbl`${t('cur.f.mastery')}: ${level ? t(`cur.mastery.${level}`) : '–'}`}>
      {MASTERY.map((m, i) => <View key={m} style={{ width: 16, height: 6, borderRadius: 3, backgroundColor: i <= at ? c.pink : c.violetSoft }} />)}
      <T size={11} color={c.mute} style={{ marginLeft: 4 }}>{level ? t(`cur.mastery.${level}`) : ''}</T>
    </View>
  );
}

/** The year in phases: blocks placed on a shared date axis, shaded by intensity, with today marked. */
export function PhaseTimeline({ phases }) {
  if (!phases.length) return null;
  const ms = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getTime();
  const lo = Math.min(...phases.map((p) => ms(p.starts_on))), hi = Math.max(...phases.map((p) => ms(p.ends_on))), span = Math.max(1, hi - lo);
  const now = Date.now(), pos = (x) => `${Math.min(100, Math.max(0, ((x - lo) / span) * 100))}%`;
  return (
    <View accessible accessibilityLabel={phases.map((p) => `${p.title}: ${when(p.starts_on)} – ${when(p.ends_on)}, ${t(`cur.intensity.${p.intensity}`)}`).join('. ')} style={{ gap: 6 }}>
      <View style={{ height: 52, borderRadius: 12, backgroundColor: c.violetSoft, overflow: 'hidden' }}>
        {phases.map((p) => (
          <View key={p.key} style={{ position: 'absolute', left: pos(ms(p.starts_on)), width: `${Math.max(2, ((ms(p.ends_on) - ms(p.starts_on)) / span) * 100)}%`, top: 4, bottom: 4, borderRadius: 8, backgroundColor: INT_TONE[p.intensity], borderWidth: 1, borderColor: c.line, padding: 4, justifyContent: 'center' }}>
            <T size={10.5} weight="800" numberOfLines={1}>{p.title}</T>
          </View>
        ))}
        {now >= lo && now <= hi ? <View style={{ position: 'absolute', left: pos(now), top: 0, bottom: 0, width: 2, backgroundColor: c.pink }} /> : null}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={11} color={c.mute}>{when(new Date(lo))}</T>{now >= lo && now <= hi ? <T size={11} weight="700" color={c.pink}>{t('cur.today')}</T> : null}<T size={11} color={c.mute}>{when(new Date(hi))}</T></View>
    </View>
  );
}

/** Wizard / approval progress: numbered steps with the current one filled. */
export function Steps({ steps, at, onGo }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6 }} accessibilityRole="tablist">
      {steps.map((s, i) => {
        const on = i === at, done = i < at;
        return (
          <Pressable key={s} onPress={onGo ? () => onGo(i) : undefined} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={lbl`${i + 1}. ${s}`} style={{ flex: 1, minHeight: 44, justifyContent: 'center', gap: 4 }}>
            <View style={{ height: 5, borderRadius: 3, backgroundColor: on || done ? c.pink : c.violetSoft }} />
            <T size={11.5} weight={on ? '800' : '600'} color={on ? c.ink : c.mute} numberOfLines={1}>{i + 1}. {s}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Approval pipeline for one version: Draft → Submitted → Approved → Published, with who and when. */
export function Pipeline({ v }) {
  const order = ['draft', 'submitted', 'approved', 'published'];
  const at = v.status === 'rejected' ? 1 : v.status === 'superseded' ? 3 : order.indexOf(v.status);
  const who = { submitted: [v.submitted_by_name, v.submitted_at], approved: [v.decided_by_name, v.decided_at], published: [null, v.published_at] };
  return (
    <View style={{ gap: 8 }}>
      {order.map((k, i) => (
        <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: i <= at ? (v.status === 'rejected' && i === 1 ? c.orange : c.lime) : c.violetSoft }}><T size={11} weight="800" color={i <= at ? '#fff' : c.mute}>{i <= at ? '✓' : i + 1}</T></View>
          <T size={13} weight={i === at ? '800' : '600'} style={{ flex: 1 }}>{t(`cur.vs.${k}`)}{v.status === 'rejected' && i === 1 ? ` · ${t('cur.vs.rejected')}` : ''}</T>
          {who[k]?.[1] && i <= at ? <T size={11.5} color={c.mute}>{[who[k][0], when(who[k][1])].filter(Boolean).join(' · ')}</T> : null}
        </View>
      ))}
      {v.self_approved ? <Tag label={t('cur.self_approved')} color={c.sunSoft} /> : null}
    </View>
  );
}

/** Readiness checklist: blockers stop submission, warnings travel with it, passes are listed so the author sees what is already right. */
export function Readiness({ r }) {
  const row = (tone, icon, x) => <View key={`${x.code}${x.ref ?? ''}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', padding: 8, borderRadius: 12, backgroundColor: tone }}><T size={13}>{icon}</T><T size={12.5} style={{ flex: 1 }}>{x.message}</T></View>;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Tag label={lbl`${r.blockers.length} ${t('cur.ready.blockers')}`} color={r.blockers.length ? c.orangeSoft : c.lime} /><Tag label={lbl`${r.warnings.length} ${t('cur.ready.warnings')}`} color={r.warnings.length ? c.sunSoft : c.lime} /><Tag label={lbl`${r.passed.length} ${t('cur.ready.passed')}`} color={c.lime} />
      </View>
      {r.blockers.map((x) => row(c.orangeSoft, '⛔', x))}{r.warnings.map((x) => row(c.sunSoft, '⚠️', x))}{r.passed.map((x) => row(c.limeSoft, '✅', x))}
    </View>
  );
}

/** What this version changes: added / edited / removed objectives, with the edited fields named. */
export function Diff({ d, against }) {
  const none = !d.added.length && !d.removed.length && !d.changed.length;
  return (
    <View style={{ gap: 6 }}>
      <T size={12} color={c.mute}>{against ? t('cur.diff.against', { v: against }) : t('cur.diff.first')}</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={lbl`+${d.added.length} ${t('cur.diff.added')}`} color={c.lime} /><Tag label={lbl`~${d.changed.length} ${t('cur.diff.edited')}`} color={c.sunSoft} /><Tag label={lbl`−${d.removed.length} ${t('cur.diff.removed')}`} color={c.orangeSoft} /></View>
      {d.added.map((x) => <T key={x.key} size={12.5}>＋ {x.title}</T>)}
      {d.changed.map((x) => <T key={x.key} size={12.5}>~ {x.title} <T size={11.5} color={c.mute}>({x.fields.map((f) => t(`cur.field.${f}`)).join(', ')})</T></T>)}
      {d.removed.map((x) => <T key={x.key} size={12.5} color={c.mute}>− {x.title}</T>)}
      {none ? <T size={12.5} color={c.mute}>{t('cur.diff.none')}</T> : null}
    </View>
  );
}

export { Card };

/** Section tabs that wrap instead of scrolling sideways, so every section stays visible in a narrow detail panel. */
export const WrapTabs = ({ options, value, onChange }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{options.map((o) => <Chip key={o.value} label={o.label} active={o.value === value} onPress={() => onChange(o.value)} />)}</View>
);
