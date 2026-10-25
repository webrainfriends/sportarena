import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { useLayout } from '../layout';
import { c } from '../theme';
import { addDays, dateTimeIn, todayIn } from '../vtime';
import { ReadinessRing } from './wellness';

const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const nice = (s) => String(s).replace(/_/g, ' ');
const PURPOSES = [['training_load', 'Training load'], ['injury_prevention', 'Injury prevention'], ['return_to_play', 'Return to play'], ['performance_review', 'Performance review']];
const FIELDS = [['sleep', 'Sleep'], ['soreness', 'Soreness'], ['mood', 'Mood'], ['hydration', 'Hydration'], ['readiness', 'Readiness score'], ['workload', 'Workload'], ['body_map', 'Body map']];
const HISTORY = [[7, '7 days'], [30, '30 days'], [90, '90 days']];
const purposeLabel = (p) => PURPOSES.find((x) => x[0] === p)?.[1] ?? nice(p);
const fieldLabel = (f) => FIELDS.find((x) => x[0] === f)?.[1] ?? nice(f);
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** the stored end is the start of the next UTC day; show and edit the last day of access */
const lastDay = (iso) => addDays(new Date(iso).toISOString().slice(0, 10), -1);
const until = (iso) => day(`${lastDay(iso)}T00:00:00Z`);
const plain = (e) => (e?.details?.code === 'stale_version' ? 'This share changed on another device. It has been reloaded; please check and try again.' : e?.message ?? 'Something went wrong');

/** Web: a download. Phone / tablet: the share sheet. */
export async function saveCsv(out) {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out.csv], { type: 'text/csv' })); a.download = out.filename; document.body.appendChild(a); a.click(); a.remove();
    return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const file = new File(Paths.cache, out.filename);
  file.create({ overwrite: true }); file.write(out.csv);
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open CSV files from here. Use the web app to download it.');
  await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text', dialogTitle: out.filename });
}

// ---------- athlete: who can see my wellness ----------

const stateTag = (s) => {
  if (s.state === 'revoked') return <Tag label="Stopped" color={c.violetSoft} />;
  if (s.state === 'expired') return <Tag label="Ended" color={c.violetSoft} />;
  if (!s.live) return <Tag label="Paused" color={c.sunSoft} />;
  return <Tag label="Active" color={c.limeSoft} />;
};

