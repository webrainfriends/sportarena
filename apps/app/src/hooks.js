import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/** Counts how many times the screen around it has come into focus (navigation.js bumps it). useLoad reloads when it changes. */
export const FocusCtx = createContext(0);
const STALE_MS = 15000; // a screen that was loaded in the last 15 s is not reloaded just because it came back into view

/** Load data on mount / when deps change. Returns {data, loading, error, reload}. */
export function useLoad(fn, deps = []) {
  const [st, setSt] = useState({ data: null, loading: true, error: null });
  const alive = useRef(true);
  const loadedAt = useRef(0);
  const run = useCallback(async () => {
    loadedAt.current = Date.now();
    setSt((s) => ({ ...s, loading: true, error: null }));
    try { const data = await fn(); if (alive.current) setSt({ data, loading: false, error: null }); }
    catch (error) { if (alive.current) setSt({ data: null, loading: false, error }); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { alive.current = true; run(); return () => { alive.current = false; }; }, [run]);
  // Screens stay mounted under the native stack and tabs, so coming back to one refreshes what it shows (keeping what is on screen meanwhile).
  const focus = useContext(FocusCtx);
  const seen = useRef(focus);
  useEffect(() => {
    if (focus === seen.current) return;
    seen.current = focus;
    if (Date.now() - loadedAt.current > STALE_MS) run();
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...st, reload: run };
}
