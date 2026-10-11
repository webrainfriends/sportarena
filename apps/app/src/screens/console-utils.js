// Small helpers shared by the event console tabs.
import { useSession } from '../session';

/** Run an API action, toast the outcome and refresh: act(() => api.post(...), 'Done' | (result) => 'Done'). */
export function useDo(refresh) {
  const { toast } = useSession();
  return async (fn, msg) => {
    try { const r = await fn(); toast(typeof msg === 'function' ? msg(r) : msg); refresh?.(); return r; }
    catch (x) { toast('' + x.message); return null; }
  };
}
export const KNOCKOUT_KINDS = ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final', 'third_place'];
