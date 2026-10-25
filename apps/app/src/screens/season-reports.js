import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, Seg, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { useLayout } from '../layout';
import { openPdf } from '../open-file';
import { c } from '../theme';
import { addDays, dateTimeIn, todayIn } from '../vtime';
import { saveCsv } from './wellness-sharing';

const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const nice = (s) => String(s ?? '').replace(/_/g, ' ');
export const SECTION_LABEL = { matches: 'Matches', results: 'Results', goals: 'Goals', awards: 'Awards', career: 'Career timeline', reports: 'Coaching reports', evidence: 'Evidence & provenance' };
const SECTION_HINT = { matches: 'Official and self-logged, labelled', results: 'Approved competition and self-reported, labelled', goals: 'Your own claims; coaches see only goals you shared with them', awards: 'Trophies, medals and MVPs', career: 'Clubs and memberships, verified or not', reports: 'Published coaching reports you were sent', evidence: 'How each number is backed' };
const plain = (e) => (e?.details?.code === 'stale_version' ? 'This share changed on another device. It has been reloaded; please check and try again.' : e?.message ?? 'Something went wrong');
const until = (iso) => new Date(addDays(new Date(iso).toISOString().slice(0, 10), -1) + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const scopeText = (s) => `${s.scope_kind === 'season' ? `Season ${s.season_year}` : 'Career'}${s.sport ? ` · ${s.sport}` : ''}`;
const ACTION = { granted: 'shared', updated: 'changed the share', revoked: 'stopped the share', expired: 'share ended', created: 'built a pack', viewed: 'opened a pack', csv: 'downloaded CSV', pdf: 'opened PDF' };

const Group = ({ title, children, sub }) => (
  <Card pad={16} style={{ gap: 10 }}>
    <View><T weight="800" size={15}>{title}</T>{sub ? <T size={12} color={c.mute}>{sub}</T> : null}</View>
    {children}
  </Card>
);
const Wrap = ({ children }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;

// ---------- one frozen pack: contents, provenance, downloads ----------

const rowLine = {
  matches: (r) => [`${r.played_on} · ${r.sport}${r.opponent ? ` vs ${r.opponent}` : ''}`, [r.result && nice(r.result), r.score_for != null && `${r.score_for}${r.score_against != null ? `–${r.score_against}` : ''}`, r.minutes != null && `${r.minutes} min`].filter(Boolean).join(' · '), r.provenance.startsWith('official') ? 'Official' : nice(r.provenance)],
  results: (r) => [`${r.on_date} · ${r.sport} ${nice(r.metric)}`, `${r.value}${r.unit ? ` ${r.unit}` : ''}${r.event_name ? ` · ${r.event_name}` : ''}`, r.provenance === 'approved_competition' ? 'Approved' : nice(r.provenance)],
  goals: (r) => [r.title, [nice(r.status), r.latest_value != null && `latest ${r.latest_value}${r.unit ? ` ${r.unit}` : ''}`, r.coach_rating && `coach: ${nice(r.coach_rating)}`].filter(Boolean).join(' · '), 'Athlete claim'],
  awards: (r) => [`${r.awarded_on} · ${r.name}`, [nice(r.kind), r.event_name].filter(Boolean).join(' · '), 'Awarded'],
  career: (r) => [`${r.club} · ${r.sport}`, `${r.starts_on} to ${r.ends_on ?? 'now'}${r.evidence_items ? ` · ${r.evidence_items} evidence` : ''}`, nice(r.verification_status)],
  reports: (r) => [`${r.title} (v${r.version})`, `By ${r.coach_name} · ${r.period_from} to ${r.period_to}`, 'Published'],
};
const verified = (t) => (['Official', 'Approved', 'Awarded', 'Published', 'Verified'].includes(t) ? c.mintSoft : c.sunSoft);

function SectionPreview({ k, data }) {
  const [open, setOpen] = useState(false);
  const rows = data.rows ?? [];
  const shown = open ? rows : rows.slice(0, 4);
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={14}>{SECTION_LABEL[k]} <T size={12} color={c.mute}>({rows.length})</T></T>
      {data.summary?.length ? data.summary.map((s) => <T key={s.sport_slug} size={12} color={c.mute}>{s.sport}: {s.matches} played · {s.wins}W {s.draws}D {s.losses}L · {s.official} official, {s.self_reported} self-reported</T>) : null}
      {data.bests?.length ? data.bests.map((b) => <T key={b.sport_slug + b.metric} size={12} color={c.mute}>Best {nice(b.metric)}: {b.best}{b.unit ? ` ${b.unit}` : ''} · approved competition</T>) : null}
      {!rows.length ? <T size={13} color={c.mute}>Nothing recorded for this selection.</T> : shown.map((r, i) => {
        const [head, sub, tag] = rowLine[k](r);
        return (
          <View key={i} accessible accessibilityLabel={`${head}. ${sub}. ${tag}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', minHeight: 44, borderTopWidth: i ? 1 : 0, borderColor: c.line, paddingTop: i ? 6 : 0 }}>
            <View style={{ flex: 1 }}><T size={13} weight="700">{head}</T>{sub ? <T size={12} color={c.mute}>{sub}</T> : null}</View>
            <Tag label={tag} color={verified(tag)} />
          </View>
        );
      })}
      {rows.length > 4 ? <Btn small title={open ? 'Show less' : `Show all ${rows.length}`} color={c.paper} ink={c.ink} onPress={() => setOpen(!open)} style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  );
}

/** The contents of a snapshot (a preview or a saved pack). */
export function PackContents({ snap }) {
  const keys = ['matches', 'results', 'goals', 'awards', 'career', 'reports'].filter((k) => snap[k]);
  return (
    <View style={{ gap: 14 }}>
      {keys.map((k) => <SectionPreview key={k} k={k} data={snap[k]} />)}
      {snap.evidence ? (
        <View style={{ gap: 4 }}>
          <T weight="800" size={14}>Evidence & provenance</T>
          {snap.evidence.notes.map((n, i) => <T key={i} size={12} color={c.mute}>• {n}</T>)}
        </View>
      ) : null}
      {snap.withheld?.length ? snap.withheld.map((w) => <T key={w.section} size={12} weight="700" color={c.sun}>Not included · {SECTION_LABEL[w.section]}: {w.reason}</T>) : null}
      <T size={11} color={c.mute}>Never included: private notes, health and wellness data, contact details, date of birth.</T>
    </View>
  );
}

/** A saved pack: summary, fingerprint, CSV, branded PDF. `templates` are the person's published season_report templates. */
function PackDetail({ pack: first, templates = [], onBack }) {
  const { toast } = useSession();
  const [pack, setPack] = useState(first);
  const [busy, setBusy] = useState(null);
  const [tpl, setTpl] = useState(null);
  const snap = pack.snapshot;
  const fail = async (e) => { toast(plain(e)); if (e?.status === 403 || e?.status === 404) onBack?.(); };
  const csv = async () => { setBusy('csv'); try { const out = await api.get(`/export-packs/${pack.id}/csv`); await saveCsv(out); toast(`Saved ${out.rows} rows`); } catch (e) { await fail(e); } finally { setBusy(null); } };
  const pdf = async () => {
    setBusy('pdf');
    try {
      const d = await api.post(`/export-packs/${pack.id}/pdf`, tpl ? { template_id: tpl } : {});
      setPack(await api.get(`/export-packs/${pack.id}`));
      await openPdf(`/branded-documents/${d.id}/file`, `season-report-${snap.scope.year ?? 'career'}`);
    } catch (e) { await fail(e); } finally { setBusy(null); }
  };
  return (
    <Card pad={16} style={{ gap: 12 }}>
      {onBack ? <Btn small title="‹ All packs" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} /> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800" size={18} style={{ flex: 1, minWidth: 180 }}>{snap.athlete.display_name} · {snap.scope.label}</T>
        <Tag label={`Prepared ${dateTimeIn(snap.generated_at, tz)}`} />
      </View>
      <T size={12} color={c.mute}>Frozen snapshot · fingerprint {pack.snapshot_sha256.slice(0, 12)}… · later changes to the athlete’s records do not alter it.</T>
      <Wrap>
        <Btn small title="Download CSV" color={c.paper} ink={c.ink} onPress={csv} loading={busy === 'csv'} accessibilityLabel="Download this pack as CSV" />
        <Btn small title="Open PDF" onPress={pdf} loading={busy === 'pdf'} accessibilityLabel="Create and open this pack as a PDF" />
      </Wrap>
      {templates.length ? (
        <View style={{ gap: 6 }}>
          <T size={12} weight="700" color={c.mute}>PDF design</T>
          <Wrap><Chip label="Plain" active={!tpl} onPress={() => setTpl(null)} />{templates.map((t) => <Chip key={t.id} label={t.name} active={tpl === t.id} onPress={() => setTpl(t.id)} />)}</Wrap>
        </View>
      ) : <T size={12} color={c.mute}>Want your logo and colours on the PDF? Make a “Athlete season / career report” template in Document designer.</T>}
      {pack.documents?.length ? <T size={12} color={c.mute}>{pack.documents.length} PDF{pack.documents.length === 1 ? '' : 's'} made from this pack.</T> : null}
      <PackContents snap={snap} />
    </Card>
  );
}

// ---------- athlete / guardian: build ----------

const sigOf = (o) => JSON.stringify(o);
function Build({ athleteId, options, onCreated }) {
  const { tablet } = useLayout();
  const { toast } = useSession();
  const [scope, setScope] = useState('season');
  const [season, setSeason] = useState(options.seasons[0]?.year ?? null);
  const [sport, setSport] = useState(null);
  const [sections, setSections] = useState(['matches', 'results', 'goals', 'awards', 'career', 'evidence']);
  const [reportIds, setReportIds] = useState([]);
  const [prev, setPrev] = useState({ loading: true });
  const [busy, setBusy] = useState(false);
  const keyRef = useRef({ sig: '', key: '' });
  const toggle = (s) => setSections((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));
  const reports = options.reports.filter((r) => scope === 'career' || (season && r.period_to >= `${season}-01-01` && r.period_from <= `${season}-12-31`));
  const chosen = reportIds.filter((id) => reports.some((r) => r.report_id === id));
  const body = { ...(athleteId ? { athlete_id: athleteId } : {}), scope, ...(scope === 'season' ? { season } : {}), ...(sport ? { sport } : {}), sections: sections.length ? sections : ['evidence'], report_ids: sections.includes('reports') ? chosen : [] };
  const sig = sigOf(body);

  useEffect(() => {
    if (scope === 'season' && !season) { setPrev({ none: true }); return undefined; }
    let live = true;
    setPrev({ loading: true });
    api.post('/export-packs/preview', body).then((r) => live && setPrev({ snap: r.snapshot })).catch((e) => live && setPrev({ error: e }));
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const create = async () => {
    if (keyRef.current.sig !== sig) keyRef.current = { sig, key: `app-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
    setBusy(true);
    try { const p = await api.post('/export-packs', { ...body, client_key: keyRef.current.key }); toast(p.duplicate ? 'You already made this pack' : 'Pack created'); onCreated(p); }
    catch (e) { toast(plain(e)); } finally { setBusy(false); }
  };
  const count = (k) => prev.snap?.[k]?.rows?.length;

  const form = (
    <View style={tablet ? { gap: 12, flex: 1, minWidth: 0 } : { gap: 12, width: '100%' }}>
      <Group title="1 · Period" sub="Pick a season or your whole career.">
        <Wrap><Chip label="Whole career" active={scope === 'career'} onPress={() => setScope('career')} />
          {options.seasons.map((s) => <Chip key={s.year} label={`${s.year}`} active={scope === 'season' && season === s.year} onPress={() => { setScope('season'); setSeason(s.year); }} />)}</Wrap>
        {!options.seasons.length ? <T size={13} color={c.mute}>No seasons yet. Matches, results, goals and awards you add will show up here.</T> : null}
        {options.sports.length > 1 ? <><T size={12} weight="700" color={c.mute}>Sport</T><Wrap><Chip label="All sports" active={!sport} onPress={() => setSport(null)} />{options.sports.map((s) => <Chip key={s.slug} label={`${s.emoji ?? ''} ${s.name}`.trim()} active={sport === s.slug} onPress={() => setSport(s.slug)} />)}</Wrap></> : null}
      </Group>
      <Group title="2 · What to include" sub="Private notes and health data can never be added.">
        {options.sections.map((k) => (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
            <Chip label={sections.includes(k) ? '✓ ' + SECTION_LABEL[k] : SECTION_LABEL[k]} active={sections.includes(k)} onPress={() => toggle(k)} />
            <T size={12} color={c.mute} style={{ flex: 1 }}>{SECTION_HINT[k]}{sections.includes(k) && count(k) != null ? ` · ${count(k)}` : ''}</T>
          </View>
        ))}
        {sections.includes('reports') ? (
          <View style={{ gap: 6, marginTop: 4 }}>
            <T size={12} weight="700" color={c.mute}>Choose the reports to include</T>
            {!reports.length ? <T size={13} color={c.mute}>No coaching reports were published to you for this period.</T> : reports.map((r) => (
              <Chip key={r.report_id} label={`${chosen.includes(r.report_id) ? '✓ ' : ''}${r.title} · ${r.coach_name} (v${r.version})`} active={chosen.includes(r.report_id)} onPress={() => setReportIds(chosen.includes(r.report_id) ? chosen.filter((x) => x !== r.report_id) : [...chosen, r.report_id])} />
            ))}
          </View>
        ) : null}
      </Group>
    </View>
  );
  const preview = (
    <View style={tablet ? { gap: 12, flex: 1, minWidth: 0 } : { gap: 12, width: '100%' }}>
      <Btn title="Create pack" onPress={create} loading={busy} disabled={prev.loading || !!prev.error || prev.none || !sections.length} accessibilityLabel="Create this season report pack" />
      <Group title="3 · Preview" sub="Exactly what the pack will contain. Nothing is saved yet.">
        {prev.loading ? <Loading /> : prev.error ? <ErrorBox error={prev.error} onRetry={() => setPrev({ loading: true, retry: Date.now() })} /> : prev.none ? <Empty emoji="📅" title="Pick a season" sub="Choose a year above to preview your report." /> : (
          <>
            <Wrap>{['matches', 'results', 'goals', 'awards', 'career', 'reports'].filter((k) => prev.snap[k]).map((k) => <StatPill key={k} value={prev.snap[k].rows.length} label={SECTION_LABEL[k].toUpperCase()} />)}</Wrap>
            <PackContents snap={prev.snap} />
          </>
        )}
      </Group>
    </View>
  );
  return <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>{form}{preview}</View>;
}

function PackList({ athleteId, templates, openId, setOpenId }) {
  const q = athleteId ? `?athlete_id=${athleteId}` : '';
  const list = useLoad(() => api.get(`/export-packs${q}`), [athleteId]);
  const one = useLoad(() => (openId ? api.get(`/export-packs/${openId}`) : Promise.resolve(null)), [openId]);
  if (openId) return (one.loading || !one.data) && !one.error ? <Loading /> : one.error ? <ErrorBox error={one.error} onRetry={one.reload} /> : <PackDetail key={openId} pack={one.data} templates={templates} onBack={() => { setOpenId(null); list.reload(); }} />;
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data.length) return <Empty emoji="📄" title="No packs yet" sub="Build your first season or career report in the Build tab." />;
  return (
    <View style={{ gap: 8 }}>
      {list.data.map((p) => (
        <Card key={p.id} pad={14} onPress={() => setOpenId(p.id)} accessibilityLabel={`${p.label}, prepared ${dateTimeIn(p.created_at, tz)}`} style={{ opacity: p.live ? 1 : 0.6 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <T weight="800" style={{ flex: 1 }}>{p.label}</T>
            {p.prepared_for === 'staff' ? <Tag label={`By ${p.created_by_name}`} color={c.cyanSoft} /> : null}
            {p.documents ? <Tag label={`${p.documents} PDF`} color={c.mintSoft} /> : null}
          </View>
          <T size={12} color={c.mute}>{p.athlete_name} · {p.sections.map((s) => SECTION_LABEL[s]).join(', ')} · {dateTimeIn(p.created_at, tz)}</T>
          {!p.live ? <T size={12} weight="700" color={c.sun}>{p.blocked_reason}</T> : null}
        </Card>
      ))}
    </View>
  );
}

// ---------- athlete / guardian: coach access ----------

function CoachAccess({ athleteId, options }) {
  const { toast } = useSession();
  const q = athleteId ? `?athlete_id=${athleteId}` : '';
  const list = useLoad(() => api.get(`/me/export-pack-shares${q}`), [athleteId]);
  const [form, setForm] = useState(null);
  const [stop, setStop] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const live = (list.data?.shares ?? []).filter((s) => s.state === 'active');
  const past = (list.data?.shares ?? []).filter((s) => s.state !== 'active');
  const min = todayIn(tz), max = addDays(min, 365);
  const edit = form?.share;
  const secOpts = options.sections.filter((s) => s !== 'reports' || true).map((value) => ({ value, label: SECTION_LABEL[value] }));
  const fields = [
    ...(edit ? [] : [{ key: 'recipient_id', label: 'Which coach', type: 'entity', options: options.recipients.map((r) => ({ id: r.id, label: r.display_name, sub: `Your coach · @${r.handle}` })), noun: 'coach' }]),
    { key: 'scope', label: 'Period', type: 'chips', options: [{ value: 'season', label: 'One season' }, { value: 'career', label: 'Whole career' }] },
    { key: 'season', label: 'Season', type: 'chips', options: options.seasons.map((s) => ({ value: s.year, label: String(s.year) })), show: (v) => v.scope === 'season' },
    ...(options.sports.length > 1 ? [{ key: 'sport', label: 'Sport', type: 'chips', optional: true, options: [{ value: '', label: 'All sports' }, ...options.sports.map((s) => ({ value: s.slug, label: s.name }))] }] : []),
    { key: 'sections', label: 'What they can build', type: 'multi', options: secOpts, hint: 'Goals appear only if you also shared those goals with this coach. “Coaching reports” means this coach’s own reports. Private notes and health data are never shared.' },
    { key: 'expires_on', label: 'Share until', type: 'date', min, max },
  ];
  const revoke = async () => {
    setBusy(true);
    try { await api.post(`/me/export-pack-shares/${stop.id}/revoke`, {}); toast('Sharing stopped'); setStop(null); await list.reload(); }
    catch (e) { toast(plain(e)); } finally { setBusy(false); }
  };
  return (
    <Group title="Coaches who can build a report" sub="Pick what a coach may put in a report about you. You can stop at any time; every pack they build or download is logged here.">
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !live.length ? <Empty emoji="🤝" title="Nobody can build a report about you" sub="Add a coach who currently coaches you." /> : live.map((s) => (
        <View key={s.id} accessible accessibilityLabel={`${s.recipient_name}, ${scopeText(s)}, ${s.live ? 'active' : 'paused'}`} style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 14, padding: 12, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{s.recipient_name}</T><Tag label={s.live ? 'Active' : 'Paused'} color={s.live ? c.mintSoft : c.sunSoft} /></View>
          <T size={12} color={c.mute}>{scopeText(s)} · until {until(s.expires_at)} · {s.packs} pack{s.packs === 1 ? '' : 's'} built</T>
          <Wrap>{s.sections.map((x) => <Tag key={x} label={SECTION_LABEL[x]} color={c.pinkSoft} />)}</Wrap>
          {!s.live ? <T size={12} weight="700" color={c.sun}>Not usable right now: {s.blocked_reason}</T> : null}
          <Wrap>
            <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm({ share: s })} accessibilityLabel={`Edit what ${s.recipient_name} can build`} />
            <Btn small title="Stop sharing" color={c.paper} ink={c.red} onPress={() => setStop(s)} accessibilityLabel={`Stop sharing with ${s.recipient_name}`} />
          </Wrap>
        </View>
      ))}
      <Btn title="＋ Share with a coach" onPress={() => setForm({})} disabled={!options.recipients.length} accessibilityLabel="Share a season report with a coach" />
      {!options.recipients.length ? <T size={12} color={c.mute}>You can share with a coach who currently coaches you.</T> : null}
      {past.length || list.data?.activity?.length ? <Btn small title={history ? 'Hide history' : 'Past shares & who did what'} color={c.paper} ink={c.ink} onPress={() => setHistory(!history)} /> : null}
      {history ? <View style={{ gap: 6 }}>
        {past.map((s) => <T key={s.id} size={12} color={c.mute}>{s.recipient_name} · {scopeText(s)} · {s.state === 'revoked' ? 'stopped' : 'ended'}</T>)}
        {(list.data?.activity ?? []).map((a) => <T key={a.id} size={12} color={c.mute}>{dateTimeIn(a.created_at, tz)} · {a.actor_name ?? 'System'} · {ACTION[a.action]}</T>)}
      </View> : null}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? `What ${edit.recipient_name} can build` : 'Share a season report'} submitLabel={edit ? 'Save' : 'Share'} fields={fields}
        initial={edit ? { scope: edit.scope_kind, season: edit.season_year ?? options.seasons[0]?.year, sport: '', sections: edit.sections, expires_on: addDays(new Date(edit.expires_at).toISOString().slice(0, 10), -1) }
          : { scope: 'season', season: options.seasons[0]?.year, sport: '', sections: ['matches', 'results', 'awards', 'evidence'], expires_on: addDays(min, 30) }}
        onSubmit={async (v) => {
          const common = { scope: v.scope, ...(v.scope === 'season' ? { season: v.season } : {}), sections: v.sections, expires_on: v.expires_on };
          try {
            if (edit) await api.patch(`/me/export-pack-shares/${edit.id}`, { version: edit.version, ...common, sport: v.sport || null });
            else await api.post('/me/export-pack-shares', { ...(athleteId ? { athlete_id: athleteId } : {}), recipient_id: v.recipient_id, ...common, ...(v.sport ? { sport: v.sport } : {}) });
            await list.reload();
            return edit ? 'Saved' : 'Shared. You can stop at any time.';
          } catch (e) { if (e?.details?.code === 'stale_version') await list.reload(); throw new Error(plain(e)); }
        }} />
      <Sheet visible={!!stop} onClose={() => setStop(null)} title="Stop sharing?">
        <T size={14}>{stop?.recipient_name} will lose access on their next view, including to packs they already built. The history stays in your log.</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Btn title="Stop sharing" color={c.red} onPress={revoke} loading={busy} />
          <Btn title="Keep sharing" color={c.paper} ink={c.ink} onPress={() => setStop(null)} />
        </View>
      </Sheet>
    </Group>
  );
}

/** Athlete (or a young person's verified guardian, via athlete_id) */
export function SeasonReports({ athlete_id, name }) {
  const opts = useLoad(() => api.get(`/me/export-pack-options${athlete_id ? `?athlete_id=${athlete_id}` : ''}`), [athlete_id]);
  const [tab, setTab] = useState('build');
  const [openId, setOpenId] = useState(null);
  return (
    <Screen onRefresh={opts.reload} wide>
      <H1>{name ? `${name}: reports` : 'Season & career reports'}</H1>
      <T size={13} color={c.mute} style={{ marginBottom: 8 }}>Build a report of a season or your whole career with matches, results, goals, awards and coaching reports, then save it as CSV or a branded PDF. Every row says where it came from and whether it is verified.</T>
      {opts.loading && !opts.data ? <Loading /> : opts.error ? <ErrorBox error={opts.error} onRetry={opts.reload} /> : (
        <View style={{ gap: 12 }}>
          <Seg options={[{ value: 'build', label: 'Build' }, { value: 'packs', label: 'My packs' }, { value: 'coaches', label: 'Coach access' }]} value={tab} onChange={(t) => { setTab(t); setOpenId(null); }} />
          {tab === 'build' ? <Build athleteId={athlete_id} options={opts.data} onCreated={(p) => { setOpenId(p.id); setTab('packs'); }} />
            : tab === 'packs' ? <PackList athleteId={athlete_id} templates={opts.data.templates} openId={openId} setOpenId={setOpenId} />
            : <CoachAccess athleteId={athlete_id} options={opts.data} />}
        </View>
      )}
    </Screen>
  );
}
export const ChildSeasonReports = ({ child_id, name }) => <SeasonReports athlete_id={child_id} name={name} />;

// ---------- coach: reports athletes shared with me ----------

function CoachDetail({ share }) {
  const { toast } = useSession();
  const [pack, setPack] = useState(null);
  const [busy, setBusy] = useState(false);
  const templates = useLoad(() => api.get('/document-templates?family=season_report').then((r) => r.filter((t) => t.latest_version)), []);
  const build = async () => {
    setBusy(true);
    try { const p = await api.post('/export-packs', { share_id: share.id }); setPack(p); toast('Pack built. This is logged and visible to the athlete.'); }
    catch (e) { toast(plain(e)); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 10, flex: 1, width: '100%' }}>
      <Card pad={16} style={{ gap: 8 }}>
        <T weight="800" size={18}>{share.athlete_name}</T>
        <T size={12} color={c.mute}>{scopeText(share)} · available until {until(share.expires_at)}</T>
        <Wrap>{share.sections.map((x) => <Tag key={x} label={SECTION_LABEL[x]} color={c.pinkSoft} />)}</Wrap>
        <T size={12} color={c.mute}>You get only what the athlete chose. Goals appear only if the athlete shared them with you. Every build and download is logged and visible to the athlete.</T>
        <Btn title={pack ? 'Build again' : 'Build report'} onPress={build} loading={busy} accessibilityLabel={`Build the report ${share.athlete_name} shared with you`} />
      </Card>
      {pack ? <PackDetail key={pack.id} pack={pack} templates={templates.data ?? []} /> : null}
    </View>
  );
}

/** Coach: athletes who shared a season / career report with me. Master-detail on a tablet or desktop, list then detail on a phone. */
export function SharedSeasonReports({ share_id }) {
  const { tablet } = useLayout();
  const list = useLoad(() => api.get('/export-pack-shared'), []);
  const [sel, setSel] = useState(share_id ?? null);
  const rows = list.data ?? [];
  const current = rows.find((r) => r.id === sel) ?? (tablet ? rows.find((r) => r.live) : null);
  return (
    <Screen onRefresh={list.reload} wide>
      <H1>Shared reports</H1>
      <T size={13} color={c.mute} style={{ marginBottom: 8 }}>Athletes you coach can let you build a season or career report. Access is checked every time and stops the moment they stop sharing.</T>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !rows.length ?
        <Empty emoji="📄" title="No athlete has shared a report with you yet" sub="Athletes you currently coach can choose to share a season or career report." /> : (
          <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>
            {tablet || !current ? <View style={{ gap: 8, width: tablet ? 270 : '100%' }}>
              {rows.map((s) => (
                <Card key={s.id} pad={14} onPress={() => setSel(s.id)} accessibilityLabel={`${s.athlete_name}, ${scopeText(s)}, ${s.live ? 'available' : 'not available'}`} style={{ opacity: s.live ? 1 : 0.65, borderWidth: current?.id === s.id ? 2 : 0, borderColor: c.ink }}>
                  <T weight="800">{s.athlete_name}</T>
                  <T size={12} color={c.mute}>{scopeText(s)} · {s.live ? `until ${until(s.expires_at)}` : s.blocked_reason ?? 'No access'}</T>
                </Card>
              ))}
            </View> : null}
            {current ? (
              <View style={{ flex: 1, width: '100%', gap: 8 }}>
                {!tablet ? <Btn small title="‹ All athletes" color={c.paper} ink={c.ink} onPress={() => setSel(null)} style={{ alignSelf: 'flex-start' }} /> : null}
                {current.live ? <CoachDetail key={current.id} share={current} /> : <Card><T weight="800">{current.athlete_name}</T><T size={13} color={c.mute}>{current.blocked_reason ?? 'No access right now.'} Nothing is shown.</T></Card>}
              </View>
            ) : null}
          </View>
        )}
    </Screen>
  );
}
