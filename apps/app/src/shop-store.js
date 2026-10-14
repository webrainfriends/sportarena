import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { useSession } from './session';

// The shop cart lives on the server (so it follows the person across devices); this keeps one copy in memory that the
// storefront, product page and cart all read, so a change anywhere shows everywhere at once.
let state = { uid: null, cart: null, loading: false };
const subs = new Set();
const emit = () => subs.forEach((f) => f());
const put = (patch) => { state = { ...state, ...patch }; emit(); };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };

export const EMPTY_CART = { items: [], saved: [], summary: { lines: 0, units: 0, subtotal_cents: 0, savings_cents: 0, total_cents: 0, unavailable: 0 } };

export function useCart() {
  const { user } = useSession();
  const uid = user?.id ?? null;
  const s = useSyncExternalStore(subscribe, () => state);
  const refresh = useCallback(async () => {
    if (!uid) return;
    put({ loading: true });
    try { put({ cart: await api.get('/shop/cart'), loading: false }); } catch { put({ loading: false }); }
  }, [uid]);
  useEffect(() => {
    if (state.uid !== uid) { state = { uid, cart: null, loading: false }; emit(); }
    if (uid && !state.cart && !state.loading) refresh();
  }, [uid, refresh]);
  /** Change the cart (add / quantity / save for later / remove). Resolves to the new cart; throws the API's message (e.g. "Only 2 left in stock"). */
  const set = useCallback(async (body) => { const cart = await api.post('/shop/cart/items', body); put({ cart }); return cart; }, []);
  const cart = s.uid === uid ? s.cart : null;
  const lineOf = (productId) => cart?.items.find((i) => i.product_id === productId) ?? null;
  return { cart: cart ?? EMPTY_CART, ready: !!cart, refresh, set, lineOf, count: cart?.summary.units ?? 0 };
}
