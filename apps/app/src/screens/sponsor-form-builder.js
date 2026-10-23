import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { Counter } from '../pickers';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { fieldsOf } from '../application-forms';

const TYPES = [
  ['text', 'Short text'], ['longtext', 'Long text'], ['number', 'Number'], ['money', 'Amount'], ['date', 'Date'], ['yesno', 'Yes / no'], ['choice', 'Pick one'], ['multi', 'Pick several'],
  ['file', 'File upload'], ['budget', 'Budget'], ['references', 'References'],
];
const TYPE_LABEL = Object.fromEntries(TYPES);
const TYPE_HELP = { text: 'One line, such as a name or a city.', longtext: 'A paragraph, such as a project description.', number: 'A whole or decimal number.', money: 'An amount in the program currency.', date: 'Picked from a calendar.', yesno: 'A simple yes or no switch.', choice: 'The applicant picks one option.', multi: 'The applicant can pick several options.', file: 'PDF or photo upload, always kept confidential.', budget: 'Itemised cost lines that must cover the amount requested. One per form.', references: 'People who can vouch for the applicant. One per form.' };
const slug = (label, taken) => { let base = (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '') || 'question').slice(0, 30), k = base, n = 2; while (taken.has(k)) k = `${base}_${n++}`; return k; };
const move = (list, i, d) => { const j = i + d; if (j < 0 || j >= list.length) return list; const n = [...list]; [n[i], n[j]] = [n[j], n[i]]; return n; };
const withDefaults = (def) => ({ sections: def.sections.map((x) => ({ ...x, fields: x.fields.map((f) => ({ ...blank(), ...f })) })) });
const blank = () => ({ label: '', type: 'text', required: false, confidential: false, options: [], max_files: 3, max_items: 3, when: null });
const strip = (f) => {
  const o = { key: f.key, label: f.label.trim(), type: f.type, required: !!f.required, confidential: !!f.confidential && !['file', 'budget', 'references'].includes(f.type) };
  if (f.hint?.trim()) o.hint = f.hint.trim();
  if (['choice', 'multi'].includes(f.type)) o.options = f.options;
  if (f.type === 'file') o.max_files = f.max_files;
  if (f.type === 'references') o.max_items = f.max_items;
  if (f.when) o.when = f.when;
  if (f.profile_key) o.profile_key = f.profile_key;
  if (typeof f.min === 'number') o.min = f.min;
  if (typeof f.max === 'number') o.max = f.max;
  return o;
};

