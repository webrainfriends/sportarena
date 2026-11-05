// Venue access features (#808), inside the venue console for managers: the lift, step-free route, accessible changing room, pool hoist and so on that
// academies check adaptive sessions against. A switch per feature; retired features are kept by the server. Venue facts only, no personal data.
import React from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { explain, LoadError } from '../access';
import { Card, Loading, Row, T } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';
import { featureLabel } from './academy-inclusion';

export function VenueAccess({ v, toast }) {
  const cat = useLoad(() => api.get('/academy/inclusion/catalogue'), []);
  const cur = useLoad(() => api.get(`/venues/${v.id}/access-features`), [v.id]);
  if (cur.error) return <LoadError error={cur.error} onRetry={cur.reload} />;
  if (!cat.data || !cur.data) return <Loading />;
  const have = new Set(cur.data.features.map((f) => f.feature));
  const flip = async (feature, present) => { try { await api.post(`/venues/${v.id}/access-features`, { feature, present }); } catch (e) { toast?.(explain(e)); } finally { cur.reload(); } };
  return (
    <Card>
      <T weight="800" size={17}>{t('inc.v_title')}</T>
      <T size={13} color={c.mute} style={{ marginBottom: 6 }}>{t('inc.v_sub')}</T>
      {cat.data.venue_features.map((f) => (
        <Row key={f} title={featureLabel(f)} right={<Switch value={have.has(f)} onValueChange={(x) => flip(f, x)} accessibilityLabel={`${featureLabel(f)}: ${have.has(f) ? t('inc.v_yes') : t('inc.v_no')}`} />} />
      ))}
    </Card>
  );
}
