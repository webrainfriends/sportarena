// Role copilots (issue #598): one screen for every role. Pick a copilot, a task and (where needed) the record to look at; get a DRAFT whose items each
// cite the records behind them, with proposed actions that do nothing until approved. All logic lives in the API (list_copilots, run_copilot_task,
// resolve_copilot_action); this screen only calls it. Layout adapts phone -> tablet -> desktop; strings come from the language packs.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, T, Tag } from '../ui';
import { HScroll } from '../pickers';
import { MenuField } from '../menu-field';
import { useLayout } from '../layout';
import { t } from '../i18n';
import { c } from '../theme';

const SEV = { high: c.red, medium: c.sun, low: c.mint };
const SEV_SOFT = { high: c.redSoft, medium: c.sunSoft, low: c.mintSoft };
const key = () => `cop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// the picker for the record a scoped copilot looks at: events I organise, venues I manage, organisations and governing bodies I can find
const SCOPE_LOAD = {
  event: (user) => api.get('/events', { organizer_id: user.id, limit: 50 }),
  venue: () => api.get('/me/venues').catch(() => []),
  organisation: () => api.get('/organisations'),
  body: () => api.get('/federation/bodies', { limit: 50 }),
};

function ItemCard({ it, sources, action, onResolve, busy }) {
  const refs = (it.source_refs ?? []).map((r) => sources.find((s) => s.ref === r)).filter(Boolean);
  return (
    <View style={{ backgroundColor: SEV_SOFT[it.severity] ?? c.violetSoft, borderRadius: 14, padding: 12, marginTop: 10, gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <T weight="700" style={{ flexShrink: 1 }}>{it.title}</T>
        <Tag label={t(`copilot.sev.${it.severity}`)} color={SEV[it.severity] ?? c.violet} />
      </View>
      {it.detail ? <T size={13}>{it.detail}</T> : null}
      {it.why ? <T size={12} color={c.mute}>{t('copilot.why')}: {it.why}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {refs.length ? refs.map((s) => (
          <View key={s.ref} accessible accessibilityLabel={t('copilot.source_a11y', { label: s.label })} style={{ minHeight: 32, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper }}>
            <T size={12} weight="600">{s.ref} · {s.label}</T>
          </View>
        )) : <T size={11} color={c.mute}>{t('copilot.no_source')}</T>}
      </View>
      {action ? (
        <View style={{ gap: 6, marginTop: 4 }}>
          <T size={12} weight="700">{action.label}</T>
          {action.status === 'proposed' && action.executable ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small title={t('copilot.approve')} disabled={busy} onPress={() => onResolve(action.id, 'approve')} accessibilityLabel={t('copilot.approve_a11y', { label: action.label })} />
              <Btn small color={c.paper} ink={c.ink} title={t('copilot.reject')} disabled={busy} onPress={() => onResolve(action.id, 'reject')} accessibilityLabel={t('copilot.reject_a11y', { label: action.label })} />
            </View>
          ) : action.status === 'proposed' ? (
            <T size={12} color={c.mute}>{t('copilot.advisory')}</T>
          ) : <Tag label={t(`copilot.status.${action.status}`)} color={action.status === 'executed' ? c.mint : c.mute} />}
        </View>
      ) : null}
    </View>
  );
}

export function Copilots() {
  const { user, toast } = useSession();
  const { tablet: wide } = useLayout();
  const list = useLoad(() => api.get('/copilots'), []);
  const [copilot, setCopilot] = useState(null);
  const [task, setTask] = useState(null);
  const [scope, setScope] = useState('');
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const cur = (list.data ?? []).find((x) => x.copilot === copilot);
  const scopes = useLoad(() => (cur?.scope ? SCOPE_LOAD[cur.scope](user) : Promise.resolve([])), [cur?.scope]);
  const options = (scopes.data?.items ?? scopes.data ?? []).map((r) => ({ value: r.id, label: r.name ?? r.title ?? r.display_name ?? r.id, sub: r.city ?? r.sport_name ?? undefined }));

  const go = async () => {
    setBusy(true); setErr(null);
    try { setRun(await api.post(`/copilots/${copilot}/tasks`, { task, scope_id: cur?.scope ? scope : undefined, client_key: key() })); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const resolve = async (actionId, decision) => {
    setBusy(true);
    try {
      const a = await api.post(`/copilots/actions/${actionId}/resolve`, { decision });
      setRun((r) => ({ ...r, actions: r.actions.map((x) => (x.id === actionId ? { ...x, ...a } : x)) }));
      toast?.(t(decision === 'approve' ? 'copilot.done' : 'copilot.rejected'));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Screen>
      <H1>{t('copilot.title')}</H1>
      <T color={c.mute} size={13}>{t('copilot.intro')}</T>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (
        <View style={{ flexDirection: wide ? 'row' : 'column', gap: 16, alignItems: 'flex-start' }}>
          <Card style={{ flex: wide ? 1 : undefined, alignSelf: 'stretch' }}>
            <T weight="700">{t('copilot.pick')}</T>
            <HScroll>
              {(list.data ?? []).map((x) => (
                <Chip key={x.copilot} label={t(`copilot.name.${x.copilot}`)} active={copilot === x.copilot} onPress={() => { setCopilot(x.copilot); setTask(null); setScope(''); setRun(null); }} />
              ))}
            </HScroll>
            {cur ? (
              <View style={{ gap: 10, marginTop: 8 }}>
                <T weight="700">{t('copilot.task')}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {cur.tasks.map((k) => <Chip key={k} label={t(`copilot.task.${k}`)} active={task === k} onPress={() => { setTask(k); setRun(null); }} />)}
                </View>
                {cur.scope ? <MenuField label={t(`copilot.scope.${cur.scope}`)} value={scope} onChange={setScope} options={options} placeholder={t('copilot.choose')} title={t(`copilot.scope.${cur.scope}`)} /> : null}
                <Btn title={t('copilot.run')} disabled={busy || !task || (cur.scope && !scope)} onPress={go} accessibilityLabel={t('copilot.run')} />
              </View>
            ) : null}
          </Card>
          <View style={{ flex: wide ? 2 : undefined, alignSelf: 'stretch' }}>
            {err ? <ErrorBox error={err} /> : null}
            {run ? (
              <Card>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <Tag label={run.ai ? t('copilot.draft') : t('copilot.status.proposed')} color={c.violet} />
                  <T size={11} color={c.mute}>{run.ai ? t('copilot.by_model', { model: run.model }) : t('copilot.by_rules')}</T>
                </View>
                <T weight="800" size={16}>{run.headline}</T>
                {run.items.length ? run.items.map((it) => (
                  <ItemCard key={it.id} it={it} sources={run.sources} action={run.actions.find((a) => a.item_id === it.id)} onResolve={resolve} busy={busy} />
                )) : <Empty title={t('copilot.empty')} />}
                {run.limitations.map((l, n) => <T key={n} size={12} color={c.mute}>{l}</T>)}
                <T size={11} color={c.mute}>{t('copilot.guardrail')}</T>
              </Card>
            ) : !cur ? <Empty title={t('copilot.start')} /> : null}
          </View>
        </View>
      )}
    </Screen>
  );
}
