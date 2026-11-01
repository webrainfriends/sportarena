# Android

One Expo / React Native codebase (`apps/app`) ships to Android with iOS, iPadOS and web.

* Config: `apps/app/app.json` (`android.package` = `dev.gotmygame.app`, the same id as the iOS bundle; adaptive icon). The package name is permanent once the app exists in Google Play.
* Pull requests: `.github/workflows/ci.yml` job **App iOS + Android bundles** runs `expo export --platform ios --platform android`, so a break that only shows on a phone fails the PR (the web export has its own job).
* Builds: **Actions > Android build > Run workflow**. It queues an EAS build and returns; follow it on expo.dev. Profile `preview` makes an installable `.apk`, `production` a Play `.aab` (version code auto-increments from EAS). Needs only the `EXPO_TOKEN` secret; EAS creates the signing keystore on first build and keeps it on expo.dev.
* Google sign-in: the Android app uses the system browser sheet with PKCE and the **Android** OAuth client (`GOOGLE_ANDROID_CLIENT_ID`, public; package `dev.gotmygame.app` + the signing SHA-1). Until that id is set the button stays hidden on Android. To get the SHA-1: run **Android build**, then **Actions > Android signing SHA-1**; the certificate prints in the job log. Add the reversed client id (`com.googleusercontent.apps.<id>`) to the `scheme` array in `apps/app/app.json`, set the repo variable `GOOGLE_ANDROID_CLIENT_ID`, and rebuild. If you use Google Play App Signing, add a second Android client with the Play signing SHA-1.
* Not done yet: submitting to Google Play (needs a Play service-account key as a repo secret), Apple sign-in on Android (the Apple button is iOS and web only), and a run on a real device.
