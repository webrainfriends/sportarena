// Findings and recommendations from a team / batch performance read.
// The findings are RULES over the aggregates (never opinion): each says what was seen, why it matters, cites the metric it came from and, where the
// coach's own drill library can help, names those drills. AI (when configured) only rewords the headline and adds a few clearly labelled
// suggestions; it is given aggregates only (no names, no individual scores) and can never change an observed finding. Without AI the findings
// are exactly the same, so the feature never depends on a model being available.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { one, many } from './db.js';
import { audit } from './helpers.js';
import { aiConfigured, aiModel, askJson, quoteData, AI_RULES } from './ai.js';

const norm = (c, v) => { const f = (v - c.scale_min) / ((c.scale_max - c.scale_min) || 1); return c.direction === 'lower_is_better' ? 1 - f : f; };

async function drillsFor(user, key) {
  return many(
    `SELECT t.id, t.title FROM coach_templates t WHERE t.coach_id=$1 AND t.scope='block' AND t.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.blocks) b WHERE b->'trains' ? $2) ORDER BY t.updated_at DESC LIMIT 4`, [user.id, key]);
}

/** @returns {Promise<Array<{kind:string,tone:'risk'|'watch'|'good'|'info',title:string,detail:string,why:string,basis:'observed',source_refs:string[],recommendation?:string,drills?:Array<{id:string,title:string}>}>>} */
export async function findingsFor(user, perf) {
  const f = [];
  const a = perf.attendance, l = perf.load, d = perf.delivery;
  if (a.rate != null) {
    const tone = a.rate < 75 ? 'risk' : a.rate < 85 ? 'watch' : 'good';
    f.push({ kind: 'attendance', tone, title: `Attendance ${a.rate}%`, detail: `${a.rate}% of recorded places were filled across ${a.by_week.length} week${a.by_week.length === 1 ? '' : 's'}.`,
      why: tone === 'good' ? 'Consistent turnout makes progress easier to measure.' : 'Low or uneven turnout limits how much of the plan reaches the group.', basis: 'observed', source_refs: ['attendance.rate'],
      ...(tone !== 'good' ? { recommendation: 'Find the pattern (weekday, venue, time) and confirm availability earlier for the next block.' } : {}) });
    const w = a.by_week;
    if (w.length >= 4) {
      const early = w.slice(0, Math.floor(w.length / 2)), late = w.slice(-Math.floor(w.length / 2));
      const avg = (x) => x.reduce((s, y) => s + y.rate, 0) / x.length;
      const drop = Math.round(avg(early) - avg(late));
      if (drop >= 10) f.push({ kind: 'attendance', tone: 'watch', title: `Attendance fell ${drop} points`, detail: `The later weeks average ${Math.round(avg(late))}% against ${Math.round(avg(early))}% earlier in the period.`, why: 'A sustained fall is an early warning of disengagement or overload.', basis: 'observed', source_refs: ['attendance.by_week'], recommendation: 'Check in with the athletes who missed the most sessions and review the recent load.' });
    }
  }
  if (a.sessions_without_record > 0) f.push({ kind: 'data', tone: 'info', title: `Attendance missing for ${a.sessions_without_record} session${a.sessions_without_record === 1 ? '' : 's'}`, detail: 'Unrecorded attendance is left out, never counted as absence.', why: 'The attendance figure only describes the sessions where it was taken.', basis: 'observed', source_refs: ['attendance.sessions_without_record'], recommendation: 'Mark attendance in each session workspace so the rate is complete.' });

  const weeks = l.by_week;
  for (let i = 1; i < weeks.length; i++) {
    const p = weeks[i - 1], c = weeks[i];
    if (p.au > 0 && c.au > p.au * 1.3) { f.push({ kind: 'load', tone: 'watch', title: `Planned load rose ${Math.round((c.au / p.au - 1) * 100)}% in the week of ${c.week}`, detail: `${p.au} to ${c.au} AU (minutes x effort).`, why: 'Steep week-on-week rises raise injury and fatigue risk.', basis: 'observed', source_refs: ['load.by_week'], recommendation: 'Hold or reduce the next week, or add a recovery block, before building again.' }); break; }
  }
  if (l.avg_rpe != null && l.avg_rpe >= 7.5) f.push({ kind: 'load', tone: 'watch', title: `High average effort (RPE ${l.avg_rpe})`, detail: 'Most planned minutes are at a high target effort.', why: 'Little variation in intensity leaves less room to recover and to learn skill.', basis: 'observed', source_refs: ['load.avg_rpe'], recommendation: 'Alternate high-effort and technical blocks, and keep a low-effort day between hard sessions.' });
  if (l.avg_rpe != null && l.avg_rpe < 4 && perf.sessions.total >= 3) f.push({ kind: 'load', tone: 'info', title: `Low average effort (RPE ${l.avg_rpe})`, detail: 'The plans are light on effort across the period.', why: 'It may under-stimulate athletes who are ready for more.', basis: 'observed', source_refs: ['load.avg_rpe'], recommendation: 'Add a conditioned-game or conditioning block where the aim is to progress.' });
  if (perf.sessions.total && !l.total_au) f.push({ kind: 'data', tone: 'info', title: 'No target effort set on the plans', detail: 'Planned load needs a target effort (RPE) on the blocks.', why: 'Without it the load and intensity picture cannot be built.', basis: 'observed', source_refs: ['load.total_au'], recommendation: 'Set an effort on each block in the session workspace.' });

  if (d.logged > 0 && d.completion_rate != null && d.completion_rate < 70) f.push({ kind: 'delivery', tone: 'watch', title: `Only ${d.completion_rate}% of logged blocks ran as planned`, detail: `${d.skipped} skipped, ${d.modified} modified, ${d.completed} completed.`, why: 'A gap between plan and delivery points to over-ambitious plans or too little time.', basis: 'observed', source_refs: ['delivery.completion_rate'], recommendation: 'Plan fewer blocks per session or shorten them, and note why blocks were skipped.' });
  if (perf.sessions.total && !d.logged) f.push({ kind: 'data', tone: 'info', title: 'Block progress was not logged', detail: 'Mark blocks completed, modified or skipped while running a session.', why: 'Delivery against plan cannot be shown without it.', basis: 'observed', source_refs: ['delivery.logged'], recommendation: 'Use the block status in the session workspace during the session.' });

  const live = perf.criteria.filter((c) => !c.suppressed && c.avg != null);
  if (live.length) {
    const weakest = [...live].sort((x, y) => norm(x, x.avg) - norm(y, y.avg))[0];
    if (norm(weakest, weakest.avg) < 0.7) {
      const drills = await drillsFor(user, weakest.key);
      f.push({ kind: 'criterion', tone: norm(weakest, weakest.avg) < 0.5 ? 'risk' : 'watch', title: `${weakest.name} is the weakest area`, detail: `Group average ${weakest.avg} on a ${weakest.scale_min} to ${weakest.scale_max} scale (${weakest.n} athletes).`, why: 'It has the most room to improve against your own evaluation sheet.', basis: 'observed', source_refs: [`criteria.${weakest.key}`],
        recommendation: drills.length ? `Give ${weakest.name} more session time using your drills below.` : `Give ${weakest.name} more session time. You have no drill tagged for it yet: tag a drill with this criterion in the session workspace.`, drills });
    }
    const slipping = live.filter((c) => c.change != null && (c.direction === 'lower_is_better' ? c.change > 0 : c.change < 0)).sort((x, y) => Math.abs(y.change) - Math.abs(x.change))[0];
    if (slipping) f.push({ kind: 'criterion', tone: 'watch', title: `${slipping.name} is slipping`, detail: `Average change ${slipping.change > 0 ? '+' : ''}${slipping.change} between first and latest score (${slipping.n_change} athletes).`, why: 'A falling score across the group usually means less practice time or a change in demands.', basis: 'observed', source_refs: [`criteria.${slipping.key}`], recommendation: 'Revisit how much time this criterion gets in the plan.', drills: await drillsFor(user, slipping.key) });
    const rising = live.filter((c) => c.change != null && (c.direction === 'lower_is_better' ? c.change < 0 : c.change > 0)).sort((x, y) => Math.abs(y.change) - Math.abs(x.change))[0];
    if (rising) f.push({ kind: 'criterion', tone: 'good', title: `${rising.name} is improving`, detail: `Average change ${rising.change > 0 ? '+' : ''}${rising.change} between first and latest score (${rising.n_change} athletes).`, why: 'Progress you can show: the work on this criterion is landing.', basis: 'observed', source_refs: [`criteria.${rising.key}`] });
  } else if (perf.athletes.n && perf.criteria.some((c) => c.suppressed)) {
    f.push({ kind: 'data', tone: 'info', title: 'Group too small to show criterion figures', detail: `Fewer than ${perf.min_cohort} athletes have scores, so averages are held back to protect individuals.`, why: 'Small groups would reveal one person\'s score.', basis: 'observed', source_refs: ['criteria'] });
  }
  if (perf.athletes.n && perf.athletes.scored_rate != null && perf.athletes.scored_rate < 50) f.push({ kind: 'coverage', tone: 'info', title: `Only ${perf.athletes.scored_rate}% of athletes have a score`, detail: `${perf.athletes.scored} of ${perf.athletes.n} athletes scored in this period.`, why: 'Group figures are only as representative as the share of athletes behind them.', basis: 'observed', source_refs: ['athletes.scored_rate'], recommendation: 'Score or evaluate everyone in the next session so the group picture is reliable.' });
  if (perf.athletes.n && !perf.goals.active && !perf.goals.achieved) f.push({ kind: 'coverage', tone: 'info', title: 'No goals set for this group', detail: 'No athlete in scope has an active or achieved goal.', why: 'Goals give the evaluation scores a target.', basis: 'observed', source_refs: ['goals'], recommendation: 'Set a goal for each athlete from the People tab of a session.' });
  return f;
}