/** Add or change one question: label, kind, required, confidential, options and an optional "show only when" rule. */
function FieldSheet({ visible, onClose, initial, earlier, onSave }) {
  const [f, setF] = useState(blank());
  const [opt, setOpt] = useState('');
  const [err, setErr] = useState(null);
  const was = React.useRef(false);
  React.useEffect(() => { if (visible && !was.current) { setF({ ...blank(), ...(initial ?? {}) }); setOpt(''); setErr(null); } was.current = visible; }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const parent = f.when ? earlier.find((e) => e.key === f.when.field) : null;
  const valueChoices = parent?.type === 'yesno' ? [{ value: true, label: 'Yes' }, { value: false, label: 'No' }] : (parent?.options ?? []).map((o) => ({ value: o.value, label: o.label }));
  const save = () => {
    if (!f.label.trim()) return setErr('Give the question a label');
    if (['choice', 'multi'].includes(f.type) && !f.options.length) return setErr('Add at least one option');
    if (f.when && f.when.op !== 'filled' && f.when.value === undefined) return setErr('Say which answer shows this question');
    onSave(f); onClose();
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={initial?.key ? 'Edit question' : 'New question'}>
      <Field label="Question" value={f.label} onChangeText={(x) => set('label', x)} maxLength={160} />
      <Field label="Help text (optional)" value={f.hint ?? ''} onChangeText={(x) => set('hint', x)} maxLength={300} />
      <T weight="800" size={13}>Kind of answer</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{TYPES.map(([v, l]) => <Chip key={v} label={l} active={f.type === v} onPress={() => set('type', v)} />)}</View>
      <T size={12} color={c.mute}>{TYPE_HELP[f.type]}</T>
      {['choice', 'multi'].includes(f.type) ? (
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Options</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{f.options.map((o) => <Chip key={o.value} active label={`${o.label}  ✕`} onPress={() => set('options', f.options.filter((x) => x.value !== o.value))} />)}</View>
          <Field value={opt} onChangeText={setOpt} placeholder="Type an option" maxLength={60} />
          <Btn small title="Add option" color={c.violet} style={{ alignSelf: 'flex-start' }} disabled={!opt.trim()} onPress={() => { const label = opt.trim(); if (!f.options.some((o) => o.label === label)) set('options', [...f.options, { value: slug(label, new Set(f.options.map((o) => o.value))), label }]); setOpt(''); }} />
        </View>
      ) : null}
      {f.type === 'file' ? <View style={{ flexDirection: 'row', alignItems: 'center' }}><T weight="800" size={13} style={{ flex: 1 }}>Most files</T><Counter value={f.max_files} min={1} max={10} onChange={(x) => set('max_files', x)} /></View> : null}
      {f.type === 'references' ? <View style={{ flexDirection: 'row', alignItems: 'center' }}><T weight="800" size={13} style={{ flex: 1 }}>Most references</T><Counter value={f.max_items} min={1} max={10} onChange={(x) => set('max_items', x)} /></View> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><T weight="800" size={13} style={{ flex: 1 }}>Applicant must answer</T><Switch accessibilityLabel="Required" value={!!f.required} onValueChange={(x) => set('required', x)} trackColor={{ true: c.pink }} /></View>
      {!['file', 'budget', 'references'].includes(f.type) ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}><T weight="800" size={13}>Confidential</T><T size={12} color={c.mute}>Stored encrypted; staff reading it is logged.</T></View><Switch accessibilityLabel="Confidential" value={!!f.confidential} onValueChange={(x) => set('confidential', x)} trackColor={{ true: c.pink }} /></View> : <T size={12} color={c.mute}>Files, budgets and references are always kept confidential.</T>}
      {earlier.length ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}><T weight="800" size={13}>Show only when…</T><T size={12} color={c.mute}>Depends on an earlier answer.</T></View><Switch accessibilityLabel="Show only when" value={!!f.when} onValueChange={(x) => set('when', x ? { field: earlier[0].key, op: 'filled' } : null)} trackColor={{ true: c.pink }} /></View>
          {f.when ? (
            <>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{earlier.map((e) => <Chip key={e.key} label={e.label || e.key} active={f.when.field === e.key} onPress={() => set('when', { field: e.key, op: 'filled' })} />)}</View>
              {valueChoices.length ? <Seg options={[{ value: 'filled', label: 'Is answered' }, { value: 'eq', label: 'Is' }, { value: 'ne', label: 'Is not' }]} value={f.when.op} onChange={(op) => set('when', { field: f.when.field, op, ...(op === 'filled' ? {} : { value: f.when.value }) })} color={c.pink} /> : <T size={12} color={c.mute}>Shown once that question is answered.</T>}
              {f.when.op !== 'filled' && valueChoices.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{valueChoices.map((o) => <Chip key={String(o.value)} label={o.label} active={f.when.value === o.value} onPress={() => set('when', { ...f.when, value: o.value })} />)}</View> : null}
            </>
          ) : null}
        </View>
      ) : null}
      {err ? <T color={c.red} weight="800">{err}</T> : null}
      <Btn title="Save question" onPress={save} />
    </Sheet>
  );
}

