// My passes (#510): one list of every rotating pass I (or a young person I look after) can show right now, and the cards and wristbands
// registered to me. The codes and every rule come from the API; this only displays them.
import React from 'react';
import { useNav } from '../nav';
import { H1, Screen, T } from '../ui';
import { c } from '../theme';
import { MyCards, MyPasses } from '../access-ui';

export function MyPassesPage() {
  const nav = useNav();
  return (
    <Screen>
      <H1>My passes</H1>
      <T size={13} color={c.mute}>Show a pass at the door, the gate or the session. It changes every 30 seconds, so it cannot be shared.</T>
      <MyPasses onOpenCards={() => nav.push('MyCards')} />
    </Screen>
  );
}

export function MyCardsPage({ userId }) {
  return (
    <Screen>
      <H1>Cards and wristbands</H1>
      <MyCards userId={userId} />
    </Screen>
  );
}
