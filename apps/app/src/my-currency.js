// The currency of the signed-in person's own country (their default address; the platform currency when none is set), from the server
// (list_payment_methods.local_currency). One source for every money field that has no record of its own yet, so a form never guesses a
// currency. Returns undefined until it is known; a money field then shows no code rather than a wrong one.
import { api } from './api';
import { useLoad } from './hooks';

export function useMyCurrency() {
  const m = useLoad(() => api.get('/payments/methods'), []);
  return m.data?.local_currency ?? m.data?.currency;
}