/** The athlete's sharing card (Health → Recovery). For a young athlete a guardian passes `athleteId`. */
export function WellnessSharing({ athleteId }) {
  const { toast } = useSession();
  const q = athleteId ? `?athlete_id=${athleteId}` : '';
  const list = useLoad(() => api.get(`/me/wellness-shares${q}`), [athleteId]);
  const recipients = useLoad(() => (athleteId ? Promise.resolve([]) : api.get('/me/wellness-shares/recipients')), [athleteId]);
  const [form, setForm] = useState(null);       // { share? } -> new or edit
  const [stop, setStop] = useState(null);
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = (list.data?.shares ?? []).filter((s) => s.state === 'active');
  const past = (list.data?.shares ?? []).filter((s) => s.state !== 'active');
  const min = todayIn(tz), max = addDays(min, 365);
  const opts = (recipients.data ?? []).map((r) => ({ id: r.id, label: r.display_name, sub: `${r.kind === 'coach' ? 'Your coach' : 'Clinician with medical access'} · @${r.handle}` }));

  const revoke = async () => {
    setBusy(true);
    try { await api.post(`/me/wellness-shares/${stop.id}/revoke`, {}); toast('Sharing stopped'); setStop(null); await list.reload(); }
    catch (e) { toast(plain(e)); } finally { setBusy(false); }
  };
  const edit = form?.share;
  const common = [
    { key: 'fields', label: 'What they can see', type: 'multi', options: FIELDS.map(([value, label]) => ({ value, label })), hint: 'Private notes are never shared.' },
    { key: 'history_days', label: 'How far back', type: 'chips', options: HISTORY.map(([value, label]) => ({ value, label })) },
    { key: 'expires_on', label: 'Share until', type: 'date', min, max },
  ];
  const fieldsForm = edit ? common : [
    { key: 'recipient_id', label: 'Who', type: 'entity', options: opts, noun: 'coach or clinician' },
    { key: 'purpose', label: 'Why', type: 'chips', options: PURPOSES.map(([value, label]) => ({ value, label })) },
    ...common,
  ];

  return (
    <Card pad={16}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" size={16} style={{ flex: 1 }}>{athleteId ? 'Wellness sharing' : 'Share with my support team'}</T>
        {live.length ? <Tag label={`${live.length} active`} color={c.limeSoft} /> : null}
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 4 }}>You choose who sees what, and for how long. Private notes are never shared. Stop any time; every view is logged for you.</T>
      <View style={{ gap: 10, marginTop: 12 }}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !live.length ?
          <Empty emoji="🤝" title="You are not sharing anything" sub={athleteId ? 'Nothing is shared from this young person’s wellness.' : 'Add a coach or clinician to let them see only what you choose.'} /> :
          live.map((s) => (
            <View key={s.id} accessible accessibilityLabel={`${s.recipient_name}, ${purposeLabel(s.purpose)}, ${s.live ? 'active' : 'paused'}`} style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 14, padding: 12, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{s.recipient_name}</T>{stateTag(s)}</View>
              <T size={12} color={c.mute}>{purposeLabel(s.purpose)} · until {until(s.expires_at)} · last {s.history_days} days</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{s.fields.map((f) => <Tag key={f} label={fieldLabel(f)} color={c.pinkSoft} />)}</View>
              {!s.live && s.blocked_reason ? <T size={12} weight="700" color={c.sun}>Not visible right now: {s.blocked_reason}</T> : null}
              <T size={12} color={c.mute}>{s.views ? `Viewed ${s.views} time${s.views === 1 ? '' : 's'} · last ${dateTimeIn(s.last_viewed_at, tz)}` : 'Not viewed yet'}</T>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm({ share: s })} accessibilityLabel={`Edit what ${s.recipient_name} can see`} />
                <Btn small title="Stop sharing" color={c.paper} ink={c.red} onPress={() => setStop(s)} accessibilityLabel={`Stop sharing with ${s.recipient_name}`} />
              </View>
            </View>
          ))}
        {!athleteId ? <Btn title="＋ Share wellness" onPress={() => setForm({})} disabled={recipients.loading} accessibilityLabel="Share wellness with a coach or clinician" /> : null}
        {!athleteId && !recipients.loading && !opts.length && !recipients.error ? <T size={12} color={c.mute}>You can share with a coach who currently coaches you, or a physio or doctor you have given medical access (Health → Access).</T> : null}
        {past.length || list.data?.activity?.length ? <Btn small title={history ? 'Hide history' : 'Past sharing & who viewed what'} color={c.paper} ink={c.ink} onPress={() => setHistory(!history)} /> : null}
        {history ? (
          <View style={{ gap: 6 }}>
            {past.map((s) => <T key={s.id} size={12} color={c.mute}>{s.recipient_name} · {purposeLabel(s.purpose)} · {s.state === 'revoked' ? 'stopped' : 'ended'}</T>)}
            {(list.data?.activity ?? []).map((a) => <T key={a.id} size={12} color={c.mute}>{dateTimeIn(a.created_at, tz)} · {a.recipient_name} · {a.action}</T>)}
          </View>
        ) : null}
      </View>

      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? `What ${edit.recipient_name} can see` : 'Share wellness'} submitLabel={edit ? 'Save' : 'Share'} fields={fieldsForm}
        initial={edit ? { fields: edit.fields, history_days: edit.history_days, expires_on: lastDay(edit.expires_at) } : { purpose: 'training_load', fields: ['sleep', 'soreness'], history_days: 30, expires_on: addDays(min, 30) }}
        onSubmit={async (v) => {
          try {
            if (edit) await api.patch(`/me/wellness-shares/${edit.id}`, { version: edit.version, fields: v.fields, history_days: v.history_days, expires_on: v.expires_on });
            else await api.post('/me/wellness-shares', v);
            await list.reload();
            return edit ? 'Saved' : 'Shared. You can stop at any time.';
          } catch (e) { if (e?.details?.code === 'stale_version') await list.reload(); throw new Error(plain(e)); }
        }} />
      <Sheet visible={!!stop} onClose={() => setStop(null)} title="Stop sharing?">
        <T size={14}>{stop?.recipient_name} will lose access on their next view. The history of what was shared stays in your log.</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Btn title="Stop sharing" color={c.red} onPress={revoke} loading={busy} />
          <Btn title="Keep sharing" color={c.paper} ink={c.ink} onPress={() => setStop(null)} />
        </View>
      </Sheet>
    </Card>
  );
}

