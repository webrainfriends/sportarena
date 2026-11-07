// Academy Content: the pack workspace (readiness, details, learning design, items, rights & price, versions, telemetry, money) and the reader.
// A pack's curriculum / methodology / drill items are references to the academy's published Curriculum versions; only micro-modules and video links are written here.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, ErrorBox, Loading, Row, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';
import { moneyIn } from '../vtime';
import { Bars, Block, Fact, Timeline, when } from './academy-ui';
import { Eyebrow, Panel, WrapTabs } from './academy-curriculum-ui';

const ELIG = ['open', 'affiliated', 'invited'];
const KINDS = ['curriculum', 'methodology', 'drill', 'module', 'video', 'document'];
const cc = (m, cur) => moneyIn(Number(m ?? 0), cur);

// ------------------------------------------------------------------------------------------------ create / edit the pack details
export function PackForm({ visible, o, pack, onClose, toast, onSaved }) {
  const edit = !!pack;
  const lib = useLoad(() => (visible ? api.get(`/organisations/${o.id}/academy/methodologies`).catch(() => []) : Promise.resolve([])), [visible, o.id]);
  const init = pack ? { ...pack, countries: pack.countries ?? [], languages: pack.languages ?? [], authors: (pack.authors ?? []).map((a) => a.name).join(', '), share_academy: Math.round((10000 - (pack.revenue_share ?? []).filter((x) => x.kind !== 'academy').reduce((n, x) => n + x.bp, 0)) / 100) } : { eligibility: 'affiliated', territory_mode: 'worldwide', languages: ['en'], term_months: 12, grace_days: 14, offline_max_days: 14, price_minor: 0, currency: 'USD', share_academy: 100 };
  return (
    <FormSheet visible={visible} onClose={onClose} title={t(edit ? 'cl.edit_pack' : 'cl.new_pack')} submitLabel={t('common.save')} initial={init}
      fields={[
        { key: 's1', type: 'section', label: t('cl.sec.identity') },
        { key: 'title', label: t('cl.f.title'), hint: t('cl.f.title_hint') },
        { key: 'summary', label: t('cl.f.summary'), type: 'multiline', optional: true },
        { key: 'sport', label: t('cl.f.sport'), type: 'sport' },
        { key: 'level_key', label: t('cl.f.level'), type: 'chips', optional: true, options: ['foundation', 'development', 'performance', 'elite', 'coach_education'].map((v) => ({ value: v, label: t(`cl.level.${v}`) })) },
        { key: 'age_min', label: t('cl.f.age_min'), type: 'stepper', min: 3, max: 99, step: 1, optional: true },
        { key: 'age_max', label: t('cl.f.age_max'), type: 'stepper', min: 3, max: 99, step: 1, optional: true },
        { key: 'languages', label: t('cl.f.languages'), type: 'multi', options: ['en', 'es', 'fr', 'de', 'pt', 'ca', 'hi', 'ta', 'te', 'ml', 'mr', 'kn', 'bn', 'or', 'si', 'ur', 'id', 'ar', 'zh', 'ja'].map((v) => ({ value: v, label: v.toUpperCase() })) },
        { key: 'methodology_id', label: t('cl.f.methodology'), type: 'chips', optional: true, options: (lib.data ?? []).map((m) => ({ value: m.id, label: `${m.title} · ${m.sport}` })) },
        { key: 'authors', label: t('cl.f.authors'), hint: t('cl.f.authors_hint') },
        { key: 's2', type: 'section', label: t('cl.sec.distribution') },
        { key: 'eligibility', label: t('cl.f.eligibility'), type: 'choice', options: ELIG.map((v) => ({ value: v, label: t(`cl.elig.${v}`) })), hint: t('cl.f.eligibility_hint') },
        { key: 'territory_mode', label: t('cl.f.territory'), type: 'choice', options: ['worldwide', 'include', 'exclude'].map((v) => ({ value: v, label: t(v === 'worldwide' ? 'cl.worldwide' : `cl.terr_label.${v}`) })) },
        { key: 'countries', label: t('cl.f.countries'), type: 'countries', show: (v) => v.territory_mode !== 'worldwide' },
        { key: 'max_seats', label: t('cl.f.max_seats'), type: 'stepper', min: 1, max: 100000, step: 5, optional: true, hint: t('cl.f.max_seats_hint') },
        { key: 'offline_allowed', label: t('cl.f.offline'), type: 'switch', hint: t('cl.f.offline_pack_hint') },
        { key: 'offline_max_days', label: t('cl.f.offline_days'), type: 'stepper', min: 1, max: 90, step: 1, suffix: t('cl.days_suffix'), show: (v) => !!v.offline_allowed },
        { key: 's3', type: 'section', label: t('cl.sec.commercial') },
        { key: 'currency', label: t('cl.f.currency'), type: 'currency' },
        { key: 'price_minor', label: t('cl.f.price_per_seat'), type: 'money', currency: (v) => v.currency, hint: t('cl.f.price_hint') },
        { key: 'term_months', label: t('cl.f.term'), type: 'stepper', min: 1, max: 60, step: 1, suffix: t('cl.months') },
        { key: 'grace_days', label: t('cl.f.grace'), type: 'stepper', min: 0, max: 90, step: 1, suffix: t('cl.days_suffix'), hint: t('cl.f.grace_hint') },
        { key: 'share_academy', label: t('cl.f.share_academy'), type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', hint: t('cl.f.share_hint') },
      ]}
      onSubmit={async (v) => {
        const authors = String(v.authors ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name, role: 'author' }));
        const authorShare = Math.max(0, 100 - (v.share_academy ?? 100));
        const share = [{ name: o.name, kind: 'academy', organisation_id: o.id, bp: Math.round((v.share_academy ?? 100) * 100) }, ...(authorShare && authors.length ? authors.map((a) => ({ name: a.name, kind: 'author', bp: Math.floor((authorShare * 100) / authors.length) })) : [])].filter((x) => x.bp > 0);
        const body = { title: v.title, summary: v.summary || undefined, sport: v.sport, level_key: v.level_key || undefined, age_min: v.age_min || undefined, age_max: v.age_max || undefined, languages: v.languages ?? [], methodology_id: v.methodology_id || undefined,
          eligibility: v.eligibility, territory_mode: v.territory_mode, countries: v.territory_mode === 'worldwide' ? [] : v.countries ?? [], max_seats: v.max_seats || undefined, offline_allowed: !!v.offline_allowed, offline_max_days: v.offline_max_days ?? 14,
          price_minor: v.price_minor ?? 0, currency: v.currency, term_months: v.term_months, grace_days: v.grace_days, authors, revenue_share: share };
        const saved = edit ? await api.patch(`/academy/content/packs/${pack.id}`, { row_version: pack.row_version, ...body }) : await api.post(`/organisations/${o.id}/academy/content/packs`, body);
        onSaved?.(saved);
        return t('cl.saved');
      }} />
  );
}

