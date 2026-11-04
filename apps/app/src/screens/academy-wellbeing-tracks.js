// Personal-development tracks (#795): values, leadership, life skills, nutrition education, study skills. Optional for every athlete, age-banded,
// delivered by a named facilitator who ticks modules off; participation is shown as counts (a group under five is hidden). The API enforces consent and age.
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { Counter } from '../pickers';
import { SportsMulti } from '../sportpicker';
import { c } from '../theme';
import { Initials } from './academy-ui';
import { CATEGORY_LIST, catLabel, deliveryLabel, opts, skipLabel, statusLabel } from './wellbeing-words';

const tick = (done, i) => `${done ? '✓ ' : ''}${i + 1}`;

export function Tracks({ o, toast, oversight, admin, reload }) {
  const [archived, setArchived] = useState(false), [edit, setEdit] = useState(null), [open, setOpen] = useState(null);
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/wellbeing/tracks`, { status: archived ? 'archived' : undefined }), [o.id, archived]);
  const rows = d.data ?? [];
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <Chip label={t('wb.tr_live')} active={!archived} onPress={() => setArchived(false)} /><Chip label={t('wb.tr_archived')} active={archived} onPress={() => setArchived(true)} />
        {admin ? <Btn small title={t('wb.tr_new')} onPress={() => setEdit({})} style={{ marginLeft: 'auto' }} /> : null}
      </View>
      {d.error ? <LoadError error={d.error} onRetry={d.reload} /> : !d.data ? <Loading /> : !rows.length ? (
        <Card><Empty emoji="🌱" title={t('wb.tr_empty_title')} sub={admin ? t('wb.tr_empty_sub_admin') : t('wb.tr_empty_sub')} /></Card>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {rows.map((x) => (
            <Card key={x.id} onPress={() => setOpen(x)} accessibilityLabel={x.title} style={{ flexGrow: 1, flexBasis: 300, minWidth: 260 }}>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={catLabel(x.category)} color={c.limeSoft} />{x.status === 'draft' ? <Tag label={t('wb.tr_draft')} color={c.sunSoft} /> : null}</View>
              <T weight="800" size={17} style={{ marginTop: 6 }}>{x.title}</T>
              {x.summary ? <T size={13} color={c.mute} numberOfLines={3}>{x.summary}</T> : null}
              <T size={12} color={c.mute} style={{ marginTop: 6 }}>{t('wb.tr_meta', { min: x.age_min, max: x.age_max, n: x.modules.length })} · {deliveryLabel(x.delivery)}</T>
              <T size={13} weight="700" style={{ marginTop: 4 }}>{x.participants_hidden ? t('wb.tr_hidden') : t('wb.tr_taking_part', { n: x.participants ?? 0 })}</T>
            </Card>
          ))}
        </View>
      )}
      <TrackForm o={o} track={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); d.reload(); reload?.(); }} toast={toast} />
      <TrackSheet o={o} track={open} admin={admin} onClose={() => setOpen(null)} toast={toast} onChanged={() => { d.reload(); reload?.(); }} onEdit={(x) => { setOpen(null); setEdit(x); }} />
    </View>
  );
}

function TrackForm({ o, track, onClose, onSaved, toast }) {
  const [v, setV] = useState(null);
  const [busy, setBusy] = useState(false);
  const seed = track?.id ? { track_id: track.id, category: track.category, title: track.title, summary: track.summary ?? '', age_min: track.age_min, age_max: track.age_max, delivery: track.delivery, sports: track.sports ?? [], modules: track.modules.map((m) => ({ ...m })), locked: track.modules.length, status: track.status === 'draft' ? 'draft' : 'active' }
    : { category: 'life_skills', title: '', summary: '', age_min: 10, age_max: 16, delivery: 'group', sports: [], modules: [{ title: '', outcome: '' }], locked: 0, status: 'active' };
  const cur = v?.for === (track?.id ?? 'new') ? v : { ...seed, for: track?.id ?? 'new' };
  const set = (k, x) => setV({ ...cur, [k]: x });
  const setMod = (i, k, x) => set('modules', cur.modules.map((m, n) => (n === i ? { ...m, [k]: x } : m)));
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/organisations/${o.id}/academy/wellbeing/tracks`, { track_id: cur.track_id, category: cur.category, title: cur.title, summary: cur.summary || undefined, age_min: cur.age_min, age_max: cur.age_max, delivery: cur.delivery, sports: cur.sports,
        modules: cur.modules.filter((m) => m.title.trim()).map((m) => ({ title: m.title.trim(), outcome: m.outcome?.trim() || undefined })), status: cur.status });
      toast(t('wb.tr_saved')); setV(null); onSaved();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={!!track} onClose={() => { setV(null); onClose(); }} title={track?.id ? t('wb.tr_edit') : t('wb.tr_new')} footer={<Btn title={t('common.save')} onPress={save} loading={busy} disabled={cur.title.trim().length < 2 || !cur.modules.some((m) => m.title.trim())} style={{ flex: 1 }} />}>
      <MenuField label={t('wb.tr_category')} value={cur.category} onChange={(x) => set('category', x)} options={opts(CATEGORY_LIST, catLabel)} />
      <Field label={t('wb.tr_title')} value={cur.title} onChangeText={(x) => set('title', x)} maxLength={120} />
      <Field label={t('wb.tr_summary')} value={cur.summary} onChangeText={(x) => set('summary', x)} multiline maxLength={600} />
      <View style={{ gap: 6 }}>
        <T weight="600" size={12} color={c.mute}>{t('wb.tr_age').toUpperCase()}</T>
        <Counter label={t('wb.tr_age_min')} value={cur.age_min} min={4} max={cur.age_max} onChange={(x) => set('age_min', x)} />
        <Counter label={t('wb.tr_age_max')} value={cur.age_max} min={cur.age_min} max={60} onChange={(x) => set('age_max', x)} />
        <T size={12} color={c.mute}>{t('wb.tr_age_hint')}</T>
      </View>
      <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>{t('wb.tr_delivery').toUpperCase()}</T><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{['group', 'one_to_one', 'blended'].map((x) => <Chip key={x} label={deliveryLabel(x)} active={cur.delivery === x} onPress={() => set('delivery', x)} />)}</View></View>
      <SportsMulti label={t('wb.tr_sports')} value={cur.sports} onChange={(x) => set('sports', x)} />
      <View style={{ gap: 8 }}>
        <T weight="600" size={12} color={c.mute}>{t('wb.tr_modules').toUpperCase()}</T>
        {cur.modules.map((m, i) => (
          <Card key={i} pad={12} color={c.bg}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <T weight="800" color={c.mute}>{i + 1}</T>
              <View style={{ flex: 1, gap: 6 }}>
                <Field value={m.title} onChangeText={(x) => setMod(i, 'title', x)} placeholder={t('wb.tr_module_title')} accessibilityLabel={t('wb.tr_module_title')} maxLength={120} />
                <Field value={m.outcome ?? ''} onChangeText={(x) => setMod(i, 'outcome', x)} placeholder={t('wb.tr_module_outcome')} accessibilityLabel={t('wb.tr_module_outcome')} maxLength={240} />
              </View>
              {i >= cur.locked ? <Btn small title="✕" color={c.paper} ink={c.red} accessibilityLabel={t('wb.tr_remove_module')} onPress={() => set('modules', cur.modules.filter((_, n) => n !== i))} /> : null}
            </View>
          </Card>
        ))}
        {cur.modules.length < 30 ? <Btn small title={t('wb.tr_add_module')} color={c.paper} ink={c.ink} onPress={() => set('modules', [...cur.modules, { title: '', outcome: '' }])} style={{ alignSelf: 'flex-start' }} /> : null}
        {cur.locked ? <T size={12} color={c.mute}>{t('wb.tr_append_only')}</T> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 6 }}>{['active', 'draft'].map((x) => <Chip key={x} label={x === 'active' ? t('wb.tr_publish') : t('wb.tr_draft')} active={cur.status === x} onPress={() => set('status', x)} />)}</View>
    </Sheet>
  );
}