/** A verified guardian manages a young athlete's wellness sharing. */
export function ChildWellnessSharing({ child_id, name }) {
  return (
    <Screen>
      <H1>{name ? `${name}: wellness sharing` : 'Wellness sharing'}</H1>
      <WellnessSharing athleteId={child_id} />
    </Screen>
  );
}

// ---------- coach / clinician: what was shared with me ----------

const Kv = ({ label, value }) => (
  <View style={{ backgroundColor: c.bg, borderRadius: 12, padding: 10, minWidth: 130, flexGrow: 1, flexBasis: 130 }}>
    <T size={12} color={c.mute}>{label}</T><T weight="800" size={18}>{value ?? '–'}</T>
  </View>
);

function Detail({ share }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/wellness-shared/${share.id}`), [share.id]);
  const [busy, setBusy] = useState(false);
  const exportCsv = async () => {
    setBusy(true);
    try { const out = await api.get(`/wellness-shared/${share.id}/export`); await saveCsv(out); toast(`Exported ${out.rows} day${out.rows === 1 ? '' : 's'}. This download is logged and visible to the athlete.`); }
    catch (e) { toast(e?.message ?? 'Could not export'); } finally { setBusy(false); }
  };
  if (d.loading && !d.data) return <Card><Loading /></Card>;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  const v = d.data, s = v.summary;
  return (
    <Card pad={16}>
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        {v.readiness ? <ReadinessRing score={v.readiness.score} band={v.readiness.band} size={96} /> : null}
        <View style={{ flex: 1, minWidth: 200 }}>
          <T weight="800" size={18}>{v.athlete.display_name}</T>
          <T size={12} color={c.mute}>{purposeLabel(v.share.purpose)} · {v.window.from} to {v.window.to}</T>
          <T size={12} color={c.mute}>Self-reported by the athlete · guidance, not a diagnosis</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {'avg_sleep_hours' in s ? <Kv label="Sleep (avg)" value={s.avg_sleep_hours == null ? null : `${s.avg_sleep_hours} h`} /> : null}
        {'avg_soreness' in s ? <Kv label="Soreness (avg)" value={s.avg_soreness == null ? null : `${s.avg_soreness} / 10`} /> : null}
        {'avg_mood' in s ? <Kv label="Mood (avg)" value={s.avg_mood == null ? null : `${s.avg_mood} / 5`} /> : null}
        {'avg_water_ml' in s ? <Kv label="Water (avg)" value={s.avg_water_ml == null ? null : `${Math.round(s.avg_water_ml)} ml`} /> : null}
        {v.workload ? <Kv label="Workload ratio" value={v.workload.ratio == null ? nice(v.workload.status) : `${v.workload.ratio} · ${v.workload.status}`} /> : null}
      </View>
      {v.body_map ? (
        <View style={{ marginTop: 12, gap: 4 }}>
          <T weight="800" size={13}>Body map (open entries)</T>
          {v.body_map.length ? v.body_map.map((p, i) => <T key={i} size={13}>{p.side !== 'centre' ? `${p.side} ` : ''}{nice(p.region)} · {p.kind} {p.severity}/10 · since {p.started_on}</T>) : <T size={13} color={c.mute}>No open entries.</T>}
        </View>
      ) : null}
      {v.days.length ? (
        <View style={{ marginTop: 12, gap: 4 }}>
          <T weight="800" size={13}>Daily log</T>
          {v.days.map((x) => (
            <View key={x.date} style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
              <T size={12} color={c.mute} style={{ width: 84 }}>{x.date}</T>
              {'sleep_hours' in x ? <T size={12}>Sleep {x.sleep_hours ?? '–'} h</T> : null}
              {'soreness' in x ? <T size={12}>Soreness {x.soreness ?? '–'}</T> : null}
              {'mood' in x ? <T size={12}>Mood {x.mood ?? '–'}</T> : null}
              {'water_ml' in x ? <T size={12}>Water {x.water_ml ?? '–'} ml</T> : null}
            </View>
          ))}
        </View>
      ) : v.readiness || v.workload || v.body_map ? null : <Empty emoji="🗓️" title="Nothing logged in this window" sub="The athlete has not logged these fields in the days they shared." />}
      <T size={12} color={c.mute} style={{ marginTop: 12 }}>Not shared: {v.not_shared.map(nice).join(', ')}.</T>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <Btn small title="Download CSV" color={c.paper} ink={c.ink} onPress={exportCsv} loading={busy} accessibilityLabel="Download shared wellness as CSV" />
        <T size={12} color={c.mute} style={{ flex: 1, minWidth: 160 }}>Every view and download is recorded and visible to {v.athlete.display_name}.</T>
      </View>
    </Card>
  );
}

/** Coach / clinician: athletes who share wellness with me. Master-detail on a tablet or desktop, list then detail on a phone. */
export function SharedWellness({ share_id }) {
  const { tablet } = useLayout();
  const list = useLoad(() => api.get('/wellness-shared'), []);
  const [sel, setSel] = useState(share_id ?? null);
  const rows = list.data ?? [];
  const current = rows.find((r) => r.id === sel) ?? (tablet ? rows.find((r) => r.live) : null);
  const Item = ({ s }) => (
    <Card onPress={() => setSel(s.id)} accessibilityLabel={`${s.athlete_name}, ${purposeLabel(s.purpose)}, ${s.live ? 'visible' : 'not visible'}`} style={{ opacity: s.live ? 1 : 0.65, borderWidth: current?.id === s.id ? 2 : 0, borderColor: c.pink }}>
      <T weight="800">{s.athlete_name}</T>
      <T size={12} color={c.mute}>{purposeLabel(s.purpose)} · {s.live ? `until ${until(s.expires_at)}` : s.blocked_reason ?? 'No access'}</T>
    </Card>
  );
  return (
    <Screen onRefresh={list.reload} wide>
      <H1>Shared wellness</H1>
      <T size={13} color={c.mute}>Athletes who chose to share wellness with you. Access is checked every time and stops the moment they stop sharing.</T>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !rows.length ?
        <Empty emoji="🤝" title="Nobody has shared wellness with you yet" sub="Athletes you coach, or who gave you medical access, can choose to share selected wellness with you." /> : (
          <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>
            {tablet || !current ? <View style={{ gap: 8, width: tablet ? 260 : '100%' }}>{rows.map((s) => <Item key={s.id} s={s} />)}</View> : null}
            {current ? (
              <View style={{ flex: 1, width: '100%', gap: 8 }}>
                {!tablet ? <Btn small title="‹ All athletes" color={c.paper} ink={c.ink} onPress={() => setSel(null)} style={{ alignSelf: 'flex-start' }} /> : null}
                {current.live ? <Detail share={current} /> : <Card><T weight="800">{current.athlete_name}</T><T size={13} color={c.mute}>{current.blocked_reason ?? 'No access right now.'} Nothing is shown.</T></Card>}
              </View>
            ) : null}
          </View>
        )}
    </Screen>
  );
}
