// The one "register a venue" form: the venue basics (name, address, area, map pin, currency, time zone). Used by the Register button in
// the venue workspace (sheet) and by the venue home's registration wizard (inline), so there is a single definition of the step.
import { api } from '../api';
import { t } from '../i18n';

const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

/** FormSheet props for the venue basics; `done(venue)` runs after the venue is created. */
export function venueFormProps(done) {
  return {
    title: t('vh.reg.title'), submitLabel: t('vh.reg.create'),
    initial: { currency: 'INR', timezone: zone() },
    fields: [
      { key: 'name', label: t('vh.reg.name') },
      { key: 'address', label: t('vh.reg.address'), optional: true },
      { key: 'city', label: t('vh.reg.city'), type: 'region', optional: true },
      { key: 'latitude', lngKey: 'longitude', label: t('vh.reg.map'), type: 'location', optional: true },
      { key: 'currency', label: t('vh.reg.currency'), type: 'currency' },
      { key: 'timezone', label: t('vh.reg.timezone'), type: 'timezone' },
    ],
    onSubmit: async (v) => { const x = await api.post('/venues', v); await done?.(x); return t('vh.reg.created'); },
  };
}
