// A saved heat / final / field flight on its own midnight screen, like a saved game opens the Match Centre. It is the same session pad the
// event console uses (SessionLive), not a second scorer: this screen only gives it a place to open from the match-day pack with no signal.
import React from 'react';
import { AScreen } from '../arena';
import { useSession } from '../session';
import { SessionLive } from './session-live';

export function SessionPad({ id }) {
  const { toast } = useSession();
  return <AScreen><SessionLive id={id} toast={toast} framed={false} /></AScreen>;
}