/** Pick a starting point: a standard template (optionally tailored to the program by AI) or a blank form. */
function TemplateGallery({ program, onPick, onBlank, onCancel }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/sponsorship-form-templates'), []);
  const ai = useLoad(() => api.get('/ai/status'), []);
  const [chosen, setChosen] = useState(null);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const use = async (t, withBrief) => {
    setBusy(true);
    try {
      const d = await api.post(`/sponsorship-programs/${program.id}/form-drafts`, { template: t.key, ...(withBrief && brief.trim() ? { brief: brief.trim() } : {}) });
      if (withBrief && brief.trim() && !d.ai) toast('AI could not tailor it just now. Here is the standard template to edit');
      onPick({ name: d.name === t.name ? `${program.name} · ${t.name}`.slice(0, 120) : d.name, def: withDefaults(d.definition), ai: d.ai });
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Screen>
      <H1>Start an application form</H1>
      <T size={13} color={c.mute}>Choose a ready-made template for {program.name}. You can change every question before you publish.</T>
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : (list.data ?? []).map((t) => (
        <Card key={t.key} color={chosen === t.key ? c.violetSoft : c.paper} onPress={() => setChosen(chosen === t.key ? null : t.key)}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{t.name}</T><Tag label={`${t.questions} questions`} color={c.mint} /></View>
          <T size={12} color={c.mute}>Best for: {t.best_for}</T>
          <T size={13} style={{ marginTop: 4 }}>{t.summary}</T>
          {chosen === t.key ? (
            <View style={{ gap: 10, marginTop: 10 }}>
              {t.definition.sections.map((x) => <View key={x.id}><T weight="800" size={12}>{x.title}</T><T size={12} color={c.mute}>{x.fields.map((f) => f.label).join(' · ')}</T></View>)}
              <Btn title="Use this template" loading={busy} onPress={() => use(t, false)} />
              {ai.data?.configured ? (
                <View style={{ gap: 8 }}>
                  <Field label="Or tailor it with AI" value={brief} onChangeText={setBrief} multiline maxLength={600} placeholder="What does this program fund, and who should apply? e.g. travel grants for under-18 swimmers" />
                  <Btn small title="Tailor with AI" color={c.violet} loading={busy} disabled={brief.trim().length < 10} style={{ alignSelf: 'flex-start' }} onPress={() => use(t, true)} />
                </View>
              ) : null}
            </View>
          ) : null}
        </Card>
      ))}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title="Cancel" color={c.paper} ink={c.ink} onPress={onCancel} style={{ flex: 1 }} />
        <Btn title="Start blank" color={c.paper} ink={c.ink} onPress={onBlank} style={{ flex: 1 }} />
      </View>
    </Screen>
  );
}

