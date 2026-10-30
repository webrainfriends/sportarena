// Organisation Command Centre (#573): the organisation's home. "Waiting on you" is the decision queue (act in place, each action is the
// existing domain capability the server names); "Across the organisation" lists every area with its status and opens the screen that owns it.
// Nothing is stored here; the screen only calls the API.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, ErrorBox, Field, Loading, Row, Section, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { explain } from '../access';
import { MenuField } from '../menu-field';
import { DateField, DateRangeField } from '../pickers';
import { toMinor } from '../contracts-ui';
import { SwitchRow } from '../federation-bits';

const DOMAIN = { admissions: 'Admissions', registrations: 'Registrations', staff: 'Staff', compliance: 'Compliance', procurement: 'Procurement', finance: 'Finance', sponsors: 'Sponsors', documents: 'Documents', tasks: 'Tasks' };
const SEV = { ok: c.lime, warn: c.sun, bad: c.red };
const when = (iso) => { if (!iso) return ''; const days = Math.floor((Date.now() - Date.parse(iso)) / 864e5); return days <= 0 ? 'today' : days === 1 ? '1 day' : `${days} days`; };

function Dot({ sev }) { return <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: SEV[sev] ?? c.lime }} />; }

/** Asks for what an action needs (a reason, a date, an amount, a typed name…), then calls the capability the server named. */
function Field1({ f, value, onChange }) {
  if (f.kind === 'date') return <DateField label={f.label} value={value || undefined} onChange={onChange} />;
  return <Field label={f.label} value={value ?? ''} onChangeText={onChange} multiline={f.kind === 'text'} keyboardType={f.kind === 'amount' ? 'decimal-pad' : undefined} placeholder={f.kind === 'text' ? 'The person sees this' : undefined} />;
}
const digits = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
const initial = (f) => (f.kind === 'amount' && f.default_minor != null ? (f.default_minor / 10 ** digits(f.currency)).toFixed(digits(f.currency)) : f.default ?? '');

