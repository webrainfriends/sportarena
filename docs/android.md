# Android

One Expo / React Native codebase (`apps/app`) ships to Android with iOS, iPadOS and web.

* Config: `apps/app/app.json` (`android.package` = `dev.gotmygame.app`, the same id as the iOS bundle; adaptive icon). The package name is permanent once the app exists in Google Play.
* Pull requests: `.github/workflows/ci.yml` job **App iOS + Android bundles** runs `expo export --platform ios --platform android`, so a break that only shows on a phone fails the PR (the web export has its own job).
* Builds: **Actions > Android build > Run workflow**. It queues an EAS build and returns; follow it on expo.dev. Profile `preview` makes an installable `.apk`, `production` a Play `.aab` (version code auto-increments from EAS). Needs only the `EXPO_TOKEN` secret; EAS creates the signing keystore on first build and keeps it on expo.dev.
* Not done yet: submitting to Google Play (needs a Play service-account key as a repo secret), Google sign-in button on Android (`google-button.js` renders on iOS and web only), and a run on a real device.
