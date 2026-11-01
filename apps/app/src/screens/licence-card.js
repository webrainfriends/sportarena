// Federation extras (#703): the licence ID card. A wallet-style card for the holder (or the guardian of a young person): live status, a QR that changes every
// minute and resolves through the public licence check, a shareable image / PDF, and share links that can be turned off. Everything is read from the API
// (REST / MCP share the same capabilities); the server decides who may open, share or export a card. Works the same on iOS, iPadOS, Android and web.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useSession } from '../session';
import { Btn, Card, Empty, H1, Loading, Screen, Sheet, T } from '../ui';
import { explain } from '../access';
import { saveExport } from '../open-file';
import { QrCode } from './passport';
import { fmtDate } from '../federation-ui';
import { c } from '../theme';
import { locale } from '../locale';
import { t } from '../i18n';

const BAND = { active: c.lime, suspended: c.sun, expired: c.mute, revoked: c.red };
const STATUS_KEY = { active: 'fedx.card.valid', suspended: 'fedx.card.suspended', expired: 'fedx.card.expired', revoked: 'fedx.card.revoked' };

/** Share a link or text with the platform's own mechanism: the web share sheet or clipboard, the native share sheet on a phone. */
export async function shareOut(text) {
  if (Platform.OS === 'web') {
    if (typeof navigator !== 'undefined' && navigator.share) { try { await navigator.share({ text }); return true; } catch { return false; } }
    if (typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
    return false;
  }
  await Share.share({ message: text });
  return true;
}

/** The card itself: the same on the holder's phone, in a shared link and (via the server) in the PDF and image. */
export function CardFace({ card, qrValue, qrLabel }) {
  const band = BAND[card.status] ?? c.mute;
  return (
    <View style={{ borderRadius: 24, overflow: 'hidden', backgroundColor: c.paper, borderWidth: 1, borderColor: c.line }} accessible accessibilityLabel={`${card.type_name}, ${card.holder_name ?? ''}, ${t(STATUS_KEY[card.status] ?? 'fedx.card.expired')}`}>
      <View style={{ backgroundColor: c.violet, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <T size={12} color="rgba(255,255,255,0.72)" weight="700" style={{ letterSpacing: 1.2 }}>{(card.body_abbreviation || card.body_name || '').toUpperCase()}</T>
          <T size={20} weight="800" color="#fff">{card.type_name}</T>
        </View>
        <View style={{ backgroundColor: band, borderRadius: 999, paddingHorizontal: 14, minHeight: 34, justifyContent: 'center' }}><T size={13} weight="800" color="#fff">{t(STATUS_KEY[card.status] ?? 'fedx.card.expired').toUpperCase()}</T></View>
      </View>
      <View style={{ padding: 18, flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
        <View style={{ flex: 1, minWidth: 190, gap: 10 }}>
          <T size={22} weight="800">{card.holder_name}</T>
          {[[t('fedx.card.number'), card.licence_no], [t('fedx.card.sport'), [card.sport_name, card.discipline].filter(Boolean).join(' · ')], [t('fedx.card.validity'), card.expires_on ? `${fmtDate(card.issued_on)} – ${fmtDate(card.expires_on)}` : null], [t('fedx.card.grade'), card.grade]]
            .filter(([, v]) => v).map(([k, v]) => <View key={k}><T size={11} color={c.mute} weight="700">{k.toUpperCase()}</T><T size={15} weight="700">{v}</T></View>)}
        </View>
        {qrValue ? (
          <View style={{ flexGrow: 1, minWidth: 160, alignItems: 'center', gap: 6 }}>
            <QrCode value={qrValue} size={150} label={qrLabel} />
            <T size={11} color={c.mute}>{t('fedx.card.scan')}</T>
            {card.public_code ? <T size={12} weight="700">{card.public_code}</T> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The card for a licence you hold (or a young person's you are guardian of), with sharing. */
export function LicenceCardSheet({ licence, visible, onClose }) {
  const { toast } = useSession();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const timer = useRef(null);
  const id = licence?.id;

  const load = useCallback(async () => {
    try { const d = await api.get(`/federation/licences/${id}/card`); setData(d); setError(null); return d; } catch (e) { setError(e); return null; }
  }, [id]);
  // the QR changes every minute, so while the card is open it is fetched again just before the code would stop working
  useEffect(() => {
    if (!visible || !id) return undefined;
    let live = true;
    setData(null);
    const tick = async () => { const d = await load(); if (live) timer.current = setTimeout(tick, Math.max(15, (d?.qr?.refresh_in_s ?? 60) - 5) * 1000); };
    tick();
    return () => { live = false; clearTimeout(timer.current); };
  }, [visible, id, load]);

  const run = async (key, fn) => { setBusy(key); try { await fn(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  const file = (format) => run(format, async () => { await saveExport(await api.get(`/federation/licences/${id}/card/file`, { format })); });
  const link = () => run('link', async () => { const s = await api.post(`/federation/licences/${id}/card/shares`, { days: 7 }); if (await shareOut(s.url)) toast(t('fedx.card.linkCreated')); load(); });
  const revoke = (sid) => run(`r${sid}`, async () => { await api.del(`/federation/licences/${id}/card/shares/${sid}`); load(); });

  const minor = data?.minor, ownMinor = minor && data?.viewing_as === 'holder', canShare = !ownMinor && !!data?.card?.valid;   // a licence that is not in force has nothing to send out
  return (
    <Sheet visible={visible} onClose={onClose} title={t('fedx.card.title')}>
      {!data && !error ? <Loading /> : null}
      {error && !data ? <Empty emoji="🔒" title={explain(error)} /> : null}
      {data ? (
        <View style={{ gap: 14 }}>
          <CardFace card={data.card} qrValue={data.qr.url} qrLabel={t('fedx.card.qrLabel')} />
          <T size={12} color={c.mute} accessibilityLiveRegion="polite">{t('fedx.card.refresh')} {t('fedx.card.asOf', { time: new Date(data.as_of).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) })}</T>
          {minor ? <Card color={c.cyanSoft} pad={12}><T size={13}>{ownMinor ? t('fedx.card.guardianOnly') : t('fedx.card.minorNote')}</T></Card> : null}
          {canShare ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Btn small title={t('fedx.card.shareImage')} loading={busy === 'png'} onPress={() => file('png')} accessibilityLabel={t('fedx.card.shareImage')} />
              <Btn small color={c.paper} ink={c.ink} title={t('fedx.card.savePdf')} loading={busy === 'pdf'} onPress={() => file('pdf')} accessibilityLabel={t('fedx.card.savePdf')} />
              <Btn small color={c.paper} ink={c.ink} title={t('fedx.card.shareLink')} loading={busy === 'link'} onPress={link} accessibilityLabel={t('fedx.card.shareLink')} />
            </View>
          ) : null}
          {canShare ? (
            <View style={{ gap: 8 }}>
              <T weight="800" size={15}>{t('fedx.card.links')}</T>
              {data.shares.filter((s) => s.active).length ? data.shares.filter((s) => s.active).map((s) => (
                <Card key={s.id} pad={12}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <T size={13} style={{ flex: 1 }}>{t('fedx.card.linkExpires', { date: fmtDate(String(s.expires_at).slice(0, 10)), count: s.view_count })}</T>
                    <Btn small color={c.paper} ink={c.red} title={t('fedx.card.revoke')} loading={busy === `r${s.id}`} onPress={() => revoke(s.id)} accessibilityLabel={t('fedx.card.revoke')} />
                  </View>
                </Card>)) : <T size={13} color={c.mute}>{t('fedx.card.noLinks')}</T>}
            </View>
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}

/** Opened from a shared link (`?licence_card=`): the card as its holder chose to share it, with live standing. No sign-in. */
export function SharedLicenceCard({ token }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => { api.get(`/federation/cards/${encodeURIComponent(token)}`).then((d) => setState({ d }), () => setState({ gone: true })); }, [token]);
  if (state.loading) return <Screen><Loading /></Screen>;
  if (state.gone) return <Screen><H1>{t('fedx.card.sharedTitle')}</H1><Empty emoji="🔒" title={t('fedx.card.sharedGone')} /></Screen>;
  return (
    <Screen>
      <H1>{t('fedx.card.sharedTitle')}</H1>
      <View style={{ marginTop: 14, gap: 12 }}>
        <CardFace card={state.d.card} />
        <T size={12} color={c.mute}>{t('fedx.card.sharedLive')}</T>
      </View>
    </Screen>
  );
}
