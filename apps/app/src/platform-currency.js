// The currency the platform charges and pays coaches in, from the server (list_payment_methods). One source for every money field that has no
// record of its own yet, so a form never guesses a currency. Returns undefined until it is known; a money field then shows no code rather than a wrong one.
import { api } from './api';
import { useLoad } from './hooks';

export function usePlatformCurrency() {
  const m = useLoad(() => api.get('/payments/methods'), []);
  return m.data?.currency;
}
