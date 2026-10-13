# iOS app and browser

One React Native (Expo) codebase ships three ways: a **native iOS app**, an **installable web app** (PWA) and a plain browser site.
All use the same API (`/api/v1`).

## Native iOS
* Config: `apps/app/app.json` (bundle id `dev.gotmygame.app`, Sign in with Apple, camera/photo permission text, no non-exempt encryption)
  and `apps/app/eas.json` (profiles `development` = simulator, `preview` = internal/ad-hoc, `production` = App Store/TestFlight).
* Release builds call `https://gotmygame.com` (set per profile in `eas.json` via `EXPO_PUBLIC_API_URL`; with no override a non-dev
  build also falls back to it). `npm run app` / `npm run ios` still use the local API.
* Building: Actions → **iOS build** → pick a profile (tick *submit* for TestFlight). One-time maintainer setup: add the repo secret
  `EXPO_TOKEN`, run `eas init` once locally or in the dashboard to fill `extra.eas.projectId` (needed for push tokens), and add the
  secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (App Store Connect API key, Admin role) and `APPLE_TEAM_ID` so EAS can manage
  certificates/profiles without an Apple password or 2FA. If the team is an individual, change `EXPO_APPLE_TEAM_TYPE` in the workflow to `INDIVIDUAL`.
* Push on iPhone uses Expo push tokens (`push.js`); tokens, session and secure storage use the iOS keychain.

## Browser / Home Screen
* Same app at the site URL on any browser. On iPhone: Safari → Share → **Add to Home Screen** for a full-screen app with its own icon
  (`apple-touch-icon.png`, standalone manifest, safe-area aware shell in `src/web.js`).
* `public/sw.js` caches only the static shell (works offline-to-open); `/api` and `/mcp` are never cached. Web push on iOS works for the
  installed Home Screen app (iOS 16.4+).

* The App ID `dev.gotmygame.app` is managed in the Apple developer console (Sign in with Apple + Push Notifications on), so EAS capability
  syncing is switched off (`EXPO_NO_CAPABILITY_SYNC=1`) in the workflow; set it too when running `eas credentials` locally.