export function headlineFor(perf, findings) {
  const bits = [`${perf.sessions.total} session${perf.sessions.total === 1 ? '' : 's'}`];
  if (perf.attendance.rate != null) bits.push(`${perf.attendance.rate}% attendance`);
  if (perf.load.total_au) bits.push(`${perf.load.total_au} AU planned load`);
  const top = findings.find((x) => x.tone === 'risk') ?? findings.find((x) => x.tone === 'watch');
  return `${bits.join(', ')}.${top ? ` Main finding: ${top.title}.` : ''}`;
}

const outSchema = z.object({ headline: z.string().max(400), suggestions: z.array(z.object({ title: z.string().max(120), detail: z.string().max(400) })).max(5) });

/** Optional: reword the headline and add a few labelled suggestions. Aggregates only go to the model. Returns null when AI is off or failed. */
export async function aiPolish(user, perf, findings) {
  if (!aiConfigured()) return null;
  const facts = {
    sessions: perf.sessions, athletes: { n: perf.athletes.n, scored_rate: perf.athletes.scored_rate }, attendance_rate: perf.attendance.rate, attendance_by_week: perf.attendance.by_week.map((w) => w.rate),
    load: { total_au: perf.load.total_au, avg_rpe: perf.load.avg_rpe, by_week_au: perf.load.by_week.map((w) => w.au) }, delivery: perf.delivery,
    criteria: perf.criteria.filter((c) => !c.suppressed).map((c) => ({ name: quoteData(c.name, 60), avg: c.avg, change: c.change, scale: [c.scale_min, c.scale_max] })),
    findings: findings.map((x) => ({ title: x.title, tone: x.tone })),
  };
  const hash = createHash('sha256').update(JSON.stringify({ facts, model: aiModel() })).digest('hex');
  const hit = await one("SELECT output FROM ai_outputs WHERE kind='team_findings' AND subject_id=$1 AND input_hash=$2", [user.id, hash]);
  if (hit) return hit.output;
  await audit(null, user.id, 'ai_team_findings', 'coaching_team_performance', null);
  const out = await askJson({
    system: `You are a careful performance analyst assisting a sports coach with a team summary. ${AI_RULES} Use only the figures given; never name or guess at individuals; do not give medical advice. Write a plain, professional headline (one or two sentences) and up to 5 practical suggestions the coach could try, each grounded in a figure above.`,
    user: `<data>${JSON.stringify(facts)}</data>`, schema: outSchema, shape: '{"headline": string, "suggestions": [{"title": string, "detail": string}]}', maxTokens: 900,
  });
  if (out) await one("INSERT INTO ai_outputs(kind, subject_id, input_hash, model, output, created_by) VALUES ('team_findings',$1,$2,$3,$4,$1) ON CONFLICT (kind, subject_id, input_hash) DO UPDATE SET model=ai_outputs.model RETURNING id", [user.id, hash, aiModel(), JSON.stringify(out)]);
  return out;
}
