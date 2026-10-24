// Tools: reusable utilities available to every signed-in user, whatever their role. Other modules deep-link into these screens
// (push('ScoringTool', { fixtureId })) instead of carrying their own copies.
import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Card, ErrorBox, H1, Loading, Screen, T, Tag } from '../ui';
import { useLayout } from '../layout';
import { c } from '../theme';

const ICON = { document_designer: '📄', scoring_tracking: '🧮' };

export function ToolsHome() {
  const { push } = useNav();
  const L = useLayout();
  const tools = useLoad(() => api.get('/tools'), []);
  const awaiting = useLoad(() => api.get('/tracking/awaiting-review').catch(() => []), []);
  if (tools.error) return <Screen><ErrorBox error={tools.error} onRetry={tools.reload} /></Screen>;
  if (tools.loading || !tools.data) return <Screen><Loading /></Screen>;
  return (
    <Screen>
      <H1>Tools</H1>
      <T color={c.mute}>Useful for everyone, whatever your role.</T>
      <View style={{ flexDirection: L.tablet ? 'row' : 'column', gap: 14, flexWrap: 'wrap' }}>
        {tools.data.map((t) => (
          <Card key={t.key} onPress={() => push(t.route)} accessibilityLabel={`${t.title}. ${t.summary}`} style={{ flex: L.tablet ? 1 : undefined, minWidth: L.tablet ? 260 : undefined }} pad={20}>
            <T size={40}>{ICON[t.key] ?? '🧰'}</T>
            <T size={19} weight="800">{t.title}</T>
            <T color={c.mute} size={13}>{t.summary}</T>
            {t.key === 'scoring_tracking' ? (
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {t.in_progress ? <Tag label={`${t.in_progress} in progress`} color={c.sun} /> : null}
                {(awaiting.data ?? []).length ? <Tag label={`${awaiting.data.length} awaiting your review`} color={c.cyan} /> : null}
              </View>
            ) : null}
          </Card>
        ))}
      </View>
    </Screen>
  );
}
