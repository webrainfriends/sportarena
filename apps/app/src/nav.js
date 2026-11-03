import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BackHandler, Platform } from 'react-native';
import { createNavigationContainerRef, StackActions } from '@react-navigation/native';
import { FocusCtx } from './hooks';

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

// ------------------------------------------------------------------------------------------------------------------------------------------------
// The signed-in app runs on a native stack with tabs (React Navigation). Screens keep calling useNav(): push / back / goTab / replace work as they
// always did, but now drive the navigators below through this ref, so they are stable functions (a screen does not re-render when someone navigates).
// The tiny provider above still owns the More wheel and serves the signed-out public pages; NavBridge overrides it inside the navigators.
export const navRef = createNavigationContainerRef();
const waiting = []; // actions asked for before the navigators exist (a tapped notification on a cold start)
const act = (fn) => { if (navRef.isReady()) fn(); else waiting.push(fn); };
/** Called when the navigators are ready: runs what was asked for early. */
export const flushNavigation = () => { while (waiting.length) waiting.shift()(); };
const web = Platform.OS === 'web';

export function NavBridge({ children }) {
  const { menu, toggleMenu, closeMenu } = useContext(Ctx);
  const push = useCallback((name, params = {}) => {
    closeMenu();
    act(() => { navRef.dispatch(StackActions.push(name, params)); if (web) history.pushState({ n: 1 }, ''); });
  }, [closeMenu]);
  const back = useCallback(() => act(() => { if (navRef.canGoBack()) navRef.goBack(); }), []);
  // names the API or old links may still use: Play became Explore, Book became Schedule
  const goTab = useCallback((t, params = {}) => {
    closeMenu();
    act(() => navRef.dispatch(StackActions.popTo('Tabs', { screen: LEGACY_TABS[t] ?? t, params: { ...params, _at: Date.now() } })));
  }, [closeMenu]);
  const replace = useCallback((name, params = {}) => {
    act(() => {
      // on a tab root there is nothing to replace: open it on top, as before
      if (navRef.getRootState()?.routes?.[navRef.getRootState().index]?.name === 'Tabs') navRef.dispatch(StackActions.push(name, params));
      else navRef.dispatch(StackActions.replace(name, params));
    });
  }, []);
  // the browser's back button goes back one screen (the address bar never changes)
  useEffect(() => {
    if (!web) return undefined;
    const onPop = () => { if (navRef.isReady() && navRef.canGoBack()) navRef.goBack(); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const value = useMemo(() => ({ menu, toggleMenu, closeMenu, push, back, goTab, replace, stack: [], tab: undefined, tabParams: {} }), [menu, toggleMenu, closeMenu, push, back, goTab, replace]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Wraps a screen so the data it loads refreshes when the person comes back to it (see useLoad). */
export function FocusScope({ navigation, children }) {
  const [tick, setTick] = useState(0);
  useEffect(() => navigation.addListener('focus', () => setTick((n) => n + 1)), [navigation]);
  return <FocusCtx.Provider value={tick}>{children}</FocusCtx.Provider>;
}

/** The tab that is showing, for the custom tab bar (it sits above the navigators). The container calls syncActiveTab on ready and on every change. */
let activeTab = 'Home';
const tabListeners = new Set();
export function syncActiveTab() {
  const root = navRef.isReady() ? navRef.getRootState() : null;
  const tabs = root?.routes?.find((r) => r.name === 'Tabs');
  const next = (tabs?.state ? tabs.state.routes[tabs.state.index]?.name : tabs?.params?.screen) ?? 'Home';
  if (next !== activeTab) { activeTab = next; tabListeners.forEach((fn) => fn()); }
}
export const useActiveTab = () => useSyncExternalStore((fn) => { tabListeners.add(fn); return () => tabListeners.delete(fn); }, () => activeTab, () => 'Home');
