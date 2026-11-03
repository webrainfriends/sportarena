// Who a published team performance report has been shared with, and a way to share it with an organisation (an academy, club or sponsor) for a limited time.
// The server enforces everything (only an aggregate-only organisation version, a real organisation, a bounded expiry, live checks on every read); this is the form.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Empty, ErrorBox, Field, Loading, Section, Sheet, T, Tag } from '../ui';
import { EntityPicker } from '../entity-picker';
import { DateField } from '../pickers';
import { t } from '../i18n';
import { c } from '../theme';
import { explain } from '../access';
const colon = (a, b) => `${a}: ${b}`;

const plusDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

export function ReportShares({ report }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get(`/coaching/reports/${report.id}/shares`), [report.id, report.latest_version]);
  const [open, setOpen] = useState(false);
  const [org, setOrg] = useState([]);
  const [expires, setExpires] = useState(plusDays(90));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const revoke = async (s) => { try { await api.post(`/coaching/report-shares/${s.id}/revoke`); toast(t('rsh.revoked')); list.reload(); } catch (e) { toast(explain(e)); } };
  const send = async () => {
    setBusy(true);
    try { await api.post(`/coaching/reports/${report.id}/shares`, { organisation_id: org[0].id, expires_on: expires, note: note.trim() || undefined }); toast(t('rsh.shared')); setOpen(false); setOrg([]); setNote(''); list.reload(); }
    catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Section title={t('rsh.title')} color={c.mint}>
      <T size={13} color={c.mute}>{t('rsh.help')}</T>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : !list.data.length ? <Empty emoji="🏛️" title={t('rsh.none')} sub={t('rsh.none_sub')} /> : list.data.map((s) => (
        <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingVertical: 8, minHeight: 44 }}>
          <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
            <T weight="700">{s.organisation_name}</T>
            <T size={12} color={c.mute}>{t('rsh.line', { v: s.version, date: s.expires_on.slice(0, 10) })}</T>
          </View>
          <Tag label={s.live ? t('rsh.live') : s.revoked_at ? t('rsh.revoked_tag') : t('rsh.expired')} color={s.live ? c.limeSoft : c.violetSoft} />
          {s.live ? <Btn small title={t('rsh.revoke')} color={c.paper} ink={c.red} onPress={() => revoke(s)} accessibilityLabel={colon(t('rsh.revoke'), s.organisation_name)} /> : null}
        </View>
      ))}
      <View style={{ marginTop: 8 }}><Btn small title={t('rsh.share_btn')} onPress={() => setOpen(true)} /></View>
      <T size={12} color={c.mute} style={{ marginTop: 6 }}>{t('rsh.pdf_note')}</T>
      {open ? (
        <Sheet visible onClose={() => setOpen(false)} title={t('rsh.share_title')}>
          <View style={{ gap: 12 }}>
            <EntityPicker kind="organisation" label={t('rsh.org')} value={org} onChange={(v) => setOrg(v.slice(-1))} />
            <DateField label={t('rsh.expires')} value={expires} onChange={setExpires} min={plusDays(1)} max={plusDays(365)} hint={t('rsh.expires_hint')} />
            <Field label={t('rsh.note')} value={note} onChangeText={setNote} multiline minHeight={70} maxLength={500} />
            <T size={12} color={c.mute}>{t('rsh.what_they_see')}</T>
            <Btn title={t('rsh.share_btn')} loading={busy} disabled={!org.length || !expires} onPress={send} />
          </View>
        </Sheet>
      ) : null}
    </Section>
  );
}