// ------------------------------------------------------------------------------------------------ add an item to the draft
function ItemForm({ visible, o, onClose, onAdd }) {
  const src = useLoad(() => (visible ? api.get(`/organisations/${o.id}/academy/content/sources`) : Promise.resolve(null)), [visible, o.id]);
  const s = src.data ?? { curricula: [], methodologies: [] };
  const drills = (id, ver) => (s.methodologies.find((m) => m.id === id && m.version === ver)?.drills ?? []);
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('cl.add_item')} submitLabel={t('cl.add')} initial={{ kind: 'module', required: true }}
      fields={[
        { key: 'kind', label: t('cl.f.kind'), type: 'chips', options: KINDS.filter((k) => k !== 'document').map((v) => ({ value: v, label: t(`cl.kind.${v}`) })) },
        { key: 'cur', label: t('cl.f.curriculum'), type: 'chips', show: (v) => v.kind === 'curriculum', options: s.curricula.map((x) => ({ value: x.id, label: `${x.title} · v${x.version}`, sub: x.sport })), hint: s.curricula.length ? t('cl.f.reference_hint') : t('cl.f.no_curricula') },
        { key: 'meth', label: t('cl.f.methodology'), type: 'chips', show: (v) => ['methodology', 'drill'].includes(v.kind), options: s.methodologies.map((m) => ({ value: `${m.id}|${m.version}`, label: `${m.title} · v${m.version}` })) },
        { key: 'drill', label: t('cl.f.drill'), type: 'chips', show: (v) => v.kind === 'drill' && !!v.meth, options: (v) => { const [id, ver] = String(v.meth ?? '|').split('|'); return drills(id, Number(ver)).map((d) => ({ value: d.key, label: d.title })); } },
        { key: 'title', label: t('cl.f.item_title'), show: (v) => ['module', 'video'].includes(v.kind) },
        { key: 'text', label: t('cl.f.module_text'), type: 'multiline', show: (v) => v.kind === 'module', hint: t('cl.f.module_hint') },
        { key: 'source', label: t('cl.f.evidence_source'), optional: true, show: (v) => v.kind === 'module', hint: t('cl.f.evidence_hint') },
        { key: 'external_url', label: t('cl.f.video_url'), type: 'url', show: (v) => v.kind === 'video', hint: t('cl.f.video_hint') },
        { key: 'youth_footage', label: t('cl.f.youth_footage'), type: 'switch', show: (v) => v.kind === 'video', hint: t('cl.f.youth_hint') },
        { key: 'minutes', label: t('cl.f.minutes'), type: 'stepper', min: 1, max: 600, step: 5, suffix: t('cl.min_suffix'), optional: true },
        { key: 'required', label: t('cl.f.required'), type: 'switch' },
      ]}
      onSubmit={async (v) => {
        const base = { required: !!v.required, minutes: v.minutes || undefined };
        if (v.kind === 'curriculum') { const x = s.curricula.find((q) => q.id === v.cur); if (!x) throw new Error(t('cl.f.pick_source')); onAdd({ kind: 'curriculum', ref_id: x.id, title: `${x.title} v${x.version}`, ...base }); }
        else if (v.kind === 'methodology' || v.kind === 'drill') {
          const [id, ver] = String(v.meth ?? '|').split('|'); const m = s.methodologies.find((q) => q.id === id && q.version === Number(ver)); if (!m) throw new Error(t('cl.f.pick_source'));
          if (v.kind === 'drill') { const d = m.drills.find((q) => q.key === v.drill); if (!d) throw new Error(t('cl.f.pick_source')); onAdd({ kind: 'drill', ref_id: id, ref_version: m.version, ref_key: d.key, title: d.title, ...base }); }
          else onAdd({ kind: 'methodology', ref_id: id, ref_version: m.version, title: `${m.title} v${m.version}`, ...base });
        } else if (v.kind === 'video') onAdd({ kind: 'video', title: v.title, external_url: v.external_url, youth_footage: !!v.youth_footage, ...base });
        else onAdd({ kind: 'module', title: v.title, body: { blocks: String(v.text ?? '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).map((text) => ({ type: 'text', text })), sources: v.source ? [{ title: v.source }] : [] }, ...base });
        return t('cl.item_added');
      }} />
  );
}

// ------------------------------------------------------------------------------------------------ the workspace
export function PackWorkspace({ o, pack, toast, onChange }) {
  const d = useLoad(() => api.get(`/academy/content/packs/${pack.id}`), [pack.id, pack.row_version]);
  const [sec, setSec] = useState('build');
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  const [design, setDesign] = useState(false);
  const [busy, setBusy] = useState(false);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data;
  const draft = x.versions.find((v) => v.status === 'draft') ?? null;
  const live = x.versions.find((v) => v.status === 'published') ?? null;
  const cur = draft ?? live;
  const items = cur?.items ?? [];
  const checks = [
    [t('cl.ready.items'), items.length > 0], [t('cl.ready.objectives'), (cur?.objectives ?? []).length > 0], [t('cl.ready.authors'), x.authors.length > 0],
    [t('cl.ready.revenue'), !x.price_minor || x.revenue_share.length > 0], [t('cl.ready.refs'), items.filter((i) => ['curriculum', 'methodology', 'drill'].includes(i.kind)).length + items.filter((i) => i.kind === 'module').length > 0],
  ];
  const ready = checks.every(([, ok]) => ok);
  const save = async (next, over = {}) => {
    setBusy(true);
    try {
      await api.post(`/academy/content/packs/${x.id}/draft`, { objectives: over.objectives ?? cur?.objectives ?? [], assessment: over.assessment ?? cur?.assessment ?? { kind: 'none' }, cpd_hours: over.cpd_hours ?? Number(cur?.cpd_hours ?? 0), prerequisites: over.prerequisites ?? cur?.prerequisites ?? [],
        items: next.map(({ id, position, withdrawn, ...it }) => ({ ...it, ref_id: it.ref_id ?? undefined, ref_version: it.ref_version ?? undefined, ref_key: it.ref_key ?? undefined, external_url: it.external_url ?? undefined, minutes: it.minutes ?? undefined })) });
      d.reload();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const move = (i, by) => { const n = [...items]; const j = i + by; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; save(n); };
  const run = async (fn, ok) => { setBusy(true); try { await fn(); toast(ok); d.reload(); onChange(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const publish = async () => {
    try { await api.post(`/academy/content/packs/${x.id}/publish`, {}); toast(t('cl.published')); d.reload(); onChange(); }
    catch (e) { toast(e?.details?.problems?.length ? e.details.problems.join(' · ') : explain(e)); }
  };
  return (
    <View style={{ gap: 12 }}>
      <WrapTabs value={sec} onChange={setSec} options={['build', 'rights', 'versions', 'insight', 'money'].map((v) => ({ value: v, label: t(`cl.ptab.${v}`) }))} />
      {sec === 'build' ? (
        <View style={{ gap: 12 }}>
          <Panel>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Eyebrow>{t('cl.readiness')}</Eyebrow><View style={{ flex: 1 }} /><Tag label={draft ? `${t('cl.draft')} v${draft.version}` : live ? `v${live.version}` : t('cl.draft')} color={draft ? c.sunSoft : c.lime} /></View>
            {checks.map(([label, ok]) => <View key={label} style={{ flexDirection: 'row', gap: 8, minHeight: 28, alignItems: 'center' }}><T>{ok ? '✅' : '⬜'}</T><T size={13} color={ok ? c.ink : c.mute}>{label}</T></View>)}
            {x.status !== 'retired' ? <Btn title={draft ? t('cl.publish_version', { n: draft.version }) : t('cl.nothing_to_publish')} disabled={!draft || !ready} loading={busy} onPress={publish} /> : null}
            {!ready && draft ? <T size={12} color={c.mute}>{t('cl.ready_hint')}</T> : null}
          </Panel>
          <Block title={t('cl.learning_design')} right={<Btn small title={t('cl.edit')} color={c.paper} ink={c.ink} onPress={() => setDesign(true)} />}>
            {(cur?.objectives ?? []).map((ob, i) => <T key={i} size={13}>• {ob.title}{ob.success_criteria ? ` — ${ob.success_criteria}` : ''}</T>)}
            <Fact k={t('cl.f.assessment')} v={cur?.assessment?.kind && cur.assessment.kind !== 'none' ? `${t(`cl.assess.${cur.assessment.kind}`)}${cur.assessment.pass_mark ? ` · ${cur.assessment.pass_mark}%` : ''}` : null} />
            <Fact k={t('cl.f.cpd')} v={Number(cur?.cpd_hours) ? t('cl.hours', { n: cur.cpd_hours }) : null} />
            <Fact k={t('cl.f.prerequisites')} v={(cur?.prerequisites ?? []).join(' · ')} />
            {!(cur?.objectives ?? []).length ? <T size={13} color={c.mute}>{t('cl.design_empty')}</T> : null}
          </Block>
          <Block title={t('cl.items')} right={x.status !== 'retired' ? <Btn small title={t('cl.add_item')} onPress={() => setAdding(true)} /> : null}>
            {items.length ? items.map((it, i) => (
              <Row key={it.id ?? i} left={<T size={18}>{{ curriculum: '🧭', methodology: '📘', drill: '🎯', module: '🧪', video: '🎥', document: '📄' }[it.kind]}</T>} title={it.title}
                sub={`${t(`cl.kind.${it.kind}`)}${it.minutes ? ` · ${t('cl.min', { n: it.minutes })}` : ''}${it.youth_footage ? ` · ${t('cl.stream_only')}` : ''}${it.required ? '' : ` · ${t('cl.optional')}`}`}
                right={draft ? <View style={{ flexDirection: 'row', gap: 4 }}><Btn small title="↑" color={c.paper} ink={c.ink} accessibilityLabel={t('cl.move_up')} onPress={() => move(i, -1)} /><Btn small title="↓" color={c.paper} ink={c.ink} accessibilityLabel={t('cl.move_down')} onPress={() => move(i, 1)} /><Btn small title="✕" color={c.paper} ink={c.ink} accessibilityLabel={t('cl.remove')} onPress={() => save(items.filter((_, k) => k !== i))} /></View> : undefined} />
            )) : <Empty emoji="🧩" title={t('cl.empty.items')} sub={t('cl.empty.items_sub')} />}
          </Block>
        </View>
      ) : null}
      {sec === 'rights' ? (
        <View style={{ gap: 12 }}>
          <Block title={t('cl.rights')} right={x.status !== 'retired' ? <Btn small title={t('cl.edit')} color={c.paper} ink={c.ink} onPress={() => setEdit(true)} /> : null}>
            <Fact k={t('cl.f.eligibility')} v={t(`cl.elig.${x.eligibility}`)} /><Fact k={t('cl.f.territory')} v={t(x.territory_mode === 'worldwide' ? 'cl.worldwide' : `cl.terr.${x.territory_mode}`, { list: x.countries.join(', ') })} />
            <Fact k={t('cl.f.max_seats')} v={x.max_seats} /><Fact k={t('cl.f.offline')} v={x.offline_allowed ? t('cl.offline_days', { n: x.offline_max_days }) : t('cl.no')} />
            <Fact k={t('cl.f.price_per_seat')} v={x.price_minor ? cc(x.price_minor, x.currency) : t('cl.free')} /><Fact k={t('cl.f.term')} v={`${x.term_months} ${t('cl.months')}`} /><Fact k={t('cl.f.grace')} v={t('cl.days', { n: x.grace_days })} />
            <Fact k={t('cl.f.authors')} v={x.authors.map((a) => a.name).join(', ')} /><Fact k={t('cl.f.languages')} v={x.languages.join(', ').toUpperCase()} />
          </Block>
          <Block title={t('cl.revenue_split')}>{x.revenue_share.length ? <Bars label={t('cl.revenue_split')} rows={x.revenue_share.map((r) => ({ label: r.name, value: r.bp, text: `${r.bp / 100}%` }))} /> : <T color={c.mute}>{t('cl.split_none')}</T>}</Block>
          {x.status === 'published' ? <Btn title={t('cl.retire')} color={c.paper} ink={c.ink} loading={busy} onPress={() => run(() => api.post(`/academy/content/packs/${x.id}/retire`, {}), t('cl.retired'))} /> : null}
        </View>
      ) : null}
      {sec === 'versions' ? (
        <Block title={t('cl.versions')}>
          <Timeline items={x.versions.map((v) => ({ title: `v${v.version} · ${t(`cl.vstatus.${v.status}`)}`, sub: `${t('cl.n_items', { n: v.items.length })}${v.published_at ? ` · ${when(v.published_at)}` : ''}${Number(v.cpd_hours) ? ` · ${t('cl.cpd', { n: v.cpd_hours })}` : ''}` }))} />
          <T size={12} color={c.mute}>{t('cl.versions_note')}</T>
        </Block>
      ) : null}
      {sec === 'insight' ? <Insight pack={x} /> : null}
      {sec === 'money' ? <Money pack={x} /> : null}
      <PackForm visible={edit} o={o} pack={x} onClose={() => setEdit(false)} toast={toast} onSaved={() => { d.reload(); onChange(); }} />
      <ItemForm visible={adding} o={o} onClose={() => setAdding(false)} onAdd={(it) => save([...items, it])} />
      <FormSheet visible={design} onClose={() => setDesign(false)} title={t('cl.learning_design')} submitLabel={t('common.save')}
        initial={{ objectives: (cur?.objectives ?? []).map((ob) => ob.title).join('\n'), assessment_kind: cur?.assessment?.kind ?? 'none', pass_mark: cur?.assessment?.pass_mark ?? 70, cpd_hours: Number(cur?.cpd_hours ?? 0), prerequisites: (cur?.prerequisites ?? []).join('\n') }}
        fields={[
          { key: 'objectives', label: t('cl.f.objectives'), type: 'multiline', hint: t('cl.f.objectives_hint') },
          { key: 'assessment_kind', label: t('cl.f.assessment'), type: 'chips', options: ['none', 'quiz', 'observation', 'portfolio'].map((v) => ({ value: v, label: t(`cl.assess.${v}`) })) },
          { key: 'pass_mark', label: t('cl.f.pass_mark'), type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', show: (v) => v.assessment_kind !== 'none' },
          { key: 'cpd_hours', label: t('cl.f.cpd'), type: 'stepper', min: 0, max: 200, step: 1, suffix: t('cl.hours_suffix') },
          { key: 'prerequisites', label: t('cl.f.prerequisites'), type: 'multiline', optional: true, hint: t('cl.f.prerequisites_hint') },
        ]}
        onSubmit={async (v) => { await save(items, { objectives: String(v.objectives ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map((title) => ({ title })), assessment: v.assessment_kind === 'none' ? { kind: 'none' } : { kind: v.assessment_kind, pass_mark: v.pass_mark }, cpd_hours: v.cpd_hours ?? 0, prerequisites: String(v.prerequisites ?? '').split('\n').map((s) => s.trim()).filter(Boolean) }); return t('cl.saved'); }} />
    </View>
  );
}

function Insight({ pack }) {
  const tel = useLoad(() => api.get(`/academy/content/packs/${pack.id}/telemetry`), [pack.id]);
  if (tel.error) return <ErrorBox error={tel.error} onRetry={tel.reload} />;
  if (!tel.data) return <Loading />;
  const { items, licensees } = tel.data;
  const anyOpened = items.filter((i) => i.opened).length > 0;
  return (
    <View style={{ gap: 12 }}>
      <Block title={t('cl.by_item')}>{anyOpened ? <Bars label={t('cl.by_item')} rows={items.map((i) => ({ label: i.title, value: i.opened, text: t('cl.opened_done', { a: i.opened, b: i.completed }) }))} /> : <T color={c.mute}>{t('cl.consumption_none')}</T>}</Block>
      <Block title={t('cl.by_licensee')}>
        {licensees.length ? licensees.map((l) => <Row key={l.licence_id} title={l.licensee_name} sub={t('cl.licensee_usage', { a: l.seats_used, b: l.seats, c: l.opened, d: l.completed })} />) : <T color={c.mute}>{t('cl.expiring_none')}</T>}
      </Block>
      <T size={12} color={c.mute}>{t('cl.telemetry_note')}</T>
    </View>
  );
}

function Money({ pack }) {
  const fin = useLoad(() => api.get(`/academy/content/packs/${pack.id}/finance`), [pack.id]);
  if (fin.error) return <ErrorBox error={fin.error} onRetry={fin.reload} />;
  if (!fin.data) return <Loading />;
  const f = fin.data;
  return (
    <View style={{ gap: 12 }}>
      <Panel>
        <Eyebrow>{t('cl.net_revenue')}</Eyebrow>
        <T size={28} weight="800" style={{ letterSpacing: -1 }}>{cc(f.net_minor, f.currency)}</T>
        <T size={12} color={c.mute}>{t('cl.gross_refunded', { a: cc(f.gross_minor, f.currency), b: cc(f.refunded_minor, f.currency) })}</T>
      </Panel>
      <Block title={t('cl.share_statement')}>
        {f.share_statement.map((s) => <Row key={s.name} title={s.name} sub={`${s.bp / 100}%`} right={<T weight="800">{cc(s.amount_minor, f.currency)}</T>} />)}
        <Row title={t('cl.retained')} right={<T weight="800">{cc(f.academy_retained_minor, f.currency)}</T>} />
        <T size={12} color={c.mute}>{t('cl.statement_note')}</T>
      </Block>
      <Block title={t('cl.licence_payments')}>
        {f.licences.length ? f.licences.map((l) => <Row key={l.licence_id} title={l.licensee_name} sub={`${t(`cl.stage.${l.stage}`)} · ${l.paid_at ? when(l.paid_at) : t('cl.unpaid')}`} right={<T weight="800">{cc(l.price_minor, l.currency)}</T>} />) : <T color={c.mute}>{t('cl.revenue_none')}</T>}
      </Block>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ the reader
export function ItemReader({ sel, onClose, toast, onDone }) {
  const d = useLoad(() => (sel ? api.get(`/academy/content/licences/${sel.licence.id}/items/${sel.item.id}`) : Promise.resolve(null)), [sel?.item?.id]);
  const [sess, setSess] = useState(false);
  const x = d.data;
  const finish = async () => { try { await api.post(`/academy/content/licences/${sel.licence.id}/items/${sel.item.id}/complete`, {}); toast(t('cl.marked_done')); onDone?.(); onClose(); } catch (e) { toast(explain(e)); } };
  return (
    <Sheet visible={!!sel} onClose={onClose} title={sel?.item?.title ?? ''}>
      {d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : !x ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={t(`cl.kind.${x.item.kind}`)} />{x.grace ? <Tag label={t('cl.stage.grace')} color={c.sunSoft} /> : null}{x.stream_only ? <Tag label={t('cl.stream_only')} color={c.orangeSoft} /> : null}{x.offline_ok ? <Tag label={t('cl.offline_yes')} color={c.cyanSoft} /> : null}</View>
          {x.watermark ? <T size={11} color={c.mute} accessibilityLabel={t('cl.watermark_a11y')}>🔒 {x.watermark}</T> : null}
          {x.item.kind === 'module' ? (x.item.body.blocks ?? []).map((b, i) => <T key={i} weight={b.type === 'heading' ? '800' : '500'} size={b.type === 'heading' ? 17 : 15}>{b.text}</T>) : null}
          {x.item.kind === 'module' && (x.item.body.sources ?? []).length ? <Block title={t('cl.sources')}>{x.item.body.sources.map((s, i) => <T key={i} size={12} color={c.mute}>• {s.title}{s.evidence ? ` (${t(`cl.evidence.${s.evidence}`)})` : ''}</T>)}</Block> : null}
          {x.reference?.objectives ? <Block title={t('cl.objectives')}>{x.reference.objectives.map((ob) => <Row key={ob.key} title={ob.title} sub={ob.success_criteria} />)}</Block> : null}
          {x.reference?.drill ? <Panel><T weight="800">{x.reference.drill.title}</T><T size={13} color={c.mute}>{[x.reference.drill.kind, x.reference.drill.duration_min ? t('cl.min', { n: x.reference.drill.duration_min }) : null, x.reference.drill.area].filter(Boolean).join(' · ')}</T>{x.reference.drill.instructions ? <T size={14}>{x.reference.drill.instructions}</T> : null}</Panel> : null}
          {x.reference?.competencies ? <Block title={t('cl.methodology')}><T size={13}>{x.reference.philosophy?.statement}</T>{x.reference.competencies.map((k) => <Row key={k.key} title={k.title} sub={k.pillar} />)}</Block> : null}
          {x.item.external_url ? <Btn title={t('cl.watch')} onPress={() => { const L = require('react-native').Linking; L.openURL(x.item.external_url); }} /> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn title={t('cl.mark_done')} onPress={finish} />
            <Btn title={t('cl.use_in_session')} color={c.paper} ink={c.ink} onPress={() => setSess(true)} />
          </View>
          <SessionLink visible={sess} sel={sel} onClose={() => setSess(false)} toast={toast} />
        </View>
      )}
    </Sheet>
  );
}

function SessionLink({ visible, sel, onClose, toast }) {
  const orgId = sel?.licence?.licensee_org_id;
  const list = useLoad(() => (visible && orgId ? api.get(`/organisations/${orgId}/academy/sessions`, { from: new Date().toISOString().slice(0, 10), to: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) }).catch(() => []) : Promise.resolve([])), [visible, orgId]);
  const rows = Array.isArray(list.data) ? list.data : list.data?.sessions ?? [];
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('cl.use_in_session')} submitLabel={t('cl.link')}
      fields={[{ key: 'session_id', label: t('cl.f.session'), type: 'chips', options: rows.map((s) => ({ value: s.id, label: `${when(s.starts_at)} · ${s.title ?? s.cohort_name ?? ''}` })), hint: rows.length ? t('cl.link_hint') : t('cl.no_sessions') }]}
      onSubmit={async (v) => { await api.post(`/academy/content/licences/${sel.licence.id}/items/${sel.item.id}/use`, { session_id: v.session_id }); return t('cl.linked'); }} />
  );
}
