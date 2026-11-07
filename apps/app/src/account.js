import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useSession } from './session';
import { Btn, Chip, Sheet, T } from './ui';
import { MenuField } from './menu-field';
import { SwitchRow } from './federation-bits';
import { api } from './api';
import { useLoad } from './hooks';
import { setTrackingConsent } from './track';
import { Icon } from './icons';
import { c, themeMode, THEME_KEY } from './theme';
import { LOCALE_KEY, LOCALES, deviceZone, followsDevice, locale, localeLabel, fmtDateTime } from './locale';
import { storage } from './storage';
import { useNav } from './nav';
import { useWorkspace } from './workspace';
import { t, languageMeta, LANGUAGES, fmtDate, fmtNumber, fmtCurrency } from './i18n';
import { CensusInfoSheet } from './census-info';

// Theme and language are read when the app loads (screens bake the tokens in), so a change is stored and the app restarts.
async function restart() {
  if (Platform.OS === 'web') return window.location.reload();
  try { await (await import('expo')).reloadAppAsync(); } catch { /* the choice applies on next launch */ }
}
const remember = async (key, value) => (value ? storage.set(key, value) : storage.del(key));

const THEMES = [['system', 'account.theme.system'], ['light', 'account.theme.light'], ['dark', 'account.theme.dark']];

// Language options for the search-and-pick MenuField: native script name, review status badge, RTL indicator.
const LANG_OPTIONS = LOCALES.map((tag) => {
  const code = tag.split(/[-_]/)[0].toLowerCase();
  const info = LANGUAGES.find((l) => l.code === code);
  const badge = info?.reviewed ? '✓' : '⚠';
  const rtlMark = info?.rtl ? ' ⇐' : '';
  const label = info ? `${info.name}${rtlMark}` : localeLabel(tag);
  const reviewer = info?.reviewMeta?.reviewer ? ` · ${info.reviewMeta.reviewer}` : '';
  const reviewedAt = info?.reviewMeta?.reviewedAt ? ` · ${info.reviewMeta.reviewedAt}` : '';
  const sub = info?.reviewed
    ? `${badge} ${t('account.lang_reviewed')}${reviewer}${reviewedAt}`
    : `${badge} ${t('account.lang_draft')}`;
  return { value: tag, label, sub };
});

/** Formatting preview line for the active locale. */
function LangFormatPreview({ tag }) {
  try {
    const preview = `${fmtNumber(1234.56, tag)} · ${fmtCurrency(12345, 'INR', tag)} · ${fmtDate(new Date(), tag)}`;
    return <T size={11} color={c.mute} style={{ marginTop: 2 }}>{t('account.lang_format_preview')}: {preview}</T>;
  } catch { return null; }
}

/** Appearance, language & region, and Log out — reachable from every screen via AccountButton. */
export function AccountSheet({ visible, onClose }) {
  const { user, signOut } = useSession();
  const [census, setCensus] = useState(false);
  const pickTheme = async (m) => { if (m === themeMode) return; await remember(THEME_KEY, m === 'system' ? null : m); restart(); };
  const pickLocale = async (tag) => { if (tag === locale && !followsDevice) return; await remember(LOCALE_KEY, tag); restart(); };
  const analytics = useLoad(() => (visible && user ? api.get('/analytics/consent').catch(() => null) : Promise.resolve(null)), [visible, user?.id]);
  const [analyticsOn, setAnalyticsOn] = useState(null);
  const consentOn = analyticsOn ?? analytics.data?.granted ?? false;
  const chooseAnalytics = async (on) => {
    const before = consentOn;
    setAnalyticsOn(on); setTrackingConsent(on);
    try { await api.post('/analytics/consent', { granted: on }); } catch { setAnalyticsOn(before); setTrackingConsent(before); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={user ? `@${user.handle}` : t('account.title')}>
      <View style={{ gap: 6 }}>
        <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('account.appearance').toUpperCase()}</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {THEMES.map(([m, label]) => <Chip key={m} label={t(label)} active={themeMode === m} onPress={() => pickTheme(m)} />)}
        </View>
        {themeMode === 'system' ? <T size={12} color={c.mute}>{t('account.follow_device')}</T> : null}
      </View>
      <View style={{ gap: 6 }}>
        <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('account.language').toUpperCase()}</T>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Chip label={t('account.use_device')} active={followsDevice} onPress={() => pickLocale(null)} />
        </View>
        <MenuField
          label={t('account.search_language')}
          value={followsDevice ? null : locale}
          onChange={pickLocale}
          options={LANG_OPTIONS}
          placeholder={t('account.search_language')}
          title={t('account.language')}
        />
        <T size={12} color={c.mute}>{followsDevice ? t('account.from_device') : t('account.your_choice')} · {deviceZone} · {`⁨${fmtDateTime(new Date())}⁩`}</T>
        <LangFormatPreview tag={locale} />
        {!languageMeta.reviewed ? <T size={12} color={c.mute}>{t('account.review_note')}</T> : null}
      </View>
      {user && analytics.data ? (
        <View style={{ gap: 6 }}>
          {analytics.data.available ? <SwitchRow label={t('account.analytics')} sub={t('account.analytics_sub')} value={consentOn} onChange={chooseAnalytics} /> : <T size={12} color={c.mute}>{t('account.analytics_youth')}</T>}
        </View>
      ) : null}
      {user ? <Btn title={t('fedx.demo.title')} color={c.paper} ink={c.ink} onPress={() => setCensus(true)} accessibilityLabel={t('fedx.demo.title')} /> : null}
      <Btn title={t('account.logout')} color={c.ink} onPress={() => { onClose(); signOut(); }} />
      {user ? <CensusInfoSheet visible={census} onClose={() => setCensus(false)} /> : null}
    </Sheet>
  );
}

/** Round account button for the top of every signed-in screen. */
export function AccountButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={t('account.title')} hitSlop={8}
        style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, opacity: pressed ? 0.6 : 1 })}>
        <Icon name="Me" color={c.ink} size={20} />
      </Pressable>
      <AccountSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Round Inbox button beside the account button: opens the one Inbox page, with the unread count on it. */
export function InboxButton() {
  const { push } = useNav();
  const n = useWorkspace()?.data?.unread ?? 0;
  return (
    <Pressable onPress={() => push('Inbox')} accessibilityRole="button" accessibilityLabel={n ? `Inbox, ${n} unread` : 'Inbox'} hitSlop={8}
      style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, opacity: pressed ? 0.6 : 1 })}>
      <Icon name="Inbox" color={c.ink} size={20} />
      {n ? <View accessibilityElementsHidden importantForAccessibility="no" style={{ position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: c.red, alignItems: 'center', justifyContent: 'center' }}><T weight="800" size={10.5} color="#fff">{n > 99 ? '99+' : n}</T></View> : null}
    </Pressable>
  );
}
