import React, { Suspense, useEffect, useState } from 'react';
import { StatusBar, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from './session';
import { NavProvider, useNav } from './nav';
import { Loading } from './ui';
import { setMfaRequiredHandler } from './api';
import { AppLockProvider } from './app-lock';
import { WorkspaceProvider } from './workspace';
import { BasketProvider } from './basket';
import { BetaBanner } from './beta-banner';
import { isSsoCallback, SsoCallbackScreen } from './sso';
import { showPublicEvent, usePublicEvent } from './public-event';
import { PASSPORT_TOKEN, VERIFY_VALUE, LICENCE_CARD_TOKEN, PUBLIC_LINK } from './app-links';
import { c, dark } from './theme';
import Landing from './screens/landing';
import { Event } from './screens/play';
import { PublicShell } from './screens/spectate';
import { PassportPublic } from './screens/passport';
import { VerifyLicence } from './screens/federation';
import { SharedLicenceCard } from './screens/licence-card';

// The signed-in app (navigators and a few hundred screens) is a separate chunk on the web, fetched only after sign-in, so the landing page and the
// public share links (event, passport, licence) start without downloading it. On the phone apps it stays in the one bundle and loads on first use.
const AuthedApp = React.lazy(() => import('./AuthedApp'));

const Page = ({ ins, children }) => <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: ins.top }}>{children}</View>;

function Shell() {
  const { ready, user } = useSession();
  const { goTab } = useNav();
  const ins = useSafeAreaInsets();
  const [mfa, setMfa] = useState(null);
  const nativeEvent = usePublicEvent();
  useEffect(() => { setMfaRequiredHandler(setMfa); return () => setMfaRequiredHandler(() => {}); }, []);
  useEffect(() => { if (!user) setMfa(null); }, [user]);
  // Logging out (from any screen) starts the next session from Home, not from a leftover pushed screen.
  useEffect(() => { if (ready && !user) goTab('Home'); }, [ready, user]); // eslint-disable-line react-hooks/exhaustive-deps
  if (PASSPORT_TOKEN) return <Page ins={ins}><PassportPublic token={PASSPORT_TOKEN} /></Page>;
  if (VERIFY_VALUE) return <Page ins={ins}><VerifyLicence code={VERIFY_VALUE} /></Page>;
  if (LICENCE_CARD_TOKEN) return <Page ins={ins}><SharedLicenceCard token={LICENCE_CARD_TOKEN} /></Page>;
  if (!ready) return <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', padding: 24 }}><Loading /></View>;
  // back from an organisation's identity provider (web): finish the sign-in, whether or not someone is already signed in
  if (isSsoCallback()) return <Page ins={ins}><SsoCallbackScreen /></Page>;
  if ((!user && (PUBLIC_LINK || nativeEvent)) || PUBLIC_LINK?.clip) return <Page ins={ins}><PublicShell eventId={PUBLIC_LINK?.event ?? nativeEvent} fixtureId={PUBLIC_LINK?.fixture} clipId={PUBLIC_LINK?.clip} onExit={PUBLIC_LINK ? undefined : () => showPublicEvent(null)} renderEvent={(params) => <Event {...params} />} /></Page>;
  if (!user) return <Page ins={ins}><BetaBanner /><View style={{ flex: 1 }}><Landing /></View></Page>;
  return (
    <Suspense fallback={<View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', padding: 24 }}><Loading /></View>}>
      <AuthedApp mfa={mfa} onMfaClose={() => setMfa(null)} />
    </Suspense>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <SessionProvider><AppLockProvider><BasketProvider><NavProvider><WorkspaceProvider><Shell /></WorkspaceProvider></NavProvider></BasketProvider></AppLockProvider></SessionProvider>
    </SafeAreaProvider>
  );
}