function ActionSheet({ item, onClose, onDone, toast }) {
  const [pick, setPick] = useState(null), [vals, setVals] = useState({}), [busy, setBusy] = useState(false);
  const fields = pick?.ask ?? [];
  const value = (f) => vals[f.key] ?? initial(f);
  const body = (a) => Object.fromEntries((a.ask ?? []).map((f) => [f.key, f.kind === 'amount' ? toMinor(value(f), f.currency) : String(value(f)).trim()]).filter(([, v]) => v !== '' && !(typeof v === 'number' && Number.isNaN(v))));
  const missing = (a) => (a.ask ?? []).some((f) => f.required && (f.kind === 'amount' ? !(toMinor(value(f), f.currency) > 0) : String(value(f)).trim().length < (f.kind === 'text' ? 3 : f.kind === 'line' ? 2 : 1)));
  const run = async (a) => {
    setBusy(true);
    try { await api[a.method === 'PATCH' ? 'patch' : 'post'](a.path, { ...a.body, ...body(a) }); toast('Done'); onDone(); }
    catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  if (!item) return null;
  return (
    <Sheet visible onClose={onClose} title={pick ? pick.label : item.title}>
      {pick ? (
        <>
          {fields.map((f) => <Field1 key={f.key} f={f} value={value(f)} onChange={(v) => setVals({ ...vals, [f.key]: v })} />)}
          <Btn title={busy ? 'Working…' : pick.label} color={pick.tone === 'danger' ? c.red : c.pink} disabled={busy || missing(pick)} onPress={() => run(pick)} />
        </>
      ) : (
        <>
          <T size={13} color={c.mute}>{item.sub}</T>
          {item.actions.map((a) => (
            <Btn key={a.label} title={a.label} color={a.tone === 'primary' ? c.pink : a.tone === 'danger' ? c.red : c.paper} ink={a.tone ? '#fff' : c.ink} disabled={busy}
              onPress={() => (a.ask?.length ? (setVals({}), setPick(a)) : run(a))} />
          ))}
        </>
      )}
    </Sheet>
  );
}

function Queue({ o, cc, filter, setFilter, openRecord, toast, reload }) {
  const q = useLoad(() => api.get(`/organisations/${o.id}/command-centre/approvals`, { ...(filter !== 'all' ? { domain: filter } : {}), limit: 50 }), [o.id, filter, cc.waiting.total]);
  const [acting, setActing] = useState(null);
  const options = [{ value: 'all', label: 'Everything' }, ...Object.entries(cc.waiting.by_domain).map(([k, n]) => ({ value: k, label: `${DOMAIN[k] ?? k} · ${n}` }))];
  return (
    <Section title={`Waiting on you${cc.waiting.total ? ` · ${cc.waiting.total}` : ''}`} color={cc.waiting.total ? c.sun : c.lime}>
      {options.length > 2 ? <MenuField label="Show" value={options.some((x) => x.value === filter) ? filter : 'all'} onChange={setFilter} options={options} /> : null}
      {q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : !q.data ? <Loading /> : q.data.items.length ? q.data.items.map((it) => (
        <Row key={it.key} title={it.title} sub={`${DOMAIN[it.domain] ?? it.domain} · ${it.sub}${it.at ? ` · ${when(it.at)}` : ''}`} onPress={() => openRecord(it.record)}
          right={it.actions.length ? <Btn small title={it.actions.length > 1 ? `${it.actions[0].label} ▼` : it.actions[0].label} onPress={() => setActing(it)} accessibilityLabel={`Decide: ${it.title}`} />
            : <Btn small title={it.open_label ?? 'Open'} color={it.can_act ? c.pink : c.paper} ink={it.can_act ? '#fff' : c.ink} onPress={() => openRecord(it.record)} accessibilityLabel={`${it.open_label ?? 'Open'}: ${it.title}`} />} />
      )) : <Empty emoji="✅" title="Nothing is waiting on you" sub="Decisions from admissions, registrations, staff, compliance, sponsors, suppliers and fees appear here." />}
      {acting ? <ActionSheet item={acting} onClose={() => setActing(null)} onDone={() => { setActing(null); q.reload(); reload(); }} toast={toast} /> : null}
    </Section>
  );
}

function Areas({ cc, go, setFilter }) {
  return (
    <Section title="Across the organisation" color={c.cyan}>
      <T size={12} color={c.mute}>Needs attention first. Tap an area to open the screen that owns it. Money stays per currency.</T>
      {cc.tiles.map((t) => (
        <Row key={t.key} title={t.label} sub={t.summary} left={<Dot sev={t.severity} />} onPress={() => (t.link.filter ? setFilter(t.link.filter) : go(t.link.tab))}
          right={<T weight="800" size={17}>{t.count}</T>} />
      ))}
    </Section>
  );
}

const yearName = (from, to) => { if (!from || !to) return ''; const a = from.slice(0, 4), b = to.slice(0, 4); return a === b ? a : `${a}–${b.slice(2)}`; };

function Rollover({ o, onClose, toast, reload }) {
  const seasons = useLoad(() => api.get(`/organisations/${o.id}/seasons`, { limit: 100 }), [o.id]);
  const [src, setSrc] = useState(null), [range, setRange] = useState({}), [name, setName] = useState(''), [keep, setKeep] = useState({ cohorts: true, coaches: true, team_links: true }), [arch, setArch] = useState(false);
  const [plan, setPlan] = useState(null), [busy, setBusy] = useState(false);
  const list = seasons.data ?? [];
  const from = src ?? list[0]?.id ?? '';
  const body = { name: name || yearName(range.from, range.to), starts_on: range.from, ends_on: range.to, carry: keep, archive_previous: arch };
  const call = async (dry) => {
    setBusy(true);
    try {
      const r = await api.post(`/organisations/${o.id}/seasons/${from}/rollover`, { ...body, dry_run: dry });
      if (dry) setPlan(r); else { toast(`${r.season.name} created with ${r.cohorts.length} group${r.cohorts.length === 1 ? '' : 's'}`); reload(); onClose(); }
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Season rollover">
      {!list.length && !seasons.loading ? <Empty emoji="📅" title="No season to roll over" sub="Create a season first, then roll it over into the next one." /> : (
        <>
          <MenuField label="From season" value={from} onChange={(v) => { setSrc(v); setPlan(null); }} options={list.map((s) => ({ value: s.id, label: s.name, sub: `${s.cohorts} group${s.cohorts === 1 ? '' : 's'}` }))} />
          <DateRangeField label="New season" from={range.from} to={range.to} onChange={(r) => { setRange(r); setName(''); setPlan(null); }} />
          <Field label="Name" value={name || yearName(range.from, range.to)} onChangeText={setName} placeholder="e.g. 2027" />
          <SwitchRow label="Groups and capacities" value={keep.cohorts} onChange={(v) => { setKeep({ ...keep, cohorts: v }); setPlan(null); }} />
          <SwitchRow label="Coaches" sub="Only those still on staff" value={keep.coaches} onChange={(v) => { setKeep({ ...keep, coaches: v }); setPlan(null); }} />
          <SwitchRow label="Team links" value={keep.team_links} onChange={(v) => { setKeep({ ...keep, team_links: v }); setPlan(null); }} />
          <SwitchRow label="Archive the old season" sub="It stays readable; nothing is deleted" value={arch} onChange={setArch} />
          <T size={12} color={c.mute}>People enrolled, attendance and charges stay with the old season.</T>
          {plan ? (
            <View style={{ gap: 6 }}>
              <T weight="800">{plan.cohorts.length ? `${plan.cohorts.length} group${plan.cohorts.length === 1 ? '' : 's'} will be created` : 'No groups will be copied'}</T>
              {plan.cohorts.map((g) => <T key={g.source_id} size={13}>{g.name}{g.capacity ? ` · ${g.capacity} places` : ''}{g.dropped?.length ? ` · ${g.dropped.join(', ')}` : ''}</T>)}
            </View>
          ) : null}
          <Btn title={busy ? 'Working…' : plan ? 'Create the new season' : 'Preview'} disabled={busy || !from || !range.from || !range.to || (name || yearName(range.from, range.to)).length < 2} onPress={() => call(!plan)} />
        </>
      )}
    </Sheet>
  );
}

function Templates({ o, mode, onClose, toast, reload }) {
  const seasons = useLoad(() => api.get(`/organisations/${o.id}/seasons`, { limit: 100 }), [o.id]);
  const tpls = useLoad(() => (mode === 'apply' ? api.get(`/organisations/${o.id}/templates`, { limit: 100 }) : Promise.resolve([])), [o.id, mode]);
  const [name, setName] = useState(''), [season, setSeason] = useState(''), [tpl, setTpl] = useState(''), [res, setRes] = useState(null), [busy, setBusy] = useState(false);
  const sOpts = (seasons.data ?? []).map((s) => ({ value: s.id, label: s.name }));
  const t = (tpls.data ?? []).find((x) => x.id === tpl);
  const save = async () => { setBusy(true); try { await api.post(`/organisations/${o.id}/templates`, { name, ...(season ? { season_id: season } : {}) }); toast('Template saved'); onClose(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const apply = async (dry) => {
    setBusy(true);
    try { const r = await api.post(`/organisations/${o.id}/templates/${tpl}/apply`, { ...(season ? { season_id: season } : {}), dry_run: dry }); if (dry) setRes(r); else { toast('Template applied'); reload(); onClose(); } }
    catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={mode === 'save' ? 'Save structure as template' : 'Apply a template'}>
      {mode === 'save' ? (
        <>
          <Field label="Template name" value={name} onChangeText={setName} placeholder="e.g. Junior club" />
          <MenuField label="Groups from season" value={season} onChange={setSeason} options={[{ value: '', label: 'Departments only' }, ...sOpts]} />
          <T size={12} color={c.mute}>Saves department and group names and capacities. No people, money or personal data.</T>
          <Btn title={busy ? 'Saving…' : 'Save template'} disabled={busy || name.trim().length < 2} onPress={save} />
        </>
      ) : (
        <>
          {tpls.data && !tpls.data.length ? <Empty emoji="🧩" title="No templates yet" sub="Save the structure of an organisation you run, then apply it here." /> : (
            <>
              <MenuField label="Template" value={tpl} onChange={(v) => { setTpl(v); setRes(null); }} options={(tpls.data ?? []).map((x) => ({ value: x.id, label: x.name, sub: x.from_organisation }))} />
              <MenuField label="Create groups in season" value={season} onChange={(v) => { setSeason(v); setRes(null); }} options={sOpts} placeholder={t && !t.structure.cohorts?.length ? 'Not needed' : 'Choose a season'} disabled={!!t && !t.structure.cohorts?.length} />
              {res ? <T size={13}>{res.departments_added.length + res.cohorts_added.length ? `Adds ${res.departments_added.length} department${res.departments_added.length === 1 ? '' : 's'} and ${res.cohorts_added.length} group${res.cohorts_added.length === 1 ? '' : 's'}; ${res.skipped.departments + res.skipped.cohorts} already exist.` : 'Everything in this template already exists here.'}</T> : null}
              <Btn title={busy ? 'Working…' : res ? 'Apply' : 'Preview'} disabled={busy || !tpl || (!!t?.structure.cohorts?.length && !season)} onPress={() => apply(!res)} />
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

export function CommandCentre({ o, role, archived, go, toast, reload }) {
  const [filter, setFilter] = useState('all'), [sheet, setSheet] = useState(null), [menu, setMenu] = useState(false);
  const { tablet } = useLayout();
  const { push } = useNav();
  const cc = useLoad(() => api.get(`/organisations/${o.id}/command-centre`), [o.id]);
  if (cc.error) return <ErrorBox error={cc.error} onRetry={cc.reload} />;
  if (!cc.data) return <Loading />;
  const refresh = () => { cc.reload(); reload(); };
  // an item opens the screen that owns the record, on that record; this organisation's own tabs open in place
  const openRecord = (r) => { if (!r) return; if (r.screen === 'Org' && r.params.id === o.id) go(r.params.tab, r.params.focus); else push(r.screen, r.params); };
  const manage = ['owner', 'admin'].includes(role) && !archived;
  const col = tablet ? { flex: 1, minWidth: 0 } : null;
  return (
    <View style={{ gap: 12, marginTop: 8 }}>
      {manage ? (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Btn small title="Manage ▼" color={c.paper} ink={c.ink} onPress={() => setMenu(true)} accessibilityLabel="Manage: season rollover and templates" />
        </View>
      ) : null}
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>
        <View style={[col, { width: tablet ? undefined : '100%' }]}><Queue o={o} cc={cc.data} filter={filter} setFilter={setFilter} openRecord={openRecord} toast={toast} reload={refresh} /></View>
        <View style={[col, { width: tablet ? undefined : '100%' }]}><Areas cc={cc.data} go={go} setFilter={setFilter} /></View>
      </View>
      <Sheet visible={menu} onClose={() => setMenu(false)} title="Manage">
        {[['rollover', 'Season rollover', 'Start the next season from this one'], ['save', 'Save structure as template', 'Departments and groups, no people or money'], ['apply', 'Apply a template', 'Add a saved structure to this organisation']].map(([k, l, s]) => (
          <Pressable key={k} onPress={() => { setMenu(false); setSheet(k); }} accessibilityRole="button" accessibilityLabel={l} style={({ pressed }) => ({ minHeight: 56, paddingHorizontal: 12, borderRadius: 12, justifyContent: 'center', backgroundColor: pressed ? c.bg : 'transparent' })}>
            <T weight="700">{l}</T><T size={12} color={c.mute}>{s}</T>
          </Pressable>
        ))}
      </Sheet>
      {sheet === 'rollover' ? <Rollover o={o} onClose={() => setSheet(null)} toast={toast} reload={refresh} /> : null}
      {sheet === 'save' || sheet === 'apply' ? <Templates o={o} mode={sheet} onClose={() => setSheet(null)} toast={toast} reload={refresh} /> : null}
    </View>
  );
}