function TrackSheet({ o, track, admin, onClose, toast, onChanged, onEdit }) {
  const full = useLoad(() => (track ? api.get(`/academy/wellbeing/tracks/${track.id}`) : Promise.resolve(null)), [track?.id]);
  const people = useLoad(() => (track ? api.get(`/organisations/${o.id}/academy/wellbeing/athletes`, { limit: 100 }) : Promise.resolve([])), [track?.id]);
  const [enrol, setEnrol] = useState(false);
  const f = full.data;
  const toggle = async (m, i, on) => { try { await api.post(`/academy/wellbeing/tracks/${track.id}/members/${m.athlete_id}`, { action: on ? 'module_undone' : 'module_done', module_index: i }); full.reload(); onChanged(); } catch (e) { toast(explain(e)); } };
  const member = async (m, action) => { try { await api.post(`/academy/wellbeing/tracks/${track.id}/members/${m.athlete_id}`, { action }); full.reload(); onChanged(); } catch (e) { toast(explain(e)); } };
  return (
    <Sheet visible={!!track} onClose={onClose} title={track?.title ?? ''}>
      {!track ? null : full.error ? <LoadError error={full.error} onRetry={full.reload} /> : !f ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={catLabel(f.category)} color={c.limeSoft} /><Tag label={t('wb.tr_meta', { min: f.age_min, max: f.age_max, n: f.modules.length })} /><Tag label={deliveryLabel(f.delivery)} /></View>
          {f.summary ? <T size={14}>{f.summary}</T> : null}
          {f.modules.map((m, i) => <Row key={i} left={<T weight="800" color={c.mute}>{i + 1}</T>} title={m.title} sub={m.outcome} />)}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {f.status === 'active' ? <Btn small title={t('wb.tr_enrol')} onPress={() => setEnrol(true)} /> : null}
            {admin && f.status !== 'archived' ? <Btn small title={t('wb.tr_edit')} color={c.paper} ink={c.ink} onPress={() => onEdit(f)} /> : null}
            {admin && f.status !== 'archived' ? <Btn small title={t('wb.tr_archive')} color={c.paper} ink={c.red} onPress={async () => { try { await api.post(`/academy/wellbeing/tracks/${f.id}/archive`, {}); toast(t('wb.updated')); onChanged(); onClose(); } catch (e) { toast(explain(e)); } }} /> : null}
          </View>
          <T weight="800" size={13}>{t('wb.tr_members', { n: f.members.length })}</T>
          {f.members.length ? f.members.map((m) => (
            <Card key={m.athlete_id} pad={12} color={c.bg}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Initials name={m.display_name} user={m} size={34} /><View style={{ flex: 1 }}><T weight="800">{m.display_name}</T><T size={12} color={c.mute}>{statusLabel(m.status)} · {t('wb.tr_progress', { a: m.modules_done.length, b: f.modules.length })}</T></View></View>
              {m.status === 'enrolled' ? (
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {f.modules.map((mod, i) => <Chip key={i} label={tick(m.modules_done.includes(i), i)} active={m.modules_done.includes(i)} onPress={() => toggle(m, i, m.modules_done.includes(i))} />)}
                  <Btn small title={t('wb.tr_complete')} color={c.paper} ink={c.ink} onPress={() => member(m, 'complete')} />
                </View>
              ) : null}
            </Card>
          )) : <Empty emoji="🌿" title={t('wb.tr_no_members_title')} sub={t('wb.tr_no_members_sub')} />}
        </View>
      )}
      <FormSheet visible={enrol} onClose={() => setEnrol(false)} title={t('wb.tr_enrol')} submitLabel={t('wb.tr_enrol')} notice={t('wb.tr_enrol_notice')}
        initial={{ athletes: [] }}
        fields={[{ key: 'athletes', label: t('wb.tr_athletes'), type: 'multimenu', options: (people.data ?? []).filter((p) => p.scopes.includes('tracks')).map((p) => ({ value: p.athlete_id, label: p.display_name, sub: p.is_youth ? t('wb.youth') : undefined })) }]}
        onSubmit={async (val) => {
          const r = await api.post(`/academy/wellbeing/tracks/${track.id}/members`, { athlete_ids: val.athletes });
          full.reload(); onChanged();
          const skipped = r.results.filter((x) => x.result === 'skipped');
          return skipped.length ? `${t('wb.tr_enrolled_n', { n: r.results.length - skipped.length })} · ${skipped.map((x) => skipLabel(x.reason)).join(', ')}` : t('wb.tr_enrolled_n', { n: r.results.length });
        }} />
    </Sheet>
  );
}
