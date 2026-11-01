// AI highlights & smart clips (#505), the player and public sides: a player's approved-clips gallery (and the offers waiting for their answer) on the passport,
// and the shareable public clip page. Every list is what the server returns right now: a takedown, an expired right or lapsed youth consent removes a clip on the
// next request. The clip itself stays hosted where it is; "Watch" opens its link.
import React from 'react';
import { Platform, Share, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { t } from '../i18n';
import { c } from '../theme';
import { Btn, Card, ErrorBox, H2, Loading, T, Tag } from '../ui';
import { A, ABtn, ACard, AT, ATag } from '../arena';
import { momentName, stateName } from './clips';

const shareUrl = (id) => (Platform.OS === 'web' && typeof window !== 'undefined' ? `${window.location.origin}/?clip=${id}` : `https://gotmygame.app/?clip=${id}`);
const share = (id, title) => (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share
  ? navigator.share({ title, url: shareUrl(id) }).catch(() => {})
  : Share.share({ message: `${title ?? ''} ${shareUrl(id)}`.trim() }));
const factLine = (f = {}) => [f.label, f.team, f.minute, f.fixture].filter(Boolean).join(' · ');

/** A player's highlight clips. `own` shows everything addressed to the player (with why one is hidden) and lets them accept, decline or remove it. */
export function PlayerClips({ userId, own }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/people/${userId}/clips`), [userId]);
  const act = async (linkId, action) => { try { await api.post(`/clip-player-links/${linkId}`, { action }); d.reload(); } catch (e) { toast(e.message); } };
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const items = d.data.items;
  if (!items.length && !own) return null;
  return (
    <View style={{ gap: 10, marginTop: 24 }}>
      <H2>{t('clips.tab')}</H2>
      {!items.length ? <T size={13} color={c.mute}>{t('clips.gallery_empty')}</T> : null}
      {items.map((it) => {
        const clip = it.clip ?? null;
        const title = clip?.title ?? it.title;
        const kind = clip?.moment_kind ?? it.moment_kind;
        const link = clip?.link ?? it.link;
        const facts = clip?.caption.facts ?? it.caption?.facts;
        const prose = clip?.caption.prose ?? it.caption?.prose;
        const byAi = clip?.caption.prose_by_ai ?? it.caption?.prose_by_ai;
        return (
          <Card key={it.link_id}>
            <View style={{ gap: 6 }}>
              <T weight="800" size={15}>{title}</T>
              <T size={12} color={c.mute}>{[clip?.event.name ?? it.event, factLine(facts)].filter(Boolean).join(' · ')}</T>
              {prose ? <T size={13}>{prose}</T> : null}
              {byAi ? <Tag label={t('clips.ai_drafted')} /> : null}
              {own && it.status === 'proposed' ? <Tag label={t('clips.pending_you')} /> : null}
              {own && it.state && it.state !== 'live' ? <Tag label={stateName(it.state)} /> : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                {link ? <Btn small title={t('clips.watch')} onPress={() => WebBrowser.openBrowserAsync(link)} /> : null}
                {own && it.status === 'proposed' ? <><Btn small title={t('clips.accept')} onPress={() => act(it.link_id, 'accept')} /><Btn small color={c.paper} title={t('clips.decline')} onPress={() => act(it.link_id, 'decline')} /></> : null}
                {own && it.status === 'accepted' ? <Btn small color={c.paper} title={t('clips.unlink')} onPress={() => act(it.link_id, 'withdraw')} /> : null}
              </View>
            </View>
          </Card>
        );
      })}
    </View>
  );
}

/** The shareable page for one published clip. The server re-checks rights, takedown and live youth consent on every load; anything that fails is "not available". */
export function PublicClipView({ id }) {
  const d = useLoad(() => api.get(`/public/clips/${id}`), [id]);
  if (d.loading && !d.data) return <View style={{ flex: 1, backgroundColor: A.bg }}><Loading /></View>;
  if (d.error || !d.data) return <View style={{ flex: 1, backgroundColor: A.bg, padding: 24 }}><AT color={A.mute}>{t('clips.public_gone')}</AT></View>;
  const v = d.data;
  return (
    <View style={{ flex: 1, backgroundColor: A.bg, padding: 16, gap: 14 }}>
      <ACard>
        <View style={{ gap: 10 }}>
          <AT size={22} weight="900">{v.title}</AT>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><ATag label={momentName(v.moment_kind)} tone={A.cyan} /><ATag label={v.event.name} tone={A.violet} /></View>
          <AT size={14} color={A.mute}>{factLine(v.caption.facts)}</AT>
          {v.caption.prose ? <AT size={15}>{v.caption.prose}</AT> : null}
          {v.caption.prose_by_ai ? <ATag label={t('clips.ai_drafted')} tone={A.sun} /> : null}
          {v.scorecard ? <AT size={13} color={A.mute}>{`${t('clips.final_score')}: ${v.scorecard.home} ${v.scorecard.home_score} – ${v.scorecard.away_score} ${v.scorecard.away}`}</AT> : null}
        </View>
      </ACard>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <ABtn tone="neon" title={t('clips.watch')} onPress={() => WebBrowser.openBrowserAsync(v.link)} />
        <ABtn tone="ghost" title={t('clips.share')} onPress={() => share(v.id, v.title)} />
      </View>
    </View>
  );
}
