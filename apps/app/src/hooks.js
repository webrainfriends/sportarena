import { useCallback, useEffect, useRef, useState } from 'react';

/** Load data on mount / when deps change. Returns {data, loading, error, reload}. */
export function useLoad(fn, deps = []) {
  const [st, setSt] = useState({ data: null, loading: true, error: null });
  const alive = useRef(true);
  const run = useCallback(async () => {
    setSt((s) => ({ ...s, loading: true, error: null }));
    try { const data = await fn(); if (alive.current) setSt({ data, loading: false, error: null }); }
    catch (error) { if (alive.current) setSt({ data: null, loading: false, error }); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { alive.current = true; run(); return () => { alive.current = false; }; }, [run]);
  return { ...st, reload: run };
}
