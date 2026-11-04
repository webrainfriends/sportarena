// The Process card: the step-by-step "how to run your academy" guide on the Organisation / Academy landing page. It teaches the order of
// setup (venues, staff, suppliers, programmes, coaches, students, classes, tax, revenue sharing, reports) with the real screens as
// screenshots, takes you to each screen, and downloads the whole guide as a PDF. It sits beside Guided setup (setup.js, which ticks
// steps from your records) and does not repeat it: this is the "how", that is the "what is left".
// Content comes from the API (apps/api/src/guides/academy-process.js); text is translated by key `guide.<id>.*` with the English from
// the API as the fallback. Keep it current: see docs/academy-process-guide.md.
import React, { useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { useNav } from '../nav';
import { saveExport } from '../open-file';
import { Btn, Card, ErrorBox, T, Tag } from '../ui';
import { c } from '../theme';
import { t, language } from '../i18n';
import { hasKey } from '../i18n/catalogue';

const pick = (key, fallback) => (hasKey(key) ? t(key) : fallback);
const stepTitle = (s) => pick(`guide.${s.id}.title`, s.title);
const stepWhy = (s) => pick(`guide.${s.id}.why`, s.why);
const stepLines = (s) => s.steps.map((x, i) => pick(`guide.${s.id}.s${i + 1}`, x));
const SIZE = { phone: { w: 390, h: 844 }, desktop: { w: 1280, h: 800 } };

/** One screenshot, fetched on demand as a base64 PNG (the API returns it as data so the sign-in header is used). */
function Shot({ persona, step, size, label }) {
  const img = useLoad(() => api.get(`/process-guides/${persona}/steps/${step}/screenshot/${size}`), [persona, step, size]);
  const { w, h } = SIZE[size];
  if (img.error || !img.data) return <View style={{ aspectRatio: w / h, borderRadius: 14, backgroundColor: c.violetSoft }} accessibilityLabel={label} />;
  return <Image accessibilityLabel={label} source={{ uri: `data:${img.data.content_type};base64,${img.data.content}` }} resizeMode="contain" style={{ width: '100%', aspectRatio: w / h, borderRadius: 14, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper }} />;
}

/**
 * @param {object} p
 * @param {(target: object) => void} p.open  go to the screen a step names: { academy: 'programmes' } | { org: 'people' } | { screen: 'Finance' }
 * @param {string} [p.persona]
 */
export function ProcessCard({ open, persona = 'academy', toast }) {
  const guide = useLoad(() => api.get(`/process-guides/${persona}`), [persona]);
  const { tablet } = useLayout();
  const [shown, setShown] = useState(false);
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  if (guide.error) return <ErrorBox error={guide.error} onRetry={guide.reload} />;
  if (!guide.data) return null;
  const steps = guide.data.steps, s = steps[i];
  const download = async () => {
    setBusy(true);
    try { await saveExport(await api.get(`/process-guides/${persona}/pdf`)); if (language !== 'en') toast?.(t('guide.pdf_english')); }
    catch (e) { toast?.(e.message); }
    setBusy(false);
  };
  const pickStep = (k) => { setI(k); setShown(true); };
  const size = tablet ? 'desktop' : 'phone';
  return (
    <Card pad={16} accessibilityLabel={t('guide.title')}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
            <T size={11} weight="800" color={c.pink}>{t('guide.kicker')}</T>
            <T size={18} weight="800">{t('guide.title')}</T>
            <T size={12} color={c.mute}>{t('guide.sub', { n: steps.length })}</T>
          </View>
          <Btn small title={shown ? t('guide.hide') : t('guide.start')} onPress={() => setShown((v) => !v)} accessibilityLabel={shown ? t('guide.hide') : t('guide.start')} />
          <Btn small title={t('guide.pdf')} color={c.paper} ink={c.ink} onPress={download} loading={busy} accessibilityLabel={t('guide.pdf_a11y')} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {steps.map((x, k) => (
            <Pressable key={x.id} onPress={() => pickStep(k)} accessibilityRole="button" accessibilityState={{ selected: shown && k === i }} accessibilityLabel={t('guide.step_a11y', { n: x.number, title: stepTitle(x) })}
              style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 22, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, backgroundColor: shown && k === i ? c.pink : c.violetSoft }}>
              <T size={13} weight="800" color={shown && k === i ? c.onAccent : c.ink}>{x.number}</T>
              {tablet ? <T size={12} weight="700" color={shown && k === i ? c.onAccent : c.ink}>{stepTitle(x)}</T> : null}
            </Pressable>
          ))}
        </View>
        {shown ? (
          <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 16, alignItems: 'flex-start' }}>
            <View style={{ flex: 1, minWidth: 0, width: tablet ? undefined : '100%', gap: 10 }}>
              <Tag label={t('guide.step_of', { n: s.number, total: steps.length })} />
              <T size={20} weight="800">{stepTitle(s)}</T>
              <T size={13} color={c.mute}>{stepWhy(s)}</T>
              <View style={{ gap: 8 }}>
                {stepLines(s).map((line, k) => (
                  <View key={k} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                    <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}><T size={12} weight="800">{k + 1}</T></View>
                    <T size={14} style={{ flex: 1 }}>{line}</T>
                  </View>
                ))}
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Btn title={t('guide.open')} onPress={() => open(s.target)} accessibilityLabel={t('guide.open_a11y', { title: stepTitle(s) })} />
                <Btn title={t('guide.prev')} color={c.paper} ink={c.ink} disabled={i === 0} onPress={() => setI(i - 1)} />
                <Btn title={t('guide.next')} color={c.paper} ink={c.ink} disabled={i === steps.length - 1} onPress={() => setI(i + 1)} />
              </View>
            </View>
            <View style={{ flex: tablet ? 1.2 : undefined, width: tablet ? undefined : '100%', minWidth: 0, alignItems: 'center' }}>
              <View style={{ width: '100%', maxWidth: size === 'phone' ? 260 : undefined }}>
                {s.screenshots[size] ? <Shot persona={persona} step={s.id} size={size} label={t('guide.shot_a11y', { title: stepTitle(s) })} /> : <T size={12} color={c.mute}>{t('guide.no_shot')}</T>}
              </View>
            </View>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

/** Turn a step's target into navigation. Used by every place the card is shown, so a step always opens the same screen. */
export function useOpenTarget({ o, academy, org }) {
  const { push } = useNav();
  return (target) => {
    if (target.academy) return academy(target.academy);
    if (target.org) return org(target.org);
    if (target.screen) return push(target.screen, ['Finance', 'Org'].includes(target.screen) ? { id: o.id } : {});
  };
}