/** Brand staff: design the application form of a program, publish versions, and pin a version to each round. */
export function FormBuilder({ program_id }) {
  const { toast } = useSession();
  const prog = useLoad(() => api.get(`/sponsorship-programs/${program_id}`), [program_id]);
  const forms = useLoad(() => api.get(`/sponsorship-programs/${program_id}/forms`, { limit: 50 }), [program_id]);
  const [edit, setEdit] = useState(null);         // { id|null, name, version, row_version, def }
  const [fieldSheet, setFieldSheet] = useState(null); // { si, fi|null }
  const [secSheet, setSecSheet] = useState(null);
  const [secTitle, setSecTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const reload = () => { prog.reload(); forms.reload(); };
  const act = async (fn, m) => { try { await fn(); if (m) toast(m); reload(); } catch (e) { toast(explain(e)); if (e.status === 409) reload(); } };
  if (prog.error) return <Screen><LoadError error={prog.error} onRetry={prog.reload} /></Screen>;
  if (prog.loading && !prog.data) return <Screen><Loading /></Screen>;
  const p = prog.data;
  const may = ['manager', 'approver', 'admin'].includes(p.my_role);

  const open = async (f) => {
    try { const full = await api.get(`/sponsorship-forms/${f.id}`); setEdit({ id: f.id, name: full.name, row_version: full.row_version, version: full.version, def: structuredClone(full.definition) }); } catch (e) { toast(explain(e)); }
  };
  const setDef = (fn) => setEdit((e) => { const def = structuredClone(e.def); fn(def); return { ...e, def }; });
  const taken = () => new Set(fieldsOf(edit.def).map((f) => f.key));
  const publish = async () => {
    setBusy(true);
    try {
      const definition = { sections: edit.def.sections.map((s) => ({ id: s.id, title: s.title, fields: s.fields.map(strip) })) };
      if (edit.id) await api.post(`/sponsorship-forms/${edit.id}/versions`, { version: edit.row_version, definition });
      else await api.post(`/sponsorship-programs/${p.id}/forms`, { name: edit.name, definition });
      toast('Published — pin it to a round for applicants to see it'); setEdit(null); reload();
    } catch (e) {
      const first = Array.isArray(e.details) ? e.details[0] : null;
      toast(first ? `${first.path}: ${first.message}` : explain(e));
    } finally { setBusy(false); }
  };

  if (picking && !edit) return <TemplateGallery program={p} onCancel={() => setPicking(false)} onBlank={() => { setPicking(false); setEdit({ id: null, name: '', version: 0, row_version: 0, def: { sections: [{ id: 'about', title: 'About the application', fields: [] }] } }); }} onPick={(t) => { setPicking(false); setEdit({ id: null, name: t.name, version: 0, row_version: 0, def: t.def }); }} />;

  if (edit) {
    const earlierFor = (si, fi) => edit.def.sections.flatMap((s, a) => s.fields.map((f, b) => [a, b, f])).filter(([a, b]) => a < si || (a === si && (fi == null || b < fi))).map(([, , f]) => f).filter((f) => !['file', 'budget', 'references'].includes(f.type));
    const editing = fieldSheet ? (fieldSheet.fi != null ? edit.def.sections[fieldSheet.si].fields[fieldSheet.fi] : null) : null;
    return (
      <Screen>
        <H1>{edit.id ? `Edit · ${edit.name}` : 'New application form'}</H1>
        <T size={13} color={c.mute}>{edit.id ? `Publishing creates version ${edit.version + 1}. Earlier versions, and the applications made under them, never change.` : 'Design the questions applicants answer. Publish when ready, then pin it to a round.'}</T>
        {!edit.id ? <Field label="Form name" value={edit.name} onChangeText={(x) => setEdit({ ...edit, name: x })} maxLength={120} /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Tag label={`${edit.def.sections.length} section${edit.def.sections.length === 1 ? '' : 's'}`} color={c.violetSoft} />
          <Tag label={`${fieldsOf(edit.def).length} questions`} color={c.violetSoft} />
          <Tag label={`${fieldsOf(edit.def).filter((f) => f.required).length} required`} color={c.mint} />
          <Tag label={`${fieldsOf(edit.def).filter((f) => f.confidential || ['file', 'budget', 'references'].includes(f.type)).length} confidential`} color={c.violetSoft} />
        </View>
        {edit.def.sections.map((s, si) => (
          <Section key={s.id} title={s.title} color={c.cyan}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              <Btn small title="↑" color={c.paper} ink={c.ink} onPress={() => setDef((d) => { d.sections = move(d.sections, si, -1); })} accessibilityLabel="Move section up" />
              <Btn small title="↓" color={c.paper} ink={c.ink} onPress={() => setDef((d) => { d.sections = move(d.sections, si, 1); })} accessibilityLabel="Move section down" />
              <Btn small title="Rename" color={c.paper} ink={c.ink} onPress={() => { setSecTitle(s.title); setSecSheet({ si }); }} />
              {edit.def.sections.length > 1 && !s.fields.length ? <Btn small title="Remove section" color={c.paper} ink={c.red} onPress={() => setDef((d) => { d.sections.splice(si, 1); })} /> : null}
            </View>
            {s.fields.map((f, fi) => (
              <Card key={f.key}>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>{fi + 1}. {f.label}</T><Tag label={TYPE_LABEL[f.type]} color={c.violetSoft} /></View>
                {f.hint ? <T size={12} color={c.mute}>{f.hint}</T> : null}
                <T size={12} color={c.mute}>{[f.required ? 'Required' : 'Optional', f.confidential ? 'Confidential' : null, f.when ? `Shown when “${fieldsOf(edit.def).find((x) => x.key === f.when.field)?.label ?? f.when.field}” ${f.when.op === 'filled' ? 'is answered' : `${f.when.op === 'eq' ? 'is' : 'is not'} ${String(f.when.value)}`}` : null].filter(Boolean).join(' · ')}</T>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  <Btn small title="↑" color={c.paper} ink={c.ink} onPress={() => setDef((d) => { d.sections[si].fields = move(d.sections[si].fields, fi, -1); })} accessibilityLabel="Move question up" />
                  <Btn small title="↓" color={c.paper} ink={c.ink} onPress={() => setDef((d) => { d.sections[si].fields = move(d.sections[si].fields, fi, 1); })} accessibilityLabel="Move question down" />
                  <Btn small title="Edit" color={c.violet} onPress={() => setFieldSheet({ si, fi })} />
                  <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => setDef((d) => { const gone = d.sections[si].fields[fi].key; d.sections[si].fields.splice(fi, 1); for (const x of d.sections.flatMap((y) => y.fields)) if (x.when?.field === gone) x.when = null; })} />
                </View>
              </Card>
            ))}
            <Btn small title="+ Add a question" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setFieldSheet({ si, fi: null })} />
          </Section>
        ))}
        <Btn small title="+ Add a section" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => { setSecTitle(''); setSecSheet({ si: null }); }} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn title="Cancel" color={c.paper} ink={c.ink} onPress={() => setEdit(null)} style={{ flex: 1 }} />
          <Btn title={edit.id ? 'Publish new version' : 'Publish form'} loading={busy} disabled={edit.def.sections.every((s) => !s.fields.length) || (!edit.id && edit.name.trim().length < 2)} onPress={publish} style={{ flex: 2 }} />
        </View>
        <FieldSheet visible={!!fieldSheet} onClose={() => setFieldSheet(null)} initial={editing} earlier={fieldSheet ? earlierFor(fieldSheet.si, fieldSheet.fi) : []}
          onSave={(f) => setDef((d) => { const { si, fi } = fieldSheet; if (fi != null) d.sections[si].fields[fi] = { ...f }; else d.sections[si].fields.push({ ...f, key: slug(f.label, taken()) }); })} />
        <Sheet visible={!!secSheet} onClose={() => setSecSheet(null)} title={secSheet?.si == null ? 'New section' : 'Rename section'}>
          <Field label="Section title" value={secTitle} onChangeText={setSecTitle} maxLength={120} />
          <Btn title="Save" disabled={!secTitle.trim()} onPress={() => { setDef((d) => { if (secSheet.si == null) d.sections.push({ id: slug(secTitle, new Set(d.sections.map((s) => s.id))), title: secTitle.trim(), fields: [] }); else d.sections[secSheet.si].title = secTitle.trim(); }); setSecSheet(null); }} />
        </Sheet>
      </Screen>
    );
  }

  const live = (forms.data ?? []).filter((f) => !f.archived_at);
  return (
    <Screen onRefresh={reload} refreshing={forms.loading && !!forms.data}>
      <H1>Application forms</H1>
      <T size={13} color={c.mute}>{p.name} · Versioned forms for this program. Each round is pinned to one version, and every application keeps the version it was filled under.</T>
      {may ? <Btn small title="New form from a template" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setPicking(true)} /> : null}
      {forms.error ? <LoadError error={forms.error} onRetry={forms.reload} /> : forms.loading && !forms.data ? <Loading /> : live.length ? live.map((f) => (
        <Card key={f.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{f.name}</T><Tag label={`v${f.latest_version}`} color={c.mint} /></View>
          <T size={12} color={c.mute}>{f.rounds.length ? `Pinned to ${f.rounds.map((r) => `round ${r.seq} (v${r.form_version})`).join(', ')}` : 'Not pinned to any round yet'}</T>
          {may ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Edit" color={c.violet} onPress={() => open(f)} />{!f.rounds.length ? <Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/sponsorship-forms/${f.id}/archive`), 'Archived — kept on record')} /> : null}</View> : null}
        </Card>
      )) : <Empty emoji="📝" title="No forms yet" sub={may ? 'Start from a ready-made template and tailor it. Applicants answer more than a pitch and an amount.' : 'Forms of this program appear here.'} />}
      <Section title="Rounds" color={c.sun}>
        {p.rounds.length ? p.rounds.map((r) => (
          <Card key={r.id}>
            <T weight="900">{r.name}</T>
            <T size={12} color={c.mute}>{r.form_id ? `Uses ${live.find((f) => f.id === r.form_id)?.name ?? 'a form'} v${r.form_version}` : 'Plain application (pitch and amount)'}</T>
            {may && r.status !== 'closed' ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                <Chip label="No form" active={!r.form_id} onPress={() => r.form_id && act(() => api.post(`/program-rounds/${r.id}/form`, { version: r.row_version, form_id: null }), 'Round now uses the plain application')} />
                {live.map((f) => <Chip key={f.id} label={`${f.name} v${f.latest_version}`} active={r.form_id === f.id && r.form_version === f.latest_version} onPress={() => act(() => api.post(`/program-rounds/${r.id}/form`, { version: r.row_version, form_id: f.id, form_version: f.latest_version }), `Pinned ${f.name} v${f.latest_version}. Drafts already started keep their version`)} />)}
              </View>
            ) : null}
          </Card>
        )) : <Empty emoji="🗓️" title="No rounds yet" sub="Add a round on the program first." />}
      </Section>
    </Screen>
  );
}
