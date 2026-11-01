// Guided setup (#514): pick who you are (academy, club, school, venue, event organiser, coach) and follow the steps from an empty account to your
// first live transaction. The API derives every step from the records you already have, so there is nothing to tick: finish the work and the
// step is done. The Home card and this screen read the same one capability.
import React from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { useGo } from '../workspace';
import { Btn, Card, Chip, ErrorBox, H1, Loading, Screen, T } from '../ui';
import { HScroll } from '../pickers';
import { MenuField } from '../menu-field';
import { explain } from '../access';
import { c } from '../theme';
import { t } from '../i18n';
import { personaBlurb, personaLabel, stepTitle, stepWhy } from '../ws-text';

function Bar({ done, total }) {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={`${done} of ${total} steps done`} accessibilityValue={{ min: 0, max: total, now: done }} style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}>
      <View style={{ width: `${total ? (done / total) * 100 : 0}%`, height: 8, backgroundColor: c.mint }} />
    </View>
  );
}

/** Open a step: the importer has its own screen, everything else is the screen the API points at. */
function useOpen() {
  const go = useGo();
  const { push } = useNav();
  return (s) => (s.action === 'import' && s.target?.params?.organisation_id ? push('Migrate', { organisation_id: s.target.params.organisation_id }) : go(s.target));
}

export function Setup({ persona: first, organisation_id: firstOrg }) {
  const { toast } = useSession();
  const { tablet } = useLayout();
  const open = useOpen();
  const [persona, setPersona] = React.useState(first ?? null);
  const [org, setOrg] = React.useState(firstOrg ?? null);
  const q = useLoad(() => api.get('/me/launch-checklist', { ...(persona ? { persona } : {}), ...(org ? { organisation_id: org } : {}) }), [persona, org]);
  const d = q.data;
  const choose = async (key) => { setPersona(key); setOrg(null); try { await api.patch('/me/launch-checklist', { persona: key, dismissed: false }); } catch (e) { toast(explain(e)); } };
  const forPersona = (d?.organisations ?? []);
  const noOrg = d?.personas?.find((p) => p.key === d.persona)?.scope === 'organisation' && !d?.organisation;
  return (
    <Screen wide onRefresh={q.reload} refreshing={q.loading && !!d}>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{t('setup.guided')}</T>
      <H1 style={{ fontSize: 28 }}>{t('setup.title')}</H1>
      <T size={14} color={c.mute} style={{ marginTop: 4 }}>{t('setup.intro')}</T>
      {q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : !d ? <Loading /> : (
        <>
          <View style={{ marginTop: 14, gap: 6 }}>
            <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('setup.i_run')}</T>
            <HScroll>{d.personas.map((p) => <Chip key={p.key} label={`${p.emoji} ${personaLabel(p)}`} active={d.persona === p.key} onPress={() => choose(p.key)} />)}</HScroll>
            {d.persona ? <T size={12.5} color={c.mute}>{personaBlurb(d.personas.find((p) => p.key === d.persona))}</T> : null}
          </View>
          {d.persona && d.personas.find((p) => p.key === d.persona)?.scope === 'organisation' && forPersona.length > 1 ? (
            <View style={{ marginTop: 12 }}><MenuField label={t('tb.org_fallback')} value={d.organisation?.id ?? ''} onChange={setOrg} options={forPersona.map((o) => ({ value: o.id, label: o.name, sub: o.kind }))} /></View>
          ) : null}
          {!d.persona ? <Card style={{ marginTop: 14 }}><T weight="700">{t('setup.choose_run')}</T></Card> : (
            <View style={{ marginTop: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <T weight="800">{d.organisation ? d.organisation.name : t('setup.your_setup')}</T>
                <T weight="700" color={c.mute}>{t('setup.n_of', { done: d.done, total: d.total })}</T>
              </View>
              <Bar done={d.done} total={d.total} />
              <View style={{ marginTop: 12, gap: 10, flexDirection: tablet ? 'row' : 'column', flexWrap: 'wrap' }}>
                {d.steps.map((s, i) => {
                  const next = s.key === d.next;
                  return (
                    <Card key={s.key} onPress={() => open(s)} pad={14} color={next ? c.violetSoft : c.paper} accessibilityLabel={t('setup.step_a11y', { n: i + 1, title: stepTitle(s, d.persona), state: s.done ? t('setup.state_done') : next ? t('setup.state_next') : t('setup.state_todo'), why: stepWhy(s, d.persona, noOrg) })}
                      style={{ width: tablet ? '49%' : '100%', borderWidth: next ? 2 : 0, borderColor: c.violet }}>
                      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
                        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: s.done ? c.mint : c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
                          <T size={13} weight="800" color={s.done ? c.onAccent : c.mute}>{s.done ? '✓' : i + 1}</T>
                        </View>
                        <View style={{ flex: 1 }}>
                          <T weight="800" style={{ textDecorationLine: s.done ? 'line-through' : 'none' }} color={s.done ? c.mute : c.ink}>{stepTitle(s, d.persona)}</T>
                          <T size={12.5} color={c.mute} style={{ marginTop: 2, lineHeight: 18 }}>{stepWhy(s, d.persona, noOrg)}</T>
                          {!s.done ? <T size={12.5} weight="800" color={c.violet} style={{ marginTop: 6 }}>{s.action === 'import' ? t('setup.start_import_go') : next ? t('setup.do_next') : t('setup.open_go')}</T> : null}
                        </View>
                      </View>
                    </Card>
                  );
                })}
              </View>
              {d.complete ? <Card color={c.limeSoft} style={{ marginTop: 14 }}><T weight="800">{t('setup.live')}</T><T size={13} color={c.mute}>{t('setup.all_done')}</T></Card> : null}
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

/** The Home card: shown until the checklist is finished or hidden, and only once there is a persona to follow. */
export function SetupCard() {
  const { push } = useNav();
  const open = useOpen();
  const q = useLoad(() => api.get('/me/launch-checklist').catch(() => null), []);
  const d = q.data;
  if (!d || d.dismissed || !d.persona || !d.total || d.complete) return null;
  const next = d.steps.find((s) => s.key === d.next);
  const hide = async () => { try { await api.patch('/me/launch-checklist', { dismissed: true }); q.reload(); } catch { /* a failed hide just leaves the card */ } };
  return (
    <Card pad={14} style={{ marginTop: 14 }} color={c.violetSoft} accessibilityLabel={t('setup.card_a11y', { done: d.done, total: d.total, title: next ? stepTitle(next, d.persona) : '' })}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T weight="800">{t('setup.card_title', { done: d.done, total: d.total })}</T>
        <Pressable onPress={hide} accessibilityRole="button" accessibilityLabel={t('setup.a11y_hide')} hitSlop={12} style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}><T size={12} weight="700" color={c.mute}>{t('setup.hide')}</T></Pressable>
      </View>
      <View style={{ marginVertical: 8 }}><Bar done={d.done} total={d.total} /></View>
      {next ? <T size={13} color={c.ink} weight="600">{t('setup.next_line', { title: stepTitle(next, d.persona) })}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {next ? <Btn small title={next.action === 'import' ? t('setup.start_import') : t('setup.continue')} onPress={() => open(next)} /> : null}
        <Btn small title={t('setup.all_steps')} color={c.paper} ink={c.ink} onPress={() => push('Setup', {})} />
      </View>
    </Card>
  );
}
