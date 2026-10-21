import React from 'react';
import { View } from 'react-native';
import { useSession } from './session';
import { T } from './ui';

/** Shown on every screen: this is a beta, and (for people awaiting approval) the account is read-only. */
export function BetaBanner() {
  const { user } = useSession();
  const waiting = user && user.access_status && user.access_status !== 'approved';
  return (
    <View accessibilityRole="alert">
      <View style={{ backgroundColor: '#FEF3C7', paddingVertical: 6, paddingHorizontal: 12 }}>
        <T size={12} weight="700" color="#92400E" style={{ textAlign: 'center' }}>BETA · This site is under beta testing and is not for public or commercial use. Please do not enter real personal or payment information.</T>
      </View>
      {waiting ? (
        <View style={{ backgroundColor: '#DAF1DE', paddingVertical: 6, paddingHorizontal: 12 }}>
          <T size={12} weight="700" color="#163832" style={{ textAlign: 'center' }}>{user.access_status === 'rejected' ? 'Your access request was declined — your account is read-only.' : 'Waiting for the administrator to approve your account. You can look around (read-only) until then.'}</T>
        </View>
      ) : null}
    </View>
  );
}
