// Instant team joining by link/code/QR (feature 4).
// JoinTeam: deep-link landing page. TeamJoinLinks: manager's link management.
import React, { useState } from 'react';
import { View, ScrollView, Share, Platform, Clipboard } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { FormSheet } from '../FormSheet';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, GradCard, H2, HScroll, Loading, Row, Screen, Section, T, Tag } from '../ui';
import { c, grad } from '../theme';
import { t } from '../i18n';

const MODE_COLORS = { open: c.lime, request: c.cyan, role_specific: c.pink };
const MODE_LABELS = { open: 'tjl.mode.open', request: 'tjl.mode.request', role_specific: 'tjl.mode.role_specific' };

export function JoinTeam({ code }) {
  const [joined, setJoined] = useState(false);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast, user } = useSession();
  const { back } = useNav();

  const q = useLoad(() => api.get(`/join/${code}`), [code]);

  const handleJoin = async () => {
    setBusy(true);
    try {
      const res = await api.post(`/join/${code}`, {});
      if (res.joined) { setJoined(true); toast(t('tjl.joined')); }
      if (res.requested) { setRequested(true); toast(t('tjl.requested')); }
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;

  const link = q.data?.link;
  if (!link) return <Empty emoji="🔗" title={t('tjl.revoked')} sub="" />;

  if (link.is_expired) return <Empty emoji="⏰" title={t('tjl.expired')} sub="" />;
  if (link.is_full) return <Empty emoji="🚫" title={t('tjl.full')} sub="" />;

  return (
    <Screen title={t('tjl.join_title')}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        {/* Team hero */}
        <GradCard colors={grad.hero} accessibilityLabel={link.team_name}>
          <View style={{ alignItems: 'center', padding: 24, gap: 8 }}>
            <T weight="800" size={24} color="#fff">{link.team_emoji ?? '🏅'} {link.team_name}</T>
            {link.sport_name && <T size={14} color="rgba(255,255,255,0.8)">{link.sport_name}</T>}
            <T size={13} color="rgba(255,255,255,0.7)">{link.member_count} members</T>
          </View>
        </GradCard>

        {/* Mode & Role chips */}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Tag label={t(MODE_LABELS[link.mode])} color={MODE_COLORS[link.mode]} />
          <Tag label={`${t('tjl.role')}: ${link.role}`} color={c.violet} />
        </View>

        {/* Gate notices */}
        {(link.age_min || link.age_max) && (
          <Card color={c.sunSoft} pad={12}>
            <T size={13}>📋 {t('tjl.age_gate', { min: link.age_min ?? 0, max: link.age_max ?? 99 })}</T>
          </Card>
        )}
        {link.guardian_required && (
          <Card color={c.orangeSoft} pad={12}>
            <T size={13}>👨‍👧 {t('tjl.guardian_required')}</T>
          </Card>
        )}

        {/* Code display */}
        <Card pad={16} accessibilityLabel={t('tjl.code')}>
          <T size={12} weight="800" color={c.mute} style={{ textAlign: 'center' }}>{t('tjl.code')}</T>
          <T weight="800" size={32} color={c.pink} style={{ textAlign: 'center', letterSpacing: 4, fontVariant: ['tabular-nums'] }}>{link.code}</T>
        </Card>

        {/* Join / Request */}
        {!joined && !requested && user && (
          <Btn
            title={link.mode === 'request' ? t('tjl.request_btn') : t('tjl.join_btn')}
            color={c.pink}
            loading={busy}
            disabled={busy}
            onPress={handleJoin}
          />
        )}
        {!user && (
          <Card color={c.violetSoft} pad={14}>
            <T weight="700" style={{ textAlign: 'center' }}>Sign in to join this team</T>
          </Card>
        )}
        {joined && (
          <Card color={c.limeSoft} pad={14}>
            <T weight="700" color={c.lime} style={{ textAlign: 'center' }}>✓ {t('tjl.joined')}</T>
          </Card>
        )}
        {requested && (
          <Card color={c.cyanSoft} pad={14}>
            <T weight="700" color={c.cyan} style={{ textAlign: 'center' }}>⏳ {t('tjl.requested')}</T>
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

export function TeamJoinLinks({ teamId }) {
  const [createSheet, setCreateSheet] = useState(false);
  const { toast } = useSession();

  const q = useLoad(() => api.get(`/teams/${teamId}/join-links`), [teamId]);
  const requests = useLoad(() => api.get(`/teams/${teamId}/join-requests`), [teamId]);

  const shareLink = async (link) => {
    const url = `https://app.sportarena.com/join/${link.code}`;
    if (Platform.OS === 'web') {
      try { await Clipboard.setStringAsync(url); toast(t('tjl.copied')); } catch { toast(url); }
      return;
    }
    await Share.share({ message: `Join our team on SportArena! Use code ${link.code} or tap: ${url}`, url });
  };

  const handleRevoke = async (linkId) => {
    await api.del(`/join-links/${linkId}`);
    q.reload();
    toast(t('tjl.revoked_ok'));
  };

  const handleCreate = async (data) => {
    await api.post(`/teams/${teamId}/join-links`, {
      ...data,
      max_uses: data.unlimited ? undefined : Number(data.max_uses),
      guardian_required: !!data.guardian_required,
      federation_auto_register: !!data.federation_auto_register,
    });
    q.reload();
    return t('tjl.link_created');
  };

  const handleDecide = async (reqId, decision) => {
    await api.patch(`/join-requests/${reqId}`, { decision });
    requests.reload();
    toast(decision === 'approved' ? 'Approved' : 'Declined');
  };

  return (
    <Screen title={t('tjl.title')}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Btn title={t('tjl.new_link')} color={c.pink} onPress={() => setCreateSheet(true)} />

        {/* Join Requests */}
        {(requests.data?.requests?.length > 0) && (
          <Section title={`${t('tjl.pending_requests')} (${requests.data.requests.length})`} color={c.sun}>
            {requests.data.requests.map(r => (
              <Card key={r.id} pad={12} accessibilityLabel={r.display_name}>
                <Row>
                  <Avatar user={{ display_name: r.display_name, avatar_url: r.avatar_url, avatar_emoji: r.avatar_emoji }} size={32} />
                  <View style={{ flex: 1, marginLeft: 8 }}>
                    <T weight="700">{r.display_name}</T>
                    <T size={12} color={c.mute}>Code: {r.link_code} · Role: {r.role}</T>
                  </View>
                  <Btn small title={t('tjl.approve')} color={c.lime} onPress={() => handleDecide(r.id, 'approved')} />
                  <Btn small title={t('tjl.decline')} color={c.paper} ink={c.red} onPress={() => handleDecide(r.id, 'declined')} />
                </Row>
              </Card>
            ))}
          </Section>
        )}

        {/* Links */}
        <Section title={t('tjl.link')} color={c.violet}>
          {q.loading && !q.data ? <Loading /> :
           q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> :
           (q.data?.links?.length ?? 0) === 0 ? (
             <Empty emoji="🔗" title={t('tjl.empty_links')} sub={t('tjl.empty_links_sub')} />
           ) : (
             q.data.links.map(link => (
               <Card key={link.id} pad={14} accessibilityLabel={`Code ${link.code}`}>
                 <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                   <T weight="800" size={18} color={c.pink} style={{ letterSpacing: 2 }}>{link.code}</T>
                   <Tag label={t(MODE_LABELS[link.mode])} color={MODE_COLORS[link.mode]} />
                 </View>
                 <T size={12} color={c.mute} style={{ marginTop: 4 }}>
                   {t('tjl.role')}: {link.role} · {link.max_uses ? t('tjl.uses', { used: link.used_count, max: link.max_uses }) : t('tjl.unlimited_uses', { used: link.used_count })}
                   {link.expires_at ? ` · Exp ${new Date(link.expires_at).toLocaleDateString()}` : ''}
                 </T>
                 {Number(link.pending_request_count) > 0 && (
                   <Tag label={`${link.pending_request_count} pending`} color={c.sun} />
                 )}
                 <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                   <Btn small title={t('tjl.share')} color={c.cyan} onPress={() => shareLink(link)} />
                   <Btn small title={t('tjl.copy_link')} color={c.paper} ink={c.ink} onPress={() => shareLink(link)} />
                   <Btn small title={t('tjl.revoke')} color={c.paper} ink={c.red} onPress={() => handleRevoke(link.id)} />
                 </View>
               </Card>
             ))
           )
          }
        </Section>
      </ScrollView>

      <FormSheet
        visible={createSheet}
        onClose={() => setCreateSheet(false)}
        title={t('tjl.new_link')}
        initial={{ mode: 'open', role: 'player', max_uses: 50, unlimited: true, guardian_required: false, federation_auto_register: false }}
        fields={[
          { key: 'mode', label: 'Mode', type: 'menu', options: ['open','request','role_specific'].map(m => ({ value: m, label: t(MODE_LABELS[m]) })) },
          { key: 'role', label: t('tjl.role'), type: 'menu', options: ['player','coach','manager','physio'].map(r => ({ value: r, label: r })) },
          { key: 'unlimited', label: t('tjl.unlimited'), type: 'switch' },
          { key: 'max_uses', label: t('tjl.max_uses'), type: 'number' },
          { key: 'expires_at', label: t('tjl.expiry'), type: 'datetime' },
          { key: 'age_min', label: t('tjl.age_min'), type: 'number' },
          { key: 'age_max', label: t('tjl.age_max'), type: 'number' },
          { key: 'guardian_required', label: t('tjl.guardian_req'), type: 'switch' },
          { key: 'federation_auto_register', label: t('tjl.federation'), type: 'switch' },
        ]}
        onSubmit={handleCreate}
      />
    </Screen>
  );
}
