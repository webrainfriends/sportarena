// Academy Content in the coaching workflow (#804): the licensed items linked to an academy session, shown inside the session's Curriculum tab
// (the screen that already owns "what this session teaches"). The server decides who may see, link and load; this only shows the live state of
// each licence and puts the items into the coach's own coaching plan. Nothing licensed is listed here: text is read through a seat in ItemReader.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';
import { Block } from './academy-ui';
import { lbl } from './academy-curriculum-ui';
import { ItemReader } from './academy-content-pack';

const TONE = { active: c.lime, grace: c.sunSoft, revoked: c.orangeSoft, expired: c.orangeSoft, suspended: c.orangeSoft };
const ICON = { curriculum: '🧭', methodology: '📘', drill: '🎯', module: '🧪', video: '🎥', document: '📄' };

export function LicensedSessionContent({ s, toast, nav, mine }) {
  const d = useLoad(() => api.get(`/academy/sessions/${s.id}/content`).catch(() => []), [s.id]);
  const lib = useLoad(() => api.get('/me/academy/content').catch(() => []), [s.id]);
  const [adding, setAdding] = useState(false);
  const [read, setRead] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!d.data) return <Loading />;
  const items = d.data;
  const linked = new Set(items.map((x) => x.item_id));
  const options = (lib.data ?? []).filter((l) => !l.locked).flatMap((l) => l.syllabus.filter((i) => !i.withdrawn && !linked.has(i.id)).map((i) => ({ value: `${l.id}|${i.id}`, label: i.title, sub: `${l.pack_title} · ${t(`cl.kind.${i.kind}`)}` })));
  const editable = s.status !== 'cancelled';
  const loadable = mine && items.some((x) => !x.locked && x.i_hold_seat && ['drill', 'curriculum', 'module'].includes(x.kind));
  const run = async (fn, ok) => { setBusy(true); try { await fn(); toast(ok); d.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const load = () => run(async () => {
    const r = await api.post(`/academy/sessions/${s.id}/content/plan`, {});
    toast(r.added.length ? t('cl.sess.loaded', { n: r.added.length }) : t('cl.sess.nothing_new'));
    if (r.added.length && nav) nav.push('SessionWorkspace', { source_type: 'academy_session', source_id: s.id });
  }, t('cl.sess.loaded_done'));
  return (
    <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>
      <Block title={t('cl.sess.title')} right={editable && options.length ? <Btn small title={t('cl.sess.add')} color={c.paper} ink={c.ink} onPress={() => setAdding(true)} /> : null}>
        <T size={12} color={c.mute}>{t('cl.sess.help')}</T>
        {items.length ? items.map((x) => (
          <View key={`${x.licence_id}${x.item_id}`} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 6 }}>
            <Row left={<T size={18}>{ICON[x.kind]}</T>} title={x.title} sub={lbl`${x.pack_title} · ${x.publisher_name}`}
              onPress={x.locked || !x.i_hold_seat ? undefined : () => setRead({ licence: { id: x.licence_id, licensee_org_id: s.organisation_id }, item: { id: x.item_id, title: x.title } })}
              right={<Tag label={x.withdrawn ? t('cl.sess.withdrawn') : t(`cl.stage.${x.state}`)} color={x.withdrawn ? c.orangeSoft : TONE[x.state]} />} />
            {x.locked ? <T size={12} color={c.mute}>{t('cl.sess.locked_hint')}</T> : !x.i_hold_seat ? <T size={12} color={c.mute}>{t('cl.sess.no_seat')}</T> : null}
            {editable ? <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title={t('cl.sess.unlink')} color={c.paper} ink={c.ink} accessibilityLabel={lbl`${t('cl.sess.unlink')}: ${x.title}`} loading={busy} onPress={() => run(() => api.del(`/academy/sessions/${s.id}/content/${x.item_id}`), t('cl.sess.unlinked'))} /></View> : null}
          </View>
        )) : <Empty emoji="📦" title={t('cl.sess.empty')} sub={options.length ? t('cl.sess.empty_pick') : t('cl.sess.empty_none')} />}
        {loadable && editable ? <Btn title={t('cl.sess.load')} loading={busy} onPress={load} /> : null}
        {loadable && editable ? <T size={11} color={c.mute}>{t('cl.sess.load_hint')}</T> : null}
      </Block>
      <FormSheet visible={adding} onClose={() => setAdding(false)} title={t('cl.sess.add')} submitLabel={t('cl.sess.add')}
        fields={[{ key: 'picks', label: t('cl.sess.pick'), type: 'multi', options }]}
        onSubmit={async (v) => { for (const p of v.picks ?? []) { const [lic, item] = p.split('|'); await api.post(`/academy/content/licences/${lic}/items/${item}/use`, { session_id: s.id }); } d.reload(); return t('cl.sess.added'); }} />
      <ItemReader sel={read} onClose={() => setRead(null)} toast={toast} onDone={d.reload} />
    </View>
  );
}
