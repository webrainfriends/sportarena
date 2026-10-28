// Paid placements (#524) as the person sees them. An ad is always a separate, labelled card beside the organic content, never inside it:
// "Sponsored" or "Promoted" is the first thing on it, the advertiser is named, and a ⓘ explains in plain words why it is there and lets the
// person hide or report it. Every rule about who sees what lives in the API (GET /public/ads); this component only asks and shows.
import React, { useEffect, useState } from 'react';
import { Image, Linking, Platform, Pressable, View } from 'react-native';
import { api, mediaUrl } from './api';
import { useNav } from './nav';
import { useSession } from './session';
import { Btn, Chip, Field, Sheet, T, Tag } from './ui';
import { c } from './theme';
import { locale } from './locale';

export const CTA_LABEL = { learn_more: 'Learn more', book_now: 'Book now', register: 'Register', shop_now: 'Shop now', view: 'View', get_directions: 'Get directions' };
const REASONS = [['misleading', 'Misleading'], ['offensive', 'Offensive'], ['irrelevant', 'Not relevant'], ['unsafe', 'Unsafe'], ['not_for_children', 'Not for children'], ['other', 'Something else']];
const ENTITY_SCREEN = { venue: 'Venue', coach: 'CoachProfile', event: 'Event', academy: 'AcademyPage', supplier: 'SupplierPage' };
const deviceCountry = (() => { try { return new Intl.Locale(locale).region ?? null; } catch { return null; } })();

/** Open a destination the API returned: a Gotmygame page in-app, an https link in the browser (new tab on web, system browser on a device). */
function openDestination(dest, push) {
  if (!dest || dest.type === 'none') return;
  if (dest.type === 'entity') { const screen = ENTITY_SCREEN[dest.entity_type]; if (screen) push(screen, { id: dest.entity_id }); return; }
  if (dest.type === 'external' && /^https:\/\//.test(dest.url)) {
    if (Platform.OS === 'web') window.open(dest.url, '_blank', 'noopener,noreferrer'); else Linking.openURL(dest.url).catch(() => {});
  }
}

/** The ad itself. `preview` renders it for the advertiser's checking: no buttons act. */
export function AdCard({ ad, onCta, onInfo, preview }) {
  const label = ad.label ?? 'Sponsored';
  const ctaLabel = CTA_LABEL[ad.cta] ?? 'Learn more';
  return (
    <View accessibilityRole="summary" accessibilityLabel={`${label} advertisement from ${ad.advertiser?.name}: ${ad.headline}`}
      style={{ borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper, overflow: 'hidden' }}>
      {ad.image_url ? <Image source={{ uri: mediaUrl(ad.image_url) }} accessibilityLabel={ad.image_alt ?? ad.headline} resizeMode="cover" style={{ width: '100%', height: 150, backgroundColor: c.violetSoft }} /> : null}
      <View style={{ padding: 14, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Tag label={label} color={c.sun} />
          <T size={12} color={c.mute} weight="600" style={{ flex: 1 }} numberOfLines={1}>{ad.advertiser?.name}</T>
          <Pressable onPress={onInfo} disabled={preview} accessibilityRole="button" accessibilityLabel="Why am I seeing this ad? Hide or report it" hitSlop={8}
            style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginRight: -10, marginTop: -10 }}>
            <T size={18} color={c.mute} weight="700">ⓘ</T>
          </Pressable>
        </View>
        <T weight="800" size={16}>{ad.headline}</T>
        {ad.body ? <T size={14} color={c.mute}>{ad.body}</T> : null}
        <Btn small title={ctaLabel} onPress={onCta} disabled={preview} accessibilityLabel={`${ctaLabel}: ${ad.headline}`} style={{ alignSelf: 'flex-start', marginTop: 4, minHeight: 44 }} />
      </View>
    </View>
  );
}

function AdInfo({ ad, onClose, onHidden }) {
  const { toast, user } = useSession();
  const [report, setReport] = useState(false);
  const [reason, setReason] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const hide = async (scope) => { setBusy(true); try { await api.post(`/ads/${ad.token}/hide`, { scope }); toast(scope === 'advertiser' ? `You won't see ads from ${ad.advertiser.name}` : "You won't see this ad again"); onHidden(); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const send = async () => { setBusy(true); try { await api.post(`/public/ads/${ad.token}/report`, { reason, ...(note.trim() ? { note: note.trim() } : {}) }); toast('Thanks — the review team will look at it'); onHidden(); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  return (
    <Sheet visible onClose={onClose} title={report ? 'Report this ad' : `${ad.label ?? 'Sponsored'} · why you are seeing this`}>
      {report ? (
        <View style={{ gap: 10 }}>
          <T size={13} color={c.mute}>What is wrong with it?</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{REASONS.map(([k, label]) => <Chip key={k} label={label} active={reason === k} onPress={() => setReason(k)} />)}</View>
          <Field label="Anything to add? (optional)" value={note} onChangeText={setNote} multiline maxLength={500} hint="Only the review team can read this." />
          <Btn title="Send report" disabled={!reason} loading={busy} onPress={send} />
          <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setReport(false)} />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <T size={14}>{ad.why}</T>
          <T size={13} color={c.mute}>Paid ads sit beside results, never inside them: paying cannot change a ranking, a review, a standing or who is selected for anything.</T>
          <Btn title="Hide this ad" color={c.paper} ink={c.ink} loading={busy} onPress={() => hide('campaign')} />
          {user ? <Btn title={`Hide all ads from ${ad.advertiser.name}`} color={c.paper} ink={c.ink} loading={busy} onPress={() => hide('advertiser')} /> : null}
          <Btn title="Report this ad" color={c.paper} ink={c.red} onPress={() => setReport(true)} />
        </View>
      )}
    </Sheet>
  );
}

/**
 * One paid placement. Pass what the page already knows (the sport being browsed, the city a filter names, the search text, the event) — that is all the
 * targeting there is. Renders nothing when there is no eligible ad, so a page never has an empty hole.
 */
export function AdSlot({ placement, sport, city, q, eventId, style }) {
  const { push } = useNav();
  const [ads, setAds] = useState([]);
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.get('/public/ads', { placement, sport: sport || undefined, city: city || undefined, country: deviceCountry || undefined, q: q?.trim() || undefined, event_id: eventId || undefined });
        if (live) setAds(r.ads ?? []);
      } catch { if (live) setAds([]); }
    }, q ? 500 : 0);   // a search box settles before it asks
    return () => { live = false; clearTimeout(t); };
  }, [placement, sport, city, q, eventId]);
  if (!ads.length) return null;
  const follow = async (ad) => { try { openDestination(await api.post(`/public/ads/${ad.token}/click`), push); } catch { /* the ad was withdrawn meanwhile: nothing to open */ } };
  return (
    <View style={[{ gap: 10 }, style]}>
      {ads.map((ad) => <AdCard key={ad.token} ad={ad} onCta={() => follow(ad)} onInfo={() => setInfo(ad)} />)}
      {info ? <AdInfo ad={info} onClose={() => setInfo(null)} onHidden={() => { setAds((l) => l.filter((x) => x.token !== info.token)); setInfo(null); }} /> : null}
    </View>
  );
}
