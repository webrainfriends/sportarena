// Opening a provider's hosted checkout (Stripe, PayPal, Razorpay) and coming back.
// Web: the page leaves for the provider and the server returns to the app's own address (?payment=&result=).
// iOS, iPadOS, Android: an in-app browser sheet that closes by itself when the provider returns to /api/v1/pay/return, which hands the person to sportarena://payment.
// The result is never read from that address: callers ask the server (POST /payments/:id/confirm) whether the payment went through.
import { Platform } from 'react-native';

export const PAY_SCHEME = 'sportarena://payment';
/** Sent to the API from the phone apps so the provider returns to the page that hands the person back to the app. */
export const CLIENT = Platform.OS === 'web' ? undefined : 'app';

/** @returns 'redirect' on the web (the page is leaving), otherwise how the sheet ended: 'success' (returned), 'cancel', 'dismiss' or 'error'. */
export async function openCheckout(url) {
  if (Platform.OS === 'web') { window.location.assign(url); return 'redirect'; }
  try {
    const WebBrowser = require('expo-web-browser');
    return (await WebBrowser.openAuthSessionAsync(url, PAY_SCHEME)).type;
  } catch { return 'error'; }
}
