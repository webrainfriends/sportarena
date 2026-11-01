import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { BackHandler, Platform } from 'react-native';

const Ctx = createContext(null);
const LEGACY_TABS = { Play: 'Explore', Book: 'Schedule', Hub: 'Home' }; // Hub (the old More page) is now the wheel overlay
export const useNav = () => useContext(Ctx);

/** Open the exact record a link names: a pushed screen, or a tab section. Links are resolved by the API (one resolver for every list). */
export function openLink(nav, link) {
  if (!link) return false;
  if (link.tab) nav.goTab(link.tab, link.params ?? {});
  else if (link.screen) nav.push(link.screen, link.params ?? {});
  else return false;
  return true;
}

/** Tiny stack navigator: one root per tab + a pushed-screen stack (mirrors browser history on web). */
export function NavProvider({ children }) {
  const [tab, setTab] = useState('Home');
  const [stack, setStack] = useState([]);
  const [menu, setMenu] = useState(false); // the More wheel overlay
  const [tabParams, setTabParams] = useState({}); // e.g. goTab('Schedule', { section: 'book' }) opens that section of the tab

  const push = useCallback((name, params = {}) => {
    setMenu(false);
    setStack((s) => [...s, { name, params }]);
    if (Platform.OS === 'web') history.pushState({ n: 1 }, '');
  }, []);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  // names the API or old links may still use: Play became Explore, Book became Schedule
  const goTab = useCallback((t, params = {}) => { setMenu(false); setStack([]); setTab(LEGACY_TABS[t] ?? t); setTabParams(params); }, []);
  const replace = useCallback((name, params = {}) => setStack((s) => [...s.slice(0, -1), { name, params }]), []);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const onPop = () => setStack((s) => s.slice(0, -1));
      window.addEventListener('popstate', onPop);
      return () => window.removeEventListener('popstate', onPop);
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { if (menu) { setMenu(false); return true; } if (stack.length) { back(); return true; } return false; });
    return () => sub.remove();
  }, [stack.length, back, menu]);

  const toggleMenu = useCallback(() => setMenu((m) => !m), []);
  const closeMenu = useCallback(() => setMenu(false), []);
  const value = useMemo(() => ({ tab, tabParams, stack, menu, toggleMenu, closeMenu, push, back, goTab, replace }), [tab, tabParams, stack, menu, toggleMenu, closeMenu, push, back, goTab, replace]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
