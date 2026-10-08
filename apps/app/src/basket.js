import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const Ctx = createContext(null);
export const useBasket = () => useContext(Ctx);

/**
 * The booking basket: slots from any number of areas and venues, held in memory until the customer confirms.
 * An item = { key, resource_id, resource_name, venue_id, venue_name, timezone, currency, starts_at, ends_at, quantity, est_cents }.
 */
export function BasketProvider({ children }) {
  const [items, setItems] = useState([]);
  const [compare, setCompare] = useState([]); // venue ids picked for comparison
  const add = useCallback((list) => setItems((cur) => {
    const keys = new Set(cur.map((i) => i.key));
    return [...cur, ...list.filter((i) => !keys.has(i.key))];
  }), []);
  const remove = useCallback((key) => setItems((cur) => cur.filter((i) => i.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);
  const toggleCompare = useCallback((id) => setCompare((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 5 ? cur : [...cur, id])), []);
  const clearCompare = useCallback(() => setCompare([]), []);
  const value = useMemo(() => ({ items, add, remove, clear, compare, toggleCompare, clearCompare }), [items, add, remove, clear, compare, toggleCompare, clearCompare]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
